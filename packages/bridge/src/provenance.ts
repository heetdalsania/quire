import type * as Y from "yjs";
import { ATTR_AUTHOR, type Author, spans } from "./attribution.js";

/**
 * Provenance: who wrote a span, with what, and why.
 *
 * Attribution answers "who". A *run* answers the rest. Rather than stamping every span
 * with a model name, timestamp and prompt -- which would dwarf the text itself -- spans
 * carry one extra mark, a run id, and the run record lives once in a map. Phase 1 measured
 * span attribution at 1.38x encoded size; this keeps that shape.
 *
 * The point is that Quire never has to *infer* whether a person wrote something. It
 * watched it being written.
 */
export const ATTR_RUN = "run";
const RUNS_KEY = "runs";

export interface Run {
  id: string;
  authorId: string;
  /** Model identifier when an agent made the edit, e.g. "claude-opus-5". */
  model: string | null;
  /** The instruction that produced this work, when the agent recorded one. */
  prompt: string | null;
  /** Which tool call it came through, e.g. "edit_document". */
  tool: string | null;
  startedAt: number;
}

export interface ProvenanceSummary {
  totalChars: number;
  byAuthor: Array<{
    authorId: string;
    name: string;
    kind: "human" | "agent" | "unknown";
    chars: number;
    share: number;
  }>;
  humanShare: number;
  agentShare: number;
  unattributedShare: number;
}

export function newRunId(): string {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function registerRun(
  doc: Y.Doc,
  run: Omit<Run, "startedAt"> & { startedAt?: number },
): string {
  const runs = doc.getMap<Omit<Run, "id">>(RUNS_KEY);
  doc.transact(() => {
    runs.set(run.id, {
      authorId: run.authorId,
      model: run.model ?? null,
      prompt: run.prompt ?? null,
      tool: run.tool ?? null,
      startedAt: run.startedAt ?? Date.now(),
    });
  }, "provenance");
  return run.id;
}

export function getRun(doc: Y.Doc, id: string): Run | null {
  const stored = doc.getMap<Omit<Run, "id">>(RUNS_KEY).get(id);
  return stored ? { id, ...stored } : null;
}

export function allRuns(doc: Y.Doc): Run[] {
  return [...doc.getMap<Omit<Run, "id">>(RUNS_KEY).entries()]
    .map(([id, rest]) => ({ id, ...rest }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** The run behind the span covering a character offset -- "why does this exist?". */
export function runAt(
  doc: Y.Doc,
  text: Y.Text,
  index: number,
): { run: Run | null; from: number; to: number } | null {
  let cursor = 0;
  for (const op of text.toDelta() as Array<{ insert?: string; attributes?: Record<string, string> }>) {
    if (typeof op.insert !== "string") continue;
    const from = cursor;
    const to = cursor + op.insert.length;
    cursor = to;
    if (index < from || index >= to) continue;
    const runId = op.attributes?.[ATTR_RUN];
    return { run: runId ? getRun(doc, runId) : null, from, to };
  }
  return null;
}

/**
 * How much of this document each party actually wrote.
 *
 * Counted from marks laid down at write time, not guessed from the prose -- which is why
 * it can be trusted where a detector cannot.
 */
export function summarise(
  doc: Y.Doc,
  text: Y.Text,
  authors: Record<string, { name: string; kind: "human" | "agent" }>,
): ProvenanceSummary {
  const chars = new Map<string, number>();
  let total = 0;

  for (const span of spans(text)) {
    const length = span.to - span.from;
    if (length === 0) continue;
    total += length;
    chars.set(span.author ?? "", (chars.get(span.author ?? "") ?? 0) + length);
  }

  const byAuthor = [...chars.entries()]
    .map(([authorId, count]) => {
      const known = authorId ? authors[authorId] : undefined;
      return {
        authorId,
        name: known?.name ?? (authorId || "Unattributed"),
        kind: (known?.kind ?? "unknown") as "human" | "agent" | "unknown",
        chars: count,
        share: total === 0 ? 0 : count / total,
      };
    })
    .sort((a, b) => b.chars - a.chars);

  const shareOf = (kind: string): number =>
    byAuthor.filter((a) => a.kind === kind).reduce((sum, a) => sum + a.share, 0);

  return {
    totalChars: total,
    byAuthor,
    humanShare: shareOf("human"),
    agentShare: shareOf("agent"),
    unattributedShare: shareOf("unknown"),
  };
}

/**
 * Sign the spans one author contributed.
 *
 * Deliberately *not* a claim that the text is true or good -- only that this key was
 * present as it was typed. Verification fails as soon as the signed spans change, which is
 * the honest behaviour: an edited claim is no longer the claim that was signed.
 */
export async function signAuthorSpans(
  text: Y.Text,
  author: Author,
  key: CryptoKey,
  subtle: SubtleCrypto,
): Promise<{ authorId: string; digest: string; signature: string; chars: number }> {
  const owned = spans(text).filter((s) => s.author === author.id);
  const full = text.toString();
  const payload = owned.map((s) => full.slice(s.from, s.to)).join(" ");
  const bytes = new TextEncoder().encode(`${author.id} ${payload}`);

  const hex = (buf: ArrayBuffer): string =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return {
    authorId: author.id,
    digest: hex(await subtle.digest("SHA-256", bytes)),
    signature: hex(await subtle.sign({ name: "HMAC" }, key, bytes)),
    chars: payload.length,
  };
}

export { ATTR_AUTHOR };

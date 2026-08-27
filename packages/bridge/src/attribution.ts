import type * as Y from "yjs";

/**
 * Authorship and suggestions are carried as Y.Text formatting marks.
 *
 * Phase 1 measured span-level attribution at 1.38x encoded size against 20.6x for
 * character-level, so spans are the unit. Marks ride along with the text through
 * concurrent edits for free, which is exactly what a bolt-on side-index would not do.
 */
export const ATTR_AUTHOR = "au";
/** Present on text an author has *proposed inserting* but that is not yet accepted. */
export const ATTR_SUGGEST_INSERT = "si";
/** Present on existing text an author has *proposed deleting*. */
export const ATTR_SUGGEST_DELETE = "sd";

export interface Author {
  id: string;
  name: string;
  color: string;
  /** Agents are rendered differently and can be undone as a unit. */
  kind: "human" | "agent";
}

export interface AttributedSpan {
  from: number;
  to: number;
  author: string | null;
  suggestInsert: string | null;
  suggestDelete: string | null;
}

/** Transaction origin for an author's edits. Also what per-author UndoManagers track. */
export const authorOrigin = (authorId: string): string => `author:${authorId}`;

export function insertAttributed(
  text: Y.Text,
  index: number,
  content: string,
  author: Author,
  options: { suggestion?: string | undefined; run?: string | undefined } = {},
): void {
  const attributes: Record<string, string> = { [ATTR_AUTHOR]: author.id };
  if (options.suggestion) attributes[ATTR_SUGGEST_INSERT] = options.suggestion;
  // The run id is what turns "who wrote this" into "why does this exist".
  if (options.run) attributes.run = options.run;
  text.doc?.transact(() => {
    text.insert(index, content, attributes);
  }, authorOrigin(author.id));
}

/**
 * Propose deleting a range without removing it, so a human can see what the agent
 * wants gone before it disappears.
 */
export function proposeDelete(
  text: Y.Text,
  from: number,
  to: number,
  author: Author,
  suggestionId: string,
): void {
  text.doc?.transact(() => {
    text.format(from, to - from, {
      [ATTR_SUGGEST_DELETE]: suggestionId,
      [ATTR_AUTHOR]: author.id,
    });
  }, authorOrigin(author.id));
}

/** Walk the delta once and return contiguous spans with their marks. */
export function spans(text: Y.Text): AttributedSpan[] {
  const out: AttributedSpan[] = [];
  let cursor = 0;
  for (const op of text.toDelta() as Array<{ insert?: string; attributes?: Record<string, string> }>) {
    if (typeof op.insert !== "string") continue;
    const length = op.insert.length;
    if (length === 0) continue;
    out.push({
      from: cursor,
      to: cursor + length,
      author: op.attributes?.[ATTR_AUTHOR] ?? null,
      suggestInsert: op.attributes?.[ATTR_SUGGEST_INSERT] ?? null,
      suggestDelete: op.attributes?.[ATTR_SUGGEST_DELETE] ?? null,
    });
    cursor += length;
  }
  return out;
}

/** Every distinct suggestion id currently present in the document. */
export function pendingSuggestions(text: Y.Text): string[] {
  const ids = new Set<string>();
  for (const span of spans(text)) {
    if (span.suggestInsert) ids.add(span.suggestInsert);
    if (span.suggestDelete) ids.add(span.suggestDelete);
  }
  return [...ids];
}

const OUTCOMES_KEY = "suggestionOutcomes";

export interface SuggestionOutcome {
  id: string;
  authorId: string | null;
  action: "accepted" | "rejected";
  chars: number;
  at: number;
}

/**
 * Record what happened to a suggestion.
 *
 * Acceptance rate is the only honest measure of whether an agent is actually useful, and
 * it cannot be reconstructed afterwards: once a suggestion is accepted or rejected, the
 * marks that described it are gone.
 */
function recordOutcome(text: Y.Text, suggestionId: string, action: "accepted" | "rejected"): void {
  const doc = text.doc;
  if (!doc) return;
  const affected = spans(text).filter(
    (s) => s.suggestInsert === suggestionId || s.suggestDelete === suggestionId,
  );
  if (affected.length === 0) return;

  const entry: SuggestionOutcome = {
    id: suggestionId,
    authorId: affected[0]?.author ?? null,
    action,
    chars: affected.reduce((sum, s) => sum + (s.to - s.from), 0),
    at: Date.now(),
  };
  doc.getArray<SuggestionOutcome>(OUTCOMES_KEY).push([entry]);
}

export function suggestionOutcomes(doc: Y.Doc): SuggestionOutcome[] {
  return [...doc.getArray<SuggestionOutcome>(OUTCOMES_KEY)];
}

/**
 * Accept a suggestion: proposed insertions become ordinary text (authorship is kept),
 * and proposed deletions actually delete.
 */
export function acceptSuggestion(text: Y.Text, suggestionId: string): void {
  recordOutcome(text, suggestionId, "accepted");
  text.doc?.transact(() => {
    // Right to left: deleting shifts every index after it.
    for (const span of spans(text).reverse()) {
      if (span.suggestDelete === suggestionId) {
        text.delete(span.from, span.to - span.from);
      } else if (span.suggestInsert === suggestionId) {
        text.format(span.from, span.to - span.from, { [ATTR_SUGGEST_INSERT]: null });
      }
    }
  }, "suggestion:accept");
}

/** Reject a suggestion: proposed insertions are removed, proposed deletions are kept. */
export function rejectSuggestion(text: Y.Text, suggestionId: string): void {
  recordOutcome(text, suggestionId, "rejected");
  text.doc?.transact(() => {
    for (const span of spans(text).reverse()) {
      if (span.suggestInsert === suggestionId) {
        text.delete(span.from, span.to - span.from);
      } else if (span.suggestDelete === suggestionId) {
        text.format(span.from, span.to - span.from, { [ATTR_SUGGEST_DELETE]: null });
      }
    }
  }, "suggestion:reject");
}

/**
 * The plain Markdown projection. Text that is only *proposed* for insertion is excluded,
 * so an unaccepted agent suggestion never reaches the file on disk.
 */
export function committedText(text: Y.Text): string {
  let out = "";
  for (const op of text.toDelta() as Array<{ insert?: string; attributes?: Record<string, string> }>) {
    if (typeof op.insert !== "string") continue;
    if (op.attributes?.[ATTR_SUGGEST_INSERT]) continue;
    out += op.insert;
  }
  return out;
}

interface VisibleRun {
  /** Offset within the committed projection. */
  committed: number;
  /** Offset within the full Y.Text, which also contains un-accepted suggestions. */
  full: number;
  length: number;
}

/** Runs of text that are visible on disk, i.e. everything not merely *proposed*. */
function visibleRuns(text: Y.Text): VisibleRun[] {
  const runs: VisibleRun[] = [];
  let committed = 0;
  for (const span of spans(text)) {
    if (span.suggestInsert) continue;
    const length = span.to - span.from;
    runs.push({ committed, full: span.from, length });
    committed += length;
  }
  return runs;
}

/**
 * Apply an external (on-disk) version to a document that has pending suggestions.
 *
 * The file on disk only ever contains committed text, so the diff has to be computed in
 * committed space and then projected back onto full-text offsets, stepping over the
 * suggestion spans that disk cannot see. Operations are applied right to left so earlier
 * offsets stay valid.
 */
export function applyCommittedDiff(
  text: Y.Text,
  next: string,
  diffFn: (a: string, b: string) => Array<[number, string]>,
): boolean {
  const current = committedText(text);
  if (current === next) return false;

  const runs = visibleRuns(text);
  const total = runs.reduce((sum, run) => sum + run.length, 0);

  const toFull = (index: number): number => {
    for (const run of runs) {
      if (index >= run.committed && index < run.committed + run.length) {
        return run.full + (index - run.committed);
      }
    }
    const last = runs[runs.length - 1];
    return last ? last.full + last.length : 0;
  };

  const ops: Array<{ at: number; insert?: string; deleteTo?: number }> = [];
  let cursor = 0;
  for (const [op, chunk] of diffFn(current, next)) {
    if (op === 0) {
      cursor += chunk.length;
    } else if (op === 1) {
      ops.push({ at: toFull(Math.min(cursor, total)), insert: chunk });
    } else {
      const from = cursor;
      const to = cursor + chunk.length;
      for (const run of runs) {
        const start = Math.max(from, run.committed);
        const end = Math.min(to, run.committed + run.length);
        if (start < end) {
          ops.push({
            at: run.full + (start - run.committed),
            deleteTo: run.full + (end - run.committed),
          });
        }
      }
      cursor = to;
    }
  }

  ops.sort((a, b) => b.at - a.at);
  text.doc?.transact(() => {
    for (const op of ops) {
      if (op.insert !== undefined) text.insert(op.at, op.insert);
      else if (op.deleteTo !== undefined) text.delete(op.at, op.deleteTo - op.at);
    }
  });
  return ops.length > 0;
}

const AUTHORS_KEY = "authors";

/**
 * Record who an author is, inside the document itself.
 *
 * Awareness is ephemeral: it vanishes the moment a peer disconnects. Attribution marks
 * outlive the session that produced them, so the name and colour behind an author id
 * have to live in the CRDT too -- otherwise yesterday's agent edits render as "Someone".
 */
export function registerAuthor(doc: import("yjs").Doc, author: Author): void {
  const authors = doc.getMap<unknown>(AUTHORS_KEY);
  if (authors.get(author.id)) return;
  doc.transact(() => {
    authors.set(author.id, { name: author.name, color: author.color, kind: author.kind });
  }, "authors");
}

export function knownAuthors(doc: import("yjs").Doc): Record<string, Omit<Author, "id">> {
  return Object.fromEntries(doc.getMap<Omit<Author, "id">>(AUTHORS_KEY).entries());
}

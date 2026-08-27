import * as Y from "yjs";
import { ATTR_AUTHOR, committedText, spans } from "./attribution.js";

/**
 * Document replay.
 *
 * "How did this spec end up like this?" is normally answered by reading twenty commits.
 * A recording answers it in fifteen seconds, and Quire can build one because the CRDT
 * already holds every operation -- this is mostly a matter of exposing what is in memory.
 *
 * Frames are built from snapshots taken against the document's own version vector, so a
 * replay reflects the order things were actually written rather than the order files were
 * saved.
 */

export interface ReplayFrame {
  /** Position in the replay, 0..1. */
  at: number;
  /** Only present when text was explicitly requested; see the note on ReplayOptions. */
  text?: string;
  /** Characters attributable to each author at this point. */
  byAuthor: Record<string, number>;
  totalChars: number;
}

export interface ReplayOptions {
  /** How many frames to produce. More is smoother and more expensive. */
  frames?: number;
  /**
   * Include each frame's full text.
   *
   * Off by default, and deliberately so: a 160-frame replay of a one-megabyte document
   * carries 160 megabytes of text, which is enough to stall a browser and to exhaust the
   * server building it. Callers fetch the text for the frame they are actually showing.
   */
  withText?: boolean;
  /**
   * Show the on-disk projection rather than the raw CRDT text.
   *
   * Without this a replay splices un-accepted suggestions into the prose, which reads as
   * the document contradicting itself -- and is not what the file ever said.
   */
  committed?: boolean;
}

/**
 * How many frames are worth building for a document of this size.
 *
 * Replay is most useful on documents a person actually reads. Scaling the count down for
 * large documents keeps the cost bounded rather than refusing outright.
 */
export function frameBudget(docLength: number, requested: number): number {
  // Each frame materialises a whole copy of the document, so the ceiling falls as the
  // document grows. Two is the floor: below that there is nothing to scrub between.
  const ceiling =
    docLength > 2_000_000 ? 3
    : docLength > 400_000 ? 8
    : docLength > 100_000 ? 20
    : docLength > 20_000 ? 40
    : 160;
  return Math.max(2, Math.min(requested, ceiling));
}

/**
 * Build a replay from a document's history.
 *
 * Yjs snapshots require `gc: false` on the document: garbage collection discards the
 * deleted content a replay needs to show. Documents created without it can still be
 * replayed, but deletions will appear as jumps rather than as text being removed.
 */
export function buildReplay(doc: Y.Doc, key = "content", options: ReplayOptions = {}): ReplayFrame[] {
  const text = doc.getText(key);
  const frameCount = frameBudget(text.length, options.frames ?? 40);
  const withText = options.withText ?? false;
  const project = options.committed
    ? (t: Y.Text): string => committedText(t)
    : (t: Y.Text): string => t.toString();
  const finalState = Y.encodeStateVector(doc);

  // Walk the clock range of every contributing client together, so a frame is a moment in
  // the document's life rather than a moment in one participant's.
  const clients = [...(Y.decodeStateVector(finalState) as Map<number, number>).entries()];
  if (clients.length === 0) {
    return [{ at: 1, ...(withText ? { text: project(text) } : {}), byAuthor: {}, totalChars: text.length }];
  }

  const frames: ReplayFrame[] = [];
  for (let i = 1; i <= frameCount; i++) {
    const ratio = i / frameCount;
    const partial = new Map<number, number>();
    for (const [client, clock] of clients) partial.set(client, Math.ceil(clock * ratio));

    try {
      const snapshot = new Y.Snapshot(Y.createDeleteSet(), partial);
      const restored = Y.createDocFromSnapshot(doc, snapshot);
      const restoredText = restored.getText(key);
      frames.push({
        at: ratio,
        ...(withText ? { text: project(restoredText) } : {}),
        byAuthor: countByAuthor(restoredText),
        totalChars: restoredText.length,
      });
      restored.destroy();
    } catch {
      // A snapshot that cannot be restored (usually a gc'd document) contributes nothing
      // rather than aborting the whole replay.
    }
  }

  // Always finish on the real document, so the last frame is exactly what is on screen.
  frames.push({
    at: 1,
    ...(withText ? { text: project(text) } : {}),
    byAuthor: countByAuthor(text),
    totalChars: text.length,
  });
  return dedupe(frames);
}

function countByAuthor(text: Y.Text): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const span of spans(text)) {
    const key = span.author ?? "";
    counts[key] = (counts[key] ?? 0) + (span.to - span.from);
  }
  return counts;
}

/** Collapse runs of identical frames; a replay should not stall on unchanged text. */
function dedupe(frames: ReplayFrame[]): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  const same = (a: ReplayFrame, b: ReplayFrame): boolean =>
    a.text !== undefined || b.text !== undefined
      ? a.text === b.text
      : a.totalChars === b.totalChars && JSON.stringify(a.byAuthor) === JSON.stringify(b.byAuthor);

  for (const frame of frames) {
    const previous = out[out.length - 1];
    if (previous && same(previous, frame)) {
      out[out.length - 1] = frame; // keep the later timestamp
      continue;
    }
    out.push(frame);
  }
  return out;
}

/** Materialise a single frame's text, for a scrubber showing one position at a time. */
export function replayFrameText(doc: Y.Doc, at: number, key = "content", committed = false): string {
  const project = (t: Y.Text): string => (committed ? committedText(t) : t.toString());
  const ratio = Math.max(0, Math.min(1, at));
  if (ratio >= 1) return project(doc.getText(key));

  const partial = new Map<number, number>();
  for (const [client, clock] of (Y.decodeStateVector(Y.encodeStateVector(doc)) as Map<number, number>).entries()) {
    partial.set(client, Math.ceil(clock * ratio));
  }
  try {
    const restored = Y.createDocFromSnapshot(doc, new Y.Snapshot(Y.createDeleteSet(), partial));
    const text = project(restored.getText(key));
    restored.destroy();
    return text;
  } catch {
    return project(doc.getText(key));
  }
}

export { ATTR_AUTHOR };

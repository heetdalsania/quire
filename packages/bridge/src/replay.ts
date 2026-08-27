import * as Y from "yjs";
import { ATTR_AUTHOR, spans } from "./attribution.js";

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
  text: string;
  /** Characters attributable to each author at this point. */
  byAuthor: Record<string, number>;
  totalChars: number;
}

export interface ReplayOptions {
  /** How many frames to produce. More is smoother and more expensive. */
  frames?: number;
}

/**
 * Build a replay from a document's history.
 *
 * Yjs snapshots require `gc: false` on the document: garbage collection discards the
 * deleted content a replay needs to show. Documents created without it can still be
 * replayed, but deletions will appear as jumps rather than as text being removed.
 */
export function buildReplay(doc: Y.Doc, key = "content", options: ReplayOptions = {}): ReplayFrame[] {
  const frameCount = Math.max(2, Math.min(options.frames ?? 40, 200));
  const text = doc.getText(key);
  const finalState = Y.encodeStateVector(doc);

  // Walk the clock range of every contributing client together, so a frame is a moment in
  // the document's life rather than a moment in one participant's.
  const clients = [...(Y.decodeStateVector(finalState) as Map<number, number>).entries()];
  if (clients.length === 0) return [{ at: 1, text: text.toString(), byAuthor: {}, totalChars: text.length }];

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
        text: restoredText.toString(),
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
  frames.push({ at: 1, text: text.toString(), byAuthor: countByAuthor(text), totalChars: text.length });
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
  for (const frame of frames) {
    if (out.length > 0 && out[out.length - 1]!.text === frame.text) {
      out[out.length - 1] = frame; // keep the later timestamp
      continue;
    }
    out.push(frame);
  }
  return out;
}

export { ATTR_AUTHOR };

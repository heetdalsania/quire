import diff from "fast-diff";
import type * as Y from "yjs";

const EQUAL = 0;
const INSERT = 1;
const DELETE = -1;

/**
 * Apply `next` to `ytext` as a minimal sequence of insert/delete operations.
 *
 * This is deliberately NOT `ytext.delete(0, len); ytext.insert(0, next)`. A wholesale
 * replacement destroys every collaborator's cursor and turns an unrelated remote edit
 * into a conflict. A minimal diff leaves untouched regions genuinely untouched, so
 * relative positions anchored in them survive.
 *
 * Returns true if anything changed.
 */
export function applyTextDiff(ytext: Y.Text, next: string): boolean {
  const current = ytext.toString();
  if (current === next) return false;

  let cursor = 0;
  for (const [op, chunk] of diff(current, next)) {
    if (op === EQUAL) {
      cursor += chunk.length;
    } else if (op === INSERT) {
      ytext.insert(cursor, chunk);
      cursor += chunk.length;
    } else {
      ytext.delete(cursor, chunk.length);
    }
  }
  return true;
}

interface Segment {
  b0: number;
  b1: number;
  o0: number;
  o1: number;
  equal: boolean;
}

/**
 * Build a function mapping a position in `base` to the corresponding position in `ours`.
 * Positions landing inside a locally-changed region clamp to the start of that region --
 * imprecise by nature, but it keeps external edits near where they were intended.
 */
function buildPositionMap(base: string, ours: string): (p: number) => number {
  const segments: Segment[] = [];
  let b = 0;
  let o = 0;

  for (const [op, chunk] of diff(base, ours)) {
    if (op === EQUAL) {
      segments.push({ b0: b, b1: b + chunk.length, o0: o, o1: o + chunk.length, equal: true });
      b += chunk.length;
      o += chunk.length;
    } else if (op === INSERT) {
      segments.push({ b0: b, b1: b, o0: o, o1: o + chunk.length, equal: false });
      o += chunk.length;
    } else {
      segments.push({ b0: b, b1: b + chunk.length, o0: o, o1: o, equal: false });
      b += chunk.length;
    }
  }

  return (p: number): number => {
    for (const s of segments) {
      if (p >= s.b0 && p <= s.b1) {
        return s.equal ? s.o0 + (p - s.b0) : s.o0;
      }
    }
    return ours.length;
  };
}

/**
 * Merge an external change into a Y.Text using three-way semantics.
 *
 *   base   -- the file content Quire last observed on disk
 *   theirs -- the file content now on disk
 *   ours   -- the current CRDT text, which may have diverged since `base`
 *
 * Diffing `ours -> theirs` directly would make disk unconditionally win and silently
 * discard concurrent in-memory edits. Instead we extract the *external* edit as
 * `diff(base, theirs)` and replay it onto `ours` through a position map.
 *
 * When `ours === base` (the overwhelmingly common case, since Quire writes to disk
 * continuously) this reduces to an exact two-way diff with no approximation at all.
 *
 * Returns true if anything changed.
 */
export function applyExternalChange(ytext: Y.Text, base: string, theirs: string): boolean {
  const ours = ytext.toString();
  if (ours === theirs) return false;

  // Exact path: no local divergence, so the external diff applies verbatim.
  if (ours === base) return applyTextDiff(ytext, theirs);

  // Divergent path: best-effort replay of the external edit onto diverged text.
  const mapPosition = buildPositionMap(base, ours);
  const clamp = (n: number): number => Math.max(0, Math.min(n, ytext.length));

  let basePos = 0;
  let shift = 0;

  for (const [op, chunk] of diff(base, theirs)) {
    if (op === EQUAL) {
      basePos += chunk.length;
    } else if (op === INSERT) {
      const at = clamp(mapPosition(basePos) + shift);
      ytext.insert(at, chunk);
      shift += chunk.length;
    } else {
      const start = clamp(mapPosition(basePos) + shift);
      const end = clamp(mapPosition(basePos + chunk.length) + shift);
      const length = Math.max(0, Math.min(end - start, ytext.length - start));
      if (length > 0) {
        ytext.delete(start, length);
        shift -= length;
      }
      basePos += chunk.length;
    }
  }

  return true;
}

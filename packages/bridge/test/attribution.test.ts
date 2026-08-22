import { describe, expect, it } from "vitest";
import * as Y from "yjs";

/**
 * Phase 1 measurement: what does per-author edit attribution cost in document size?
 *
 * This is a gating number for the Phase 4 wedge. Attribution has to be carried in the
 * document schema from the first commit, so if character-level marks are ruinous we need
 * to know before designing around them -- not in Week 4.
 */

const PARAGRAPH = "The quick brown fox jumps over the lazy dog near the riverbank. ";

function buildPlain(chunks: number): Y.Doc {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  doc.transact(() => {
    for (let i = 0; i < chunks; i++) text.insert(text.length, PARAGRAPH);
  });
  return doc;
}

function buildSpanAttributed(chunks: number, authors: number): Y.Doc {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  doc.transact(() => {
    for (let i = 0; i < chunks; i++) {
      text.insert(text.length, PARAGRAPH, { author: `user-${i % authors}` });
    }
  });
  return doc;
}

function buildCharAttributed(chars: number, authors: number): Y.Doc {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  doc.transact(() => {
    for (let i = 0; i < chars; i++) {
      text.insert(text.length, PARAGRAPH[i % PARAGRAPH.length]!, {
        author: `user-${i % authors}`,
      });
    }
  });
  return doc;
}

const sizeOf = (doc: Y.Doc): number => Y.encodeStateAsUpdateV2(doc).byteLength;
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

describe("Phase 1 measurement -- attribution overhead", () => {
  it("reports encoded size across attribution granularities", () => {
    const chunks = Math.ceil(50_000 / PARAGRAPH.length); // ~50 KB of prose

    const plainBulk = buildPlain(1);
    const plain = buildPlain(chunks);
    const span2 = buildSpanAttributed(chunks, 2);
    const span8 = buildSpanAttributed(chunks, 8);

    const textBytes = plain.getText("content").toString().length;
    const rows: Array<[string, number]> = [
      ["raw markdown text", textBytes],
      ["plain, single insert", sizeOf(plainBulk)],
      [`plain, ${chunks} inserts`, sizeOf(plain)],
      ["span attribution, 2 authors", sizeOf(span2)],
      ["span attribution, 8 authors", sizeOf(span8)],
    ];

    // Character-level attribution measured on a smaller doc; it is superlinear enough
    // that running it at 50 KB is pointless once the ratio is visible.
    const charDoc = buildCharAttributed(5_000, 2);
    const charPlain = buildPlain(Math.ceil(5_000 / PARAGRAPH.length));
    const charRatio = sizeOf(charDoc) / sizeOf(charPlain);

    console.log(`\n      ${"granularity".padEnd(32)}${"encoded".padStart(10)}   vs raw text`);
    for (const [label, bytes] of rows) {
      const ratio = (bytes / textBytes).toFixed(2);
      console.log(`      ${label.padEnd(32)}${kb(bytes).padStart(10)}   ${ratio}x`);
    }
    console.log(
      `      ${"char attribution (5 KB doc)".padEnd(32)}${kb(sizeOf(charDoc)).padStart(10)}   ${charRatio.toFixed(1)}x vs plain\n`,
    );

    const spanOverhead = sizeOf(span2) / sizeOf(plain);

    // Verdict thresholds. Span-level attribution must stay cheap enough to ship.
    expect(spanOverhead).toBeLessThan(3);
    expect(sizeOf(span2)).toBeLessThan(textBytes * 4);
  });
});

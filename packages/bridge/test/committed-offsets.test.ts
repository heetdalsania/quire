import { expect, it } from "vitest";
import * as Y from "yjs";
import { committedText, committedToFull, insertAttributed, proposeDelete } from "../src/attribution.js";

it("maps committed boundaries around pending insertions and retains proposed deletions", () => {
  const doc = new Y.Doc(); const text = doc.getText("content");
  const author = { id: "agent", name: "Agent", color: "blue", kind: "agent" as const };
  text.insert(0, "abcd");
  insertAttributed(text, 2, "pending", author, { suggestion: "insert" });
  proposeDelete(text, 0, 1, author, "delete");
  expect(committedText(text)).toBe("abcd");
  expect([0, 1, 2, 3, 4].map(offset => committedToFull(text, offset))).toEqual([0, 1, 9, 10, 11]);
  insertAttributed(text, text.length, "tail", author, { suggestion: "tail" });
  expect(committedToFull(text, 4)).toBe(11);
  doc.destroy();
});

it("maps an empty committed projection to zero", () => {
  const doc = new Y.Doc(); const text = doc.getText("content");
  expect(committedToFull(text, 0)).toBe(0);
  insertAttributed(text, 0, "pending", { id: "agent", name: "Agent", color: "blue", kind: "agent" }, { suggestion: "insert" });
  expect(committedToFull(text, 0)).toBe(0);
  doc.destroy();
});

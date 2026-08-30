import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ATTR_AUTHOR, type Author } from "@quire/bridge/attribution";
import { configureSuggesting, suggestingExtension } from "../src/suggesting.js";

const human: Author = { id: "human-1", name: "Human", color: "#336699", kind: "human" };

describe("normal human editing", () => {
  it("attributes every inserted range after the editor applies it", async () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "base");
    configureSuggesting(text, human);

    const state = EditorState.create({ doc: "base", extensions: [suggestingExtension()] });
    state.update({ changes: [{ from: 0, insert: "A" }, { from: 4, insert: "B" }] });

    // y-codemirror applies this same transaction to Y.Text before the queued attribution
    // pass runs. Reproduce that order without needing a browser DOM.
    text.insert(4, "B");
    text.insert(0, "A");
    await Promise.resolve();

    expect(text.toString()).toBe("AbaseB");
    expect(text.toDelta()).toEqual([
      { insert: "A", attributes: { [ATTR_AUTHOR]: human.id } },
      { insert: "base" },
      { insert: "B", attributes: { [ATTR_AUTHOR]: human.id } },
    ]);
  });
});

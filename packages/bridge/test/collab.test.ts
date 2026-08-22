import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  type Author,
  CommentStore,
  acceptSuggestion,
  authorOrigin,
  committedText,
  insertAttributed,
  pendingSuggestions,
  proposeDelete,
  rejectSuggestion,
  spans,
} from "../src/index.js";

const human: Author = { id: "h1", name: "Heet", color: "#3b5bdb", kind: "human" };
const agent: Author = { id: "a1", name: "Claude", color: "#c2255c", kind: "agent" };

function docWith(initial: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  text.insert(0, initial);
  return { doc, text };
}

describe("attribution and suggestions", () => {
  it("tags spans with their author", () => {
    const { text } = docWith("");
    insertAttributed(text, 0, "human wrote this. ", human);
    insertAttributed(text, text.length, "agent wrote this.", agent);

    const authored = spans(text).filter((s) => s.author);
    expect(authored.map((s) => s.author)).toEqual(["h1", "a1"]);
    expect(text.toString()).toBe("human wrote this. agent wrote this.");
  });

  it("keeps proposed insertions out of the on-disk projection until accepted", () => {
    const { text } = docWith("Original text.");
    insertAttributed(text, 14, " Proposed addition.", agent, { suggestion: "s1" });

    expect(text.toString()).toBe("Original text. Proposed addition.");
    expect(committedText(text)).toBe("Original text."); // disk sees nothing yet
    expect(pendingSuggestions(text)).toEqual(["s1"]);

    acceptSuggestion(text, "s1");
    expect(committedText(text)).toBe("Original text. Proposed addition.");
    expect(pendingSuggestions(text)).toEqual([]);
    // Authorship survives acceptance.
    expect(spans(text).some((s) => s.author === "a1")).toBe(true);
  });

  it("rejecting a proposed insertion removes it entirely", () => {
    const { text } = docWith("Keep this.");
    insertAttributed(text, 10, " Drop this.", agent, { suggestion: "s2" });
    rejectSuggestion(text, "s2");

    expect(text.toString()).toBe("Keep this.");
    expect(committedText(text)).toBe("Keep this.");
    expect(pendingSuggestions(text)).toEqual([]);
  });

  it("a proposed deletion only takes effect on accept", () => {
    const { text } = docWith("alpha bravo charlie");
    proposeDelete(text, 6, 12, agent, "s3"); // "bravo "

    expect(committedText(text)).toBe("alpha bravo charlie"); // still on disk
    expect(spans(text).some((s) => s.suggestDelete === "s3")).toBe(true);

    acceptSuggestion(text, "s3");
    expect(committedText(text)).toBe("alpha charlie");
  });

  it("rejecting a proposed deletion keeps the text and clears the mark", () => {
    const { text } = docWith("alpha bravo charlie");
    proposeDelete(text, 6, 12, agent, "s4");
    rejectSuggestion(text, "s4");

    expect(committedText(text)).toBe("alpha bravo charlie");
    expect(pendingSuggestions(text)).toEqual([]);
  });

  it("undoes one author's edits without touching another's", () => {
    const { doc, text } = docWith("base. ");
    const agentUndo = new Y.UndoManager(text, {
      trackedOrigins: new Set([authorOrigin(agent.id)]),
    });

    insertAttributed(text, text.length, "AGENT-EDIT. ", agent);
    doc.transact(() => {
      text.insert(text.length, "human typed after.");
    }, authorOrigin(human.id));

    expect(text.toString()).toBe("base. AGENT-EDIT. human typed after.");

    agentUndo.undo();

    // The agent's span is gone; the human's adjacent edit is untouched.
    expect(text.toString()).toBe("base. human typed after.");
  });
});

describe("comment anchoring", () => {
  it("follows the text it is attached to through edits above it", () => {
    const { doc, text } = docWith("alpha\nbravo\ncharlie\n");
    const comments = new CommentStore(doc);
    const from = text.toString().indexOf("bravo");
    comments.add({ text, from, to: from + 5, body: "why bravo?", authorId: "h1", authorName: "Heet" });

    text.insert(0, "PREPENDED LINE\n");

    const [thread] = comments.list();
    expect(thread?.orphaned).toBe(false);
    const { from: f, to: t } = thread!.range!;
    expect(text.toString().slice(f, t)).toBe("bravo");
  });

  it("flags a thread as orphaned rather than dropping it when its text is deleted", () => {
    const { doc, text } = docWith("alpha\nbravo\ncharlie\n");
    const comments = new CommentStore(doc);
    const from = text.toString().indexOf("bravo");
    comments.add({ text, from, to: from + 5, body: "doomed anchor", authorId: "h1", authorName: "Heet" });

    text.delete(from, 5);

    const [thread] = comments.list();
    expect(thread).toBeDefined();
    expect(thread?.orphaned).toBe(true);
    expect(thread?.range).toBeNull();
    expect(thread?.quote).toBe("bravo"); // the conversation is still legible
    expect(thread?.body).toBe("doomed anchor");
  });

  it("resolves and removes threads", () => {
    const { doc, text } = docWith("hello world");
    const comments = new CommentStore(doc);
    const id = comments.add({ text, from: 0, to: 5, body: "nit", authorId: "h1", authorName: "Heet" });

    comments.setResolved(id, true);
    expect(comments.list()[0]?.resolved).toBe(true);

    comments.remove(id);
    expect(comments.list()).toEqual([]);
  });
});

describe("regression: stale client state across a server restart", () => {
  it("two independently seeded docs merge by concatenation, which is why epochs exist", () => {
    // This is the failure the document epoch guards against, pinned as a test so the
    // reason the guard exists cannot be forgotten. Yjs cannot tell that identical
    // characters seeded by two different clientIDs are "the same" text.
    const fromServerA = new Y.Doc();
    fromServerA.getText("content").insert(0, "# Doc\n\nalpha\n");

    const fromServerB = new Y.Doc();
    fromServerB.getText("content").insert(0, "# Doc\n\nalpha\n");

    Y.applyUpdate(fromServerB, Y.encodeStateAsUpdate(fromServerA));

    expect(fromServerB.getText("content").toString()).toBe("# Doc\n\nalpha\n# Doc\n\nalpha\n");
  });

  it("a doc seeded once and synced normally does not duplicate", () => {
    const server = new Y.Doc();
    server.getText("content").insert(0, "# Doc\n\nalpha\n");

    // A client that takes the server's state rather than seeding its own.
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client, Y.encodeStateVector(server)));

    expect(client.getText("content").toString()).toBe("# Doc\n\nalpha\n");
    expect(server.getText("content").toString()).toBe("# Doc\n\nalpha\n");
  });
});

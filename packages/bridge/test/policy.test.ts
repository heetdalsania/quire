import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  AgentBudget,
  type Author,
  DEFAULT_POLICY,
  allRuns,
  insertAttributed,
  isRangeLocked,
  knownAuthors,
  lockedRanges,
  measureUpdate,
  readPolicy,
  registerAuthor,
  registerRun,
  runAt,
  sections,
  summarise,
  writePolicy,
} from "../src/index.js";

const human: Author = { id: "h1", name: "Heet", color: "#3b5bdb", kind: "human" };
const agent: Author = { id: "a1", name: "Claude", color: "#ea9d34", kind: "agent" };

function doc(initial = ""): { doc: Y.Doc; text: Y.Text } {
  const d = new Y.Doc();
  const text = d.getText("content");
  if (initial) text.insert(0, initial);
  return { doc: d, text };
}

describe("agent policy", () => {
  it("defaults to a far tighter delete budget than insert budget", () => {
    // Runaway deletion loses work; runaway insertion is noise that reverts cleanly.
    expect(DEFAULT_POLICY.maxDeletes).toBeLessThan(DEFAULT_POLICY.maxInserts);
  });

  it("round-trips through the document, so it travels with the file", () => {
    const { doc: d } = doc();
    writePolicy(d, { mode: "propose", maxDeletes: 50, lockedSections: ["Security"] });
    const read = readPolicy(d);
    expect(read.mode).toBe("propose");
    expect(read.maxDeletes).toBe(50);
    expect(read.lockedSections).toEqual(["Security"]);
  });
});

describe("budgets", () => {
  it("refuses deletions past the ceiling and does not charge for the refusal", () => {
    const budget = new AgentBudget({ ...DEFAULT_POLICY, maxDeletes: 100 });
    expect(budget.admit({ inserted: 0, deleted: 60 }).allowed).toBe(true);

    const refused = budget.admit({ inserted: 0, deleted: 60 });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("Deletion budget");
    // An agent that hit its ceiling should not also be billed for the attempt.
    expect(budget.spent.deleted).toBe(60);
    expect(budget.remaining.deleted).toBe(40);

    expect(budget.admit({ inserted: 0, deleted: 40 }).allowed).toBe(true);
  });

  it("refuses everything in read-only mode", () => {
    const budget = new AgentBudget({ ...DEFAULT_POLICY, mode: "read-only" });
    const verdict = budget.admit({ inserted: 1, deleted: 0 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("read-only");
  });

  it("measures a real Yjs update rather than trusting the sender", () => {
    const a = new Y.Doc();
    const text = a.getText("content");
    text.insert(0, "hello world");

    const insertUpdate = Y.encodeStateAsUpdate(a);
    expect(measureUpdate(insertUpdate).inserted).toBeGreaterThanOrEqual(11);

    const before = Y.encodeStateVector(a);
    text.delete(0, 6);
    expect(measureUpdate(Y.encodeStateAsUpdate(a, before)).deleted).toBeGreaterThanOrEqual(6);
  });

  it("treats an undecodable update as empty rather than throwing", () => {
    expect(measureUpdate(new Uint8Array([9, 9, 9, 9]))).toEqual({ inserted: 0, deleted: 0 });
  });
});

describe("locked sections", () => {
  const markdown = "# Title\n\nintro\n\n## Security\n\nDo not touch.\n\n## Notes\n\nfine\n";

  it("finds the sections a document has", () => {
    expect(sections(markdown).map((s) => s.heading)).toEqual(["Title", "Security", "Notes"]);
  });

  it("locks only the named section", () => {
    const locked = lockedRanges(markdown, ["Security"]);
    expect(locked).toHaveLength(1);
    expect(markdown.slice(locked[0]!.from, locked[0]!.to)).toContain("Do not touch");
  });

  it("detects an edit that overlaps a locked range", () => {
    const at = markdown.indexOf("Do not touch");
    expect(isRangeLocked(markdown, ["Security"], at, at + 5)?.heading).toBe("Security");
    const elsewhere = markdown.indexOf("fine");
    expect(isRangeLocked(markdown, ["Security"], elsewhere, elsewhere + 4)).toBeNull();
  });

  it("matches headings case-insensitively", () => {
    expect(isRangeLocked(markdown, ["security"], markdown.indexOf("Do not"), markdown.indexOf("Do not") + 3)).not.toBeNull();
  });
});

describe("provenance", () => {
  it("reports who actually wrote the document", () => {
    const { doc: d, text } = doc();
    registerAuthor(d, human);
    registerAuthor(d, agent);
    insertAttributed(text, 0, "0123456789", human); // 10 chars
    insertAttributed(text, text.length, "abcdefghij", agent); // 10 chars

    const summary = summarise(d, text, knownAuthors(d) as never);
    expect(summary.totalChars).toBe(20);
    expect(summary.humanShare).toBeCloseTo(0.5);
    expect(summary.agentShare).toBeCloseTo(0.5);
    expect(summary.unattributedShare).toBe(0);
  });

  it("counts text nobody claimed as unattributed rather than human", () => {
    // Pre-existing file content has no author, and pretending it is human would make the
    // whole measure a lie.
    const { doc: d, text } = doc("written before Quire ever saw it");
    const summary = summarise(d, text, knownAuthors(d) as never);
    expect(summary.unattributedShare).toBe(1);
    expect(summary.humanShare).toBe(0);
  });

  it("answers why a passage exists", () => {
    const { doc: d, text } = doc("Existing. ");
    const runId = registerRun(d, {
      id: "r1",
      authorId: agent.id,
      model: "claude-opus-5",
      prompt: "Tighten the retry policy",
      tool: "edit_document",
    });
    insertAttributed(text, text.length, "Retries are capped at five.", agent, { run: runId });

    const found = runAt(d, text, text.toString().indexOf("Retries"));
    expect(found?.run?.prompt).toBe("Tighten the retry policy");
    expect(found?.run?.model).toBe("claude-opus-5");
    expect(allRuns(d)).toHaveLength(1);
  });

  it("returns no origin for text written by hand", () => {
    const { doc: d, text } = doc("typed by a person");
    expect(runAt(d, text, 3)?.run).toBeNull();
  });
});

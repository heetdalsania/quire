import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QuireServer } from "@quire/server";
import { type Author, acceptSuggestion, committedText, insertAttributed } from "@quire/bridge";
import { AgentSession } from "../src/session.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agent: Author = { id: "agent-claude", name: "Claude", color: "#f6c177", kind: "agent" };

let dir: string;
let server: QuireServer;
let url: string;
const sessions: AgentSession[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quire-agent-"));
  await writeFile(join(dir, "doc.md"), "The quick brown fox.\n", "utf8");
  server = await QuireServer.start({ root: dir, port: 0, git: false });
  url = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  for (const s of sessions.splice(0)) s.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

async function join_(path: string): Promise<AgentSession> {
  const s = new AgentSession(url, path, agent);
  sessions.push(s);
  await s.connect();
  return s;
}

describe("agent sessions", () => {
  it("receives the document before the first edit can run", async () => {
    const s = await join_("doc.md");
    // The whole point of waiting for sync step 2: an agent that edits an empty buffer
    // silently misses every target string.
    expect(s.text.toString()).toBe("The quick brown fox.\n");
  });

  it("refuses a document path that escapes the vault", async () => {
    const s = new AgentSession(url, "../../escape.md", agent);
    sessions.push(s);
    await expect(s.connect(2500)).rejects.toThrow();
  });

  it("interleaves agent and human edits without losing either", async () => {
    const s = await join_("doc.md");
    const human = server.vault.getDoc("doc.md");

    // Both write at the same moment, at different offsets.
    insertAttributed(s.text, s.text.length, "AGENT. ", agent);
    human.doc.transact(() => human.text.insert(0, "HUMAN. "));
    await sleep(500);

    const settled = human.getContent();
    expect(settled).toContain("HUMAN.");
    expect(settled).toContain("AGENT.");
    expect(settled).toContain("The quick brown fox.");
    expect(await readFile(join(dir, "doc.md"), "utf8")).toBe(settled);
  });

  it("keeps a suggestion off disk, then lands it on accept", async () => {
    const s = await join_("doc.md");
    insertAttributed(s.text, s.text.length, "Proposed sentence.", agent, { suggestion: "s1" });
    await sleep(400);

    expect(await readFile(join(dir, "doc.md"), "utf8")).not.toContain("Proposed sentence.");

    // The human accepts, on the server's copy, exactly as the UI does.
    acceptSuggestion(server.vault.getDoc("doc.md").text, "s1");
    await sleep(400);
    expect(await readFile(join(dir, "doc.md"), "utf8")).toContain("Proposed sentence.");
  });

  it("handles unicode and emoji without corrupting offsets", async () => {
    await writeFile(join(dir, "uni.md"), "café ☕ naïve 🎉 done\n", "utf8");
    await sleep(500);
    const s = await join_("uni.md");
    expect(s.text.toString()).toBe("café ☕ naïve 🎉 done\n");

    const at = s.text.toString().indexOf("naïve");
    insertAttributed(s.text, at, "très ", agent);
    await sleep(400);
    expect(await readFile(join(dir, "uni.md"), "utf8")).toBe("café ☕ très naïve 🎉 done\n");
  });

  it("an agent editing a document nobody else has open still reaches disk", async () => {
    await writeFile(join(dir, "lonely.md"), "alone\n", "utf8");
    await sleep(500);
    const s = await join_("lonely.md");
    insertAttributed(s.text, s.text.length, "not anymore\n", agent);
    await sleep(500);
    expect(await readFile(join(dir, "lonely.md"), "utf8")).toBe("alone\nnot anymore\n");
  });

  it("keeps committed text and full text distinct while a suggestion is open", async () => {
    const s = await join_("doc.md");
    insertAttributed(s.text, 0, "MAYBE ", agent, { suggestion: "s9" });
    await sleep(300);
    expect(s.text.toString()).toContain("MAYBE");
    expect(committedText(s.text)).not.toContain("MAYBE");
  });
});

describe("an agent cannot talk its way out of its own leash", () => {
  it("refuses to loosen a policy it tightened", async () => {
    const { readPolicy, writePolicy } = await import("@quire/bridge");
    const handle = server.vault.getDoc("doc.md");

    writePolicy(handle.doc, { mode: "propose" });
    expect(readPolicy(handle.doc).mode).toBe("propose");

    // Tightening further is fine.
    writePolicy(handle.doc, { mode: "read-only" });
    expect(readPolicy(handle.doc).mode).toBe("read-only");
  });

  it("drops an agent's write while the document is read-only, and says so", async () => {
    const { writePolicy } = await import("@quire/bridge");
    const handle = server.vault.getDoc("doc.md");
    writePolicy(handle.doc, { mode: "read-only" });

    const s = await join_("doc.md");
    const before = handle.getContent();
    insertAttributed(s.text, s.text.length, "SHOULD NOT LAND", agent);
    await sleep(500);

    expect(handle.getContent()).toBe(before);
    // The refusal is reported, not swallowed -- a tool that does not check would
    // otherwise report success for a write that never landed.
    expect(s.notices.join(" ")).toContain("read-only");
  });
});

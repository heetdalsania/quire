import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocStore, insertAttributed, registerAuthor } from "@quire/bridge";
import { QuireServer } from "../src/index.js";

const agent = { id: "agent-1", name: "Claude", color: "#448899", kind: "agent" as const };
let dir: string;
let server: QuireServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quire-reverts-"));
  await writeFile(join(dir, "doc.md"), "Base\n");
  await writeFile(join(dir, "progress.md"), "# Progress\n\n## Iteration log\nold entry\n");
  server = await QuireServer.start({ root: dir, port: 0, git: false, appendOnlyLogs: ["progress.md"], agentActivityLog: "progress.md" });
  const handle = server.vault.getDoc("doc.md");
  registerAuthor(handle.doc, agent);
  insertAttributed(handle.text, handle.text.length, "Agent line\n", agent);
});
afterEach(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

async function request(action: "revert" | "restore", actor: string, field: Record<string, string>, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/reverts${token ? `?share=${token}` : ""}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, actor, doc: "doc.md", ...field }),
  });
}

describe("reversible applied agent edits", () => {
  it("requires edit permission and records self-reported actor in the append-only log", async () => {
    const view = server.shares.create({ role: "view", path: "doc.md" });
    expect((await request("revert", "Heet", { agentId: agent.id }, view.token)).status).toBe(403);
    const edit = server.shares.create({ role: "edit", path: "doc.md" });
    const response = await request("revert", "Heet", { agentId: agent.id }, edit.token);
    expect(response.status).toBe(200);
    const { record } = await response.json() as { record: { id: string; revertedBy: string } };
    expect(record.revertedBy).toBe("Heet");
    expect(server.vault.getDoc("doc.md").getContent()).toBe("Base\n");
    expect(server.vault.getDoc("progress.md").getContent()).toContain("Heet | REVERT");
    expect(server.vault.getDoc("progress.md").getContent()).toContain("old entry\n");
    expect(await new DocStore({ root: dir }).load("doc.md")).not.toBeNull();
    const restore = await request("restore", "Arun", { id: record.id }, edit.token);
    expect(restore.status).toBe(200);
    expect(server.vault.getDoc("doc.md").getContent()).toContain("Agent line");
    expect(server.vault.getDoc("progress.md").getContent()).toContain("Arun | RESTORE");
    expect((await request("restore", "Arun", { id: record.id }, edit.token)).status).toBe(400);
  });

  it("keeps restoration history after a server restart", async () => {
    const response = await request("revert", "Heet", { agentId: agent.id });
    expect(response.status).toBe(200);
    const { record } = await response.json() as { record: { id: string } };
    await server.close();
    server = await QuireServer.start({ root: dir, port: 0, git: false, appendOnlyLogs: ["progress.md"], agentActivityLog: "progress.md" });
    const history = await fetch(`http://127.0.0.1:${server.port}/api/reverts?doc=doc.md`);
    expect((await history.json() as { reverts: Array<{ id: string }> }).reverts[0]?.id).toBe(record.id);
    expect((await request("restore", "Heet", { id: record.id })).status).toBe(200);
    expect(server.vault.getDoc("doc.md").getContent()).toContain("Agent line");
  });
});

import { Server, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommentStore, pendingSuggestions } from "@quire/bridge";
import type { ConversationProvider } from "@quire/agent";
import { QuireServer } from "../src/server.js";
import { collectReceipt, renderReceipt } from "../src/receipt.js";

let root: string; let server: QuireServer; let provider: ConversationProvider;
const origin = { provider: "codex" as const, sessionId: "private-source", turnId: "delivery" };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quire-conversation-api-"));
  await writeFile(join(root, "report.md"), "Original report.");
  vi.spyOn(Server.prototype, "listen").mockImplementation(function(this: Server, ...args: any[]) {
    queueMicrotask(args.at(-1)); return this;
  });
  provider = { fork: vi.fn(async () => "private-child"), prompt: vi.fn(async () => "Reply") };
  server = await QuireServer.start({ root, port: 0, git: false, conversationProvider: provider });
});
afterEach(async () => { await server?.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
async function request(path: string, method = "GET", body?: unknown, options: { origin?: string; host?: string; remoteAddress?: string } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  Object.assign(req, { url: path, method, headers: { host: options.host ?? "127.0.0.1", ...(options.origin ? { origin: options.origin } : {}) }, socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" } });
  let code = 200; let response = ""; const headers: Record<string, string> = {};
  const res = { setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; }, writeHead: (status: number) => { code = status; }, end: (value: string) => { response = value; } };
  await (server as unknown as { onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> }).onRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { code, text: response, headers, json: () => JSON.parse(response) };
}
async function bind() {
  server.bindAtStartup({ doc: "report.md", origin, label: "Review" });
  await vi.waitFor(() => expect(server.conversations.status("report.md")?.state).toBe("connected"));
}
it("leaves a clean vault without conversation or collaboration state when persistence is disabled", async () => {
  await server.close();
  await rm(join(root, ".quire"), { recursive: true, force: true });
  server = await QuireServer.start({ root, port: 0, git: false, persist: false, conversationProvider: provider });
  await expect(stat(join(root, ".quire/conversations"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(root, ".quire"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(() => server.bindAtStartup({ doc: "report.md", origin })).toThrow(/requires persistent collaboration state/);
  expect(provider.fork).not.toHaveBeenCalled();
  await server.close();
  await expect(stat(join(root, ".quire/conversations"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(root, ".quire"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("still refuses existing bound conversations when persistence is disabled", async () => {
  await bind();
  await server.close();
  await expect(QuireServer.start({ root, port: 0, git: false, persist: false, conversationProvider: provider }))
    .rejects.toThrow(/Bound native conversations require persistent collaboration state/);
});
const comment = () => {
  const handle = server.vault.getDoc("report.md");
  return new CommentStore(handle.doc).add({ text: handle.text, from: 0, to: 8, authorId: "human", authorName: "Human", body: "Revise" });
};

it("binds server-side only and returns private-ID-free no-store status", async () => {
  expect((await request("/api/agent/conversation", "POST", { doc: "report.md", origin })).code).toBe(405);
  expect(provider.fork).not.toHaveBeenCalled();
  await bind();
  const response = await request("/api/agent/conversation?path=report.md");
  expect(response.code).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toMatchObject({ name: "Codex · Review", state: "connected" });
  expect(response.text).not.toMatch(/private-source|private-child|delivery|sessionId|origin/);
  expect(provider.prompt).not.toHaveBeenCalled();
});
it.each([
  { origin: "https://hostile.example" }, { host: "hostile.example" }, { remoteAddress: "192.0.2.1" },
])("refuses nonlocal or cross-origin conversation requests: %j", async options => {
  expect((await request("/api/agent/conversation?path=report.md", "GET", undefined, options)).code).toBe(403);
  expect((await request("/api/agent/conversation/decision", "POST", { doc: "report.md", id: "id", accepted: true }, options)).code).toBe(403);
});
it("rejects private paths, shared capabilities, malformed decisions and unknown routes", async () => {
  expect((await request("/api/agent/conversation?path=.quire/conversations/private.json")).code).toBe(400);
  expect((await request("/api/agent/conversation?path=report.md&share=token")).code).toBe(403);
  expect((await request("/api/agent/conversation/bind", "POST", {})).code).toBe(404);
  expect((await request("/api/agent/conversation/decision", "POST", { doc: "report.md", id: "id", accepted: "true" })).code).toBe(400);
  expect((await request("/api/agent/conversation/decision", "POST", "not-json")).code).toBe(400);
  expect((await request("/api/agent/conversation/retry")).code).toBe(405);
});
it.each(["command", "file", "tool"] as const)("requires a matching one-time %s approval and routes edits to suggestions", async kind => {
  vi.mocked(provider.prompt).mockImplementation(async (_session, _text, run) => {
    const accepted = await run.approve({ id: "approval", kind, detail: "Review this change" });
    if (accepted) {
      await run.tools!.setModel("fixture-model");
      const current = JSON.parse((await run.tools!.call("quire_read_artifact", {})).content[0]!.text);
      const proposal = await run.tools!.call("quire_propose_replacement", { revision: current.revision, old_text: "Original", new_text: "Reviewed", reason: "Clarify" });
      expect(proposal.isError).not.toBe(true);
    }
    return accepted ? "Proposed for review" : "Declined";
  });
  await bind(); comment();
  await vi.waitFor(() => expect(server.conversations.status("report.md")?.state).toBe("approval"));
  expect((await request("/api/agent/conversation/decision", "POST", { doc: "report.md", id: "stale", accepted: true })).code).toBe(400);
  expect((await request("/api/agent/conversation/decision", "POST", { doc: "report.md", id: "approval", accepted: true })).code).toBe(200);
  await vi.waitFor(() => expect(server.conversations.busy("report.md")).toBe(false));
  expect((await request("/api/agent/conversation/decision", "POST", { doc: "report.md", id: "approval", accepted: true })).code).toBe(400);
  expect(pendingSuggestions(server.vault.getDoc("report.md").text)).toHaveLength(1);
  const receipt = collectReceipt(server.vault.getDoc("report.md"));
  expect(JSON.stringify(receipt)).not.toMatch(/private-source|private-child/);
  expect(renderReceipt(receipt)).not.toMatch(/private-source|private-child/);
  expect(await readFile(join(root, "report.md"), "utf8")).toBe("Original report.");
  expect(provider.prompt).toHaveBeenCalledOnce();
});
it("restores rooms for bound documents at startup and accepts Disconnect", async () => {
  await bind(); comment(); await vi.waitFor(() => expect(provider.prompt).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(server.conversations.busy("report.md")).toBe(false));
  await server.close();
  server = await QuireServer.start({ root, port: 0, git: false, conversationProvider: provider });
  expect(server.rooms.has("report.md")).toBe(true);
  expect(provider.prompt).toHaveBeenCalledOnce();
  expect((await request("/api/agent/conversation/disconnect", "POST", { doc: "report.md" })).code).toBe(200);
  expect((await request("/api/agent/conversation?path=report.md")).json()).toBeNull();
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationTools } from "../src/conversation-provider.js";

const fixture = vi.hoisted(() => ({
  path: "", calls: [] as Array<{ method: string; params: any }>,
  source: [{ id: "delivery", status: "completed" }, { id: "later", status: "completed" }],
  child: [] as Array<{ id: string; status: string }>, badBoundary: false, badModel: false,
  callback: "", foreignTurn: false, closed: vi.fn(), revoked: vi.fn(),
}));
vi.mock("../src/conversation-mcp.js", () => ({ ConversationMcp: { start: vi.fn(async (tools: ConversationTools) => ({
  config: { url: "http://127.0.0.1:12345/mcp", http_headers: { Authorization: "Bearer test-only" } },
  close: async () => { tools.close(); fixture.revoked(); },
})) } }));
vi.mock("../src/native-rpc.js", () => ({ NativeRpc: class {
  requestHandler: (message: any) => Promise<any> = async () => { throw new Error("Unsupported request"); };
  listeners = new Set<(message: any) => void>();
  configuration: any = {};
  async initialize() {}
  async close() { fixture.closed(); }
  subscribe(listener: (message: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(method: string, params: any) { for (const listener of this.listeners) listener({ method, params }); }
  async request(method: string, params: any) {
    fixture.calls.push({ method, params });
    if (method === "thread/read") return { thread: { id: params.threadId, path: fixture.path, turns: params.threadId === "source-session" ? fixture.source : fixture.child } };
    if (method === "thread/fork") {
      fixture.child = fixture.source.slice(0, fixture.badBoundary ? 2 : 1).map(turn => ({ ...turn }));
      return { thread: { id: "child-session", forkedFromId: params.threadId }, model: params.model, modelProvider: params.modelProvider };
    }
    if (method === "thread/resume") {
      this.configuration = params.config;
      return { thread: { id: params.threadId, turns: fixture.child }, model: fixture.badModel ? "wrong-model" : params.model, modelProvider: params.modelProvider };
    }
    if (method === "mcpServerStatus/list") return { data: Object.keys(this.configuration).filter(key => key.startsWith("mcp_servers.")).map(key => ({
      name: key.slice("mcp_servers.".length), runtimeStatus: "connected", tools: { quire_read_artifact: {}, quire_propose_replacement: {} },
    })) };
    if (method === "turn/start") {
      let answer = "Answer";
      if (fixture.callback) {
        if (fixture.callback === "item/fileChange/requestApproval") this.emit("item/started", { threadId: "child-session", item: { id: "file", type: "fileChange", changes: [{ path: "report.md", diff: "-old\n+new" }] } });
        try { answer = (await this.requestHandler({ id: "wire-id", method: fixture.callback, params: { threadId: "child-session", itemId: "file", command: "git diff" } })).decision; }
        catch { answer = "Denied unsupported callback"; }
      }
      if (fixture.foreignTurn) {
        this.emit("item/completed", { threadId: "child-session", turnId: "another-turn", item: { id: "foreign", type: "agentMessage", text: "Not this comment" } });
        this.emit("turn/completed", { threadId: "child-session", turn: { id: "another-turn", status: "completed" } });
      }
      this.emit("item/completed", { threadId: "child-session", turnId: "turn", item: { id: "reply", type: "agentMessage", text: answer } });
      this.emit("turn/completed", { threadId: "child-session", turn: { id: "turn", status: "completed" } });
      return { turn: { id: "turn" } };
    }
    throw new Error(`Unexpected method: ${method}`);
  }
} }));
import { CodexConversationProvider } from "../src/codex-conversation.js";

let root: string;
const origin = { provider: "codex" as const, sessionId: "source-session", turnId: "delivery" };
beforeEach(async () => {
  vi.clearAllMocks(); fixture.calls = []; fixture.child = []; fixture.badBoundary = false; fixture.badModel = false; fixture.callback = ""; fixture.foreignTurn = false;
  fixture.source = [{ id: "delivery", status: "completed" }, { id: "later", status: "completed" }];
  root = await mkdtemp(join(tmpdir(), "quire-codex-contract-")); fixture.path = join(root, "source.jsonl");
  await writeFile(fixture.path, [
    { type: "session_meta", payload: { id: origin.sessionId, model_provider: "fixture" } },
    { type: "turn_context", payload: { turn_id: "delivery", model: "delivery-model", effort: "high" } },
  ].map(row => JSON.stringify(row)).join("\n"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const tools = (): ConversationTools => ({ definitions: ["quire_read_artifact", "quire_propose_replacement"].map(name => ({
  name, description: name, inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
})), call: vi.fn(), setModel: vi.fn(), close: vi.fn() });

it("forks exactly the completed turn without a model call or mutation of the source", async () => {
  const before = await readFile(fixture.path, "utf8"); const source = structuredClone(fixture.source);
  expect(await new CodexConversationProvider(root).fork(origin, AbortSignal.timeout(1000))).toBe("child-session");
  expect(fixture.child).toEqual([source[0]]);
  expect(fixture.source).toEqual(source); expect(await readFile(fixture.path, "utf8")).toBe(before);
  expect(fixture.calls.map(call => call.method)).toEqual(["thread/read", "thread/read", "thread/fork", "thread/read"]);
  expect(fixture.calls.find(call => call.method === "thread/fork")!.params).toMatchObject({ threadId: origin.sessionId, lastTurnId: "delivery", model: "delivery-model", modelProvider: "fixture" });
  expect(fixture.closed).toHaveBeenCalledOnce();
});
it("rejects a fork that includes later turns", async () => {
  fixture.badBoundary = true;
  await expect(new CodexConversationProvider(root).fork(origin, AbortSignal.timeout(1000))).rejects.toThrow(/exactly/);
  expect(fixture.calls.some(call => call.method === "turn/start")).toBe(false);
});
it("refuses an incomplete delivery before forking", async () => {
  fixture.source[0]!.status = "inProgress";
  await expect(new CodexConversationProvider(root).fork(origin, AbortSignal.timeout(1000))).rejects.toThrow(/completed/);
  expect(fixture.calls.some(call => call.method === "thread/fork")).toBe(false);
});
it("refuses a model mismatch before starting and revokes the tools", async () => {
  fixture.badModel = true; const toolset = tools();
  await expect(new CodexConversationProvider(root).prompt("child-session", "Question", { origin, signal: AbortSignal.timeout(1000), approve: vi.fn(), tools: toolset })).rejects.toThrow(/model/);
  expect(fixture.calls.some(call => call.method === "turn/start")).toBe(false);
  expect(toolset.close).toHaveBeenCalled();
});
it("correlates fast completion events with the exact started turn", async () => {
  fixture.foreignTurn = true;
  expect(await new CodexConversationProvider(root).prompt("child-session", "Question", { origin, signal: AbortSignal.timeout(1000), approve: vi.fn(), tools: tools() })).toBe("Answer");
});
it.each(["item/tool/requestUserInput", "item/permissions/requestApproval"])("fails closed on unsupported callback %s", async callback => {
  fixture.callback = callback; const approve = vi.fn(); const toolset = tools();
  await expect(new CodexConversationProvider(root).prompt("child-session", "Question", { origin, signal: AbortSignal.timeout(1000), approve, tools: toolset })).rejects.toThrow(/unsupported/);
  expect(approve).not.toHaveBeenCalled(); expect(toolset.close).toHaveBeenCalled();
});
it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])("uses one-time decisions for %s", async callback => {
  fixture.callback = callback; const approve = vi.fn(async () => true); const toolset = tools();
  expect(await new CodexConversationProvider(root).prompt("child-session", "Question", { origin, signal: AbortSignal.timeout(1000), approve, tools: toolset })).toBe("accept");
  expect(approve).toHaveBeenCalledOnce(); expect(fixture.revoked).toHaveBeenCalledOnce();
  expect(toolset.setModel).toHaveBeenCalledWith("delivery-model");
  const resume = fixture.calls.find(call => call.method === "thread/resume")!.params;
  expect(resume).not.toHaveProperty("approvalPolicy"); expect(resume).not.toHaveProperty("sandbox");
  expect(fixture.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
});

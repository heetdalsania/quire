import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexConversationProvider } from "../src/codex-conversation.js";

let root: string; let script: string;
const origin = { provider: "codex" as const, sessionId: "parent", turnId: "delivery" };
const inherited = { model: "fixture-native", modelProvider: "fixture", config: { model_reasoning_effort: "high" } };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quire-codex-rpc-")); script = join(root, "app-server.mjs");
  await writeFile(join(root, "rollout.jsonl"), [
    { type: "session_meta", payload: { id: "parent", model_provider: "fixture" } },
    { type: "turn_context", payload: { turn_id: "delivery", model: "fixture-native", effort: "high" } },
  ].map(row => JSON.stringify(row)).join("\n"));
  await writeFile(script, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const emit = (method, params) => send({method, params});
let mode = ''; let configuration = {};
function finish(text) {
  emit('item/completed', {threadId:'child', turnId:'new-turn', item:{id:'answer',type:'agentMessage',phase:'final_answer',text}});
  emit('turn/completed', {threadId:'child', turn:{id:'new-turn',status:'completed'}});
}
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line); appendFileSync('calls.jsonl', line + '\\n');
  if (m.method === 'initialize') send({id:m.id,result:{}});
  else if (m.method === 'thread/read') send({id:m.id,result:{thread:{id:m.params.threadId,path:${JSON.stringify(join(root, "rollout.jsonl"))},turns:[{id:'delivery',status:m.params.threadId==='active'?'inProgress':'completed'}]}}});
  else if (m.method === 'thread/fork') send({id:m.id,result:{thread:{id:'child',forkedFromId:m.params.threadId},model:m.params.model,modelProvider:m.params.modelProvider}});
  else if (m.method === 'thread/resume') { configuration=m.params.config || {}; send({id:m.id,result:{thread:{id:m.params.threadId,turns:[]},model:m.params.threadId==='wrong-model'?'global-default':m.params.model,modelProvider:m.params.modelProvider}}); }
  else if (m.method === 'mcpServerStatus/list') send({id:m.id,result:{data:Object.keys(configuration).map(key=>({name:key.slice('mcp_servers.'.length),runtimeStatus:m.params.threadId==='missing-tools'?'failed':'connected',tools:{fixture_tool:{name:'fixture_tool'}}}))}});
  else if (m.method === 'turn/start') {
    mode = m.params.input[0].text;
    if (mode === 'crash') { process.exit(2); return; }
    if (mode === 'wait') return;
    if (mode === 'command') send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'child',itemId:'cmd',command:'git diff',cwd:'/workspace',reason:'Review changes'}});
    else if (mode === 'file') {
      emit('item/started', {threadId:'child',turnId:'new-turn',item:{id:'file',type:'fileChange',changes:[{path:'report.md',diff:'-old\\n+new'}]}});
      send({id:'approval',method:'item/fileChange/requestApproval',params:{threadId:'child',itemId:'file',reason:'Update report'}});
    } else if (mode === 'question') send({id:'approval',method:'item/tool/requestUserInput',params:{threadId:'child'}});
    else finish('History retained: sentinel');
    send({id:m.id,result:{turn:{id:'new-turn'}}});
  } else if (m.id === 'approval') finish(m.error ? 'Unsupported' : m.result.decision);
});
`);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const provider = () => new CodexConversationProvider(root, process.execPath, [script]);
const calls = async () => (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));

describe("Codex native protocol adapter", () => {
  it("pins the fork boundary, resumes only the child, and handles events preceding the turn response", async () => {
    const p = provider(); const signal = AbortSignal.timeout(5000);
    const child = await p.fork({ provider: "codex", sessionId: "parent", turnId: "delivery" }, signal);
    expect(child).toBe("child");
    expect(await p.prompt(child, "question-free prompt", { origin, signal, approve: async () => false })).toBe("History retained: sentinel");
    const log = await calls();
    expect(log.find(m => m.method === "thread/fork").params).toEqual({ threadId: "parent", lastTurnId: "delivery", ...inherited });
    expect(log.find(m => m.method === "thread/resume").params).toEqual({ threadId: "child", ...inherited });
    expect(log.find(m => m.method === "turn/start").params).not.toHaveProperty("model");
    expect(log.find(m => m.method === "turn/start").params).not.toHaveProperty("approvalPolicy");
  });
  it("refuses an incomplete delivery turn without making a fork", async () => {
    await expect(provider().fork({ provider: "codex", sessionId: "active", turnId: "delivery" }, AbortSignal.timeout(5000))).rejects.toThrow(/completed/);
    expect((await calls()).some(m => m.method === "thread/fork")).toBe(false);
  });
  it.each(["command", "file"])("relays reviewable %s requests and never grants session-wide approval", async mode => {
    const approve = vi.fn(async () => true);
    expect(await provider().prompt("child", mode, { origin, signal: AbortSignal.timeout(5000), approve })).toBe("accept");
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ kind: mode, detail: expect.stringContaining(mode === "file" ? "+new" : "git diff") }));
    expect((await calls()).find(m => m.id === "approval").result).toEqual({ decision: "accept" });
  });
  it("fails closed on unsupported interactive requests", async () => {
    const approve = vi.fn(async () => true);
    await expect(provider().prompt("child", "question", { origin, signal: AbortSignal.timeout(5000), approve })).rejects.toThrow(/native|unsupported/);
    expect(approve).not.toHaveBeenCalled();
    expect((await calls()).find(m => m.id === "approval").error.code).toBe(-32601);
  });
  it("attaches ephemeral tools without replacing model or permissions and revokes them at turn end", async () => {
    const toolset = { definitions: [{ name: "fixture_tool", description: "Fixture", inputSchema: { type: "object" as const, properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }], call: async () => ({ content: [{ type: "text" as const, text: "ok" }] }), setModel: vi.fn(), close: vi.fn() };
    await provider().prompt("child", "answer", { origin, signal: AbortSignal.timeout(5000), approve: async () => false, tools: toolset });
    const log = await calls(); const resume = log.find(m => m.method === "thread/resume").params;
    expect(resume).toMatchObject({ model: inherited.model, modelProvider: inherited.modelProvider, config: inherited.config });
    expect(resume).not.toHaveProperty("approvalPolicy"); expect(resume).not.toHaveProperty("sandbox");
    const key = Object.keys(resume.config).find(key => key.startsWith("mcp_servers."))!;
    expect(key).toMatch(/^mcp_servers\.quire_artifact_/);
    const configuration = resume.config[key];
    expect(configuration.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(log.findIndex(m => m.method === "mcpServerStatus/list")).toBeLessThan(log.findIndex(m => m.method === "turn/start"));
    expect(toolset.setModel).toHaveBeenCalledWith("fixture-native");
    expect(toolset.close).toHaveBeenCalled();
    await expect(fetch(configuration.url, { headers: configuration.http_headers })).rejects.toThrow();
  });
  it("does not start a model turn when required artifact tools failed to connect", async () => {
    const toolset = { definitions: [], call: async () => ({ content: [] }), setModel: vi.fn(), close: vi.fn() };
    await expect(provider().prompt("missing-tools", "answer", { origin, signal: AbortSignal.timeout(5000), approve: async () => false, tools: toolset })).rejects.toThrow(/editing tools/);
    expect((await calls()).some(m => m.method === "turn/start")).toBe(false);
    expect(toolset.close).toHaveBeenCalled();
  });
  it("contains process failure and cancellation", async () => {
    await expect(provider().prompt("child", "crash", { origin, signal: AbortSignal.timeout(5000), approve: async () => false })).rejects.toThrow(/exited/);
    await expect(provider().prompt("child", "wait", { origin, signal: AbortSignal.timeout(100), approve: async () => false })).rejects.toThrow(/cancelled/);
  });
  it("refuses missing native metadata or a different restored model before starting a turn", async () => {
    await expect(provider().prompt("wrong-model", "answer", { origin, signal: AbortSignal.timeout(5000), approve: async () => false })).rejects.toThrow(/restore.*model/);
    await writeFile(join(root, "rollout.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "parent", model_provider: "fixture" } }));
    await expect(provider().fork(origin, AbortSignal.timeout(5000))).rejects.toThrow(/exact delivery model/);
    expect((await calls()).some(m => m.method === "turn/start" || m.method === "thread/fork")).toBe(false);
  });
});

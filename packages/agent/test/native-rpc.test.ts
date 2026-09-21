import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeRpc } from "../src/native-rpc.js";
import { CodexConversationProvider } from "../src/codex-conversation.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...original, spawn: vi.fn(original.spawn), execFile: Object.assign(vi.fn(original.execFile), {
    [promisify.custom]: vi.fn(promisify(original.execFile)),
  }) };
});

let root: string;
let rpc: NativeRpc | undefined;
const pids: number[] = [];
const execute = promisify(execFile);
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "quire-native-shutdown-")); });
afterEach(async () => {
  try { await rpc?.close(); }
  finally {
    rpc = undefined;
    vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); vi.mocked(execute).mockReset();
    for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already reaped */ } }
    await rm(root, { recursive: true, force: true });
  }
});
it.skipIf(process.platform === "win32").each([false, true])("bounds cleanup when exit is observed=%s but termination never completes", async observed => {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
  vi.mocked(execute).mockResolvedValue({ stdout: `${child.pid} 1 ${child.pid} S\n`, stderr: "" });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  rpc = new NativeRpc("fixture", [], root, new AbortController().signal, "Fixture", { graceMs: 0, timeoutMs: 100 });
  if (observed) child.emit("close");
  const started = Date.now();
  const closed = rpc.close();
  expect(rpc.close()).toBe(closed);
  await closed;
  expect(Date.now() - started).toBeLessThan(1000);
  expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  expect(kill.mock.calls.filter(call => call[1] === 0).length).toBeGreaterThanOrEqual(observed ? 3 : 2);
  expect(child.stdin.destroyed).toBe(true);
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
  expect(child.unref).toHaveBeenCalledTimes(1);
}, 2000);
async function running(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "win32") return true;
  // An orphan can remain a zombie until the CI host's init reaps it.
  const { stdout } = await execute("ps", ["-eo", "pid=,stat="]);
  return stdout.trim().split("\n").some(line => {
    const [id, state] = line.trim().split(/\s+/);
    return Number(id) === pid && state && !state.startsWith("Z");
  });
}

it.each([false, true])("waits for a stubborn descendant after its leader exits (detached=%s)", async detached => {
  await writeFile(join(root, "worker.mjs"), `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync('worker.pid', String(process.pid));
setInterval(() => writeFileSync('progress', String(Date.now())), 20);
`);
  const script = join(root, "leader.mjs");
  await writeFile(script, `
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
spawn(process.execPath, ['worker.mjs'], { stdio: 'ignore', detached: ${detached} });
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const timer = setInterval(() => {
      if (!existsSync('worker.pid')) return;
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
    }, 10);
  }
});
`);
  rpc = new NativeRpc(process.execPath, [script], root, new AbortController().signal);
  await rpc.initialize();
  const pid = Number(await readFile(join(root, "worker.pid"), "utf8")); pids.push(pid);
  expect(await running(pid)).toBe(true);
  const closed = rpc.close();
  expect(rpc.close()).toBe(closed);
  await closed;
  expect(await running(pid)).toBe(false);
});

it.skipIf(process.platform === "win32")("does not settle a cancelled provider turn until its native process stops", async () => {
  const script = join(root, "native.mjs");
  await writeFile(join(root, "rollout.jsonl"), [
    { type: "session_meta", payload: { id: "parent", model_provider: "fixture" } },
    { type: "turn_context", payload: { turn_id: "delivery", model: "fixture-native" } },
  ].map(row => JSON.stringify(row)).join("\n"));
  await writeFile(script, `
import { createInterface } from 'node:readline';
process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 250); });
setInterval(() => {}, 1000);
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/read') send({id:message.id,result:{thread:{id:'parent',path:${JSON.stringify(join(root, "rollout.jsonl"))},turns:[{id:'delivery',status:'completed'}]}}});
  if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'child', turns: [] }, model:'fixture-native',modelProvider:'fixture' } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn' } } });
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'child', command: String(process.pid) } });
  }
});
`);
  let ready!: (pid: number) => void;
  const started = new Promise<number>(resolve => { ready = resolve; });
  const controller = new AbortController();
  const work = new CodexConversationProvider(root, process.execPath, [script]).prompt("child", "Wait", {
    origin: { provider: "codex", sessionId: "parent", turnId: "delivery" },
    signal: controller.signal, approve: async request => { ready(Number(request.detail)); return false; },
  });
  const checked = expect(work).rejects.toThrow(/cancelled/);
  const pid = await started; pids.push(pid);
  controller.abort(); await checked;
  expect(await running(pid)).toBe(false);
});

it("settles cleanup when the native executable cannot be spawned", async () => {
  rpc = new NativeRpc(join(root, "missing-executable"), [], root, new AbortController().signal);
  await expect(rpc.initialize()).rejects.toThrow(/Unable to start/);
  await rpc.close();
});

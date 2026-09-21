import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
const execute = promisify(execFile);
const SHUTDOWN_TIMEOUT_MS = 5000;
type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: { code?: number; message: string } };
type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Small stdio JSON-RPC client. No shell interpolation or global agent configuration. */
export class NativeRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(message: Message) => void>();
  private sequence = 0;
  private buffer = "";
  private ended: Error | null = null;
  private closing: Promise<void> | null = null;
  private readonly exited: Promise<void>;
  requestHandler: (message: Message) => Promise<unknown> = async () => { throw new Error("Unsupported agent request"); };
  constructor(command: string, args: string[], cwd: string, private readonly signal: AbortSignal, private readonly label = "Codex",
    private readonly shutdown: { graceMs?: number; timeoutMs?: number } = {}) {
    signal.throwIfAborted();
    this.child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.exited = new Promise(resolve => this.child.once("close", () => resolve()));
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) return this.stop(new Error(`${this.label} response exceeded 32 MiB`));
      let end: number;
      while ((end = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch { this.stop(new Error(`Invalid JSON from ${this.label} native runtime`)); return; }
      }
    });
    // Drain stderr without leaking native session contents into HTTP errors.
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.stop(new Error(`${this.label} input closed`)));
    this.child.on("error", error => this.stop(new Error(`Unable to start ${this.label}: ${error.message}`)));
    this.child.on("exit", code => this.stop(new Error(`${this.label} native runtime exited (${code ?? "signal"})`)));
    signal.addEventListener("abort", this.abort, { once: true });
  }
  private readonly abort = (): void => this.stop(new Error(`${this.label} conversation cancelled`));
  // Event handlers initiate shutdown; providers await the same promise in finally.
  private stop(error: Error): void { void this.close(error).catch(() => {}); }
  private send(message: Message): void {
    if (this.ended) throw this.ended;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private receive(message: Message): void {
    if (message.method && message.id !== undefined) {
      void this.requestHandler(message).then(
        result => { if (!this.ended) this.send({ id: message.id!, result }); },
        error => {
          if (!this.ended) this.send({ id: message.id!, error: { code: -32601, message: error instanceof Error ? error.message : "Unsupported request" } });
          this.stop(error instanceof Error ? error : new Error("Unsupported request"));
        },
      );
    } else if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id)); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    } else for (const listener of this.listeners) listener(message);
  }
  request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    if (this.ended) return Promise.reject(this.ended);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.label} ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  subscribe(listener: (message: Message) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "quire", version: "0.2.0" }, capabilities: null });
    this.send({ method: "initialized" });
  }
  close(error = new Error(`${this.label} connection closed`)): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve().then(() => this.terminate());
    this.ended = error;
    this.signal.removeEventListener("abort", this.abort);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: "quire/disconnected", params: { error } });
    this.listeners.clear();
    return this.closing;
  }
  private async finishTermination(cleanup: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const fallback = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
        this.child.unref();
        resolve();
      }, this.shutdown.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    });
    try { await Promise.race([cleanup(controller.signal), fallback]); }
    finally { clearTimeout(timer!); }
  }
  private async terminate(): Promise<void> {
    const pid = this.child.pid;
    if (!pid) { this.child.stdin.destroy(); await this.finishTermination(() => this.exited); return; }
    if (process.platform === "win32") {
      // Kill the tree before killing its root, while taskkill can still find it.
      try { await execute("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 10_000 }); }
      catch (error) { if (this.child.exitCode === null && this.child.signalCode === null) throw error; }
      this.child.stdin.destroy();
      await this.finishTermination(() => this.exited); return;
    }
    const exists = (target: number) => {
      try { process.kill(target, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
        throw error;
      }
    };
    const descendants = new Set<number>([pid]);
    const running = async () => {
      const { stdout } = await execute("ps", ["-eo", "pid=,ppid=,pgid=,stat="], { timeout: 5000 });
      const processes = stdout.trim().split("\n").map(line => {
        const [id, parent, group, state] = line.trim().split(/\s+/);
        return { id: Number(id), parent: Number(parent), group: Number(group), state };
      });
      // Capture descendants before their parent exits and they are reparented.
      // Native tools may create their own process groups.
      let size: number;
      do {
        size = descendants.size;
        for (const child of processes) {
          if (child.group === pid || descendants.has(child.parent)) descendants.add(child.id);
        }
      } while (descendants.size !== size);
      return processes.filter(child => descendants.has(child.id) && child.state && !child.state.startsWith("Z"));
    };
    const terminateTree = async (signal: NodeJS.Signals, stop?: AbortSignal) => {
      const processes = await running();
      if (stop?.aborted) return;
      try { process.kill(-pid, signal); }
      catch (error) {
        // macOS can report EPERM for a group containing only orphan zombies.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && !(code === "EPERM" && !(await running()).some(child => child.group === pid))) throw error;
      }
      for (const child of processes) {
        if (stop?.aborted) return;
        if (child.group === pid) continue;
        try { process.kill(child.id, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    };
    await terminateTree("SIGTERM");
    this.child.stdin.destroy();
    const deadline = Date.now() + (this.shutdown.graceMs ?? 1500);
    const treeExists = () => exists(-pid) || [...descendants].some(id => exists(id));
    // A leader's exit does not mean its descendants have finished.
    while (treeExists() && Date.now() < deadline) await delay(25);
    await this.finishTermination(async signal => {
      if (treeExists()) await terminateTree("SIGKILL", signal);
      await this.exited;
      // Orphan zombies may await init's reaper, but cannot execute further work.
      while (!signal.aborted && treeExists() && (await running()).length) {
        if (signal.aborted) return;
        await delay(25);
      }
    });
  }
}

import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateFileName } from "@quire/bridge";
import { parseOrigin, type ConversationOrigin } from "./conversation-provider.js";

export interface Receipt {
  threadId: string;
  revision: string;
  state: "baseline" | "dispatched" | "completed";
  model: string | null;
}
export interface Binding {
  doc: string;
  origin: ConversationOrigin;
  sessionId: string;
  authorId: string;
  label: string | null;
  createdAt: string;
  receipts: Receipt[];
  active: string | null;
  error: "uncertain" | "deleted" | "renamed" | null;
}
const MAX_STORE = 8 * 1024 * 1024;
export const bindingFileName = (doc: string): string => stateFileName(doc).replace(/\.bin$/, ".json");

export class BindingStore {
  private writes: Promise<unknown> = Promise.resolve();
  private saved = new Set<string>();
  constructor(private readonly root: string) {}
  private async directory(): Promise<string> {
    let directory = await realpath(this.root);
    for (const part of [".quire", "conversations"]) {
      directory = join(directory, part);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (await realpath(directory) !== directory) throw new Error("Conversation directory must not be a symlink");
      if (process.platform !== "win32") {
        const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.chmod(0o700); } finally { await handle.close(); }
      }
    }
    return directory;
  }
  async load(): Promise<Binding[]> {
    const directory = await this.directory();
    const entries: Binding[] = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".json")) continue;
      if (await realpath(join(directory, name)) !== join(directory, name)) throw new Error("Conversation file must not be a symlink");
      const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: any;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_STORE) throw new Error("Invalid conversation state size");
        await file.chmod(0o600);
        try { data = JSON.parse(await file.readFile("utf8")); }
        catch { throw new Error("Invalid conversation state"); }
      } finally { await file.close(); }
      const origin = parseOrigin(data.origin);
      if (data.version !== 1 || typeof data.doc !== "string" || bindingFileName(data.doc) !== name ||
        typeof data.sessionId !== "string" || !/^[\w-]{1,160}$/.test(data.sessionId) || data.sessionId === origin.sessionId ||
        typeof data.authorId !== "string" || !/^agent-native-[a-f0-9]{16}$/.test(data.authorId) ||
        !(data.label === null || (typeof data.label === "string" && data.label.length <= 80)) ||
        typeof data.createdAt !== "string" || !(data.active === null || typeof data.active === "string") ||
        ![null, "uncertain", "deleted", "renamed"].includes(data.error) || !Array.isArray(data.receipts) ||
        data.receipts.some((receipt: any) => !receipt || typeof receipt.threadId !== "string" ||
          typeof receipt.revision !== "string" || !/^[a-f0-9]{64}$/.test(receipt.revision) ||
          !["baseline", "dispatched", "completed"].includes(receipt.state) ||
          !(receipt.model === null || typeof receipt.model === "string"))) throw new Error("Invalid conversation binding");
      const receipts = data.receipts.map((receipt: Receipt) => ({ threadId: receipt.threadId, revision: receipt.revision, state: receipt.state, model: receipt.model }));
      if ([origin.sessionId, data.sessionId].some(id => JSON.stringify({ label: data.label, receipts, authorId: data.authorId }).includes(id))) throw new Error("Private identifiers in conversation metadata");
      entries.push({ doc: data.doc, origin, sessionId: data.sessionId, authorId: data.authorId, label: data.label,
        createdAt: data.createdAt, receipts, active: data.active, error: data.active ? "uncertain" : data.error });
      this.saved.add(name);
    }
    return entries;
  }
  save(bindings: Binding[]): Promise<void> {
    const snapshots = bindings.map(binding => ({ name: bindingFileName(binding.doc), data: JSON.stringify({ version: 1, ...binding }, null, 2) }));
    const operation = this.writes.then(async () => {
      const directory = await this.directory();
      for (const { name, data } of snapshots) {
        if (Buffer.byteLength(data) > MAX_STORE) throw new Error("Conversation state is too large");
        const temporary = join(directory, `${name}-${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try { await file.writeFile(`${data}\n`); await file.sync(); } finally { await file.close(); }
          await rename(temporary, join(directory, name));
          this.saved.add(name);
        } finally { await rm(temporary, { force: true }); }
      }
      const keep = new Set(snapshots.map(snapshot => snapshot.name));
      for (const name of this.saved) {
        if (!keep.has(name)) { await rm(join(directory, name), { force: true }); this.saved.delete(name); }
      }
      if (process.platform !== "win32") {
        const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
      }
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  async close(): Promise<void> { await this.writes; }
}

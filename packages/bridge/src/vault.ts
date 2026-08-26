import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import { DISK_ORIGIN, DocHandle } from "./doc-handle.js";

export interface VaultOptions {
  root: string;
  /** File extensions treated as documents. Everything else is ignored. */
  extensions?: string[];
  /** Coalesce rapid CRDT changes before touching disk. */
  writeDebounceMs?: number;
  /** How long a file must stop changing before we read it (handles save-per-keystroke editors). */
  stabilityThresholdMs?: number;
  /** Window in which an unlink+add pair with identical content is treated as a rename. */
  renameGraceMs?: number;
  /** Files larger than this are skipped rather than loaded into memory. */
  maxFileBytes?: number;
}

interface PendingUnlink {
  handle: DocHandle;
  content: string;
  timer: NodeJS.Timeout;
}

interface RecentAdd {
  content: string;
  timer: NodeJS.Timeout;
}

const DEFAULTS = {
  extensions: [".md", ".markdown"],
  writeDebounceMs: 40,
  stabilityThresholdMs: 60,
  renameGraceMs: 300,
  maxFileBytes: 8 * 1024 * 1024,
};

const TMP_PREFIX = ".quire-tmp-";
let tmpCounter = 0;

/**
 * Keeps a directory of Markdown files bidirectionally in sync with a set of Yjs documents.
 *
 * Invariants:
 *  - The Y.Doc is live truth; the file is a continuously-maintained projection of it.
 *  - Disk changes are merged as CRDT deltas, never as wholesale overwrites.
 *  - Writes triggered by disk-originated updates are suppressed by transaction origin,
 *    which is what prevents a watcher feedback loop.
 */
export class Vault extends EventEmitter {
  readonly root: string;
  private readonly opts: Required<Omit<VaultOptions, "root">>;
  private readonly handles = new Map<string, DocHandle>();
  private readonly writeTimers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pendingUnlinks = new Map<string, PendingUnlink>();
  /**
   * Files that appeared very recently. A rename surfaces as an unlink/add pair, but the
   * OS gives no ordering guarantee between the two, so we have to be able to stitch the
   * pair together from whichever half arrives second.
   */
  private readonly recentAdds = new Map<string, RecentAdd>();
  private watcher: FSWatcher | null = null;
  private closed = false;

  private constructor(options: VaultOptions) {
    super();
    this.root = options.root;
    this.opts = {
      extensions: options.extensions ?? DEFAULTS.extensions,
      writeDebounceMs: options.writeDebounceMs ?? DEFAULTS.writeDebounceMs,
      stabilityThresholdMs: options.stabilityThresholdMs ?? DEFAULTS.stabilityThresholdMs,
      renameGraceMs: options.renameGraceMs ?? DEFAULTS.renameGraceMs,
      maxFileBytes: options.maxFileBytes ?? DEFAULTS.maxFileBytes,
    };
  }

  static async open(options: VaultOptions): Promise<Vault> {
    const vault = new Vault(options);
    await mkdir(vault.root, { recursive: true });
    // Index everything that already exists BEFORE the vault is handed out. chokidar's
    // "ready" fires before awaitWriteFinish-delayed "add" events, so relying on the
    // watcher for the initial load lets getDoc() mint an empty handle for a file that
    // already has content -- and the first edit then writes that empty doc over it.
    await vault.scanInitial();
    await vault.startWatching();
    return vault;
  }

  /** Load every existing document synchronously, before any caller can touch the vault. */
  private async scanInitial(): Promise<void> {
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(TMP_PREFIX)) continue;

      const absPath = join(entry.parentPath, entry.name);
      const relPath = this.toRel(absPath);
      if (!relPath || !this.isDocument(relPath)) continue;
      if (relPath.split("/").some((part) => part === ".git" || part === "node_modules")) continue;

      const content = await this.readDoc(absPath, relPath);
      if (content === null) continue;

      const handle = new DocHandle(relPath);
      handle.initFromDisk(content);
      this.bind(handle);
      this.handles.set(relPath, handle);
    }
  }

  // ---------------------------------------------------------------- public API

  /**
   * Get (or lazily create) the document for a vault-relative path.
   *
   * Throws on a path that escapes the vault. The server validates too, but this is the
   * boundary that actually writes files, so it refuses rather than trusting its caller.
   */
  getDoc(relPath: string): DocHandle {
    const key = normalise(relPath);
    if (!isContainedPath(key)) {
      throw new Error(`Refusing document path outside the vault: ${relPath}`);
    }
    let handle = this.handles.get(key);
    if (!handle) {
      handle = new DocHandle(key);
      this.bind(handle);
      this.handles.set(key, handle);
      this.emit("doc:open", { path: key });
    }
    return handle;
  }

  has(relPath: string): boolean {
    return this.handles.has(normalise(relPath));
  }

  /**
   * Document paths that actually exist as files.
   *
   * A handle opened for a path that has never been written is deliberately excluded:
   * listing a document the user cannot find on disk is worse than not listing it. It
   * appears as soon as it has content and has been flushed.
   */
  list(): string[] {
    const out: string[] = [];
    for (const [path, handle] of this.handles) {
      if (handle.deleted) continue;
      if (handle.lastDiskContent === null && handle.getContent().length === 0) continue;
      out.push(path);
    }
    return out.sort();
  }

  /** Force every pending write to disk and wait for it. Essential for deterministic tests. */
  async flush(): Promise<void> {
    for (const [path, timer] of this.writeTimers) {
      clearTimeout(timer);
      this.writeTimers.delete(path);
      this.track(this.writeNow(path));
    }
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    for (const { timer } of this.pendingUnlinks.values()) clearTimeout(timer);
    this.pendingUnlinks.clear();
    for (const { timer } of this.recentAdds.values()) clearTimeout(timer);
    this.recentAdds.clear();
    await this.watcher?.close();
    this.watcher = null;
    for (const handle of this.handles.values()) handle.destroy();
    this.handles.clear();
  }

  // ------------------------------------------------------------- write pipeline

  private bind(handle: DocHandle): void {
    handle.doc.on("update", (_update: Uint8Array, origin: unknown) => {
      // The loop breaker: never write back something that just came from disk.
      if (origin === DISK_ORIGIN) return;
      this.scheduleWrite(handle.path);
    });
  }

  private scheduleWrite(relPath: string): void {
    if (this.closed) return;
    const existing = this.writeTimers.get(relPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.writeTimers.delete(relPath);
      this.track(this.writeNow(relPath));
    }, this.opts.writeDebounceMs);
    timer.unref?.();
    this.writeTimers.set(relPath, timer);
  }

  private track(p: Promise<void>): void {
    const wrapped: Promise<void> = p
      .catch((err: unknown) => {
        this.emit("error", err);
      })
      .finally(() => {
        this.inFlight.delete(wrapped);
      });
    this.inFlight.add(wrapped);
  }

  private async writeNow(relPath: string): Promise<void> {
    const handle = this.handles.get(relPath);
    if (!handle || handle.deleted) return;

    const content = handle.getContent();
    if (content === handle.lastDiskContent) return;

    const abs = join(this.root, relPath);
    const tmp = join(dirname(abs), `${TMP_PREFIX}${basename(abs)}.${process.pid}.${tmpCounter++}`);

    await mkdir(dirname(abs), { recursive: true });
    try {
      // Atomic: readers never observe a half-written document.
      await writeFile(tmp, content, "utf8");
      await rename(tmp, abs);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }

    handle.lastDiskContent = content;
    this.emit("doc:written", { path: relPath, bytes: Buffer.byteLength(content) });
  }

  // -------------------------------------------------------------- read pipeline

  private async startWatching(): Promise<void> {
    const watcher = watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: this.opts.stabilityThresholdMs,
        pollInterval: 10,
      },
      ignored: (p: string) => {
        const b = basename(p);
        if (b.startsWith(TMP_PREFIX)) return true;
        return b === ".git" || b === "node_modules";
      },
    });

    watcher.on("add", (abs) => void this.onAdd(abs));
    watcher.on("change", (abs) => void this.onChange(abs));
    watcher.on("unlink", (abs) => void this.onUnlink(abs));
    watcher.on("error", (err) => this.emit("error", err));

    this.watcher = watcher;
    await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  }

  private isDocument(relPath: string): boolean {
    const lower = relPath.toLowerCase();
    return this.opts.extensions.some((ext) => lower.endsWith(ext));
  }

  private toRel(abs: string): string | null {
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith("..")) return null;
    return normalise(rel);
  }

  /** Read a file, guarding against oversized and vanished files. */
  private async readDoc(abs: string, relPath: string): Promise<string | null> {
    try {
      const info = await stat(abs);
      if (info.size > this.opts.maxFileBytes) {
        this.emit("doc:skipped", { path: relPath, reason: "too-large", bytes: info.size });
        return null;
      }
      return await readFile(abs, "utf8");
    } catch {
      return null; // Vanished between event and read -- the unlink handler will follow.
    }
  }

  private async fileExists(relPath: string): Promise<boolean> {
    try {
      await stat(join(this.root, relPath));
      return true;
    } catch {
      return false;
    }
  }

  private async onAdd(abs: string): Promise<void> {
    const relPath = this.toRel(abs);
    if (!relPath || !this.isDocument(relPath)) return;

    const content = await this.readDoc(abs, relPath);
    if (content === null) return;

    // An unlink followed by an add with identical content is a rename, not a delete.
    for (const [oldPath, pending] of this.pendingUnlinks) {
      if (pending.content === content) {
        clearTimeout(pending.timer);
        this.pendingUnlinks.delete(oldPath);
        this.handles.delete(oldPath);
        pending.handle.path = relPath;
        pending.handle.lastDiskContent = content;
        pending.handle.deleted = false;
        this.handles.set(relPath, pending.handle);
        this.emit("doc:rename", { from: oldPath, to: relPath });
        return;
      }
    }

    // Rename, add-first ordering: an existing document has exactly this content and its
    // own file is gone. Adopt the new path onto it rather than briefly exposing a
    // provisional duplicate that callers could attach to and then lose.
    if (!this.handles.has(relPath)) {
      for (const [oldPath, candidate] of this.handles) {
        if (oldPath === relPath || candidate.deleted) continue;
        if ((candidate.lastDiskContent ?? candidate.getContent()) !== content) continue;
        if (await this.fileExists(oldPath)) continue;

        const pending = this.pendingUnlinks.get(oldPath);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingUnlinks.delete(oldPath);
        }
        this.handles.delete(oldPath);
        candidate.path = relPath;
        candidate.lastDiskContent = content;
        candidate.deleted = false;
        this.handles.set(relPath, candidate);
        this.emit("doc:rename", { from: oldPath, to: relPath });
        return;
      }
    }

    const existing = this.handles.get(relPath);
    if (existing) {
      existing.deleted = false;

      // A document created in memory has just collided with a file appearing at the
      // same path. There is no shared base to merge against, so rather than silently
      // picking a winner we keep the CRDT content and say so.
      if (existing.lastDiskContent === null && existing.getContent() !== content) {
        this.emit("doc:conflict", { path: relPath, kept: "crdt" });
        this.scheduleWrite(relPath);
        return;
      }

      if (existing.applyFromDisk(content)) {
        this.emit("doc:change", { path: relPath, source: "disk" });
      }
      return;
    }

    const handle = new DocHandle(relPath);
    handle.initFromDisk(content);
    this.bind(handle);
    this.handles.set(relPath, handle);

    const timer = setTimeout(() => this.recentAdds.delete(relPath), this.opts.renameGraceMs);
    timer.unref?.();
    this.recentAdds.set(relPath, { content, timer });

    this.emit("doc:open", { path: relPath });
  }

  private async onChange(abs: string): Promise<void> {
    const relPath = this.toRel(abs);
    if (!relPath || !this.isDocument(relPath)) return;

    const content = await this.readDoc(abs, relPath);
    if (content === null) return;

    const handle = this.getDoc(relPath);

    // Fast path: this is the echo of our own write, or disk already agrees with us.
    if (content === handle.lastDiskContent && content === handle.getContent()) return;

    if (handle.applyFromDisk(content)) {
      this.emit("doc:change", { path: relPath, source: "disk" });
    }
  }

  private async onUnlink(abs: string): Promise<void> {
    const relPath = this.toRel(abs);
    if (!relPath || !this.isDocument(relPath)) return;

    const handle = this.handles.get(relPath);
    if (!handle) return;

    // Rename where the add landed first: adopt the new path onto the ORIGINAL handle so
    // its identity, history and connected clients survive, and discard the provisional
    // handle the add created.
    const ourContent = handle.lastDiskContent ?? handle.getContent();
    for (const [newPath, recent] of this.recentAdds) {
      if (newPath === relPath || recent.content !== ourContent) continue;

      clearTimeout(recent.timer);
      this.recentAdds.delete(newPath);

      const provisional = this.handles.get(newPath);
      if (provisional && provisional !== handle) {
        const pendingWrite = this.writeTimers.get(newPath);
        if (pendingWrite) {
          clearTimeout(pendingWrite);
          this.writeTimers.delete(newPath);
        }
        provisional.destroy();
      }

      this.handles.delete(relPath);
      handle.path = newPath;
      handle.lastDiskContent = recent.content;
      handle.deleted = false;
      this.handles.set(newPath, handle);
      this.emit("doc:rename", { from: relPath, to: newPath });
      return;
    }

    // Otherwise hold briefly: the matching add may still be on its way.
    const timer = setTimeout(() => {
      this.pendingUnlinks.delete(relPath);
      handle.deleted = true;
      this.emit("doc:delete", { path: relPath });
    }, this.opts.renameGraceMs);
    timer.unref?.();

    this.pendingUnlinks.set(relPath, {
      handle,
      content: handle.lastDiskContent ?? handle.getContent(),
      timer,
    });
  }
}

function normalise(relPath: string): string {
  return relPath.split(sep).join("/").replace(/^\.\//, "");
}

/** True when a normalised relative path stays inside the vault. */
function isContainedPath(relPath: string): boolean {
  if (!relPath || relPath.includes("\0")) return false;
  if (relPath.startsWith("/") || /^[a-zA-Z]:/.test(relPath)) return false;
  return !relPath.split("/").some((s) => s === ".." || s === "" || s === ".");
}

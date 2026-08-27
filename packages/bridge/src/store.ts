import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Y from "yjs";

/**
 * Persisting collaboration state.
 *
 * The Markdown file carries the text and nothing else. Everything that makes Quire more
 * than an editor -- who wrote each span, why, the comments, the agent policy, which
 * suggestions were accepted -- lives in the CRDT, and without a home on disk all of it
 * vanished the moment the server stopped. Restarting `quire` silently discarded every
 * comment, which is not a limitation so much as a bug with a long fuse.
 *
 * So each document gets a sidecar holding its encoded state, written beside the vault
 * rather than inside the documents themselves. The Markdown stays clean and diffable; the
 * sidecar is an implementation detail the user can delete at any time and lose only the
 * collaboration layer, never their prose.
 */

export const STATE_DIR = ".quire/state";

/** Encode a vault path as a single flat filename, reversibly and without separators. */
export function stateFileName(relPath: string): string {
  return `${Buffer.from(relPath, "utf8").toString("base64url")}.bin`;
}

export function pathFromStateFile(fileName: string): string | null {
  if (!fileName.endsWith(".bin")) return null;
  try {
    return Buffer.from(fileName.slice(0, -4), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export interface StoreOptions {
  root: string;
  /**
   * Refuse to persist state larger than this.
   *
   * With history retained, state grows with edit volume rather than document size, and a
   * runaway sidecar is worse than no sidecar: it would slow every startup and every write.
   */
  maxBytes?: number;
}

const DEFAULT_MAX = 32 * 1024 * 1024;

export class DocStore {
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(options: StoreOptions) {
    this.dir = join(options.root, STATE_DIR);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX;
  }

  /** Load a document's saved state, or null if there is none we can use. */
  async load(relPath: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(join(this.dir, stateFileName(relPath))));
    } catch {
      return null;
    }
  }

  /**
   * Save a document's state.
   *
   * Written through a temporary file so a crash mid-write leaves the previous state
   * intact rather than a truncated one that would fail to decode.
   */
  async save(relPath: string, doc: Y.Doc): Promise<boolean> {
    const encoded = Y.encodeStateAsUpdateV2(doc);
    if (encoded.byteLength > this.maxBytes) return false;

    const target = join(this.dir, stateFileName(relPath));
    const temp = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temp, encoded);
    const { rename } = await import("node:fs/promises");
    await rename(temp, target);
    return true;
  }

  async forget(relPath: string): Promise<void> {
    await rm(join(this.dir, stateFileName(relPath)), { force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    const state = await this.load(from);
    if (!state) return;
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, stateFileName(to)), state);
    await this.forget(from);
  }

  /** Paths that have saved state but no longer exist in the vault. */
  async orphans(livePaths: Set<string>): Promise<string[]> {
    try {
      const files = await readdir(this.dir);
      return files
        .map(pathFromStateFile)
        .filter((p): p is string => Boolean(p) && !livePaths.has(p as string));
    } catch {
      return [];
    }
  }

  async prune(livePaths: Set<string>): Promise<number> {
    const gone = await this.orphans(livePaths);
    for (const path of gone) await this.forget(path);
    return gone.length;
  }
}

/**
 * Restore a document from saved state, then reconcile it with what is on disk.
 *
 * The file may have changed while the server was stopped -- edited in another editor, or
 * pulled from git. Applying the saved state first and *then* merging the file as a delta
 * keeps the collaboration layer while letting the text catch up, which is the same
 * three-way behaviour the live watcher already relies on.
 */
export function restoreInto(doc: Y.Doc, state: Uint8Array, origin: unknown): void {
  Y.applyUpdateV2(doc, state, origin);
}

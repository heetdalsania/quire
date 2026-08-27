import * as Y from "yjs";
import diff from "fast-diff";
import { applyCommittedDiff, committedText, pendingSuggestions } from "./attribution.js";
import { applyExternalChange } from "./diff.js";

/**
 * Transaction origin used for every mutation that came FROM disk.
 *
 * This is the loop breaker. The writer ignores updates carrying this origin, so a
 * disk change that produces CRDT ops can never bounce back out as another disk write.
 * Correctness here comes from origins, not from content comparison -- content checks
 * elsewhere are only an optimisation.
 */
export const DISK_ORIGIN = Symbol("quire:disk");

export const CONTENT_KEY = "content";

export class DocHandle {
  readonly doc: Y.Doc;
  readonly text: Y.Text;

  /** Path relative to the vault root. Mutable: survives an external rename. */
  path: string;

  /**
   * The content Quire last knows to have been on disk. Serves as the merge base for
   * external changes, and lets us skip redundant reads and writes.
   */
  lastDiskContent: string | null = null;

  /** Set once the file is gone from disk and the rename grace period has expired. */
  deleted = false;

  constructor(path: string, options: { history?: boolean } = {}) {
    this.path = path;
    // Yjs garbage collection discards deleted content, which is exactly the material a
    // replay needs in order to show text being removed rather than jumping. Keeping it
    // costs memory that grows with edit volume, so it is a vault-level choice.
    this.doc = new Y.Doc({ gc: options.history === false });
    this.text = this.doc.getText(CONTENT_KEY);
  }

  /**
   * The plain-Markdown projection written to disk. Text that is only *proposed* by a
   * suggestion is excluded, so an un-accepted agent edit never reaches the file.
   */
  getContent(): string {
    return committedText(this.text);
  }

  /** The full CRDT text, including un-accepted suggestion spans. */
  getFullText(): string {
    return this.text.toString();
  }

  /**
   * Merge content observed on disk into the CRDT. Never overwrites wholesale --
   * see applyExternalChange for the three-way semantics.
   */
  applyFromDisk(content: string): boolean {
    const base = this.lastDiskContent ?? this.getContent();
    let changed = false;
    this.doc.transact(() => {
      changed = pendingSuggestions(this.text).length > 0
        ? // Disk cannot see suggestion spans, so the diff has to be computed in
          // committed space and projected back onto full-text offsets.
          applyCommittedDiff(this.text, content, diff)
        : applyExternalChange(this.text, base, content);
    }, DISK_ORIGIN);
    this.lastDiskContent = content;
    return changed;
  }

  /** Seed a freshly-opened document without recording a spurious edit. */
  initFromDisk(content: string): void {
    this.doc.transact(() => {
      if (this.text.length > 0) this.text.delete(0, this.text.length);
      if (content.length > 0) this.text.insert(0, content);
    }, DISK_ORIGIN);
    this.lastDiskContent = content;
  }

  destroy(): void {
    this.doc.destroy();
  }
}

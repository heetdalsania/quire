import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Vault } from "./vault.js";

const exec = promisify(execFile);

export interface GitSnapshotOptions {
  /** Commit at most this often, and only when something actually changed. */
  intervalMs?: number;
  /** Wait for this much quiet before committing, so a burst becomes one commit. */
  quietMs?: number;
  authorName?: string;
  authorEmail?: string;
}

/**
 * Periodic git commits of the vault.
 *
 * Git is the archive, never the transport. Nothing here takes part in live sync; it only
 * records restore points. A snapshot must include only document paths Quire changed. It
 * must never sweep unrelated work from the repository into one of its commits.
 */
export class GitSnapshotter {
  private timer: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  private readonly pendingPaths = new Set<string>();
  private running = false;

  private readonly onWritten = (event: { path: string }): void => this.mark(event.path);
  private readonly onDeleted = (event: { path: string }): void => this.mark(event.path);
  private readonly onRenamed = (event: { from: string; to: string }): void => {
    this.mark(event.from);
    this.mark(event.to);
  };

  constructor(
    private readonly vault: Vault,
    private readonly opts: GitSnapshotOptions = {},
  ) {}

  private get intervalMs(): number {
    return this.opts.intervalMs ?? 60_000;
  }
  private get quietMs(): number {
    return this.opts.quietMs ?? 5_000;
  }

  async isRepo(): Promise<boolean> {
    try {
      await exec("git", ["rev-parse", "--git-dir"], { cwd: this.vault.root });
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.vault.on("doc:written", this.onWritten);
    this.vault.on("doc:delete", this.onDeleted);
    this.vault.on("doc:rename", this.onRenamed);

    this.timer = setInterval(() => void this.tick(), Math.min(this.intervalMs, this.quietMs));
    this.timer.unref?.();
  }

  private mark(path: string): void {
    this.pendingPaths.add(path);
    this.lastActivity = Date.now();
  }

  private async tick(): Promise<void> {
    if (this.running || this.pendingPaths.size === 0) return;
    if (Date.now() - this.lastActivity < this.quietMs) return;
    this.running = true;
    try {
      await this.commit();
    } catch {
      // A failing snapshot must never disturb live editing.
    } finally {
      this.running = false;
    }
  }

  /** Commit pending Markdown paths written by Quire, without touching unrelated work. */
  async commit(message?: string): Promise<string | null> {
    if (!(await this.isRepo())) return null;
    const paths = [...this.pendingPaths].sort();
    if (paths.length === 0) return null;

    const cwd = this.vault.root;
    const pathspecs = paths.map((path) => `:(literal)${path}`);

    const { stdout: status } = await exec("git", ["status", "--porcelain", "--", ...pathspecs], { cwd });
    if (status.trim() === "") {
      for (const path of paths) this.pendingPaths.delete(path);
      return null;
    }

    await exec("git", ["add", "-A", "--", ...pathspecs], { cwd });
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    await exec(
      "git",
      [
        "-c",
        `user.name=${this.opts.authorName ?? "Quire"}`,
        "-c",
        `user.email=${this.opts.authorEmail ?? "snapshot@quire.local"}`,
        "commit",
        "-q",
        "--only",
        "-m",
        message ?? `Quire snapshot ${stamp}`,
        "--",
        ...pathspecs,
      ],
      { cwd },
    );
    for (const path of paths) this.pendingPaths.delete(path);
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd });
    return stdout.trim();
  }

  async history(limit = 50): Promise<Array<{ sha: string; date: string; message: string }>> {
    if (!(await this.isRepo())) return [];
    const { stdout } = await exec(
      "git",
      ["log", `-${limit}`, "--pretty=format:%H %aI %s"],
      { cwd: this.vault.root },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const sha = line.slice(0, line.indexOf(" "));
        const rest = line.slice(sha.length + 1);
        const date = rest.slice(0, rest.indexOf(" "));
        return { sha, date, message: rest.slice(date.length + 1) };
      });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.vault.off("doc:written", this.onWritten);
    this.vault.off("doc:delete", this.onDeleted);
    this.vault.off("doc:rename", this.onRenamed);
  }
}

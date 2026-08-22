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
 * Git is the archive, never the transport -- see PLAN.md section 2. Nothing here takes
 * part in live sync; it only records restore points, which is what makes the history
 * useful: every commit is a real commit and every diff a real diff.
 */
export class GitSnapshotter {
  private timer: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  private dirty = false;
  private running = false;

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
    const onChange = (): void => {
      this.dirty = true;
      this.lastActivity = Date.now();
    };
    this.vault.on("doc:written", onChange);
    this.vault.on("doc:delete", onChange);
    this.vault.on("doc:rename", onChange);

    this.timer = setInterval(() => void this.tick(), Math.min(this.intervalMs, this.quietMs));
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running || !this.dirty) return;
    if (Date.now() - this.lastActivity < this.quietMs) return;
    this.running = true;
    try {
      await this.commit();
      this.dirty = false;
    } catch {
      // A failing snapshot must never disturb live editing.
    } finally {
      this.running = false;
    }
  }

  /** Commit any pending changes. Returns the commit sha, or null if there was nothing. */
  async commit(message?: string): Promise<string | null> {
    if (!(await this.isRepo())) return null;
    const cwd = this.vault.root;

    const { stdout: status } = await exec("git", ["status", "--porcelain"], { cwd });
    if (status.trim() === "") return null;

    await exec("git", ["add", "-A"], { cwd });
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
        "-m",
        message ?? `Quire snapshot ${stamp}`,
      ],
      { cwd },
    );
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
  }
}

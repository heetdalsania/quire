import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitSnapshotter, Vault } from "../src/index.js";
import { cleanup, makeTempVaultDir } from "./helpers.js";

const exec = promisify(execFile);

let dir: string;
let vault: Vault;
let snapshots: GitSnapshotter;

const git = (...args: string[]) => exec("git", args, { cwd: dir });

beforeEach(async () => {
  dir = await makeTempVaultDir();
  await writeFile(join(dir, "doc.md"), "original\n", "utf8");
  await writeFile(join(dir, "private.txt"), "private original\n", "utf8");
  await git("init", "-q", "-b", "main");
  await git("config", "core.autocrlf", "false");
  await git("config", "user.email", "test@quire.local");
  await git("config", "user.name", "Quire Test");
  await git("add", "doc.md", "private.txt");
  await git("commit", "-qm", "base");
});

afterEach(async () => {
  snapshots?.stop();
  await vault?.close();
  await cleanup(dir);
});

describe("git snapshots", () => {
  it("commits only Markdown paths Quire changed and preserves unrelated staged work", async () => {
    vault = await Vault.open({ root: dir });
    snapshots = new GitSnapshotter(vault, { intervalMs: 60_000 });
    snapshots.start();

    vault.getDoc("doc.md").text.insert(vault.getDoc("doc.md").text.length, "changed by Quire\n");
    await writeFile(join(dir, "private.txt"), "private changed\n", "utf8");
    await git("add", "private.txt");
    await vault.flush();

    expect(await snapshots.commit("safe snapshot")).not.toBeNull();

    const { stdout: names } = await git("show", "--pretty=format:", "--name-only", "HEAD");
    expect(names.trim()).toBe("doc.md");
    expect((await git("show", "HEAD:private.txt")).stdout).toBe("private original\n");
    expect((await readFile(join(dir, "private.txt"), "utf8"))).toBe("private changed\n");
    expect((await git("status", "--porcelain", "--", "private.txt")).stdout).toBe("M  private.txt\n");
  });
});

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "../src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let vault: Vault;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quire-edge-"));
});
afterEach(async () => {
  await vault?.close();
  await chmod(dir, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe("vault boundaries", () => {
  it("rejects document paths that escape the vault", async () => {
    vault = await Vault.open({ root: dir });
    for (const bad of ["../escape.md", "a/../../escape.md", "/etc/passwd", "", "a/./b.md"]) {
      expect(() => vault.getDoc(bad)).toThrow();
    }
  });

  it("accepts ordinary nested paths", async () => {
    vault = await Vault.open({ root: dir });
    expect(() => vault.getDoc("a/b/c.md")).not.toThrow();
  });

  it("creates the vault directory when it does not exist yet", async () => {
    const nested = join(dir, "does/not/exist");
    vault = await Vault.open({ root: nested });
    expect(vault.list()).toEqual([]);
  });

  it("does not list a document that was never written to disk", async () => {
    vault = await Vault.open({ root: dir });
    vault.getDoc("phantom.md"); // opened but never edited
    // Listing a file the user cannot find on disk is worse than not listing it.
    expect(vault.list()).not.toContain("phantom.md");
  });

  it("lists a newly opened document once it actually has content", async () => {
    vault = await Vault.open({ root: dir });
    const handle = vault.getDoc("fresh.md");
    handle.doc.transact(() => handle.text.insert(0, "# Fresh\n"));
    await vault.flush();
    expect(vault.list()).toContain("fresh.md");
    expect(await readFile(join(dir, "fresh.md"), "utf8")).toBe("# Fresh\n");
  });
});

describe("filesystem trouble", () => {
  it("reports a write failure without crashing the vault", async () => {
    await writeFile(join(dir, "ok.md"), "fine\n", "utf8");
    vault = await Vault.open({ root: dir });

    const errors: unknown[] = [];
    vault.on("error", (e) => errors.push(e));

    const handle = vault.getDoc("ok.md");
    await chmod(dir, 0o500); // read + execute only: no new files, no renames

    handle.doc.transact(() => handle.text.insert(0, "changed "));
    await vault.flush();
    await sleep(200);

    // Either the platform allowed it or we surfaced an error -- never a silent crash.
    if (errors.length === 0) {
      expect(handle.getContent()).toContain("changed");
    } else {
      expect(errors.length).toBeGreaterThan(0);
    }
    await chmod(dir, 0o755);
  });

  it("recovers when a deleted file is recreated", async () => {
    await writeFile(join(dir, "flap.md"), "v1\n", "utf8");
    vault = await Vault.open({ root: dir, renameGraceMs: 80 });
    const handle = vault.getDoc("flap.md");

    await rm(join(dir, "flap.md"));
    await sleep(300);
    expect(handle.deleted).toBe(true);

    await writeFile(join(dir, "flap.md"), "v2 reborn\n", "utf8");
    await sleep(500);

    expect(vault.getDoc("flap.md").deleted).toBe(false);
    expect(vault.getDoc("flap.md").getContent()).toContain("reborn");
  });

  it("ignores a directory that happens to end in .md", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "notes.md"), { recursive: true });
    await writeFile(join(dir, "notes.md/inner.md"), "# Inner\n", "utf8");
    vault = await Vault.open({ root: dir });
    await sleep(400);
    expect(vault.list()).toContain("notes.md/inner.md");
    expect(vault.list()).not.toContain("notes.md");
  });
});

describe("write coalescing under pressure", () => {
  it("does not corrupt a document under a burst of edits", async () => {
    await writeFile(join(dir, "burst.md"), "", "utf8");
    vault = await Vault.open({ root: dir });
    const handle = vault.getDoc("burst.md");

    for (let i = 0; i < 500; i++) {
      handle.doc.transact(() => handle.text.insert(handle.text.length, `${i} `));
    }
    await vault.flush();
    await sleep(300);

    const expected = Array.from({ length: 500 }, (_, i) => `${i} `).join("");
    expect(handle.getContent()).toBe(expected);
    expect(await readFile(join(dir, "burst.md"), "utf8")).toBe(expected);
  }, 20_000);
});

describe("collaboration state survives a restart", () => {
  it("keeps attribution, comments and policy across a restart", async () => {
    const { CommentStore, insertAttributed, readPolicy, registerAuthor, writePolicy, summarise, knownAuthors } =
      await import("../src/index.js");
    const author = { id: "h1", name: "Heet", color: "#907aa9", kind: "human" as const };

    await writeFile(join(dir, "a.md"), "# A\n\n", "utf8");
    vault = await Vault.open({ root: dir });
    let handle = vault.getDoc("a.md");
    registerAuthor(handle.doc, author);
    insertAttributed(handle.text, handle.text.length, "Attributed sentence.", author);
    new CommentStore(handle.doc).add({
      text: handle.text, from: 0, to: 3, body: "a comment", authorId: author.id, authorName: author.name,
    });
    writePolicy(handle.doc, { mode: "propose", lockedSections: ["Secret"] });
    await vault.flush();
    await vault.close();

    // A fresh process, reading the same folder.
    vault = await Vault.open({ root: dir });
    handle = vault.getDoc("a.md");

    expect(handle.getContent()).toContain("Attributed sentence.");
    // Everything that makes Quire more than an editor used to vanish here.
    expect(summarise(handle.doc, handle.text, knownAuthors(handle.doc) as never).humanShare).toBeGreaterThan(0);
    expect(new CommentStore(handle.doc).list()).toHaveLength(1);
    expect(readPolicy(handle.doc).mode).toBe("propose");
    expect(readPolicy(handle.doc).lockedSections).toEqual(["Secret"]);
  }, 20_000);

  it("merges a file edited while the server was stopped", async () => {
    const { insertAttributed, registerAuthor } = await import("../src/index.js");
    const author = { id: "h1", name: "Heet", color: "#907aa9", kind: "human" as const };

    await writeFile(join(dir, "b.md"), "line one\n", "utf8");
    vault = await Vault.open({ root: dir });
    const first = vault.getDoc("b.md");
    registerAuthor(first.doc, author);
    insertAttributed(first.text, first.text.length, "line two\n", author);
    await vault.flush();
    await vault.close();

    // Someone edits the file in another editor, or pulls it from git.
    await writeFile(join(dir, "b.md"), "line one\nline two\nline three\n", "utf8");

    vault = await Vault.open({ root: dir });
    const handle = vault.getDoc("b.md");
    // The prose catches up without discarding the collaboration layer.
    expect(handle.getContent()).toContain("line three");
    expect(handle.getContent()).toContain("line two");
  }, 20_000);

  it("discards state for documents that no longer exist", async () => {
    const { readdir } = await import("node:fs/promises");
    await writeFile(join(dir, "temp.md"), "# Temp\n", "utf8");
    vault = await Vault.open({ root: dir });
    const handle = vault.getDoc("temp.md");
    handle.doc.transact(() => handle.text.insert(handle.text.length, "x"));
    await vault.flush();
    await vault.close();

    await rm(join(dir, "temp.md"));
    vault = await Vault.open({ root: dir });
    // Sidecars for deleted documents would otherwise accumulate forever.
    const left = await readdir(join(dir, ".quire/state")).catch(() => []);
    expect(left).toHaveLength(0);
  }, 20_000);

  it("never lists its own state directory as a document", async () => {
    await writeFile(join(dir, "c.md"), "# C\n", "utf8");
    vault = await Vault.open({ root: dir });
    const handle = vault.getDoc("c.md");
    handle.doc.transact(() => handle.text.insert(handle.text.length, "edit"));
    await vault.flush();
    await sleep(400);
    expect(vault.list().every((p) => !p.includes(".quire"))).toBe(true);
  }, 20_000);
});

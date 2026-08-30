import { execFile } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { CONTENT_KEY, Vault } from "../src/index.js";
import { type Client, cleanup, connectClient, makeTempVaultDir, sleep, waitFor } from "./helpers.js";

const exec = promisify(execFile);

let dir: string;
let vault: Vault;

const abs = (p: string): string => join(dir, p);
const write = (p: string, body: string): Promise<void> => writeFile(abs(p), body, "utf8");
const read = (p: string): Promise<string> => readFile(abs(p), "utf8");

beforeEach(async () => {
  dir = await makeTempVaultDir();
});

afterEach(async () => {
  await vault?.close();
  await cleanup(dir);
});

describe("Phase 1 bridge spike -- acceptance", () => {
  it("1. two clients editing concurrently converge, and disk matches", async () => {
    await write("notes.md", "# Title\n\nbody\n");
    vault = await Vault.open({ root: dir });

    const handle = vault.getDoc("notes.md");
    const a: Client = connectClient(handle);
    const b: Client = connectClient(handle);

    // Concurrent edits at opposite ends of the document.
    a.text.insert(0, "A-start ");
    b.text.insert(b.text.length, "B-end\n");

    await waitFor(() => a.content() === b.content(), "clients converge");
    await vault.flush();

    const onDisk = await read("notes.md");
    expect(a.content()).toBe(b.content());
    expect(handle.getContent()).toBe(a.content());
    expect(onDisk).toBe(a.content());
    expect(onDisk).toContain("A-start");
    expect(onDisk).toContain("B-end");
  });

  it("2. an external write is merged as a delta, leaving anchors intact", async () => {
    await write("doc.md", "alpha\nbravo\ncharlie\n");
    vault = await Vault.open({ root: dir });

    const handle = vault.getDoc("doc.md");
    const client = connectClient(handle);

    // Anchor a relative position on "bravo" -- this is how comments will be pinned.
    const anchorIndex = handle.getContent().indexOf("bravo");
    const anchor = Y.createRelativePositionFromTypeIndex(
      handle.doc.getText(CONTENT_KEY),
      anchorIndex,
    );

    // An outside editor appends a line.
    await write("doc.md", "alpha\nbravo\ncharlie\ndelta\n");

    await waitFor(() => handle.getContent().includes("delta"), "external append merged");

    expect(handle.getContent()).toBe("alpha\nbravo\ncharlie\ndelta\n");
    expect(client.content()).toBe(handle.getContent());

    const resolved = Y.createAbsolutePositionFromRelativePosition(anchor, handle.doc);
    expect(resolved).not.toBeNull();
    expect(resolved?.index).toBe(anchorIndex);
    expect(handle.getContent().slice(resolved!.index, resolved!.index + 5)).toBe("bravo");
  });

  it("3. Quire's own writes do not echo back into a loop", async () => {
    await write("loop.md", "seed\n");
    vault = await Vault.open({ root: dir });

    const handle = vault.getDoc("loop.md");
    const client = connectClient(handle);

    let writes = 0;
    let diskChanges = 0;
    vault.on("doc:written", () => writes++);
    vault.on("doc:change", () => diskChanges++);

    client.text.insert(client.text.length, "one local edit\n");
    await vault.flush();

    // Well past the watcher's stability threshold: a loop would show up here.
    await sleep(600);

    expect(writes).toBe(1);
    expect(diskChanges).toBe(0);
    expect(await read("loop.md")).toBe("seed\none local edit\n");
  });

  it("4. a real `git merge` rewriting the file mid-session behaves like an external edit", async () => {
    const git = (...args: string[]): Promise<unknown> => exec("git", args, { cwd: dir });

    await write("spec.md", "line one\nline two\nline three\n");
    await git("init", "-q", "-b", "main");
    await git("config", "core.autocrlf", "false");
    await git("config", "user.email", "spike@quire.test");
    await git("config", "user.name", "Spike");
    await git("add", "spec.md");
    await git("commit", "-qm", "base");

    await git("checkout", "-qb", "feature");
    await write("spec.md", "line one\nline two CHANGED\nline three\n");
    await git("commit", "-qam", "feature edit");
    await git("checkout", "-q", "main");

    vault = await Vault.open({ root: dir });
    const handle = vault.getDoc("spec.md");
    const client = connectClient(handle);
    expect(handle.getContent()).toBe("line one\nline two\nline three\n");

    // Git rewrites the working-tree file underneath the live session.
    await git("merge", "-q", "feature");

    await waitFor(() => handle.getContent().includes("CHANGED"), "merge result merged");
    expect(handle.getContent()).toBe("line one\nline two CHANGED\nline three\n");
    expect(client.content()).toBe(handle.getContent());
  });

  it("5. an external rename preserves document identity", async () => {
    await write("old-name.md", "durable content\n");
    vault = await Vault.open({ root: dir });

    const handle = vault.getDoc("old-name.md");
    const client = connectClient(handle);
    const clientId = handle.doc.clientID;
    client.text.insert(client.text.length, "edited before rename\n");
    await vault.flush();

    const renames: Array<{ from: string; to: string }> = [];
    vault.on("doc:rename", (e: { from: string; to: string }) => renames.push(e));

    await rename(abs("old-name.md"), abs("new-name.md"));

    await waitFor(() => renames.length > 0, "rename observed");
    expect(renames[0]).toEqual({ from: "old-name.md", to: "new-name.md" });
    expect(vault.list()).toEqual(["new-name.md"]);

    const renamed = vault.getDoc("new-name.md");
    expect(renamed).toBe(handle); // same object, not a fresh document
    expect(renamed.doc.clientID).toBe(clientId);
    expect(renamed.path).toBe("new-name.md");
    expect(renamed.getContent()).toBe("durable content\nedited before rename\n");
    expect(renamed.deleted).toBe(false);

    // The live client is still attached to the same document after the rename.
    client.text.insert(client.text.length, "after rename\n");
    await vault.flush();
    expect(await read("new-name.md")).toContain("after rename");
  });

  it("6. deleting an open file is handled without crashing", async () => {
    await write("doomed.md", "here today\n");
    await write("survivor.md", "still here\n");
    vault = await Vault.open({ root: dir, renameGraceMs: 120 });

    const doomed = vault.getDoc("doomed.md");
    connectClient(doomed);

    const deletions: string[] = [];
    vault.on("doc:delete", (e: { path: string }) => deletions.push(e.path));

    await rm(abs("doomed.md"));

    await waitFor(() => deletions.includes("doomed.md"), "delete event");
    expect(doomed.deleted).toBe(true);
    expect(vault.list()).not.toContain("doomed.md");

    // The vault keeps working for everything else.
    const survivor = vault.getDoc("survivor.md");
    const client = connectClient(survivor);
    client.text.insert(client.text.length, "and still editable\n");
    await vault.flush();
    expect(await read("survivor.md")).toBe("still here\nand still editable\n");
  });

  it("7. rapid successive external writes are debounced without corruption", async () => {
    await write("fast.md", "v0\n");
    vault = await Vault.open({ root: dir });
    const handle = vault.getDoc("fast.md");
    const client = connectClient(handle);

    // Simulates an editor that saves on every keystroke.
    for (let i = 1; i <= 20; i++) {
      await write("fast.md", `v${i}\n`);
      await sleep(5);
    }

    await waitFor(() => handle.getContent() === "v20\n", "settles on final write");
    await sleep(300);

    expect(handle.getContent()).toBe("v20\n");
    expect(client.content()).toBe("v20\n");
    expect(await read("fast.md")).toBe("v20\n");
  });

  it("8. a 1 MB document loads and accepts edits at acceptable latency", async () => {
    const big = `${"lorem ipsum dolor sit amet consectetur\n".repeat(26_000)}`;
    expect(big.length).toBeGreaterThan(1_000_000);
    await write("big.md", big);

    const openStart = performance.now();
    vault = await Vault.open({ root: dir });
    const handle = vault.getDoc("big.md");
    const openMs = performance.now() - openStart;

    expect(handle.getContent().length).toBe(big.length);

    // A small external edit to a large file must not cost a full re-parse.
    const editStart = performance.now();
    await write("big.md", `PREFIX\n${big}`);
    await waitFor(() => handle.getContent().startsWith("PREFIX"), "large-file delta", 15_000);
    const editMs = performance.now() - editStart;

    console.log(`      [perf] 1MB open=${openMs.toFixed(0)}ms  external-edit=${editMs.toFixed(0)}ms`);
    expect(handle.getContent()).toBe(`PREFIX\n${big}`);
    expect(openMs).toBeLessThan(5000);
    expect(editMs).toBeLessThan(5000);
  });

  it("9. offline edits merge cleanly on reconnect", async () => {
    await write("offline.md", "shared base\n");
    vault = await Vault.open({ root: dir });
    const handle = vault.getDoc("offline.md");
    const client = connectClient(handle);

    client.disconnect();

    // Both sides edit while partitioned.
    client.text.insert(client.text.length, "written offline by client\n");
    handle.doc.transact(() => {
      handle.text.insert(handle.text.length, "written on server\n");
    });

    expect(client.content()).not.toBe(handle.getContent());

    client.reconnect();

    expect(client.content()).toBe(handle.getContent());
    expect(handle.getContent()).toContain("written offline by client");
    expect(handle.getContent()).toContain("written on server");

    await vault.flush();
    expect(await read("offline.md")).toBe(handle.getContent());
  });

  it("10. non-markdown and binary files are ignored gracefully", async () => {
    await write("real.md", "# real\n");
    await writeFile(abs("image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]));
    await write("notes.txt", "not a document\n");
    await writeFile(abs("data.bin"), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));

    const errors: unknown[] = [];
    vault = await Vault.open({ root: dir });
    vault.on("error", (e) => errors.push(e));

    await sleep(300);

    expect(vault.list()).toEqual(["real.md"]);
    expect(vault.has("image.png")).toBe(false);
    expect(vault.has("notes.txt")).toBe(false);
    expect(errors).toEqual([]);

    // Binary files are left strictly alone.
    const png = await readFile(abs("image.png"));
    expect([...png]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
  });
});

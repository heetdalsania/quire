import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Vault } from "../src/vault.js";
import { insertAttributed } from "../src/attribution.js";
import { cleanup, makeTempVaultDir } from "./helpers.js";

let root: string;
let vault: Vault;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

// Control watcher delivery and I/O completion independently of OS scheduling.
interface FilePipeline {
  readDoc(abs: string, path: string): Promise<string | null>;
  onChange(abs: string): Promise<void>;
  onAdd(abs: string): Promise<void>;
  writeNow(path: string): Promise<void>;
}

beforeEach(async () => {
  root = await makeTempVaultDir();
  await writeFile(join(root, "doc.md"), "base\n");
  await writeFile(join(root, "other.md"), "other\n");
  vault = await Vault.open({ root, persist: false, writeDebounceMs: 60_000 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await vault?.close();
  await cleanup(root);
});

for (const event of ["onChange", "onAdd"] as const) {
  it(`serializes ${event} snapshots with later writes without blocking other files`, async () => {
    const pipeline = vault as unknown as FilePipeline;
    const captured = deferred();
    const release = deferred();
    const originalRead = pipeline.readDoc.bind(vault);
    vi.spyOn(pipeline, "readDoc").mockImplementationOnce(async (...args) => {
      const snapshot = await originalRead(...args);
      captured.resolve();
      await release.promise;
      return snapshot;
    });
    const reading = pipeline[event](join(root, "doc.md"));
    await captured.promise;
    const handle = vault.getDoc("doc.md");
    handle.text.insert(0, "local ");
    const content = vi.spyOn(handle, "getContent");
    const writing = pipeline.writeNow("doc.md");
    try {
      const other = vault.getDoc("other.md");
      other.text.insert(0, "independent ");
      await pipeline.writeNow("other.md");
      expect(await readFile(join(root, "other.md"), "utf8")).toBe("independent other\n");
      expect(content).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.all([reading, writing]);
    }
    expect(handle.getContent()).toBe("local base\n");
    expect(await readFile(join(root, "doc.md"), "utf8")).toBe("local base\n");
  });
}

it("a failed operation does not prevent later writes for the same file", async () => {
  const pipeline = vault as unknown as FilePipeline;
  vi.spyOn(pipeline, "readDoc").mockRejectedValueOnce(new Error("simulated read failure"));
  await expect(pipeline.onChange(join(root, "doc.md"))).rejects.toThrow("simulated read failure");
  vault.getDoc("doc.md").text.insert(0, "recovered ");
  await pipeline.writeNow("doc.md");
  expect(await readFile(join(root, "doc.md"), "utf8")).toBe("recovered base\n");
});

it("an unchanged disk echo preserves unflushed local edits beside suggestions", () => {
  const handle = vault.getDoc("doc.md");
  handle.text.insert(0, "local ");
  insertAttributed(handle.text, handle.text.length, "proposal", {
    id: "agent", name: "Agent", color: "#008800", kind: "agent",
  }, { suggestion: "pending" });
  expect(handle.applyFromDisk("base\n")).toBe(false);
  expect(handle.getContent()).toBe("local base\n");
  expect(handle.getFullText()).toContain("proposal");
});

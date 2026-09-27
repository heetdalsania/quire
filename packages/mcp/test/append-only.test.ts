import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { QuireServer } from "@quire/server";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
let server: QuireServer;
let client: Client;
let transport: StdioClientTransport;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quire-append-only-"));
  await writeFile(join(root, "progress.md"), "# Progress\n\n| T01 | pending |\n\n## Iteration log\n\n2026-09-22 14:00 | Arun | started\n");
  server = await QuireServer.start({ root, port: 0, git: false, persist: false, appendOnlyLogs: ["progress.md"] });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", `import { runStdio } from ${JSON.stringify(new URL("../dist/src/server.js", import.meta.url).href)}; await runStdio({ serverUrl: "http://127.0.0.1:${server.port}", agentName: "Test" });`],
    stderr: "pipe",
  });
  client = new Client({ name: "append-only-test", version: "1.0.0" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close();
  await transport?.close();
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it("keeps task rows editable and accepts new entries at the end", async () => {
  const row = await client.callTool({ name: "edit_document", arguments: {
    path: "progress.md", old_text: "| T01 | pending |", new_text: "| T01 | active |",
  } });
  expect(row.isError).not.toBe(true);
  const append = await client.callTool({ name: "append_document", arguments: {
    path: "progress.md", text: "2026-09-22 14:05 | Heet | joined\n",
  } });
  expect(append.isError).not.toBe(true);
  await expect.poll(() => readFile(join(root, "progress.md"), "utf8")).toContain("2026-09-22 14:05 | Heet | joined");
  expect(await readFile(join(root, "progress.md"), "utf8")).toContain("| T01 | active |");
});

it("refuses changes to an existing timestamp entry", async () => {
  const result = await client.callTool({ name: "edit_document", arguments: {
    path: "progress.md", old_text: "2026-09-22 14:00 | Arun | started", new_text: "2026-09-22 14:00 | Arun | erased",
  } });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("append-only");
  expect(await readFile(join(root, "progress.md"), "utf8")).toContain("Arun | started");
  expect(await readFile(join(root, "progress.md"), "utf8")).not.toContain("Arun | erased");
});

it("refuses removal of the log heading and its entries", async () => {
  const result = await client.callTool({ name: "edit_document", arguments: {
    path: "progress.md", old_text: "## Iteration log\n\n2026-09-22 14:00 | Arun | started\n", new_text: "",
  } });
  expect(result.isError).toBe(true);
  expect(await readFile(join(root, "progress.md"), "utf8")).toContain("## Iteration log");
});

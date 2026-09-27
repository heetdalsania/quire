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
  root = await mkdtemp(join(tmpdir(), "quire-activity-"));
  await writeFile(join(root, "spec.md"), "# Spec\n\nDraft.\n");
  await writeFile(join(root, "progress.md"), "# Progress\n\n| T01 | pending |\n\n## Iteration log\n\nEarlier entry.\n");
  server = await QuireServer.start({
    root, port: 0, git: false, persist: false,
    appendOnlyLogs: ["progress.md"], agentActivityLog: "progress.md",
  });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", `import { runStdio } from ${JSON.stringify(new URL("../dist/src/server.js", import.meta.url).href)}; await runStdio({ serverUrl: "http://127.0.0.1:${server.port}", agentName: "Test Agent" });`],
    stderr: "pipe",
  });
  client = new Client({ name: "activity-test", version: "1.0.0" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close();
  await transport?.close();
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it("records committed agent edits once, but not manual log appends or pending suggestions", async () => {
  const edit = await client.callTool({ name: "edit_document", arguments: {
    path: "spec.md", old_text: "Draft.", new_text: "Agreed text.",
  } });
  expect(edit.isError).not.toBe(true);
  await server.vault.flush();
  let log = await readFile(join(root, "progress.md"), "utf8");
  expect(log).toContain("Test Agent | AUTO | Committed edit to spec.md");
  expect(log.match(/\| AUTO \|/g)).toHaveLength(1);

  const row = await client.callTool({ name: "edit_document", arguments: {
    path: "progress.md", old_text: "| T01 | pending |", new_text: "| T01 | active |",
  } });
  expect(row.isError).not.toBe(true);
  await server.vault.flush();
  log = await readFile(join(root, "progress.md"), "utf8");
  expect(log).toContain("| T01 | active |");
  expect(log).toContain("Committed edit to progress.md");
  expect(log.match(/\| AUTO \|/g)).toHaveLength(2);

  const manual = await client.callTool({ name: "append_document", arguments: {
    path: "progress.md", text: "Manual iteration entry.\n",
  } });
  expect(manual.isError).not.toBe(true);
  await server.vault.flush();
  log = await readFile(join(root, "progress.md"), "utf8");
  expect(log).toContain("Manual iteration entry.");
  expect(log.match(/\| AUTO \|/g)).toHaveLength(2);

  const suggestion = await client.callTool({ name: "edit_document", arguments: {
    path: "spec.md", old_text: "Agreed text.", new_text: "Proposed text.", suggest: true,
  } });
  expect(suggestion.isError).not.toBe(true);
  await server.vault.flush();
  expect((await readFile(join(root, "progress.md"), "utf8")).match(/\| AUTO \|/g)).toHaveLength(2);
  expect(await readFile(join(root, "spec.md"), "utf8")).toContain("Agreed text.");
});

it("rejects an activity log that is not protected as append-only", async () => {
  await expect(QuireServer.start({
    root, port: 0, git: false, persist: false, agentActivityLog: "progress.md",
  })).rejects.toThrow("append-only document");
});

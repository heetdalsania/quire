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
  root = await mkdtemp(join(tmpdir(), "quire-protocol-"));
  await writeFile(join(root, "doc.md"), "# Protocol\n\nOriginal sentence.\n");
  server = await QuireServer.start({ root, port: 0, git: false, persist: false });
  const moduleUrl = new URL("../dist/src/server.js", import.meta.url).href;
  const options = { serverUrl: `http://127.0.0.1:${server.port}`, agentName: "Test", agentColor: "#008080" };
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", `import { runStdio } from ${JSON.stringify(moduleUrl)}; await runStdio(${JSON.stringify(options)});`],
    stderr: "pipe",
  });
  client = new Client({ name: "quire-protocol-test", version: "1.0.0" });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close();
  await transport?.close();
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it("publishes usable JSON schemas for all MCP tools", async () => {
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(17);
  const read = tools.find((tool) => tool.name === "read_document")!;
  expect(read.inputSchema.required).toContain("path");
  expect(read.inputSchema.required).not.toContain("committed_only");
  expect(read.inputSchema.properties?.path).toMatchObject({ type: "string" });
  const policy = tools.find((tool) => tool.name === "set_agent_policy")!;
  expect(policy.inputSchema.properties?.mode).toMatchObject({ enum: ["edit", "propose", "read-only"] });
});

it("rejects malformed arguments over the actual MCP transport", async () => {
  for (const request of [
    { name: "read_document", arguments: { path: 42 } },
    { name: "set_agent_policy", arguments: { path: "doc.md", mode: "unrestricted" } },
  ]) {
    const result = await client.callTool(request);
    expect(result.isError).toBe(true);
  }
  expect(await readFile(join(root, "doc.md"), "utf8")).toContain("Original sentence.");
});

it("persists valid tool edits while keeping suggestions off disk", async () => {
  const edit = await client.callTool({ name: "edit_document", arguments: {
    path: "doc.md", old_text: "Original sentence.", new_text: "Revised sentence.",
  } });
  expect(edit.isError).not.toBe(true);
  await expect.poll(() => readFile(join(root, "doc.md"), "utf8")).toContain("Revised sentence.");
  const proposal = await client.callTool({ name: "append_document", arguments: {
    path: "doc.md", text: "Pending proposal.", suggest: true,
  } });
  expect(proposal.isError).not.toBe(true);
  const full = await client.callTool({ name: "read_document", arguments: { path: "doc.md" } });
  expect(JSON.stringify(full.content)).toContain("Pending proposal.");
  const committed = await client.callTool({ name: "read_document", arguments: { path: "doc.md", committed_only: true } });
  expect(JSON.stringify(committed.content)).not.toContain("Pending proposal.");
  expect(await readFile(join(root, "doc.md"), "utf8")).not.toContain("Pending proposal.");
});

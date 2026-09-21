import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentBudget, CommentStore, Vault, acceptSuggestion, pendingSuggestions, readPolicy, registerAuthor, rejectSuggestion, runAt, spans, writePolicy } from "@quire/bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { artifactTools } from "../src/artifact-tools.js";
import { ConversationMcp } from "../src/conversation-mcp.js";
import type { ConversationTools } from "../src/conversation-provider.js";

let root: string; let vault: Vault; let tools: ConversationTools;
let endpoint: ConversationMcp | undefined; let client: Client | undefined;
let controller: AbortController; let threadId: string;
const original = "# Report\n\nOriginal passage.\n\n# Locked\nProtected passage.\n";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quire-artifact-tools-"));
  await writeFile(join(root, "report.md"), original);
  vault = await Vault.open({ root });
  const handle = vault.getDoc("report.md");
  const author = { id: "agent-native", name: "Codex", kind: "agent" as const, color: "blue" };
  registerAuthor(handle.doc, author);
  threadId = new CommentStore(handle.doc).add({ text: handle.text, from: 10, to: 26, body: "Revise", authorId: "human", authorName: "Human" });
  controller = new AbortController();
  tools = artifactTools(vault, { handle, humanCursors: () => [{ name: "Human", index: 15 }], setAgentPresence: () => {} }, threadId, author, new AgentBudget(readPolicy(handle.doc)), controller.signal);
  tools.setModel("native-model");
});
afterEach(async () => { controller.abort(); await client?.close(); client = undefined; await endpoint?.close(); endpoint = undefined; tools.close(); await vault.close(); await rm(root, { recursive: true, force: true }); });
const read = async () => JSON.parse((await tools.call("quire_read_artifact", {})).content[0]!.text);
const propose = (revision: string, old_text = "Original passage.", new_text = "Revised passage.") => tools.call("quire_propose_replacement", { revision, old_text, new_text, reason: "Clarify the report" });

it("creates attributed suggestions near the human cursor and writes only on acceptance", async () => {
  const current = await read();
  const result = await propose(current.revision);
  expect(result.isError).not.toBe(true); expect(result.content[0]!.text).toContain("Human is working nearby");
  const handle = vault.getDoc("report.md"); const id = pendingSuggestions(handle.text)[0]!;
  expect(id).toBeTruthy();
  expect((await read()).pending).toEqual([{ id, inserted: "Revised passage.", deleted: "Original passage." }]);
  const added = spans(handle.text).find(span => span.suggestInsert === id)!;
  expect(runAt(handle.doc, handle.text, added.from)?.run).toMatchObject({ authorId: "agent-native", model: "native-model", tool: "quire_propose_replacement" });
  await vault.flush(); expect(await readFile(join(root, "report.md"), "utf8")).toBe(original);
  acceptSuggestion(handle.text, id); await vault.flush();
  expect(await readFile(join(root, "report.md"), "utf8")).toBe(original.replace("Original passage.", "Revised passage."));
  await propose((await read()).revision, "Revised passage.", "Another proposal.");
  rejectSuggestion(handle.text, pendingSuggestions(handle.text)[0]!); await vault.flush();
  expect(await readFile(join(root, "report.md"), "utf8")).not.toContain("Another proposal");
});

it("rejects stale revisions, ambiguous text, locked sections and read-only policy", async () => {
  const first = await read();
  vault.getDoc("report.md").text.insert(0, "Human edit\n");
  expect((await propose(first.revision)).isError).toBe(true);
  const current = await read();
  expect((await propose(current.revision, "passage.")).content[0]!.text).toContain("Ambiguous");
  writePolicy(vault.getDoc("report.md").doc, { lockedSections: ["Locked"] });
  expect((await propose(current.revision, "Protected passage.")).content[0]!.text).toContain("locked");
  writePolicy(vault.getDoc("report.md").doc, { mode: "read-only" });
  expect((await propose(current.revision)).isError).toBe(true);
  expect(pendingSuggestions(vault.getDoc("report.md").text)).toHaveLength(0);
});

it("rejects out-of-scope, invalid, expired and resolved-comment calls", async () => {
  expect((await tools.call("quire_read_artifact", { path: "other.md" })).isError).toBe(true);
  expect((await tools.call("quire_read_artifact", { limit: 1e9 })).isError).toBe(true);
  expect((await tools.call("execute_command", { command: "anything" })).isError).toBe(true);
  const current = await read();
  new CommentStore(vault.getDoc("report.md").doc).setResolved(threadId, true);
  expect((await propose(current.revision)).isError).toBe(true);
  tools.close(); expect((await tools.call("quire_read_artifact", {})).isError).toBe(true);
});

it("enforces cumulative edit budgets without consuming a second suggestion", async () => {
  const handle = vault.getDoc("report.md");
  writePolicy(handle.doc, { maxInserts: 20, maxDeletes: 30 });
  expect((await propose((await read()).revision)).isError).not.toBe(true);
  expect((await propose((await read()).revision, "Protected passage.", "Another revision.")).content[0]!.text).toMatch(/budget/i);
  expect(pendingSuggestions(handle.text)).toHaveLength(1);
});

it("rejects unknown edit keys and overlapping suggestions", async () => {
  const current = await read();
  expect((await tools.call("quire_propose_replacement", { revision: current.revision, old_text: "Original passage.", new_text: "New", reason: "Review", path: "other.md" })).isError).toBe(true);
  expect((await propose(current.revision)).isError).not.toBe(true);
  expect((await propose(current.revision)).content[0]!.text).toContain("pending deletion");
});

it("serves real MCP only to the per-turn native capability and revokes it on abort", async () => {
  endpoint = await ConversationMcp.start(tools, controller.signal);
  const { url, http_headers: headers } = endpoint.config;
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(403);
  expect((await fetch(url, { method: "POST", headers: { ...headers, Origin: "null" }, body: "{}" })).status).toBe(403);
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { ...headers, Host: "untrusted.test" } }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject); req.end("{}");
  });
  expect(wrongHost).toBe(403);
  expect((await fetch(url, { method: "POST", headers, body: "invalid" })).status).toBe(400);
  client = new Client({ name: "fixture", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }) as Transport);
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["quire_read_artifact", "quire_propose_replacement"]);
  const response = await client.callTool({ name: "quire_read_artifact", arguments: {} });
  const current = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
  const result = await client.callTool({ name: "quire_propose_replacement", arguments: { revision: current.revision, old_text: "Original passage.", new_text: "Through MCP.", reason: "Review" } });
  expect(result.isError).not.toBe(true);
  expect(pendingSuggestions(vault.getDoc("report.md").text)).toHaveLength(1);
  controller.abort(); await endpoint.close();
  // The listener is gone, so the capability URL is unreachable rather than answering 410.
  await expect(fetch(url, { headers })).rejects.toThrow();
});

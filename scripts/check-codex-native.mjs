// Exercise the installed Codex MCP client without invoking a model or reading a real conversation.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentBudget, CommentStore, Vault, acceptSuggestion, pendingSuggestions, readPolicy } from "../packages/bridge/dist/src/index.js";
import { artifactTools } from "../packages/agent/dist/src/artifact-tools.js";
import { CodexRpc } from "../packages/agent/dist/src/codex-conversation.js";
import { ConversationMcp } from "../packages/agent/dist/src/conversation-mcp.js";

if (process.env.QUIRE_CHECK_CODEX_NATIVE !== "1") {
  console.error("Opt-in only: set QUIRE_CHECK_CODEX_NATIVE=1 to check the installed Codex without a model call.");
  process.exit(2);
}

const root = await mkdtemp(join(tmpdir(), "quire-native-tools-"));
const signal = AbortSignal.timeout(55_000);
const rpcs = []; let vault; let endpoint; let sessionId;
try {
  const source = "# Synthetic report\n\nOriginal sentence.\n";
  await writeFile(join(root, "report.md"), source);
  vault = await Vault.open({ root });
  const handle = vault.getDoc("report.md");
  const thread = new CommentStore(handle.doc).add({ text: handle.text, from: 21, to: 38, body: "Revise this synthetic sentence", authorId: "human", authorName: "Test human" });
  const toolset = artifactTools(vault, { handle, humanCursors: () => [], setAgentPresence() {} }, thread,
    { id: "agent-native-check", kind: "agent", name: "Native check", color: "blue" }, new AgentBudget(readPolicy(handle.doc)), signal);
  endpoint = await ConversationMcp.start(toolset, signal);
  const rpc = new CodexRpc("codex", ["app-server", "--listen", "stdio://"], root, signal); rpcs.push(rpc);
  await rpc.initialize();
  const started = await rpc.request("thread/start", { cwd: root, sandbox: "read-only", config: { "mcp_servers.quire_native_check": endpoint.config } });
  sessionId = started.thread.id;
  await toolset.setModel(started.model);
  for (let attempt = 0; ; attempt++) {
    const status = await rpc.request("mcpServerStatus/list", { threadId: sessionId, limit: 100, detail: "full" });
    const item = status.data.find(item => item.name === "quire_native_check");
    if (item?.runtimeStatus === "connected" && item.tools.quire_propose_replacement) break;
    if (attempt >= 10) throw new Error(`Native tool connection failed: ${item?.runtimeStatus ?? "missing"}`);
    await delay(500, undefined, { signal });
  }
  const call = (tool, args) => rpc.request("mcpServer/tool/call", { threadId: sessionId, server: "quire_native_check", tool, arguments: args });
  const read = await call("quire_read_artifact", {});
  assert.notEqual(read.isError, true);
  const current = JSON.parse(read.content[0].text);
  assert.equal(current.text, source);
  const changed = await call("quire_propose_replacement", { revision: current.revision, old_text: "Original sentence.", new_text: "Reviewed sentence.", reason: "Synthetic local integration check" });
  assert.notEqual(changed.isError, true);
  await vault.flush(); assert.equal(await readFile(join(root, "report.md"), "utf8"), source);
  const suggestions = pendingSuggestions(handle.text); assert.equal(suggestions.length, 1);
  acceptSuggestion(handle.text, suggestions[0]); await vault.flush();
  assert.equal(await readFile(join(root, "report.md"), "utf8"), source.replace("Original", "Reviewed"));
  console.log("PASS: native Codex MCP read/propose/accept succeeded. No model turn was started. This does not verify model-driven editing or persisted-session resume.");
} finally {
  if (sessionId) {
    const rpc = rpcs.at(-1);
    await rpc.request("thread/archive", { threadId: sessionId }).catch(error => {
      // An empty synthetic thread may never have had a persisted rollout.
      if (!error.message.includes("no rollout found")) console.error(`Unable to archive synthetic session ${sessionId}: ${error.message}`);
    });
  }
  for (const rpc of rpcs) await rpc.close();
  await endpoint?.close(); await vault?.close(); await rm(root, { recursive: true, force: true });
}

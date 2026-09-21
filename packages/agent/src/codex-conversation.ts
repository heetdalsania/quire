import { createHash, randomUUID } from "node:crypto";
import type { ConversationOrigin, ConversationProvider, ConversationRun } from "./conversation-provider.js";
import { ConversationMcp } from "./conversation-mcp.js";
import { setTimeout as delay } from "node:timers/promises";
import { codexDeliverySettings } from "./codex-settings.js";

import { NativeRpc as CodexRpc } from "./native-rpc.js";
export { NativeRpc as CodexRpc } from "./native-rpc.js";

/** Uses the installed, authenticated Codex. Native model and permission settings are inherited. */
export class CodexConversationProvider implements ConversationProvider {
  constructor(private readonly cwd: string, private readonly executable = "codex", private readonly args = ["app-server", "--listen", "stdio://"]) {}
  async fork(origin: ConversationOrigin, signal: AbortSignal): Promise<string> {
    if (origin.provider !== "codex") throw new Error("Expected a Codex conversation origin");
    const rpc = new CodexRpc(this.executable, this.args, this.cwd, signal);
    try {
      await rpc.initialize();
      const settings = await codexDeliverySettings(rpc, origin);
      const source = await rpc.request("thread/read", { threadId: origin.sessionId, includeTurns: true });
      const boundary = source.thread?.turns?.findIndex((turn: any) => turn.id === origin.turnId && turn.status === "completed");
      if (source.thread?.id !== origin.sessionId || boundary === undefined || boundary < 0) throw new Error("The delivery turn is no longer available");
      const result = await rpc.request("thread/fork", { threadId: origin.sessionId, lastTurnId: origin.turnId, ...settings });
      const child = result?.thread;
      if (typeof child?.id !== "string" || child.id === origin.sessionId || child.forkedFromId !== origin.sessionId) throw new Error("Codex did not confirm a distinct fork of the original session");
      if (result.model !== settings.model || result.modelProvider !== settings.modelProvider) throw new Error("Codex did not inherit the delivery model/provider");
      const verified = await rpc.request("thread/read", { threadId: child.id, includeTurns: true });
      if (verified.thread?.id !== child.id || verified.thread.turns?.at(-1)?.id !== origin.turnId || verified.thread.turns.at(-1).status !== "completed" ||
        JSON.stringify(verified.thread.turns.map((turn: any) => turn.id)) !== JSON.stringify(source.thread.turns.slice(0, boundary + 1).map((turn: any) => turn.id))) throw new Error("Codex did not fork exactly the completed delivery turn");
      return child.id;
    } finally { await rpc.close(); }
  }
  async prompt(sessionId: string, text: string, run: ConversationRun): Promise<string> {
    if (!run.origin || run.origin.provider !== "codex" || run.origin.sessionId === sessionId) throw new Error("The original Codex delivery is required to resume its child");
    const rpc = new CodexRpc(this.executable, this.args, this.cwd, run.signal);
    let dispose: (() => void) | undefined;
    let mcp: ConversationMcp | undefined;
    try {
      if (run.tools) mcp = await ConversationMcp.start(run.tools, run.signal);
      await rpc.initialize();
      const settings = await codexDeliverySettings(rpc, run.origin);
      const toolServer = `quire_artifact_${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
      const resumed = await rpc.request("thread/resume", { threadId: sessionId, ...settings,
        config: { ...settings.config, ...(mcp ? { [`mcp_servers.${toolServer}`]: mcp.config } : {}) } });
      if (resumed?.thread?.id !== sessionId) throw new Error("Codex resumed a different session");
      if (resumed.model !== settings.model || resumed.modelProvider !== settings.modelProvider) throw new Error("Codex did not restore the delivery model/provider; no model turn was started");
      if (typeof resumed.model === "string") await run.tools?.setModel(resumed.model);
      if (resumed.thread.turns?.some((turn: any) => turn.status === "inProgress")) throw new Error("This artifact session is already running in another client");
      if (mcp && run.tools) {
        const deadline = Date.now() + 30_000;
        while (true) {
          const inventory = await rpc.request("mcpServerStatus/list", { threadId: sessionId, limit: 100, detail: "full" });
          const target = inventory.data?.find((item: any) => item.name === toolServer);
          if (target?.runtimeStatus === "connected" && run.tools.definitions.every(tool => target.tools?.[tool.name])) break;
          if (Date.now() >= deadline || ["failed", "authenticationRequired", "disabled", "cancelled"].includes(target?.runtimeStatus)) throw new Error("Codex could not connect the artifact editing tools; no model turn was started");
          await delay(500, undefined, { signal: run.signal });
        }
      }
      const changes = new Map<string, string>();
      let unsupported: string | null = null;
      rpc.requestHandler = async message => {
        if (unsupported) throw new Error("This request requires the native Codex client");
        if (message.params?.threadId !== sessionId) { unsupported = "foreign session request"; run.tools?.close(); throw new Error("Request belongs to a different session"); }
        const kind = message.method === "item/commandExecution/requestApproval" ? "command" : message.method === "item/fileChange/requestApproval" ? "file" : null;
        if (!kind) { unsupported = message.method ?? "unknown"; run.tools?.close(); throw new Error("This request requires the native Codex client"); }
        const detail = kind === "command"
          ? [message.params.command, message.params.cwd, message.params.reason].filter(Boolean).join("\n")
          : [changes.get(message.params.itemId), message.params.reason].filter(Boolean).join("\n");
        // Never approve a file request without its actual diff to review.
        if (!detail || (kind === "file" && !changes.get(message.params.itemId)) ||
          (kind === "command" && (typeof message.params.command !== "string" || !message.params.command.trim()))) {
          unsupported = "approval without reviewable details"; run.tools?.close(); throw new Error("This approval requires the native Codex client");
        }
        const accepted = await run.approve({ id: randomUUID(), kind, detail });
        return { decision: accepted ? "accept" : "decline" };
      };
      const final = new Map<string, Map<string, string>>();
      const completed = new Map<string, any>();
      let turnId: string | null = null;
      let settle = () => {};
      const done = new Promise<string>((resolve, reject) => {
        settle = () => {
          if (unsupported) { reject(new Error(`Continue in Codex: unsupported request ${unsupported}`)); return; }
          if (!turnId || !completed.has(turnId)) return;
          const turn = completed.get(turnId);
          if (turn.status !== "completed") reject(new Error(turn.error?.message ?? `Codex turn ${turn.status ?? "failed"}`));
          else resolve([...(final.get(turnId)?.values() ?? [])].join("\n\n").trim());
        };
        dispose = rpc.subscribe(message => {
          if (message.method === "quire/disconnected") { reject(message.params.error); return; }
          const p = message.params;
          if (p?.threadId !== sessionId) return;
          if (message.method === "item/started" && p.item?.type === "fileChange") {
            const diffs = p.item.changes;
            if (Array.isArray(diffs) && diffs.length && diffs.every((change: any) => typeof change.path === "string" && typeof change.diff === "string" && change.diff.trim())) {
              changes.set(p.item.id, diffs.map((change: any) => `${change.path}\n${change.diff}`).join("\n\n"));
            }
          }
          if (message.method === "item/completed" && typeof p.turnId === "string" && p.item?.type === "agentMessage" && (!p.item.phase || p.item.phase === "final_answer")) {
            const messages = final.get(p.turnId) ?? new Map<string, string>();
            messages.set(p.item.id, p.item.text ?? ""); final.set(p.turnId, messages);
          }
          if (message.method === "turn/completed" && typeof p.turn?.id === "string") {
            completed.set(p.turn.id, p.turn); settle();
          }
        });
      });
      // Observe before starting: very short turns can finish before the RPC response.
      const started = rpc.request("turn/start", { threadId: sessionId, clientUserMessageId: randomUUID(), input: [{ type: "text", text, text_elements: [] }] }).then(result => {
        if (typeof result?.turn?.id !== "string" || !result.turn.id) throw new Error("Codex did not identify the started turn");
        turnId = result.turn.id; settle();
      });
      const [, answer] = await Promise.all([started, done]);
      if (!answer) throw new Error("Codex completed without an answer");
      return answer;
    } finally { dispose?.(); await Promise.all([rpc.close(), mcp?.close()]); }
  }
}

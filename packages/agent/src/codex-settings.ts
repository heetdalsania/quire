import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ConversationOrigin } from "./conversation-provider.js";
import type { NativeRpc } from "./native-rpc.js";

/** Read only the delivery's native metadata; app-server resume otherwise uses profile defaults. */
export async function codexDeliverySettings(rpc: NativeRpc, origin: ConversationOrigin) {
  if (origin.provider !== "codex") throw new Error("Expected a Codex delivery");
  const seen = new Set<string>();
  let sessionId = origin.sessionId;
  while (seen.size < 20 && !seen.has(sessionId)) {
    seen.add(sessionId);
    const { thread } = await rpc.request("thread/read", { threadId: sessionId, includeTurns: true });
    if (thread?.id !== sessionId || !thread.turns?.some((turn: any) => turn.id === origin.turnId && turn.status === "completed")) {
      throw new Error("The delivery turn must exist and be completed before handing off");
    }
    if (typeof thread.path !== "string" || !isAbsolute(thread.path)) throw new Error("Codex did not expose the native delivery metadata; resume in Codex first");
    const file = await open(thread.path, "r");
    let metadata: any; let context: any;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Codex delivery metadata exceeds the 64 MiB handoff limit");
      const buffer = Buffer.alloc(stat.size);
      // Read the bounded snapshot, even if another native process appends later.
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) throw new Error("Codex delivery metadata changed while reading");
        offset += bytesRead;
      }
      for (const line of buffer.toString("utf8").split("\n")) {
        if (!line) continue;
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.type === "session_meta") metadata = row.payload;
        if (row.type === "turn_context" && row.payload?.turn_id === origin.turnId) context = row.payload;
      }
    } finally { await file.close(); }
    if (metadata?.id !== sessionId) throw new Error("Codex delivery metadata belongs to a different session");
    if (context) {
      const model = context.model;
      const modelProvider = context.model_provider ?? metadata.model_provider;
      const effort = context.effort ?? context.reasoning_effort ?? context.collaboration_mode?.settings?.reasoning_effort;
      if (typeof model !== "string" || !model || typeof modelProvider !== "string" || !modelProvider) throw new Error("Codex did not record the delivery model/provider; resume in Codex first");
      if (effort != null && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw new Error("Unsupported recorded Codex reasoning effort");
      return { model, modelProvider, config: effort == null ? {} : { model_reasoning_effort: effort } };
    }
    if (!thread.forkedFromId || thread.forkedFromId !== metadata.forked_from_id) break;
    sessionId = thread.forkedFromId;
  }
  throw new Error("Codex did not retain the exact delivery model metadata; resume in Codex first");
}

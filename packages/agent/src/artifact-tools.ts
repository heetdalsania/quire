import { createHash } from "node:crypto";
import { AgentBudget, CommentStore, pendingSuggestions, readPolicy, spans, type Author, type Vault } from "@quire/bridge";
import { suggestEdit, type ToolContext } from "./suggest.js";
import type { AgentRoom } from "./room.js";
import type { ConversationTools } from "./conversation-provider.js";

const readSchema = { type: "object" as const, additionalProperties: false, properties: {
  offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 40000 },
} };
const editSchema = { type: "object" as const, additionalProperties: false, required: ["revision", "old_text", "new_text", "reason"], properties: {
  revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
  old_text: { type: "string", minLength: 1, maxLength: 40000 },
  new_text: { type: "string", maxLength: 40000 },
  reason: { type: "string", minLength: 1, maxLength: 2000 },
} };
function object(input: unknown): input is Record<string, unknown> { return !!input && typeof input === "object" && !Array.isArray(input); }
function validRead(input: unknown): input is { offset?: number; limit?: number } {
  return object(input) && Object.keys(input).every(key => key === "offset" || key === "limit") &&
    (input.offset === undefined || (Number.isSafeInteger(input.offset) && (input.offset as number) >= 0)) &&
    (input.limit === undefined || (Number.isSafeInteger(input.limit) && (input.limit as number) >= 1 && (input.limit as number) <= 40000));
}
function validEdit(input: unknown): input is { revision: string; old_text: string; new_text: string; reason: string } {
  return object(input) && Object.keys(input).every(key => key in editSchema.properties) &&
    typeof input.revision === "string" && /^[a-f0-9]{64}$/.test(input.revision) &&
    typeof input.old_text === "string" && input.old_text.length > 0 && input.old_text.length <= 40000 &&
    typeof input.new_text === "string" && input.new_text.length <= 40000 &&
    typeof input.reason === "string" && input.reason.trim().length > 0 && input.reason.length <= 2000;
}
const revision = (source: string) => createHash("sha256").update(source).digest("hex");

/** Per-turn access to the active artifact. Native shell/model permissions are separate. */
export function artifactTools(vault: Vault, room: AgentRoom, threadId: string, author: Author, budget: AgentBudget, signal: AbortSignal, privateIds: string[] = []): ConversationTools {
  const context: ToolContext = { handle: room.handle, threadId, author, budget, signal,
    model: null, active: true, snapshot: "", humanCursors: () => room.humanCursors() };
  let readRevision: string | null = null;
  const ensureActive = () => {
    signal.throwIfAborted();
    if (!context.active || room.handle.deleted) throw new Error("This artifact tool session has ended");
    const thread = new CommentStore(room.handle.doc).list().find(item => item.id === threadId);
    if (!thread || thread.resolved) throw new Error("The comment is resolved or gone");
  };
  return {
    definitions: [
      { name: "quire_read_artifact", description: "Read the live committed artifact source, revision, policy and pending changes. Use this before proposing an edit; disk contents may omit unaccepted suggestions.", inputSchema: { ...readSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
      { name: "quire_propose_replacement", description: "Propose replacing one unique exact passage in the active artifact. Requires the revision returned by quire_read_artifact. The change appears live for human acceptance/rejection; does not write the file. Respects document locks and edit budgets. Use this for document changes instead of filesystem tools.", inputSchema: { ...editSchema },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    ],
    async call(name, args) {
      try {
        ensureActive();
        const source = room.handle.getContent();
        if (name === "quire_read_artifact") {
          if (!validRead(args)) throw new Error("Invalid read parameters");
          context.snapshot = source; readRevision = revision(source);
          const offset = args.offset ?? 0;
          const allSpans = spans(room.handle.text);
          const fullSource = room.handle.text.toString();
          const pending = pendingSuggestions(room.handle.text).slice(0, 64).map(id => ({ id,
            inserted: allSpans.filter(span => span.suggestInsert === id).map(span => fullSource.slice(span.from, span.to)).join("").slice(0, 2000),
            deleted: allSpans.filter(span => span.suggestDelete === id).map(span => fullSource.slice(span.from, span.to)).join("").slice(0, 2000),
          }));
          return { content: [{ type: "text", text: JSON.stringify({ path: room.handle.path, revision: readRevision, offset, totalChars: source.length, text: source.slice(offset, offset + (args.limit ?? 24000)), policy: readPolicy(room.handle.doc), pending }) }] };
        }
        if (name !== "quire_propose_replacement") throw new Error("Unknown artifact tool");
        if (!validEdit(args)) throw new Error("Invalid edit parameters");
        if (!readRevision || args.revision !== readRevision || args.revision !== revision(source)) throw new Error("The document changed or was not read. Read it again before proposing a change.");
        if (privateIds.some(id => args.new_text.includes(id) || args.reason.includes(id))) throw new Error("Private native identifiers cannot be exported");
        const from = source.indexOf(args.old_text);
        if (from < 0) throw new Error("Passage not found; read the document again");
        if (source.indexOf(args.old_text, from + 1) >= 0) throw new Error("Ambiguous passage; include more surrounding text");
        if (args.old_text === args.new_text) throw new Error("The proposed passage is unchanged");
        return { content: [{ type: "text", text: suggestEdit(context, from, from + args.old_text.length, args.new_text, args.reason) }] };
      } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : "Artifact tool failed" }], isError: true }; }
    },
    setModel(model) { if (privateIds.some(id => model.includes(id))) throw new Error("Invalid native model identity"); context.model = model; },
    close() { context.active = false; },
  };
}

import { randomUUID } from "node:crypto";
import { AgentBudget, CommentStore, committedText, committedToFull, insertAttributed, isRangeLocked, proposeDelete, readPolicy, registerAuthor, registerRun, spans, type Author, type DocHandle } from "@quire/bridge";

export interface ToolContext {
  handle: DocHandle;
  author: Author;
  budget: AgentBudget;
  model: string | null;
  threadId: string;
  active: boolean;
  signal: AbortSignal;
  snapshot: string;
  humanCursors(): Array<{ name: string; index: number }>;
}

function ensureActive(context: ToolContext): void {
  context.signal.throwIfAborted();
  if (!context.active || context.handle.deleted) throw new Error("This agent run is no longer active");
  const thread = new CommentStore(context.handle.doc).list().find(entry => entry.id === context.threadId);
  if (!thread || thread.resolved) throw new Error("The comment is resolved or gone");
}

export function suggestEdit(context: ToolContext, from: number, to: number, replacement: string, note?: string): string {
  ensureActive(context);
  const { handle, author } = context;
  const committed = committedText(handle.text);
  if (![from, to].every(Number.isSafeInteger) || from < 0 || to < from || to > committed.length) throw new Error("Invalid committed-text range");
  if (committed !== context.snapshot) throw new Error("The document changed. Read it again before suggesting an edit.");
  const fullFrom = committedToFull(handle.text, from);
  const fullTo = committedToFull(handle.text, to);
  const policy = readPolicy(handle.doc);
  const locked = isRangeLocked(handle.text.toString(), policy.lockedSections, fullFrom, fullTo);
  if (locked) throw new Error(`"${locked.heading}" is locked against agent edits in this document.`);
  const existing = spans(handle.text);
  if (existing.some(span => span.suggestDelete && span.from < fullTo && span.to > fullFrom)) throw new Error("This range already has a pending deletion suggestion; wait for human review.");
  context.budget.update(policy);
  const verdict = context.budget.admit({ inserted: replacement.length, deleted: to - from });
  if (!verdict.allowed) throw new Error(verdict.reason);
  const suggestion = `s_${randomUUID()}`;
  const run = `r_${randomUUID()}`;
  registerAuthor(handle.doc, author);
  registerRun(handle.doc, { id: run, authorId: author.id, model: context.model, prompt: note ?? null, tool: "quire_propose_replacement" });
  handle.doc.transact(() => {
    for (const span of existing) {
      if (span.suggestInsert) continue;
      const start = Math.max(span.from, fullFrom);
      const end = Math.min(span.to, fullTo);
      if (end > start) proposeDelete(handle.text, start, end, author, suggestion);
    }
    if (replacement) insertAttributed(handle.text, fullTo, replacement, author, { suggestion, run });
  }, `author:${author.id}`);
  const human = context.humanCursors().find(cursor => cursor.index >= fullFrom - 120 && cursor.index <= fullTo + 120);
  return `Proposed ${suggestion}; awaiting human review. The file on disk is unchanged.${human ? ` ${human.name} is working nearby; no direct edits were made.` : ""}`;
}

import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { ATTR_AUTHOR, ATTR_SUGGEST_DELETE, ATTR_SUGGEST_INSERT } from "@quire/bridge";
import type { DocHandle } from "@quire/bridge";

const KEY = "agentReverts";
const MAX_CHARS = 500_000;

interface RemovedSpan {
  anchor: string;
  text: string;
  attributes: Record<string, string>;
}

export interface RevertRecord {
  id: string;
  agentId: string;
  agentName: string;
  revertedBy: string;
  revertedAt: number;
  restoredBy: string | null;
  restoredAt: number | null;
  chars: number;
  spans: RemovedSpan[];
}

export type RevertSummary = Omit<RevertRecord, "spans">;

function records(handle: DocHandle): Y.Map<RevertRecord> {
  return handle.doc.getMap<RevertRecord>(KEY);
}

export function listReverts(handle: DocHandle): RevertSummary[] {
  return [...records(handle).values()]
    .map(({ spans: _spans, ...summary }) => summary)
    .sort((a, b) => b.revertedAt - a.revertedAt);
}

/** Remove only committed insertions, keeping an attributed restoration payload in CRDT state. */
export function revertAgentEdits(handle: DocHandle, agentId: string, agentName: string, actor: string, protectedStart = Infinity): RevertSummary {
  const text = handle.text;
  const removed: Array<RemovedSpan & { from: number; to: number }> = [];
  let offset = 0;
  let chars = 0;
  for (const part of text.toDelta() as Array<{ insert?: string; attributes?: Record<string, string> }>) {
    if (typeof part.insert !== "string") continue;
    const from = offset;
    offset += part.insert.length;
    const attributes = part.attributes ?? {};
    if (attributes[ATTR_AUTHOR] !== agentId || attributes[ATTR_SUGGEST_INSERT] || attributes[ATTR_SUGGEST_DELETE] || offset > protectedStart) continue;
    chars += part.insert.length;
    if (chars > MAX_CHARS) throw new Error("This revert is too large to restore safely in one operation");
    removed.push({
      from, to: offset, text: part.insert, attributes: { ...attributes },
      anchor: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, from, -1))).toString("base64"),
    });
  }
  if (!removed.length) throw new Error("No applied insertions by this agent can be reverted");

  const record: RevertRecord = {
    id: randomUUID(), agentId, agentName, revertedBy: actor, revertedAt: Date.now(),
    restoredBy: null, restoredAt: null, chars,
    spans: removed.map(({ anchor, text: content, attributes }) => ({ anchor, text: content, attributes })),
  };
  handle.doc.transact(() => {
    records(handle).set(record.id, record);
    for (const span of removed.reverse()) text.delete(span.from, span.to - span.from);
  }, "revert:agent");
  const { spans: _spans, ...summary } = record;
  return summary;
}

/** Reinsert removed attributed spans at their CRDT-relative anchors, even after later edits. */
export function restoreAgentEdits(handle: DocHandle, id: string, actor: string, protectedStart = Infinity): RevertSummary {
  const record = records(handle).get(id);
  if (!record) throw new Error("Revert record not found");
  if (record.restoredAt !== null) throw new Error("These edits have already been restored");
  if (!Array.isArray(record.spans) || record.spans.length === 0) throw new Error("Revert record is incomplete");

  record.spans.forEach((span) => {
    if (typeof span.text !== "string" || !span.text || typeof span.anchor !== "string" || !span.attributes || typeof span.attributes !== "object") {
      throw new Error("Revert record is invalid");
    }
    const relative = Y.decodeRelativePosition(Buffer.from(span.anchor, "base64"));
    const position = Y.createAbsolutePositionFromRelativePosition(relative, handle.doc);
    if (!position || position.type !== handle.text || position.index > protectedStart) throw new Error("The protected log cannot be changed by restore");
  });

  const restored: RevertRecord = { ...record, restoredBy: actor, restoredAt: Date.now() };
  handle.doc.transact(() => {
    for (let i = record.spans.length - 1; i >= 0; i--) {
      const span = record.spans[i]!;
      const relative = Y.decodeRelativePosition(Buffer.from(span.anchor, "base64"));
      const position = Y.createAbsolutePositionFromRelativePosition(relative, handle.doc);
      if (!position || position.type !== handle.text) throw new Error("Cannot resolve the original edit location");
      handle.text.insert(position.index, span.text, span.attributes);
    }
    records(handle).set(id, restored);
  }, "restore:agent");
  const { spans: _spans, ...summary } = restored;
  return summary;
}

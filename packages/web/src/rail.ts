import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import {
  type AttributedSpan,
  ATTR_AUTHOR,
  ATTR_SUGGEST_DELETE,
  ATTR_SUGGEST_INSERT,
} from "@quire/bridge/attribution";
import { authorRegistry } from "./decorations.js";

export interface Thread {
  id: string;
  authorName: string;
  body: string;
  quote: string;
  resolved: boolean;
  range: { from: number; to: number } | null;
  orphaned: boolean;
}

/**
 * Browser-side mirror of the bridge's CommentStore. The bridge module itself pulls in
 * node:fs through the vault, so the comment shape is re-implemented here against the
 * same Y.Doc structure rather than importing it.
 */
export class Comments {
  private readonly array: Y.Array<Y.Map<unknown>>;

  constructor(private readonly doc: Y.Doc) {
    this.array = doc.getArray<Y.Map<unknown>>("comments");
  }

  observe(fn: () => void): void {
    this.array.observeDeep(fn);
  }

  add(text: Y.Text, from: number, to: number, body: string, authorId: string, authorName: string): void {
    const entry = new Y.Map<unknown>();
    this.doc.transact(() => {
      entry.set("id", `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
      entry.set("authorId", authorId);
      entry.set("authorName", authorName);
      entry.set("body", body);
      entry.set("createdAt", Date.now());
      entry.set("resolved", false);
      entry.set("quote", text.toString().slice(from, to));
      entry.set("start", Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, from)));
      entry.set("end", Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, to)));
      this.array.push([entry]);
    }, "comments");
  }

  list(): Thread[] {
    const out: Thread[] = [];
    for (const entry of this.array) {
      const start = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(entry.get("start") as Uint8Array),
        this.doc,
      );
      const end = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(entry.get("end") as Uint8Array),
        this.doc,
      );
      const alive = start !== null && end !== null && end.index > start.index;
      out.push({
        id: entry.get("id") as string,
        authorName: entry.get("authorName") as string,
        body: entry.get("body") as string,
        quote: entry.get("quote") as string,
        resolved: Boolean(entry.get("resolved")),
        range: alive ? { from: start.index, to: end.index } : null,
        orphaned: !alive,
      });
    }
    return out.sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity));
  }

  setResolved(id: string, resolved: boolean): void {
    this.doc.transact(() => {
      for (const entry of this.array) if (entry.get("id") === id) entry.set("resolved", resolved);
    }, "comments");
  }

  remove(id: string): void {
    this.doc.transact(() => {
      for (let i = 0; i < this.array.length; i++) {
        if (this.array.get(i)?.get("id") === id) return void this.array.delete(i, 1);
      }
    }, "comments");
  }
}

function spansOf(text: Y.Text): AttributedSpan[] {
  const out: AttributedSpan[] = [];
  let cursor = 0;
  for (const op of text.toDelta() as Array<{ insert?: string; attributes?: Record<string, string> }>) {
    if (typeof op.insert !== "string" || op.insert.length === 0) continue;
    out.push({
      from: cursor,
      to: cursor + op.insert.length,
      author: op.attributes?.[ATTR_AUTHOR] ?? null,
      suggestInsert: op.attributes?.[ATTR_SUGGEST_INSERT] ?? null,
      suggestDelete: op.attributes?.[ATTR_SUGGEST_DELETE] ?? null,
    });
    cursor += op.insert.length;
  }
  return out;
}

export interface Suggestion {
  id: string;
  authorName: string;
  color: string;
  inserted: string;
  removed: string;
}

export function listSuggestions(text: Y.Text): Suggestion[] {
  const byId = new Map<string, Suggestion>();
  const full = text.toString();
  for (const span of spansOf(text)) {
    const id = span.suggestInsert ?? span.suggestDelete;
    if (!id) continue;
    const known = span.author ? authorRegistry.get(span.author) : undefined;
    const entry = byId.get(id) ?? {
      id,
      authorName: known?.name ?? "Someone",
      color: known?.color ?? "#8a8f98",
      inserted: "",
      removed: "",
    };
    if (span.suggestInsert === id) entry.inserted += full.slice(span.from, span.to);
    if (span.suggestDelete === id) entry.removed += full.slice(span.from, span.to);
    byId.set(id, entry);
  }
  return [...byId.values()];
}

/** Accept: proposed inserts become real text, proposed deletes actually delete. */
export function acceptSuggestion(text: Y.Text, id: string): void {
  text.doc?.transact(() => {
    for (const span of spansOf(text).reverse()) {
      if (span.suggestDelete === id) text.delete(span.from, span.to - span.from);
      else if (span.suggestInsert === id) text.format(span.from, span.to - span.from, { [ATTR_SUGGEST_INSERT]: null });
    }
  }, "suggestion:accept");
}

/** Reject: proposed inserts vanish, proposed deletes are kept. */
export function rejectSuggestion(text: Y.Text, id: string): void {
  text.doc?.transact(() => {
    for (const span of spansOf(text).reverse()) {
      if (span.suggestInsert === id) text.delete(span.from, span.to - span.from);
      else if (span.suggestDelete === id) text.format(span.from, span.to - span.from, { [ATTR_SUGGEST_DELETE]: null });
    }
  }, "suggestion:reject");
}

export function scrollTo(view: EditorView, from: number, to: number): void {
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  view.focus();
}

/**
 * Remove every span an author contributed, leaving everyone else's text alone.
 *
 * This is attribution-based rather than UndoManager-based on purpose: Yjs transaction
 * origins are local to the process that made the edit and do not survive the wire, so a
 * browser cannot undo a remote agent's work by origin. Walking the marks does survive.
 *
 * Limitation: it removes what the author inserted; it cannot resurrect text the author
 * deleted outright. That is exactly what suggest mode exists to avoid.
 */
export function revertAuthor(text: Y.Text, authorId: string): number {
  let removed = 0;
  text.doc?.transact(() => {
    for (const span of spansOf(text).reverse()) {
      if (span.author !== authorId) continue;
      text.delete(span.from, span.to - span.from);
      removed += span.to - span.from;
    }
  }, "revert:author");
  return removed;
}

export function authorsPresent(text: Y.Text): string[] {
  return [...new Set(spansOf(text).map((s) => s.author).filter((a): a is string => Boolean(a)))];
}

/** The on-disk projection: everything except text that is only *proposed*. */
export function committedTextOf(text: Y.Text): string {
  let out = "";
  for (const op of text.toDelta() as Array<{ insert?: string; attributes?: Record<string, string> }>) {
    if (typeof op.insert !== "string") continue;
    if (op.attributes?.[ATTR_SUGGEST_INSERT]) continue;
    out += op.insert;
  }
  return out;
}

/** Author identities stored in the document, which outlive any single connection. */
export function readAuthors(doc: Y.Doc): Record<string, { name: string; color: string; kind: "human" | "agent" }> {
  return Object.fromEntries(doc.getMap<{ name: string; color: string; kind: "human" | "agent" }>("authors").entries());
}

export function registerLocalAuthor(doc: Y.Doc, id: string, name: string, color: string): void {
  const authors = doc.getMap<unknown>("authors");
  if (authors.get(id)) return;
  doc.transact(() => authors.set(id, { name, color, kind: "human" }), "authors");
}

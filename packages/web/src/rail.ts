import type { EditorView } from "@codemirror/view";
import type * as Y from "yjs";
import {
  acceptSuggestion,
  committedText,
  knownAuthors,
  pendingSuggestions,
  registerAuthor,
  rejectSuggestion,
  spans,
} from "@quire/bridge/attribution";
import { CommentStore, type CommentThread } from "@quire/bridge/comments";
import { authorRegistry } from "./decorations.js";

/**
 * Rail state.
 *
 * The comment store and the suggestion primitives come straight from @quire/bridge --
 * both of those modules depend only on yjs, so they bundle for the browser unchanged.
 * Re-implementing them here would mean two definitions of "accepted" that could drift.
 */
export {
  CommentStore,
  type CommentThread,
  acceptSuggestion,
  committedText,
  knownAuthors,
  pendingSuggestions,
  registerAuthor,
  rejectSuggestion,
};

export interface Suggestion {
  id: string;
  authorId: string | null;
  authorName: string;
  color: string;
  inserted: string;
  removed: string;
}

/** Group the document's suggestion marks into reviewable cards. */
export function listSuggestions(text: Y.Text): Suggestion[] {
  const byId = new Map<string, Suggestion>();
  const full = text.toString();

  for (const span of spans(text)) {
    const id = span.suggestInsert ?? span.suggestDelete;
    if (!id) continue;
    const known = span.author ? authorRegistry.get(span.author) : undefined;
    const entry = byId.get(id) ?? {
      id,
      authorId: span.author,
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

/**
 * Remove every span an author contributed, leaving everyone else's text alone.
 *
 * Attribution-based rather than UndoManager-based on purpose: Yjs transaction origins are
 * local to the process that made the edit and do not survive the wire, so a browser cannot
 * undo a remote agent's work by origin. Walking the marks does survive.
 *
 * Limitation: it removes what the author inserted; it cannot resurrect text they deleted
 * outright. That is exactly what suggest mode exists to avoid.
 */
export function revertAuthor(text: Y.Text, authorId: string): number {
  let removed = 0;
  text.doc?.transact(() => {
    for (const span of spans(text).reverse()) {
      if (span.author !== authorId) continue;
      text.delete(span.from, span.to - span.from);
      removed += span.to - span.from;
    }
  }, "revert:author");
  return removed;
}

export function authorsPresent(text: Y.Text): string[] {
  return [...new Set(spans(text).map((s) => s.author).filter((a): a is string => Boolean(a)))];
}

/** Author identities recorded in the document, which outlive any single connection. */
export function readAuthors(doc: Y.Doc): Record<string, { name: string; color: string; kind: "human" | "agent" }> {
  return knownAuthors(doc) as Record<string, { name: string; color: string; kind: "human" | "agent" }>;
}

export function registerLocalAuthor(doc: Y.Doc, id: string, name: string, color: string): void {
  registerAuthor(doc, { id, name, color, kind: "human" });
}

export function committedTextOf(text: Y.Text): string {
  return committedText(text);
}

export function scrollTo(view: EditorView, from: number, to: number): void {
  view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
  view.focus();
}

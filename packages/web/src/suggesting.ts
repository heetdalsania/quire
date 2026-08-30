import { EditorState, type Extension, type Transaction } from "@codemirror/state";
import { ySyncAnnotation } from "y-codemirror.next";
import type * as Y from "yjs";
import {
  ATTR_AUTHOR,
  type Author,
  authorOrigin,
  insertAttributed,
  proposeDelete,
} from "@quire/bridge/attribution";

/**
 * Suggesting mode for people, the counterpart to the agent's `suggest` flag.
 *
 * Typing normally edits the document. With suggesting on, the same keystrokes become
 * proposals: insertions are marked, deletions are struck through rather than removed, and
 * nothing reaches the file until somebody accepts.
 *
 * It works by intercepting the editor's own transactions before they apply and replaying
 * them as marked CRDT operations instead. Letting the edit through and *then* marking it
 * would briefly write un-reviewed text into the document -- and, because Quire writes
 * continuously, straight to disk.
 */

let suggesting = false;
let author: Author | null = null;
let text: Y.Text | null = null;

/** Consecutive keystrokes belong to one reviewable suggestion, not one card per character. */
let currentId: string | null = null;
let idleTimer: number | undefined;
const IDLE_MS = 1800;

export const isSuggesting = (): boolean => suggesting;

export function configureSuggesting(nextText: Y.Text, nextAuthor: Author): void {
  text = nextText;
  author = nextAuthor;
  currentId = null;
}

export function setSuggesting(on: boolean): void {
  suggesting = on;
  currentId = null;
  window.clearTimeout(idleTimer);
}

function suggestionId(): string {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    currentId = null;
  }, IDLE_MS);
  currentId ??= `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  return currentId;
}

interface PendingChange {
  from: number;
  to: number;
  inserted: string;
  resultFrom: number;
}

/**
 * Convert one editor transaction into suggestion marks.
 *
 * Applied right to left so that earlier offsets stay valid while later ones are rewritten.
 */
function applyAsSuggestion(changes: PendingChange[]): void {
  if (!text || !author) return;
  const id = suggestionId();
  const doc = text.doc;
  if (!doc) return;

  doc.transact(() => {
    for (const change of [...changes].reverse()) {
      if (change.to > change.from) {
        proposeDelete(text!, change.from, change.to, author!, id);
      }
      if (change.inserted.length > 0) {
        // Sit the replacement immediately after the text it replaces, so the rail can
        // show it as a before/after pair.
        insertAttributed(text!, change.to, change.inserted, author!, { suggestion: id });
      }
    }
  });
}

export function suggestingExtension(): Extension {
  return EditorState.transactionFilter.of((tr: Transaction) => {
    if (!tr.docChanged) return tr;
    // Remote work arriving through the Yjs binding is not this user typing.
    if (tr.annotation(ySyncAnnotation) !== undefined) return tr;

    const changes: PendingChange[] = [];
    tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
      changes.push({ from: fromA, to: toA, inserted: inserted.toString(), resultFrom: fromB });
    });
    if (changes.length === 0) return tr;

    if (!suggesting) {
      // Let CodeMirror and y-codemirror apply the edit normally so native history, IME,
      // selection and composition behavior stay intact. Once the insert exists in Y.Text,
      // add its durable author mark without changing a byte of visible text.
      queueMicrotask(() => {
        if (!text?.doc || !author) return;
        text.doc.transact(() => {
          for (const change of changes) {
            if (change.inserted.length > 0) {
              text!.format(change.resultFrom, change.inserted.length, { [ATTR_AUTHOR]: author!.id });
            }
          }
        }, authorOrigin(author.id));
      });
      return tr;
    }

    // Rewrite outside the filter: mutating the document from inside a transaction filter
    // re-enters the editor mid-update.
    queueMicrotask(() => applyAsSuggestion(changes));

    // Cancel the direct edit. The marked version arrives through the Yjs binding.
    return [];
  });
}

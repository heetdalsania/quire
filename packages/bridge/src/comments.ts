import * as Y from "yjs";

export interface CommentThread {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: number;
  resolved: boolean;
  /** Text the comment was originally attached to, used to explain orphans. */
  quote: string;
  /** Resolved character range, or null if the anchored text is gone. */
  range: { from: number; to: number } | null;
  orphaned: boolean;
}

const COMMENTS_KEY = "comments";

/**
 * Comments anchored with Y.RelativePosition so they ride along with concurrent edits
 * instead of pointing at a stale offset.
 *
 * Orphan policy: when the anchored text is deleted outright the relative position stops
 * resolving. Rather than dropping the thread (losing a real conversation) or silently
 * reattaching it somewhere arbitrary, it is kept and flagged `orphaned`, carrying the
 * quote it was originally attached to so a human can see what was being discussed.
 */
export class CommentStore {
  private readonly array: Y.Array<Y.Map<unknown>>;

  constructor(private readonly doc: Y.Doc) {
    this.array = doc.getArray<Y.Map<unknown>>(COMMENTS_KEY);
  }

  get yarray(): Y.Array<Y.Map<unknown>> {
    return this.array;
  }

  add(input: {
    text: Y.Text;
    from: number;
    to: number;
    body: string;
    authorId: string;
    authorName: string;
  }): string {
    const id = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const start = Y.createRelativePositionFromTypeIndex(input.text, input.from);
    const end = Y.createRelativePositionFromTypeIndex(input.text, input.to);

    const entry = new Y.Map<unknown>();
    this.doc.transact(() => {
      entry.set("id", id);
      entry.set("authorId", input.authorId);
      entry.set("authorName", input.authorName);
      entry.set("body", input.body);
      entry.set("createdAt", Date.now());
      entry.set("resolved", false);
      entry.set("quote", input.text.toString().slice(input.from, input.to));
      entry.set("start", Y.encodeRelativePosition(start));
      entry.set("end", Y.encodeRelativePosition(end));
      this.array.push([entry]);
    }, "comments");
    return id;
  }

  list(): CommentThread[] {
    const out: CommentThread[] = [];
    for (const entry of this.array) {
      const start = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(entry.get("start") as Uint8Array),
        this.doc,
      );
      const end = Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(entry.get("end") as Uint8Array),
        this.doc,
      );
      // A zero-width resolution means the quoted text itself was deleted.
      const alive = start !== null && end !== null && end.index > start.index;
      out.push({
        id: entry.get("id") as string,
        authorId: entry.get("authorId") as string,
        authorName: entry.get("authorName") as string,
        body: entry.get("body") as string,
        createdAt: entry.get("createdAt") as number,
        resolved: entry.get("resolved") as boolean,
        quote: entry.get("quote") as string,
        range: alive ? { from: start.index, to: end.index } : null,
        orphaned: !alive,
      });
    }
    return out.sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity));
  }

  setResolved(id: string, resolved: boolean): void {
    this.doc.transact(() => {
      for (const entry of this.array) {
        if (entry.get("id") === id) entry.set("resolved", resolved);
      }
    }, "comments");
  }

  remove(id: string): void {
    this.doc.transact(() => {
      for (let i = 0; i < this.array.length; i++) {
        if (this.array.get(i)?.get("id") === id) {
          this.array.delete(i, 1);
          return;
        }
      }
    }, "comments");
  }
}

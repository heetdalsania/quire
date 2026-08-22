import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { type Author, registerAuthor } from "@quire/bridge";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

/**
 * A live editing session held by an agent against one Quire document.
 *
 * The point of the whole wedge: the agent is not rewriting a file behind everyone's
 * back, it is a peer in the same CRDT session as the humans -- so its cursor is
 * visible, its edits are attributed, and a human can type straight through them.
 */
export class AgentSession {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: Awareness;
  private ws: WebSocket | null = null;
  private synced = false;

  constructor(
    private readonly baseUrl: string,
    readonly path: string,
    private readonly author: Author,
  ) {
    this.text = this.doc.getText("content");
    this.awareness = new Awareness(this.doc);
  }

  async connect(timeoutMs = 8000): Promise<void> {
    const url = new URL(`/sync?doc=${encodeURIComponent(this.path)}`, this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url.toString());
    this.ws = ws;

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.baseUrl}`)), timeoutMs);

      ws.on("open", () => {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        writeSyncStep1(enc, this.doc);
        ws.send(encoding.toUint8Array(enc));
        this.announce();
      });

      ws.on("message", (data: Buffer) => {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const enc = encoding.createEncoder();
        const type = decoding.readVarUint(decoder);
        if (type === MSG_SYNC) {
          encoding.writeVarUint(enc, MSG_SYNC);
          const step = readSyncMessage(decoder, enc, this.doc, this);
          if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));

          // Only step 2 (or a subsequent update) actually carries the document. The
          // server opens with step 1, and resolving on that would hand the agent an
          // empty document to edit.
          if (!this.synced && (step === SYNC_STEP_2 || step === SYNC_UPDATE)) {
            this.synced = true;
            clearTimeout(timer);
            resolve();
          }
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Publish presence so the agent shows up in the UI with a cursor like anyone else. */
  announce(cursor?: { anchor: number; head: number }): void {
    // Durable identity, so the agent's spans stay attributed after it disconnects.
    registerAuthor(this.doc, this.author);
    this.awareness.setLocalStateField("user", {
      name: this.author.name,
      color: this.author.color,
      kind: this.author.kind,
    });
    if (cursor) {
      this.awareness.setLocalStateField("cursor", {
        anchor: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, cursor.anchor)),
        head: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, cursor.head)),
      });
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    this.send(encoding.toUint8Array(enc));
  }

  private send(payload: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload);
  }

  /** Give the server a moment to broadcast and the vault to write to disk. */
  async settle(ms = 250): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  close(): void {
    this.awareness.destroy();
    this.ws?.close();
    this.doc.destroy();
  }
}

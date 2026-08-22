import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import type * as Y from "yjs";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_EPOCH = 2;

/**
 * Minimal Yjs websocket client speaking the same protocol as @quire/server.
 * Deliberately not y-websocket: that package assumes a room-name-in-path URL scheme,
 * and a document path is not a room name.
 */
export class SyncProvider {
  readonly awareness: Awareness;
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;

  private epoch: string | null = null;

  constructor(
    private readonly url: string,
    readonly doc: Y.Doc,
    private readonly onStatus: (connected: boolean) => void,
    /** Called when the server's document lineage changed and local state must be dropped. */
    private readonly onStale: () => void = () => location.reload(),
  ) {
    this.awareness = new Awareness(doc);

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });

    this.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>) => {
      const changed = [...(added ?? []), ...(updated ?? []), ...(removed ?? [])];
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(this.awareness, changed));
      this.send(encoding.toUint8Array(enc));
    });

    window.addEventListener("beforeunload", () => {
      removeAwarenessStates(this.awareness, [this.doc.clientID], "unload");
    });

    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onStatus(true);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      writeSyncStep1(enc, this.doc);
      ws.send(encoding.toUint8Array(enc));
    };

    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const decoder = decoding.createDecoder(new Uint8Array(event.data));
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(decoder);
      if (type === MSG_SYNC) {
        encoding.writeVarUint(enc, MSG_SYNC);
        readSyncMessage(decoder, enc, this.doc, this);
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
      } else if (type === MSG_EPOCH) {
        const epoch = decoding.readVarString(decoder);
        if (this.epoch === null) {
          this.epoch = epoch;
        } else if (this.epoch !== epoch) {
          // The server restarted. Merging our stale doc would duplicate the document,
          // so drop it and rebuild from the server instead.
          this.closed = true;
          ws.close();
          this.onStale();
        }
      }
    };

    ws.onclose = () => {
      this.onStatus(false);
      if (this.closed) return;
      // Back off, but stay responsive: a dropped laptop lid should reconnect quickly.
      const delay = Math.min(1000 * 2 ** this.retry++, 10_000);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private send(payload: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload);
  }

  destroy(): void {
    this.closed = true;
    removeAwarenessStates(this.awareness, [this.doc.clientID], "destroy");
    this.awareness.destroy();
    this.ws?.close();
  }
}

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import type { DocHandle } from "@quire/bridge";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** One collaborative session over a single document. */
export class Room {
  readonly awareness: Awareness;
  private readonly sockets = new Set<WebSocket>();

  constructor(readonly handle: DocHandle) {
    this.awareness = new Awareness(handle.doc);
    this.awareness.setLocalState(null);

    handle.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin instanceof Object ? origin : null);
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        const changed = [...added, ...updated, ...removed];
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_AWARENESS);
        encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(this.awareness, changed));
        this.broadcast(encoding.toUint8Array(encoder), null);
      },
    );
  }

  get size(): number {
    return this.sockets.size;
  }

  add(socket: WebSocket): void {
    this.sockets.add(socket);

    // Sync step 1: ask the client what it has.
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MSG_SYNC);
    writeSyncStep1(sync, this.handle.doc);
    socket.send(encoding.toUint8Array(sync));

    // Seed the newcomer with everyone's presence.
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      socket.send(encoding.toUint8Array(enc));
    }

    socket.on("message", (data: ArrayBufferLike) => this.onMessage(socket, new Uint8Array(data as ArrayBuffer)));
    socket.on("close", () => this.remove(socket));
    socket.on("error", () => this.remove(socket));
  }

  private onMessage(socket: WebSocket, message: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(message);
      const encoder = encoding.createEncoder();
      const type = decoding.readVarUint(decoder);

      if (type === MSG_SYNC) {
        encoding.writeVarUint(encoder, MSG_SYNC);
        // `socket` as origin keeps the update from being echoed to its sender.
        readSyncMessage(decoder, encoder, this.handle.doc, socket);
        if (encoding.length(encoder) > 1) socket.send(encoding.toUint8Array(encoder));
      } else if (type === MSG_AWARENESS) {
        applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), socket);
      }
    } catch {
      // A malformed frame from one client must never take the room down.
    }
  }

  private remove(socket: WebSocket): void {
    if (!this.sockets.delete(socket)) return;
    const ids = [...this.awareness.getStates().keys()].filter(
      (id) => this.awareness.meta.get(id)?.clock !== undefined && id !== this.handle.doc.clientID,
    );
    removeAwarenessStates(this.awareness, ids.filter((id) => !this.hasSocketFor(id)), socket);
  }

  private hasSocketFor(_clientId: number): boolean {
    // Presence is reaped on disconnect by the awareness timeout; keeping this explicit
    // rather than guessing which socket owned which clientID.
    return this.sockets.size > 0;
  }

  private broadcast(payload: Uint8Array, exclude: unknown): void {
    for (const socket of this.sockets) {
      if (socket === exclude) continue;
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  destroy(): void {
    this.awareness.destroy();
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }
}

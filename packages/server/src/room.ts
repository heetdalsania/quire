import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import type { DocHandle } from "@quire/bridge";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
/** Server -> client only: identifies the document state lineage. See Room.add. */
const MSG_EPOCH = 2;

/** One collaborative session over a single document. */
export class Room {
  readonly awareness: Awareness;
  private readonly sockets = new Set<WebSocket>();
  /**
   * Which awareness client ids each socket speaks for.
   *
   * Presence has to be reaped per socket, not per room. Clearing everything only when
   * the last peer leaves strands a departed collaborator's avatar on everyone else's
   * screen for the rest of the session.
   */
  private readonly ownedClients = new Map<WebSocket, Set<number>>();

  constructor(
    readonly handle: DocHandle,
    private readonly epoch: string,
  ) {
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
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        // Attribute these ids to the socket that announced them, so they can be reaped
        // when it goes away.
        const owner = this.ownedClients.get(origin as WebSocket);
        if (owner) {
          for (const id of added) owner.add(id);
          for (const id of updated) owner.add(id);
          for (const id of removed) owner.delete(id);
        }

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
    this.ownedClients.set(socket, new Set());

    // Epoch first, before any sync traffic.
    //
    // Each server process seeds its Y.Doc from disk with a fresh clientID, so a client
    // still holding state from a previous process would merge that state in as genuinely
    // concurrent content -- Yjs has no way to know the identical characters are the same
    // text, so it concatenates and the document silently doubles. Restarting the server
    // with a tab open used to corrupt every open file. The client compares this epoch and
    // discards its local doc instead of merging when the lineage has changed.
    const epochMsg = encoding.createEncoder();
    encoding.writeVarUint(epochMsg, MSG_EPOCH);
    encoding.writeVarString(epochMsg, this.epoch);
    socket.send(encoding.toUint8Array(epochMsg));

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
    const owned = this.ownedClients.get(socket);
    this.ownedClients.delete(socket);
    if (owned && owned.size > 0) {
      removeAwarenessStates(this.awareness, [...owned], "disconnect");
    }
  }

  private broadcast(payload: Uint8Array, exclude: unknown): void {
    for (const socket of this.sockets) {
      if (socket === exclude) continue;
      if (socket.readyState === 1) socket.send(payload);
    }
  }

  destroy(): void {
    this.ownedClients.clear();
    this.awareness.destroy();
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }
}

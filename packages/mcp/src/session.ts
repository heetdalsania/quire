import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { type AgentPolicy, type Author, readPolicy, registerAuthor, registerRun, newRunId } from "@quire/bridge";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_EPOCH = 2;
const MSG_NOTICE = 3;
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
  /** Refusals from the server, e.g. an exhausted leash. Surfaced to the agent verbatim. */
  readonly notices: string[] = [];

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
    // Declaring itself an agent is what puts this connection on a leash. It is declared
    // rather than sniffed because an agent that hides is a worse failure than one that
    // is trusted to say so and then constrained by the server regardless.
    url.searchParams.set("kind", "agent");
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
        if (type === MSG_NOTICE) {
          this.notices.push(decoding.readVarString(decoder));
          return;
        }
        if (type === MSG_EPOCH) return;
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

  /** The leash this document puts on agents. */
  policy(): AgentPolicy {
    return readPolicy(this.doc);
  }

  /**
   * Record why this edit is happening, and return the run id to mark spans with.
   *
   * Provenance for prose usually stops at "who". Keeping the instruction alongside the
   * text answers "why", which for a spec or a policy is the more useful question.
   */
  beginRun(tool: string, prompt: string | null, model: string | null): string {
    const id = newRunId();
    registerRun(this.doc, { id, authorId: this.author.id, model, prompt, tool });
    return id;
  }

  /**
   * Where the humans are right now.
   *
   * Presence is broadcast continuously, so an agent can see a person's cursor before it
   * starts rewriting the paragraph they are sitting in.
   */
  humanCursors(): Array<{ name: string; index: number }> {
    const out: Array<{ name: string; index: number }> = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const peer = state as {
        user?: { name?: string; kind?: string };
        cursor?: { head?: unknown };
      };
      if (peer.user?.kind === "agent") continue;
      const head = peer.cursor?.head;
      if (!head) continue;
      try {
        const abs = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(new Uint8Array(Object.values(head as Record<string, number>))),
          this.doc,
        );
        if (abs) out.push({ name: peer.user?.name ?? "Someone", index: abs.index });
      } catch {
        // A cursor we cannot resolve is one we cannot avoid; ignore it rather than throw.
      }
    }
    return out;
  }

  close(): void {
    this.awareness.destroy();
    this.ws?.close();
    this.doc.destroy();
  }
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { QuireServer } from "../src/index.js";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_EPOCH = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let server: QuireServer;
let port: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quire-life-"));
  await writeFile(join(dir, "doc.md"), "start\n", "utf8");
  server = await QuireServer.start({ root: dir, port: 0, git: false });
  port = server.port;
});

afterEach(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

/** A minimal browser-equivalent client speaking Quire's wire protocol. */
class TestClient {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: Awareness;
  private ws!: WebSocket;

  constructor(private readonly name: string) {
    this.text = this.doc.getText("content");
    this.awareness = new Awareness(this.doc);
  }

  async connect(port: number, path = "doc.md"): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/sync?doc=${path}`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      writeUpdate(e, u);
      this.send(encoding.toUint8Array(e));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
      this.ws.on("open", () => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        writeSyncStep1(e, this.doc);
        this.ws.send(encoding.toUint8Array(e));
      });
      this.ws.on("message", (data: Buffer) => {
        const dec = decoding.createDecoder(new Uint8Array(data));
        const enc = encoding.createEncoder();
        const type = decoding.readVarUint(dec);
        if (type === MSG_SYNC) {
          encoding.writeVarUint(enc, MSG_SYNC);
          const step = readSyncMessage(dec, enc, this.doc, this);
          if (encoding.length(enc) > 1) this.ws.send(encoding.toUint8Array(enc));
          if (step === 1 || step === 2) { clearTimeout(timer); resolve(); }
        } else if (type === MSG_AWARENESS) {
          applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), this);
        } else if (type === MSG_EPOCH) {
          decoding.readVarString(dec);
        }
      });
      this.ws.on("error", reject);
    });
  }

  announce(): void {
    this.awareness.setLocalStateField("user", { name: this.name, color: "#000", kind: "human" });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    encoding.writeVarUint8Array(e, encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    this.send(encoding.toUint8Array(e));
  }

  private send(payload: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(payload);
  }

  close(): void { this.ws.close(); }
}

describe("presence lifecycle", () => {
  it("drops a peer's presence when only that peer disconnects", async () => {
    const a = new TestClient("A");
    const b = new TestClient("B");
    await a.connect(port);
    await b.connect(port);
    a.announce();
    b.announce();
    await sleep(400);

    const room = server.rooms.get("doc.md")!;
    expect(room.awareness.getStates().size).toBe(2);

    b.close();
    await sleep(600);

    // B is gone; A must survive. A stale avatar for a departed collaborator is the
    // most visible possible bug in a presence UI.
    expect(room.awareness.getStates().size).toBe(1);
    expect([...room.awareness.getStates().values()].map((s) => (s as any).user.name)).toEqual(["A"]);

    a.close();
  });

  it("clears all presence once everyone has left", async () => {
    const a = new TestClient("A");
    await a.connect(port);
    a.announce();
    await sleep(300);
    a.close();
    await sleep(600);
    expect(server.rooms.get("doc.md")!.awareness.getStates().size).toBe(0);
  });
});

describe("concurrency", () => {
  it("converges with eight clients editing the same document at once", async () => {
    const clients = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const c = new TestClient(`C${i}`);
        await c.connect(port);
        return c;
      }),
    );

    await Promise.all(
      clients.map(async (c, i) => {
        for (let n = 0; n < 12; n++) {
          c.doc.transact(() => c.text.insert(c.text.length, `c${i}-${n} `));
          await sleep(4);
        }
      }),
    );
    await sleep(1500);

    const texts = clients.map((c) => c.text.toString());
    // Every replica agrees, and nothing was lost.
    expect(new Set(texts).size).toBe(1);
    for (let i = 0; i < 8; i++) {
      for (let n = 0; n < 12; n++) expect(texts[0]).toContain(`c${i}-${n}`);
    }
    expect(server.vault.getDoc("doc.md").getContent()).toBe(texts[0]);

    await sleep(400);
    expect(await readFile(join(dir, "doc.md"), "utf8")).toBe(texts[0]);
    for (const c of clients) c.close();
  }, 40_000);

  it("survives rapid connect/disconnect churn", async () => {
    for (let round = 0; round < 12; round++) {
      const c = new TestClient(`churn${round}`);
      await c.connect(port);
      c.announce();
      c.doc.transact(() => c.text.insert(c.text.length, `r${round} `));
      c.close();
    }
    await sleep(900);
    const content = server.vault.getDoc("doc.md").getContent();
    for (let round = 0; round < 12; round++) expect(content).toContain(`r${round}`);
    expect(server.rooms.get("doc.md")!.awareness.getStates().size).toBe(0);
  }, 30_000);
});

describe("many documents", () => {
  it("indexes and serves a few hundred documents", async () => {
    await Promise.all(
      Array.from({ length: 250 }, (_, i) =>
        writeFile(join(dir, `bulk-${i}.md`), `# Bulk ${i}\n\ncontent ${i}\n`, "utf8"),
      ),
    );
    await sleep(2500);
    const { files } = (await (await fetch(`http://127.0.0.1:${port}/api/files`)).json()) as { files: string[] };
    expect(files.length).toBeGreaterThanOrEqual(250);
    expect(server.vault.getDoc("bulk-249.md").getContent()).toContain("content 249");
  }, 40_000);
});

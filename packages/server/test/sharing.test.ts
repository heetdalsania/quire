import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { QuireServer } from "../src/index.js";
import { ShareRegistry } from "../src/sharing.js";

const MSG_SYNC = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let server: QuireServer;
let port: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quire-share-"));
  await writeFile(join(dir, "doc.md"), "original\n", "utf8");
  server = await QuireServer.start({ root: dir, port: 0, git: false });
  port = server.port;
});
afterEach(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

/** Connect with an optional share token and try to write. */
async function connectAndEdit(token: string | null, insert: string): Promise<{ text: string; open: boolean }> {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const url = new URL(`ws://127.0.0.1:${port}/sync`);
  url.searchParams.set("doc", "doc.md");
  if (token) url.searchParams.set("share", token);

  const ws = new WebSocket(url.toString(), { headers: { Origin: `http://127.0.0.1:${port}` } });
  const opened = await new Promise<boolean>((resolve) => {
    ws.on("open", () => resolve(true));
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
    setTimeout(() => resolve(false), 2500);
  });
  if (!opened) return { text: "", open: false };

  ws.on("message", (data: Buffer) => {
    const dec = decoding.createDecoder(new Uint8Array(data));
    const enc = encoding.createEncoder();
    if (decoding.readVarUint(dec) !== MSG_SYNC) return;
    encoding.writeVarUint(enc, MSG_SYNC);
    readSyncMessage(dec, enc, doc, "peer");
    if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
  });

  const step1 = encoding.createEncoder();
  encoding.writeVarUint(step1, MSG_SYNC);
  writeSyncStep1(step1, doc);
  ws.send(encoding.toUint8Array(step1));
  await sleep(350);

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "peer") return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  });
  doc.transact(() => text.insert(0, insert));
  await sleep(450);

  const received = text.toString();
  ws.close();
  return { text: received, open: true };
}

describe("share links", () => {
  it("enforces view-only on the server, not in the UI", async () => {
    const share = server.shares.create({ role: "view", path: "doc.md" });
    const result = await connectAndEdit(share.token, "VANDALISM ");

    expect(result.open).toBe(true);
    // The holder receives the document...
    expect(result.text).toContain("original");
    // ...but their write is dropped at the server, so the vault is untouched.
    await sleep(200);
    expect(server.vault.getDoc("doc.md").getContent()).toBe("original\n");
    expect(server.vault.getDoc("doc.md").getContent()).not.toContain("VANDALISM");
  });

  it("lets an edit link write", async () => {
    const share = server.shares.create({ role: "edit", path: "doc.md" });
    await connectAndEdit(share.token, "ALLOWED ");
    await sleep(300);
    expect(server.vault.getDoc("doc.md").getContent()).toContain("ALLOWED");
  });

  it("refuses a token scoped to a different document", async () => {
    await writeFile(join(dir, "other.md"), "other\n", "utf8");
    await sleep(400);
    const share = server.shares.create({ role: "edit", path: "other.md" });
    const result = await connectAndEdit(share.token, "WRONG DOC ");
    expect(result.open).toBe(false);
  });

  it("refuses an unknown or revoked token", async () => {
    const share = server.shares.create({ role: "edit", path: "doc.md" });
    server.shares.revoke(share.token);
    expect((await connectAndEdit(share.token, "x")).open).toBe(false);
    expect((await connectAndEdit("not-a-real-token", "x")).open).toBe(false);
  });

  it("still allows the local owner with no token at all", async () => {
    const result = await connectAndEdit(null, "OWNER ");
    expect(result.open).toBe(true);
    await sleep(300);
    expect(server.vault.getDoc("doc.md").getContent()).toContain("OWNER");
  });
});

describe("share registry", () => {
  it("expires timed links", () => {
    const shares = new ShareRegistry();
    const share = shares.create({ role: "view", ttlMs: -1 });
    expect(shares.resolve(share.token)).toBeNull();
  });

  it("scopes a whole-vault link to every document", () => {
    const shares = new ShareRegistry();
    const share = shares.create({ role: "comment", path: null });
    expect(shares.roleFor(share.token, "anything.md")).toBe("comment");
  });
});

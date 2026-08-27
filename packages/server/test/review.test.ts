import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  type Author,
  acceptSuggestion,
  insertAttributed,
  isCommentOnlyUpdate,
  registerAuthor,
  proposeDelete,
  rejectSuggestion,
  suggestionOutcomes,
  updateTargets,
} from "@quire/bridge";
import { QuireServer } from "../src/index.js";
import { collectReceipt, renderReceipt } from "../src/receipt.js";

const MSG_SYNC = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const agent: Author = { id: "a1", name: "Claude", color: "#ea9d34", kind: "agent" };
const human: Author = { id: "h1", name: "Heet", color: "#907aa9", kind: "human" };

let dir: string;
let server: QuireServer;
let base: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quire-review-"));
  await writeFile(join(dir, "spec.md"), "# Spec\n\nOriginal prose.\n", "utf8");
  server = await QuireServer.start({ root: dir, port: 0, git: false, history: true });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

/** Connect with a share token and attempt an edit of a given kind. */
async function attempt(
  token: string | null,
  mutate: (doc: Y.Doc) => void,
): Promise<{ open: boolean }> {
  const doc = new Y.Doc();
  const url = new URL(`ws://127.0.0.1:${server.port}/sync`);
  url.searchParams.set("doc", "spec.md");
  if (token) url.searchParams.set("share", token);

  const ws = new WebSocket(url.toString(), { headers: { Origin: base } });
  const open = await new Promise<boolean>((resolve) => {
    ws.on("open", () => resolve(true));
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
    setTimeout(() => resolve(false), 2500);
  });
  if (!open) return { open: false };

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
  mutate(doc);
  await sleep(450);
  ws.close();
  return { open: true };
}

describe("comment-only links are enforced, not merely respected", () => {
  it("drops an attempt to edit the prose", async () => {
    const share = server.shares.create({ role: "comment", path: "spec.md" });
    await attempt(share.token, (doc) => doc.getText("content").insert(0, "VANDALISM "));
    await sleep(200);

    // Enforced at the server, so hiding the editor was never the protection.
    expect(server.vault.getDoc("spec.md").getContent()).not.toContain("VANDALISM");
    expect(server.vault.getDoc("spec.md").getContent()).toContain("Original prose");
  });

  it("accepts a comment from the same link", async () => {
    const share = server.shares.create({ role: "comment", path: "spec.md" });
    await attempt(share.token, (doc) => {
      doc.getArray("comments").push([{ id: "c1", body: "Is this still true?" }]);
    });
    await sleep(250);
    expect(server.vault.getDoc("spec.md").doc.getArray("comments").length).toBe(1);
  });

  it("still lets an edit link edit", async () => {
    const share = server.shares.create({ role: "edit", path: "spec.md" });
    await attempt(share.token, (doc) => doc.getText("content").insert(0, "ALLOWED "));
    await sleep(250);
    expect(server.vault.getDoc("spec.md").getContent()).toContain("ALLOWED");
  });
});

describe("update classification", () => {
  it("names the root types an update touches", () => {
    const doc = new Y.Doc();
    const before = Y.encodeStateVector(doc);
    doc.getText("content").insert(0, "prose");
    expect([...updateTargets(Y.encodeStateAsUpdate(doc, before), doc)]).toEqual(["content"]);

    const mid = Y.encodeStateVector(doc);
    doc.getArray("comments").push([{ id: "c" }]);
    expect([...updateTargets(Y.encodeStateAsUpdate(doc, mid), doc)]).toEqual(["comments"]);
  });

  it("recognises a deletion of prose, not just an insertion", () => {
    // Deletions carry clock ranges rather than parent names, so they have to be resolved
    // against the document -- otherwise a reviewer could delete freely.
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "delete me please");
    const before = Y.encodeStateVector(doc);
    doc.getText("content").delete(0, 6);

    const update = Y.encodeStateAsUpdate(doc, before);
    expect(isCommentOnlyUpdate(update, doc)).toBe(false);
    expect([...updateTargets(update, doc)]).toContain("content");
  });

  it("treats an unclassifiable update as not comment-safe", () => {
    expect(isCommentOnlyUpdate(new Uint8Array([7, 7, 7]), new Y.Doc())).toBe(false);
  });
});

describe("review requests", () => {
  it("carries a brief the reviewer can read before doing anything", async () => {
    const res = await fetch(
      `${base}/api/share?role=comment&path=spec.md&brief=${encodeURIComponent("Does this read clearly?")}&by=Heet`,
      { method: "POST" },
    );
    const { token } = (await res.json()) as { token: string };

    // Holding the token is the permission, so the brief is readable with nothing else.
    const info = (await (await fetch(`${base}/api/share/info?token=${token}`)).json()) as {
      role: string; brief: string; requestedBy: string; path: string;
    };
    expect(info.role).toBe("comment");
    expect(info.brief).toBe("Does this read clearly?");
    expect(info.requestedBy).toBe("Heet");
    expect(info.path).toBe("spec.md");
  });

  it("reports an unknown or expired link plainly", async () => {
    expect((await fetch(`${base}/api/share/info?token=nope`)).status).toBe(404);
    const expired = server.shares.create({ role: "comment", ttlMs: -1 });
    expect((await fetch(`${base}/api/share/info?token=${expired.token}`)).status).toBe(404);
  });

  it("caps a brief rather than storing whatever is sent", async () => {
    const res = await fetch(`${base}/api/share?role=comment&brief=${"x".repeat(5000)}`, { method: "POST" });
    const { token } = (await res.json()) as { token: string };
    const info = (await (await fetch(`${base}/api/share/info?token=${token}`)).json()) as { brief: string };
    expect(info.brief.length).toBeLessThanOrEqual(600);
  });
});

describe("suggestion outcomes", () => {
  it("records acceptance and rejection, which cannot be reconstructed later", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "Base. ");

    insertAttributed(text, text.length, "Accepted idea.", agent, { suggestion: "s1" });
    acceptSuggestion(text, "s1");
    insertAttributed(text, text.length, "Rejected idea.", agent, { suggestion: "s2" });
    rejectSuggestion(text, "s2");

    const outcomes = suggestionOutcomes(doc);
    expect(outcomes.map((o) => o.action)).toEqual(["accepted", "rejected"]);
    expect(outcomes.every((o) => o.authorId === agent.id)).toBe(true);
    // Once resolved, the marks describing a suggestion are gone -- hence the log.
    expect(text.toString()).toContain("Accepted idea.");
    expect(text.toString()).not.toContain("Rejected idea.");
  });

  it("records a proposed deletion's outcome too", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "keep this remove this");
    proposeDelete(text, 10, 21, agent, "s3");
    acceptSuggestion(text, "s3");
    expect(suggestionOutcomes(doc)).toHaveLength(1);
    expect(text.toString()).toBe("keep this ");
  });
});

describe("the receipt", () => {
  it("reports what a document is made of", () => {
    const handle = server.vault.getDoc("spec.md");
    // Identities have to be registered, or every span reads as unattributed.
    registerAuthor(handle.doc, human);
    registerAuthor(handle.doc, agent);
    insertAttributed(handle.text, handle.text.length, "A human sentence.", human);
    insertAttributed(handle.text, handle.text.length, "An agent sentence.", agent);

    const data = collectReceipt(handle, { replay: false });
    expect(data.path).toBe("spec.md");
    expect(data.humanShare).toBeGreaterThan(0);
    expect(data.agentShare).toBeGreaterThan(0);
    expect(data.contributors.length).toBeGreaterThanOrEqual(2);
  });

  it("renders a self-contained page with no external requests", () => {
    const handle = server.vault.getDoc("spec.md");
    insertAttributed(handle.text, handle.text.length, "Words.", human);
    const html = renderReceipt(collectReceipt(handle, { replay: false }));

    expect(html).toContain("<!doctype html>");
    // Nothing fetched: it must still work years later, offline, from an email attachment.
    expect(html).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']http/);
    expect(html).toContain("provenance receipt");
  });

  it("escapes document content rather than injecting it", () => {
    const handle = server.vault.getDoc("spec.md");
    insertAttributed(handle.text, 0, "<script>alert(1)</script>", human);
    const html = renderReceipt(collectReceipt(handle, { replay: true, maxFrames: 4 }));
    // The replay payload is JSON in a script tag, so "</script>" must not close it early.
    expect(html).not.toContain("</script>alert");
    expect(html).toContain("\\u003c");
  });

  it("shows the on-disk text, not un-accepted proposals", () => {
    const handle = server.vault.getDoc("spec.md");
    insertAttributed(handle.text, handle.text.length, "PROPOSED ONLY", agent, { suggestion: "s9" });
    const data = collectReceipt(handle, { replay: true, maxFrames: 6 });
    // A receipt asserts what the file said. It never said this.
    expect(data.frames.every((f) => !f.text.includes("PROPOSED ONLY"))).toBe(true);
  });
});

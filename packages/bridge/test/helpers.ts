import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { CONTENT_KEY, type DocHandle } from "../src/index.js";

export async function makeTempVaultDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "quire-spike-"));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds, or throw with a useful message. */
export async function waitFor(
  predicate: () => boolean,
  message = "condition",
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${message}`);
}

const FROM_PEER = Symbol("test:from-peer");

/**
 * A simulated browser client: its own Y.Doc, kept in sync with a vault document by
 * relaying updates both ways. This mirrors what y-websocket does in production, so
 * edits made here reach the vault exactly as a real collaborator's would.
 */
export interface Client {
  doc: Y.Doc;
  text: Y.Text;
  content: () => string;
  disconnect: () => void;
  reconnect: () => void;
}

export function connectClient(handle: DocHandle): Client {
  const doc = new Y.Doc();
  const text = doc.getText(CONTENT_KEY);
  const origin = Symbol("test:client");
  let connected = true;

  Y.applyUpdate(doc, Y.encodeStateAsUpdate(handle.doc), FROM_PEER);

  const fromVault = (update: Uint8Array, updateOrigin: unknown): void => {
    if (!connected || updateOrigin === origin) return;
    Y.applyUpdate(doc, update, FROM_PEER);
  };
  const toVault = (update: Uint8Array, updateOrigin: unknown): void => {
    if (!connected || updateOrigin === FROM_PEER) return;
    Y.applyUpdate(handle.doc, update, origin);
  };

  handle.doc.on("update", fromVault);
  doc.on("update", toVault);

  return {
    doc,
    text,
    content: () => text.toString(),
    disconnect: () => {
      connected = false;
    },
    reconnect: () => {
      connected = true;
      // Exchange missing state in both directions, as a real reconnect would.
      const vaultUpdate = Y.encodeStateAsUpdate(handle.doc, Y.encodeStateVector(doc));
      const clientUpdate = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(handle.doc));
      Y.applyUpdate(doc, vaultUpdate, FROM_PEER);
      Y.applyUpdate(handle.doc, clientUpdate, origin);
    },
  };
}

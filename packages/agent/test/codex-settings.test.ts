import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { codexDeliverySettings } from "../src/codex-settings.js";
import type { NativeRpc } from "../src/native-rpc.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "quire-codex-settings-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const origin = { provider: "codex" as const, sessionId: "parent", turnId: "delivery" };
const threads = () => new Map<string, any>();
const rpc = (data: Map<string, any>) => ({ request: async (_: string, { threadId }: { threadId: string }) => ({ thread: data.get(threadId) }) }) as NativeRpc;
async function fixture(data: Map<string, any>, id: string, contexts: any[], parent?: string) {
  const path = join(root, `${id}.jsonl`);
  await writeFile(path, [{ type: "session_meta", payload: { id, model_provider: "recorded-provider", forked_from_id: parent } },
    ...contexts.map(payload => ({ type: "turn_context", payload }))].map(row => JSON.stringify(row)).join("\n"));
  data.set(id, { id, path, forkedFromId: parent, turns: [{ id: "delivery", status: "completed" }] });
}
it("uses the exact delivery settings, not a later model or current profile default", async () => {
  const data = threads();
  await fixture(data, "parent", [
    { turn_id: "delivery", model: "delivery-model", effort: "high" },
    { turn_id: "later", model: "later-model", effort: "low" },
  ]);
  expect(await codexDeliverySettings(rpc(data), origin)).toEqual({ model: "delivery-model", modelProvider: "recorded-provider", config: { model_reasoning_effort: "high" } });
});
it("follows a verified native fork reference when the delivery context is inherited", async () => {
  const data = threads();
  await fixture(data, "parent", [], "ancestor");
  await fixture(data, "ancestor", [{ turn_id: "delivery", model: "inherited-model" }]);
  expect(await codexDeliverySettings(rpc(data), origin)).toEqual({ model: "inherited-model", modelProvider: "recorded-provider", config: {} });
});
it("refuses cycles, missing context and mismatched native file identity", async () => {
  const data = threads();
  await fixture(data, "parent", [], "ancestor"); await fixture(data, "ancestor", [], "parent");
  await expect(codexDeliverySettings(rpc(data), origin)).rejects.toThrow(/exact delivery/);
  data.get("parent").path = data.get("ancestor").path;
  await expect(codexDeliverySettings(rpc(data), origin)).rejects.toThrow(/different session/);
});
it("refuses unknown reasoning metadata before any native fork or turn", async () => {
  const data = threads();
  await fixture(data, "parent", [{ turn_id: "delivery", model: "delivery-model", effort: "future-effort" }]);
  await expect(codexDeliverySettings(rpc(data), origin)).rejects.toThrow(/Unsupported.*reasoning/);
});

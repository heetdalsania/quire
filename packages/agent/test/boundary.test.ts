import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
it.each(["docs/native-handoff.md", "SECURITY.md"])("discloses the native filesystem boundary in %s", async file => {
  const content = await readFile(new URL(file, root), "utf8");
  expect(content).toMatch(/filesystem[\s\S]{0,80}retain their existing permissions/);
  expect(content).toMatch(/bypass[\s\S]{0,30}review/);
});
it("keeps installed Codex checks explicit, model-free, and outside normal CI", async () => {
  const script = await readFile(new URL("scripts/check-codex-native.mjs", root), "utf8");
  expect(script).toContain('process.env.QUIRE_CHECK_CODEX_NATIVE !== "1"');
  expect(script).not.toContain('rpc.request("turn/start"');
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  expect(JSON.stringify(pkg.scripts)).not.toContain("check-codex-native");
  const agent = JSON.parse(await readFile(new URL("packages/agent/package.json", root), "utf8"));
  expect(Object.keys(agent.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "@quire/bridge", "yjs"]);
});

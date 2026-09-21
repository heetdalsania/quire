import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/quire.js", import.meta.url));
it.each([
  ["--origin-provider", "codex"],
  ["--doc", "report.md", "--origin-session", "source"],
  ["--doc", "report.md", "--origin-provider", "hermes", "--origin-session", "source", "--origin-turn", "delivery"],
  ["--doc", "report.md", "--origin-label", "Review"],
  ["--doc"],
  ["--doc", "report.md", "--origin-provider", "codex", "--origin-session", "source", "--origin-turn"],
  ["--doc", "report.md", "--origin-provider", "codex", "--origin-session", "../source", "--origin-turn", "delivery"],
  ["--doc", "report.md", "--origin-provider", "codex", "--origin-session", "source", "--origin-turn", "delivery", "--no-persist"],
].map(args => [args]))("exits 2 with usage before native runtime launch for %j", async args => {
  await expect(execute(process.execPath, [cli, ...args])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("Usage: quire") });
});
it("documents CLI-only IDs and prints only a doc query parameter", async () => {
  expect((await execute(process.execPath, [cli, "--help"])).stdout).toContain("--origin-label");
  const source = await readFile(cli, "utf8");
  expect(source).toContain("/?doc=${encodeURIComponent(doc)}");
  expect(source).not.toMatch(/origin-session=|origin-turn=|origin-provider=/);
  expect(source).toContain("native filesystem tools retain their existing permissions");
});

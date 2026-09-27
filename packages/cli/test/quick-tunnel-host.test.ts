import { mkdtemp, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readQuickTunnelHost } from "../bin/quick-tunnel-host.js";

const paths: string[] = [];
const posixIt = process.platform === "win32" ? it.skip : it;
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function hostFile(value: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quire-tunnel-host-"));
  paths.push(dir);
  const path = join(dir, "host.txt");
  await writeFile(path, value, { mode: 0o600 });
  return path;
}

posixIt("accepts a single exact Quick Tunnel hostname", async () => {
  expect(readQuickTunnelHost(await hostFile("Example-Cloud.trycloudflare.com\n")))
    .toBe("example-cloud.trycloudflare.com");
});

it.each([
  "trycloudflare.com",
  "a.trycloudflare.com.evil.example",
  "https://a.trycloudflare.com",
  "a.trycloudflare.com\nb.trycloudflare.com",
  "a.example.com",
])("rejects an unsafe or ambiguous hostname: %s", async (value) => {
  const path = await hostFile(value);
  expect(() => readQuickTunnelHost(path)).toThrow();
});

posixIt("rejects a host file writable by another user", async () => {
  const path = await hostFile("a.trycloudflare.com");
  await chmod(path, 0o666);
  expect(() => readQuickTunnelHost(path)).toThrow(/not writable by others/);
});

posixIt("rejects a symlink even if its target has private permissions", async () => {
  const path = await hostFile("a.trycloudflare.com");
  await symlink(path, `${path}.link`);
  expect(() => readQuickTunnelHost(`${path}.link`)).toThrow(/host file and directory/);
});

if (process.platform === "win32") it("fails closed when Windows file permissions cannot be verified", async () => {
  const path = await hostFile("a.trycloudflare.com");
  expect(() => readQuickTunnelHost(path)).toThrow(/cannot be verified on Windows/);
});

#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QuireServer } from "@quire/server";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  quire <directory>       Make a folder of Markdown files collaborative.

    --port <n>            Port to listen on (default 4321)
    --host <addr>         Bind address (default 127.0.0.1, local only)

  No account, no signup, no network calls. Everything runs on this machine.
`);
  process.exit(0);
}

const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const positional = args.filter((a, i) => !a.startsWith("--") && !String(args[i - 1] ?? "").startsWith("--"));
const root = resolve(positional[0] ?? process.cwd());
const webRoot = resolve(here, "../../web/dist");

if (!existsSync(webRoot)) {
  console.error("Web client not built. Run: npm run build -w @quire/web");
  process.exit(1);
}

const server = await QuireServer.start({
  root,
  webRoot,
  port: Number(flag("--port", 4321)),
  host: flag("--host", "127.0.0.1"),
});

const count = server.vault.list().length;
console.log(`\n  Quire\n`);
console.log(`  vault   ${root}`);
console.log(`  docs    ${count} markdown file${count === 1 ? "" : "s"}`);
console.log(`  local   http://127.0.0.1:${server.port}\n`);
console.log(`  Local only. Nothing is uploaded and no account is needed.`);
console.log(`  Ctrl+C to stop.\n`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

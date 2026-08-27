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
    --allow-host <name>   Additionally trust this hostname (repeatable). Needed only
                          when deliberately exposing the vault, e.g. via a tunnel.
    --no-git              Disable periodic git snapshots
    --no-discover         Disable the Discover tab (no outbound requests at all)
    --no-search           Keep the curated index, but disable live GitHub search

  Requests are refused unless they come from loopback or an allowed host, so a web page
  you happen to have open cannot reach into your vault.

  No account, no signup, no telemetry, no network calls.
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
const registryPath = resolve(here, "../../../registry/index.json");

if (!existsSync(webRoot)) {
  console.error("Web client not built. Run: npm run build -w @quire/web");
  process.exit(1);
}

const allowedHosts = args.reduce((acc, arg, i) => {
  if (arg === "--allow-host" && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);

const server = await QuireServer.start({
  root,
  webRoot,
  port: Number(flag("--port", 4321)),
  host: flag("--host", "127.0.0.1"),
  allowedHosts,
  git: args.includes("--no-git") ? false : {},
  // Discover is index-only: entries are fetched from their own repositories on request.
  ...(args.includes("--no-discover") || !existsSync(registryPath) ? {} : { registryPath }),
  githubSearch: !args.includes("--no-discover") && !args.includes("--no-search"),
});

const count = server.vault.list().length;
console.log(`\n  Quire\n`);
console.log(`  vault   ${root}`);
console.log(`  docs    ${count} markdown file${count === 1 ? "" : "s"}`);
console.log(`  local   http://127.0.0.1:${server.port}\n`);
const snapshots = server.git && (await server.git.isRepo());
console.log(`  git     ${snapshots ? "snapshots on (commits when idle)" : "not a repository -- snapshots off"}`);
if (allowedHosts.length > 0) console.log(`  trusted ${allowedHosts.join(", ")}`);
console.log(`\n  Local only. Nothing is uploaded and no account is needed.`);
console.log(`  Ctrl+C to stop.\n`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

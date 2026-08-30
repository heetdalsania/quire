#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QuireServer } from "@quire/server";

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));

/**
 * Find an asset in both layouts.
 *
 * In the repository the web client and registry live in sibling packages; in the published
 * package they sit beside the bundled entry point. Checking both means one binary works
 * from a clone and from `npx quire` without a build-time substitution.
 */
const locate = (...candidates) => candidates.map((c) => resolve(here, c)).find(existsSync) ?? null;
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  quire <directory>       Make a folder of Markdown files collaborative.

    -v, --version         Print the installed Quire version
    --port <n>            Port to listen on (default 4321)
    --host <addr>         Bind address (default 127.0.0.1, local only)
    --allow-host <name>   Additionally trust this hostname (repeatable). Needed only
                          when deliberately exposing the vault, e.g. via a tunnel.
    --git                 Opt in to periodic git snapshots of Markdown changed by Quire
    --no-discover         Disable the Discover tab (no outbound requests at all)
    --no-search           Keep the curated index, but disable live GitHub search
    --no-persist          Do not save collaboration state. Comments, attribution and
                          policy then last only as long as the server runs.
    --history             Retain edit history so documents can be replayed. Off by
                          default: keeping it makes document state grow with edit
                          volume rather than with document size.
    --allow-exec          Allow running fenced code blocks from documents. Off by
                          default. Runs arbitrary code as you; refused whenever the
                          server is bound beyond localhost.

  Requests are refused unless they come from loopback or an allowed host, so a web page
  you happen to have open cannot reach into your vault.

  No account, no signup, no telemetry. Core editing stays local. Discover and direct
  peer setup contact public services only when you choose those features.
`);
  process.exit(0);
}

const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const positional = args.filter((a, i) => !a.startsWith("--") && !String(args[i - 1] ?? "").startsWith("--"));
const root = resolve(positional[0] ?? process.cwd());
// The repository build comes first. Both layouts can exist at once -- `build:release`
// stages a copy beside the binary -- and in a clone the live build is the one that
// changes, so preferring the staged copy would serve a stale client after every release.
const webRoot = locate("../../web/dist", "../web");
const registryPath = locate("../../../registry/index.json", "../registry/index.json");

if (!webRoot) {
  console.error("Web client not found. From a clone, run: npm run build");
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
  git: args.includes("--git") && !args.includes("--no-git") ? {} : false,
  // Discover is index-only: entries are fetched from their own repositories on request.
  ...(args.includes("--no-discover") || !registryPath ? {} : { registryPath }),
  githubSearch: !args.includes("--no-discover") && !args.includes("--no-search"),
  allowExec: args.includes("--allow-exec"),
  history: args.includes("--history"),
  persist: !args.includes("--no-persist"),
});

const count = server.vault.list().length;
console.log(`\n  Quire\n`);
console.log(`  vault   ${root}`);
console.log(`  docs    ${count} markdown file${count === 1 ? "" : "s"}`);
console.log(`  local   http://127.0.0.1:${server.port}\n`);
const snapshots = server.git && (await server.git.isRepo());
console.log(`  git     ${snapshots ? "snapshots on (commits when idle)" : "not a repository -- snapshots off"}`);
if (args.includes("--history")) {
  console.log(`  history retained -- documents can be replayed, and state grows with edits`);
}
if (args.includes("--allow-exec")) {
  console.log(`  exec    ENABLED -- documents in this vault can run code as you`);
}
if (allowedHosts.length > 0) console.log(`  trusted ${allowedHosts.join(", ")}`);
console.log(`\n  Local only. Nothing is uploaded and no account is needed.`);
console.log(`  Ctrl+C to stop.\n`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

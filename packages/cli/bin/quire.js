#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  quire --demo             Try Quire in a disposable sample vault.

    -v, --version         Print the installed Quire version
    --demo                Create sample Markdown in a temporary folder, then remove it
                          when Quire stops. No existing files are read or changed.
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
    --doc <path>          Open a vault-relative Markdown document.
    --origin-provider codex  Continue a native Codex conversation on that document.
    --origin-session <id> Source session to fork; never the most recent session.
    --origin-turn <id>    Exact completed delivery turn, included in the fork.
    --origin-label <text> Optional human-readable label (no session IDs).

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

const handoffFlags = ["--origin-provider", "--origin-session", "--origin-turn"];
const usageError = () => {
  console.error("Usage: quire <vault> --doc <path> [--origin-provider codex --origin-session <id> --origin-turn <id> [--origin-label <text>]]");
  process.exit(2);
};
for (const name of ["--doc", ...handoffFlags, "--origin-label"]) {
  if (args.includes(name) && (args.indexOf(name) !== args.lastIndexOf(name) || !flag(name) || flag(name).startsWith("--"))) usageError();
}
const doc = flag("--doc");
const handoff = handoffFlags.some(name => args.includes(name)) || args.includes("--origin-label");
if (handoff && (!doc || !handoffFlags.every(name => args.includes(name)) || flag("--origin-provider") !== "codex" || args.includes("--no-persist"))) usageError();
if (handoff && [flag("--origin-session"), flag("--origin-turn")].some(value => !/^[\w-]{1,160}$/.test(value))) usageError();
const label = flag("--origin-label");
if (label && (label.length > 80 || !label.trim() || /[\r\n\x00-\x1f]/.test(label) || label.includes(flag("--origin-session")))) usageError();

const positional = args.filter((a, i) => !a.startsWith("--") && !String(args[i - 1] ?? "").startsWith("--"));
const demo = args.includes("--demo");
let demoRoot = null;
if (demo) {
  demoRoot = await mkdtemp(join(tmpdir(), "quire-demo-"));
  await Promise.all([
    writeFile(join(demoRoot, "welcome.md"), `# Welcome to Quire

This vault is disposable. Explore freely: it is removed when Quire stops.

## Try the editor

Type beside a collaborator, select text to leave a comment, or switch on suggesting mode.

## Bring an agent

Run the MCP command shown in the README, then ask the agent to improve this document.
`, "utf8"),
    writeFile(join(demoRoot, "project-plan.md"), `# Launch plan

- [x] Keep the source as plain Markdown
- [x] Make every collaborator visible
- [ ] Invite the first reviewers

## Principle

Agents should work beside people, not rewrite their files behind the scenes.
`, "utf8"),
    writeFile(join(demoRoot, "architecture.md"), `# Architecture

\`\`\`mermaid
flowchart LR
  Human --> CRDT
  Agent --> CRDT
  CRDT --> Markdown
\`\`\`

The filesystem remains the source of truth.
`, "utf8"),
  ]);
}
const root = demoRoot ?? resolve(positional[0] ?? process.cwd());
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

let server;
try {
  server = await QuireServer.start({
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
    ...(handoff ? { bindAtStartup: { doc, origin: { provider: "codex", sessionId: flag("--origin-session"), turnId: flag("--origin-turn") }, ...(label ? { label } : {}) } } : {}),
  });
} catch (error) {
  if (demoRoot) await rm(demoRoot, { recursive: true, force: true });
  throw error;
}

const count = server.vault.list().length;
console.log(`\n  Quire\n`);
console.log(`  vault   ${root}`);
console.log(`  docs    ${count} markdown file${count === 1 ? "" : "s"}`);
console.log(`  local   http://127.0.0.1:${server.port}${doc ? `/?doc=${encodeURIComponent(doc)}` : ""}\n`);
if (demoRoot) console.log(`  demo    disposable -- removed when Quire stops`);
const snapshots = server.git && (await server.git.isRepo());
console.log(`  git     ${snapshots ? "snapshots on (commits when idle)" : "not a repository -- snapshots off"}`);
if (args.includes("--history")) {
  console.log(`  history retained -- documents can be replayed, and state grows with edits`);
}
if (args.includes("--allow-exec")) {
  console.log(`  exec    ENABLED -- documents in this vault can run code as you`);
}
if (allowedHosts.length > 0) console.log(`  trusted ${allowedHosts.join(", ")}`);
console.log(`\n  The editor stays local. Connected native agents use their existing accounts and providers.`);
if (handoff || server.conversations.paths().length) {
  console.log("  Native handoff: artifact tools propose changes for review; native filesystem tools retain their existing permissions.");
}
console.log(`  Ctrl+C to stop.\n`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server.close();
  } finally {
    if (demoRoot) await rm(demoRoot, { recursive: true, force: true });
  }
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.on("SIGTERM", shutdown);

#!/usr/bin/env node
import { runStdio } from "@quire/mcp";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

if (args.includes("--help") || args.includes("-h")) {
  console.error(`
  quire-mcp --url http://127.0.0.1:4321

  Exposes a running Quire vault to any MCP client. The agent joins each document's
  live session as a peer: visible cursor, attributed edits, optional suggest mode.

    --name <name>     Display name (default Claude)
    --role <role>     A role, e.g. editor, fact-checker. Several agents can hold one
                      document at once; the role is what makes their work legible.
    --model <id>      Model identifier recorded in provenance, e.g. claude-opus-5
    --color <hex>     Cursor colour
    --share <token>   Capability from an edit share link. Required for remote servers;
                      QUIRE_SHARE_TOKEN may be used instead to keep it out of arguments.
    --impolite        Do not yield when a human is editing the same passage

  Agent connections are leashed by the document's own policy -- insert and delete
  budgets, locked sections, propose-only mode -- enforced by the server, not by trust.

  No account, no signup, no cloud service.
`);
  process.exit(0);
}

const shareToken = flag("--share", process.env.QUIRE_SHARE_TOKEN ?? "");
if ((args.includes("--share") && !shareToken) ||
    (shareToken && (!/^[A-Za-z0-9_-]{16,128}$/.test(shareToken) || args.filter((arg) => arg === "--share").length > 1))) {
  console.error("Invalid --share capability token");
  process.exit(2);
}

await runStdio({
  serverUrl: flag("--url", "http://127.0.0.1:4321"),
  agentName: flag("--name", "Claude"),
  agentColor: flag("--color", "#ea9d34"),
  model: flag("--model", ""),
  role: flag("--role", ""),
  shareToken,
  // Politeness is on by default: colliding with someone mid-sentence is the rude default,
  // and an agent that yields is the whole point of being a peer rather than a process.
  polite: !args.includes("--impolite"),
});

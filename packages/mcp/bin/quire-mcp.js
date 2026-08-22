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

  No account, no signup, no cloud service.
`);
  process.exit(0);
}

await runStdio({
  serverUrl: flag("--url", "http://127.0.0.1:4321"),
  agentName: flag("--name", "Claude"),
  agentColor: flag("--color", "#c2255c"),
});

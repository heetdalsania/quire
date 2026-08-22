# Quire

**Google Docs for Markdown — where the files stay yours, and one of the collaborators is an agent.**

Point Quire at a folder of Markdown. It becomes a live multiplayer workspace, and AI agents
can join editing sessions as first-class collaborators with visible cursors and separately
revertable edits. Your documents stay plain `.md` files on disk, in your git repo, owned by you.

```bash
npm install && npm run build
node packages/cli/bin/quire.js ~/my-notes
```

No account. No signup. No network calls. Binds `127.0.0.1` by default.

## What works today

| | |
|---|---|
| **Live co-editing** | Multiple browsers on one file, remote cursors and selections, offline-tolerant reconnect |
| **Plain files** | The filesystem is the source of truth. Edit in vim or `git pull` mid-session and it merges as a delta, not an overwrite |
| **Agents as peers** | An MCP endpoint lets Claude Code (or any MCP client) join the *same CRDT session* — not rewrite files behind your back |
| **Attribution** | Every span carries its author. Toggle **Authors** to tint text by who wrote it |
| **Suggest mode** | Agent edits can be proposed rather than applied. They show inline, and never reach disk until accepted |
| **Revert by author** | Remove one agent's contributions without touching the paragraph you wrote beside them |
| **Comments** | Anchored to text ranges, survive concurrent edits, and are flagged rather than dropped when their anchor is deleted |
| **Wiki-links** | `[[links]]`, backlinks panel, unresolved links flagged |
| **Search** | ripgrep-backed, with an in-process fallback |
| **Mermaid** | Rendered in the live preview |
| **Git snapshots** | Periodic commits on quiet. Git is the archive, never the transport |

## Connecting an agent

Run the vault, then point any MCP client at it:

```bash
node packages/mcp/bin/quire-mcp.js --url http://127.0.0.1:4321 --name Claude
```

Tools: `list_documents`, `read_document`, `edit_document` (with `suggest`), `append_document`,
`list_suggestions`, `list_comments`, `add_comment`, `search_vault`.

The agent gets a presence identity and a cursor. You can type straight through its edits —
CRDTs make that a non-event.

## Self-hosting

```bash
docker compose up --build
```

## Documents

| File | What's in it |
|---|---|
| **[PLAN.md](./PLAN.md)** | Execution plan, locked decisions, phases, outcomes, risks |
| [DESIGN.md](./DESIGN.md) | Competitive landscape, architecture, the hard problems |
| [BUSINESS.md](./BUSINESS.md) | Cost math, deployment, funding paths |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Architecture invariants — read before a large PR |

## Licence

AGPL-3.0-or-later for the server; the client SDK and MCP adapter are permissive.

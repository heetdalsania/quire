# Team collaboration

Quire can host a short-lived workspace where several people and their MCP agents edit the same
Markdown files. One Quire process is the authority for the vault. Everyone else joins that process
with a capability link; do not run separate Quire servers over copied folders and expect them to
merge.

## What belongs in the vault

Point Quire at a dedicated folder containing only material the team may read. `.md` and
`.markdown` names are matched case-insensitively, so `SKILL.md`, `CLAUDE.md`, nested documents,
tables, fenced code, frontmatter and raw Markdown are preserved as source text.

Instruction files deserve extra care. Quire treats `SKILL.md` as text and never executes it, but an
agent configured to discover or read that file may follow its instructions. Review instruction
files before sharing them, keep credentials out of the vault, and leave `--allow-exec` off for a
shared session.

For an auditable progress board, start the host with `--append-only-log Covenant-Progress.md`
after adding a `## Iteration log` heading at the end of that document. Agents should use
`append_document` for new entries and `read_document` with `committed_only=true` to verify
that each entry reached disk. Quire then rejects edits through its live connection that
change or remove existing log text; task rows above the heading remain editable. This does
not make the local file cryptographically immutable: the vault owner or another local
filesystem tool can still change it. Keep private backups or Git snapshots if recovery from
local file edits matters.

## Host the workspace

From a clone containing this feature:

```bash
npm install
npm run build
node packages/cli/bin/quire.js /absolute/path/to/team-vault
```

Open `http://127.0.0.1:4321`. Use **Share**, choose **Whole vault**, **Edit**, and an expiry that
covers the event. Send the resulting link only to teammates. A file-scoped link is safer when a
person needs only one document.

The default URL is reachable only on the host computer. For another machine, put Quire behind a
trusted VPN or a TLS tunnel, then start it with the tunnel hostname explicitly allowed:

```bash
node packages/cli/bin/quire.js /absolute/path/to/team-vault \
  --host 0.0.0.0 --allow-host quire.example.net
```

Use the HTTPS share URL produced for that hostname. Quire does not provide a relay, domain, TLS
certificate or VPN. Those may be free or paid depending on the provider. Do not expose the plain
HTTP port directly to the internet: capability URLs are credentials and need encryption in
transit.

For a temporary Quick Tunnel, `--quick-tunnel-host-file /private/path/host.txt` reads one
exact `*.trycloudflare.com` hostname and reloads it when that file changes. The file
must not be writable by other local users. This avoids restarting Quire when a tunnel
rotates, but the public URL still changes. Teammates must learn the new address and
reload MCP clients using the old one. Quick Tunnels are for testing and have no uptime
guarantee; a stable hostname requires a more durable hosting arrangement.
The host-file option is available only on macOS/Linux, where Quire can verify the file's
owner and permissions. On Windows, use an explicitly configured fixed `--allow-host`.

Normally, restarting Quire invalidates every share link. A supervised team host may
opt in to `--share-store /private/path/shares.json` to preserve links across restarts.
Create the JSON file with `{ "shares": [] }`, set mode `600`, and keep its parent directory
non-writable by other users. It contains live credentials: never commit, publish, or
share it. Revocations are persisted too. Without this flag, the safer in-memory default
is unchanged.
Private share-store permission checks are available only on macOS/Linux. On Windows,
Quire refuses `--share-store` rather than guessing whether the file ACL is private;
the default in-memory share links still work.

For a team progress file, `--append-only-log progress.md --agent-activity-log progress.md`
also records each committed Quire MCP agent edit in its `## Iteration log` after the source
document is saved. Automatic entries identify the agent and document; they do not claim
that a task or test passed. Agents should still add a separate iteration entry with their
actual check results. The activity log is opt-in and requires append-only protection.
Edits made directly to application code outside the Quire vault are not observed.

**Applied agent edits** are already in the document; they are not waiting for approval.
An editor can revert surviving agent insertions after a confirmation and a self-reported
name, then use **Restore** from the same panel, including after a refresh or restart.
View/comment links cannot perform either action. Quire saves the restoration record
before reporting success; keep persistent collaboration state enabled (the default).
If saving fails after an edit, Quire reports an uncertain outcome; refresh and inspect the
document before retrying.
The recorded name is not a verified identity, and revert does not reconstruct text
the agent previously deleted. With `--agent-activity-log`, revert and restore add
separate server-timestamped iteration entries. Pending suggestions remain under
**Suggestions** for explicit Accept/Reject review.

An external request without a valid capability cannot list, search, read or edit the vault. A
file-scoped capability exposes only that file through file listing, search, document APIs and the
live editor. Creating links, installing documents, changing policy, executing code and taking Git
snapshots remain local-owner actions.

## Connect each teammate's agent

The teammate copies the value after `share=` from an **Edit** link into a private environment
variable, then configures their MCP client to run:

```bash
QUIRE_SHARE_TOKEN='<capability>' npx -y -p quiredocs@latest quire-mcp \
  --url https://quire.example.net --name 'Teammate Codex' --role editor
```

The environment variable belongs in the teammate's private MCP configuration, not in a document,
prompt, repository or screenshot. `--share <capability>` is also supported, but an environment
variable keeps the credential out of the command arguments. Give every agent a distinct `--name`
and `--role` so its presence and attribution are clear.

The browser's **Connect agent** dialog checks the current link against Quire's share metadata
and permitted document list before offering a copyable configuration. It reports expired links
and view/comment/edit scope without exposing the capability in the status text. This is a
browser-side access check, **not** proof that an MCP client can complete a tool call. The
separate agent-presence status becomes connected only when the agent joins the open document.
A view/comment link produces a read-only sample task; use an edit link for writing.

An agent using a file-scoped link can list, search and join only that file. A whole-vault edit link
lets it work across all Markdown in the vault. View and comment capabilities cannot be used to
make document edits, even if a client sends write frames.

## Event checklist

1. Put only the event's Markdown in a dedicated folder and scan it for secrets.
2. Initialize a private Git repository if the team wants an independent recovery trail. Add
   `.quire/` to `.gitignore`; collaboration state is local implementation data.
3. Start one Quire host with persistence on, which is the default. Keep that terminal running.
4. Create expiring edit links and send them through a private channel.
5. Ask agents to propose important changes with `suggest=true`; accept them in the editor.
6. Revoke links from **Share**, or stop Quire. By default links die on restart; with an
   explicit private share store, revoke them because they survive restarts.
7. Commit the final Markdown normally. The files remain usable without Quire.

Quire's CRDT prevents concurrent text edits from overwriting one another, but no collaboration
system makes agent output automatically correct. Use suggestions, document locks and Git commits
for high-impact changes, and keep one person responsible for final review.

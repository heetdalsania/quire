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
6. Revoke links from **Share**, or stop Quire. All links die when the server restarts.
7. Commit the final Markdown normally. The files remain usable without Quire.

Quire's CRDT prevents concurrent text edits from overwriting one another, but no collaboration
system makes agent output automatically correct. Use suggestions, document locks and Git commits
for high-impact changes, and keep one person responsible for final review.

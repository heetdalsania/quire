# Security

## Posture

Quire is a local-first tool. By default it binds `127.0.0.1` and serves only its own origin.

- **No telemetry, no analytics, no phone-home.** Quire never reports on you.
- **Core text collaboration makes no outbound requests.** Images referenced in Markdown may
  be fetched by your browser when you open the preview. Discover has three user-triggered requests:
  fetching a document from `raw.githubusercontent.com`, searching repositories via
  `api.github.com`, and listing a repository's Markdown files. Install URLs are derived from the registry index rather than from the caller and the
  host is pinned, so the endpoint cannot be turned into a general-purpose fetcher for your
  machine's network position. `--no-search` keeps the curated index but disables live search;
  `--no-discover` removes the Discover surface and its requests.
- **Direct peer setup uses public STUN only after a person chooses it.** The browser contacts
  `stun.l.google.com` or `stun1.l.google.com` to discover a route. Document bytes travel over an
  encrypted WebRTC data channel directly between peers; Quire has no TURN relay or hosted service.
  Do not choose direct peer setup if contacting public STUN is unacceptable.
- **GitHub search needs no account.** It uses the unauthenticated repository-search endpoint, which
  is rate limited to roughly ten requests a minute; results are cached and limiting is reported
  plainly. Quire does not read or transmit `GITHUB_TOKEN` or any other credential.
- **No accounts.** Identity is a display name generated in your browser. External access uses
  random capability links rather than user accounts.
- **Requests are origin-checked.** Browsers permit cross-origin WebSocket upgrades with no
  preflight, and a cross-origin `GET /api/files` needs no CORS approval to be *sent*. Without a
  check, any page you had open could read and rewrite your vault. Quire refuses a request whose
  `Origin` names an untrusted host, and checks `Host` too, which closes DNS rebinding. A *missing*
  `Origin` is allowed: that means a non-browser client (the CLI, an MCP agent, curl), which is not
  a drive-by vector.
- **Document paths are validated twice** — at the transport, and again in `Vault.getDoc`, which is
  the boundary that actually writes files and so refuses rather than trusting its caller.
- **Writes are atomic** (temp file + rename), so a reader never sees a half-written document.
- **Markdown previews are sanitized.** DOMPurify removes scripts, event handlers, unsafe URLs,
  embedded frames and document-supplied styles before HTML enters the page. Mermaid uses its
  strict security mode. HTML exports and rich-text copies use this rendered preview; original
  Markdown files and Markdown exports remain unchanged and may still contain untrusted HTML.
- **Git snapshots are opt-in.** `--git` commits only Markdown paths Quire changed. It does not
  include unrelated working-tree or staged changes, and it never pushes or changes remotes.

## Exposing a vault beyond your machine

`--host 0.0.0.0` and `--allow-host <name>` widen reachability deliberately. The owner session is
restricted to the loopback URL. External browser and MCP requests need a valid view, comment or
edit capability; file-scoped capabilities also scope listing, search and document APIs. Privileged
operations such as creating links, changing policy, installing content, code execution and Git
snapshots remain loopback-only.

Quire does not terminate TLS or provide a relay. Use a trusted VPN or HTTPS tunnel and preserve the
public Host header. Do not expose the plain HTTP port to the internet: a capability URL is a bearer
credential, and anyone who obtains it receives its role until it expires, is revoked, or the server
restarts.

## What the agent leash is, and is not

Document policy -- insert and delete budgets, propose-only, read-only, locked sections --
is enforced by the server on connections that identify themselves as agents. It is a
guardrail against the realistic failure: an agent looping, over-deleting, or wandering into
a section it was told to leave alone.

**It is not a defence against a hostile holder of an edit capability.** A connection can simply
not declare itself an agent and will not receive agent budgets. Capabilities control which
documents and role a caller receives; the leash controls well-behaved agent activity inside that
role. Treat the link as the lock and the leash as a separate damage limit.

## Where collaboration state lives

The Markdown file holds the text. Everything else -- authorship, comments, provenance,
agent policy, suggestion outcomes -- lives in a CRDT, persisted to `.quire/state/` beside
the vault. That directory is an implementation detail: deleting it loses the collaboration
layer and nothing else, and your prose is untouched. Add it to `.gitignore` unless you
deliberately want to share attribution history. `--no-persist` turns it off entirely.

## Known limitations

### Native Codex handoff

Native bindings live in private per-document files under `.quire/conversations/`,
written atomically with `0600` files and `0700` directories on POSIX. They contain
native routing IDs, never credentials or transcripts; do not share or commit them.
Browser status, attribution, run receipts, and shared exports do not expose raw
native session IDs. Binding is CLI-only: IDs do not belong in review URLs.

Every run receives a random bearer capability for a separate loopback MCP listener
exposing only `quire_read_artifact` and `quire_propose_replacement`. Host, Origin,
and capability checks protect this listener. Completion, failure, and cancellation
revoke tools immediately: open connections are closed and the listener shuts down.
This listener is separate from the vault MCP endpoint and does not broaden a vault share.
Approval/Disconnect controls are local-only; approvals are single-use, never global.

**Native filesystem and shell tools retain their existing permissions.** The
artifact tools enforce locks, budgets, attribution, and suggestion review, but do
not sandbox Codex's other tools. Native writes can bypass review and merge as
ordinary disk changes. Restrict Codex's own permissions and trust vault commenters,
whose comments can trigger agent actions. Native model calls use the existing
account/provider and may transmit document context and incur charges. Uncertain
runs are never automatically retried. [Native handoff](docs/native-handoff.md)
documents recovery and the private-state boundary.

### General limitations

- **No accounts or individual user ACLs.** Access is granted by bearer capabilities. A link may be
  scoped to one document or the vault, but it is not tied to a person and cannot distinguish two
  people who share it.
- **No encryption at rest or in transit.** Run behind TLS if you expose it.
- **Direct peer setup reveals network metadata to public STUN.** Peers use WebRTC encryption, but
  each side and the STUN service can observe connection metadata and IP addresses.
- **Documents load eagerly at startup.** A vault with many thousands of files will use
  proportional memory.
- **Edit history is off by default.** `--history` enables replay, but disabling Yjs
  garbage collection makes document state grow with edit volume rather than with document
  size -- measured at 308x the visible text after four thousand edits. That cost lands on
  memory, on the browser's offline store, and on the payload every new client downloads.
- **`--allow-exec` runs arbitrary code as you**, in the vault directory. It is refused
  whenever the server is bound beyond loopback, never runs automatically, and is off
  unless asked for -- but an installed document you then choose to run is still code you
  are choosing to run.
- **View and comment links are enforced server-side.** View links cannot write. Comment links may
  update comment and awareness data but text edits are rejected by inspecting the CRDT update.
  These are still capability links: possession of the URL grants its role.
- **Share links are capabilities.** There are no accounts, so the link *is* the credential. Anyone
  holding it has the role baked into it. Links live in memory and die when the server stops. Remote
  MCP agents require an edit capability through `QUIRE_SHARE_TOKEN` or `--share`.
- **Suggestions are advisory.** Any connected client can accept one; there is no reviewer role.
- **Registry documents are third-party content.** Quire records where each installed file came
  from and under what licence, but does not vet it. A `CLAUDE.md` you install changes how agents
  behave in that directory — read it before you rely on it.

## Reporting

Open a GitHub issue for non-sensitive matters. For anything exploitable, please report it
privately through GitHub's security advisory flow rather than a public issue.

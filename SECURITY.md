# Security

## Posture

Quire is a local-first tool. By default it binds `127.0.0.1` and serves only its own origin.

- **No telemetry, no analytics, no phone-home.** Quire never reports on you.
- **Outbound requests happen only in Discover, and only when you ask.** Three of them exist:
  fetching a document from `raw.githubusercontent.com`, searching repositories via
  `api.github.com`, and listing a repository's Markdown files. Nothing else in Quire touches the
  network. Install URLs are derived from the registry index rather than from the caller and the
  host is pinned, so the endpoint cannot be turned into a general-purpose fetcher for your
  machine's network position. `--no-search` keeps the curated index but disables live search;
  `--no-discover` gives a build that makes no outbound requests at all.
- **GitHub search needs no account.** It uses the unauthenticated repository-search endpoint, which
  is rate limited to roughly ten requests a minute; results are cached and limiting is reported
  plainly. If you happen to have a token, `GITHUB_TOKEN` in the environment raises the limit —
  Quire never asks for, stores, or transmits credentials of its own.
- **No accounts.** Identity is a display name generated in your browser.
- **Requests are origin-checked.** Browsers permit cross-origin WebSocket upgrades with no
  preflight, and a cross-origin `GET /api/files` needs no CORS approval to be *sent*. Without a
  check, any page you had open could read and rewrite your vault. Quire refuses a request whose
  `Origin` names an untrusted host, and checks `Host` too, which closes DNS rebinding. A *missing*
  `Origin` is allowed: that means a non-browser client (the CLI, an MCP agent, curl), which is not
  a drive-by vector.
- **Document paths are validated twice** — at the transport, and again in `Vault.getDoc`, which is
  the boundary that actually writes files and so refuses rather than trusting its caller.
- **Writes are atomic** (temp file + rename), so a reader never sees a half-written document.

## Exposing a vault beyond your machine

`--host 0.0.0.0` and `--allow-host <name>` widen access deliberately. **There is no
authentication yet**: anyone who can reach the port can read and edit every document in the vault.
Only do this on a network you trust, or behind something that provides authentication.

## What the agent leash is, and is not

Document policy -- insert and delete budgets, propose-only, read-only, locked sections --
is enforced by the server on connections that identify themselves as agents. It is a
guardrail against the realistic failure: an agent looping, over-deleting, or wandering into
a section it was told to leave alone.

**It is not a defence against a hostile client.** A connection can simply not declare
itself an agent, and there is no authentication to tell one caller from another. Anything
that can reach the port can already write. Treat the leash as a seatbelt, not a lock.

## Known limitations

- **No authentication or per-document permissions.** Access is all-or-nothing per vault.
- **No encryption at rest or in transit.** Run behind TLS if you expose it.
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
- **View links are enforced; comment links are advisory.** A view link's writes are dropped by the
  server, so read-only genuinely is read-only. A comment link is currently enforced only in the
  client, because distinguishing a comment write from a text write requires inspecting the CRDT
  update. Treat a comment link as "edit, with a UI that discourages it".
- **Share links are capabilities.** There are no accounts, so the link *is* the credential. Anyone
  holding it has the role baked into it. Links live in memory and die when the server stops.
- **Suggestions are advisory.** Any connected client can accept one; there is no reviewer role.
- **Registry documents are third-party content.** Quire records where each installed file came
  from and under what licence, but does not vet it. A `CLAUDE.md` you install changes how agents
  behave in that directory — read it before you rely on it.

## Reporting

Open a GitHub issue for non-sensitive matters. For anything exploitable, please report it
privately through GitHub's security advisory flow rather than a public issue.

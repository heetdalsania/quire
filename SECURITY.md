# Security

## Posture

Quire is a local-first tool. By default it binds `127.0.0.1` and serves only its own origin.

- **No telemetry, no analytics, no phone-home.** Quire never reports on you.
- **Exactly one outbound request, and only on request.** Installing or previewing a document
  from **Discover** fetches it from `raw.githubusercontent.com`. Nothing else in Quire touches the
  network, the URL is derived from the bundled registry index rather than from the caller, and the
  host is pinned so the endpoint cannot be turned into a general-purpose fetcher for your machine's
  network position. Start with `--no-discover` for a build that makes no outbound requests at all.
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

## Known limitations

- **No authentication or per-document permissions.** Access is all-or-nothing per vault.
- **No encryption at rest or in transit.** Run behind TLS if you expose it.
- **Documents load eagerly at startup.** A vault with many thousands of files will use
  proportional memory.
- **Suggestions are advisory.** Any connected client can accept one; there is no reviewer role.
- **Registry documents are third-party content.** Quire records where each installed file came
  from and under what licence, but does not vet it. A `CLAUDE.md` you install changes how agents
  behave in that directory — read it before you rely on it.

## Reporting

Open a GitHub issue for non-sensitive matters. For anything exploitable, please report it
privately through GitHub's security advisory flow rather than a public issue.

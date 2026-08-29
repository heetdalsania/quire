# Changelog

## 0.1.0-beta.1 - 2026-08-28

First release. Point Quire at a folder of Markdown and it becomes a live multiplayer
workspace where AI agents are collaborators you can watch, not processes that rewrite your
files behind your back.

### Release readiness
- Added deterministic polling for watcher-based tests and immediate WebSocket termination
  during room teardown, eliminating platform-specific hangs without changing production
  watcher behavior.
- Added `quire --version` and expanded the publishability check to verify executable bits,
  version output, licence metadata, bundle startup, shebangs, and dependency closure.
- Split the editor, collaboration runtime, and Markdown parser into stable browser chunks;
  Mermaid remains lazy-loaded only when a document contains a diagram.
- Reconciled security, licensing, package, release, and launch documentation with the code
  that is actually shipped.
- Added `AGENT_CHANGELOG.md` as the append-only cross-agent handoff record.
- Added grouped monthly Dependabot updates for npm dependencies and GitHub Actions.

### Editing
- Real-time co-editing over plain `.md` files, with the filesystem as the source of truth.
  External edits — another editor, `git pull` — merge as CRDT deltas rather than overwrites.
- Presence, remote cursors, offline editing via IndexedDB, and reconnection.
- Comments anchored to text ranges that survive concurrent edits; threads whose anchor is
  deleted are flagged rather than dropped.
- Suggesting mode for people, and an enforced comment-only role for reviewers.
- Wiki-links with backlinks, ripgrep-backed search, Mermaid, git snapshots.

### Agents
- MCP endpoint with 17 tools. Agents join the same CRDT session as humans: visible cursor,
  attributed spans, separately revertable work.
- Agent leashes — insert and delete budgets, propose-only, read-only, sections locked by
  heading — enforced where writes land rather than requested in a prompt.
- Politeness: an agent yields to a human working in the same passage, turning its edit into
  a suggestion instead of typing over them.
- Provenance: every span records who, which model, which tool, and the instruction behind
  it. `why_does_this_exist` answers that for any passage.

### Sharing
- Capability links with view / comment / edit roles, all enforced server-side.
- Review requests: a link carrying a brief, openable with no account and no install.
- Provenance receipts: a self-contained page reporting what a document is made of, with the
  replay embedded.

### Discover
- A curated index of widely-used Markdown, plus live GitHub search. The registry is an
  index, not a host: files are fetched from their own repositories, with provenance
  recorded and drift from upstream tracked in `quire.lock`.

### Appearance
- Sixteen themes, including both classics and published palettes used at their real values.
- Text-bearing roles are contrast-corrected per theme at runtime: published palettes are
  built for syntax highlighting, where the lowest greys are comments nobody reads, and
  mapping them straight onto prose left secondary text illegible in most of them.
- Typography controls for prose and editor faces, size, leading and measure, plus a focus
  mode. All display-only — none of it changes a byte of the file.

### Notable defaults
- Binds `127.0.0.1`, refuses cross-origin requests, no telemetry, no accounts.
- Edit history is **off** (`--history`): retaining it makes state grow with edit volume.
- Code execution is **off** (`--allow-exec`) and refused whenever the server is not on
  loopback.
- Collaboration state persists in `.quire/state/` so it survives a restart.

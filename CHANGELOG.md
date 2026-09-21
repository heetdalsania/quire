# Changelog

## Unreleased

- Add an experimental CLI-only native Codex handoff: fork a specified completed turn,
  continue human comments on a separate child, and propose edits through existing review.
- Store private per-document bindings atomically with restrictive permissions, stable
  opaque authors, model provenance, and persisted at-most-once dispatch. Uncertain runs
  pause until explicit recovery; dispatched comments are never replayed automatically.
- Scope native artifact tools to authenticated ephemeral loopback capabilities. Add local
  status, one-time approvals, Disconnect, Simplified Chinese strings, deterministic fixture
  tests, and an opt-in model-free installed-Codex check. Vault-wide MCP remains unchanged.

## 0.1.0-beta.5 - 2026-09-20

- Serialize filesystem reads and writes per document so delayed watcher snapshots cannot
  replay older saved text over newer edits or undo/redo. Preserve unsaved local edits beside
  suggestions when the disk projection is unchanged; add deterministic race regressions.
- Wait for timed-out executable process trees to terminate before returning, preventing their
  working directories from remaining locked during cleanup on Windows.
- Use the collaborative history manager consistently for undo/redo, preventing local history
  from treating incoming document content and peer edits as the current user's typing.
- Add local agent setup for Claude Code, Codex and Cursor, including native Windows configuration,
  the active server port, a review-only sample task and live document-specific agent presence.
  Shared links cannot generate full-vault setup commands. No model calls or command execution.
- Add an experimental Simplified Chinese translation for core navigation, review controls and
  agent setup, with persistent language selection, English fallback and a Chinese quickstart.
  Switching language preserves the current document and editing session.
- Update Zod to 4.6.5. Keep Node typings aligned with Node 22; separate major Dependabot upgrades
  from routine minor/patch groups. Mermaid 12 remains deferred for dedicated compatibility review.
- Add tests for setup URL validation, platform configuration, presence, localization and
  Unicode suggestions, plus a reproducible recorder for focused collaboration demos.

## 0.1.0-beta.4 - 2026-09-13

### Security and compatibility
- Sanitize Markdown previews with DOMPurify to remove active HTML, unsafe links, and injected
  styles. Original Markdown stays unchanged; rendered HTML exports use the sanitized preview.
- Added real MCP transport tests for tool schemas, invalid arguments, edits, and suggestions.
- Added frontend and browser-test typechecking to the release gate and CI, and corrected a
  WebSocket buffer type mismatch exposed by current browser definitions.
- Added browser regressions for unsafe HTML, tables, task lists, wiki links, valid Mermaid,
  and malformed diagrams across Chromium, Firefox, and WebKit.
- Updated production dependencies and the TypeScript, Vite, Vitest, and Playwright toolchain.
  Source builds now require Node.js 22.12 or newer; the packaged CLI still supports Node.js 22+.
- Refreshed the real-app demo and added a disposable-vault recorder entry point.

### Navigation and mobile editing
- Added touch-sized Files, Edit, Preview, and Comments views on phones and tablets. Switching
  views keeps the current editing session, selection, and document intact.
- Added desktop Edit/Split/Preview controls so either document pane can use the full width.
- Replaced the flat vault list with nested, collapsible folders and readable filenames.
  Opening a document reveals its parent folders; folder expansion is retained during the session.
- Search now matches filenames and folder paths as well as contents, and ignores outdated search
  responses after a query changes or clears.
- Kept comments, toolbar actions, and navigation accessible with saved desktop layout preferences,
  and respected hidden controls for unavailable features and restricted share links.
- Made the WebRTC send buffer explicitly ArrayBuffer-backed for current browser type definitions.
- Added browser regression coverage for navigation, mobile editing and persistence, touch comments,
  viewport changes, stale searches, and desktop pane controls in Chromium, Firefox, and WebKit.

Thanks to [@Hamsterarsch](https://github.com/Hamsterarsch) for the workshop use case and reports
[#10](https://github.com/heetdalsania/quire/issues/10) and
[#11](https://github.com/heetdalsania/quire/issues/11).

### Dependencies
- Updated the MCP dependency tree's `fast-uri`, `hono`, and `qs` to compatible patched versions
  addressing the advisories reported by the release audit.

## 0.1.0-beta.3 - 2026-08-30

### Positioning and Markdown fidelity
- Reframed Quire around its local, git-native source of truth and accountable AI-agent workflow
  rather than a generic "Google Docs for Markdown" comparison.
- Added an automated byte-fidelity test covering YAML frontmatter, task lists, tables, fenced code,
  Mermaid, wiki-links, footnotes, raw HTML, comments, and escaped Markdown.
- Documented the distinction between editing original `.md` files in place and cloud
  import/collaborate/export workflows.
- Published a reproducible Google Docs round-trip comparison using the same fixture, recording
  both preserved semantics and source-level changes without overstating a single test.

### Onboarding and compatibility
- Added `quire --demo`, which creates a disposable three-document vault and removes it on exit.
- Added copy-paste MCP setup for Claude Code, Codex, and Cursor, including native Windows guidance.
- Added automated browser smoke coverage for Chromium, Firefox, and WebKit.
- Extended the filesystem and collaboration test matrix to Windows, alongside macOS and Linux.
- Added reproducible launch artwork: a social preview, current static screenshot, compact core demo,
  and Product Hunt thumbnail, all derived from the real application recorder.

### Reliability
- Prevented a closed document connection from incorrectly marking the newly opened document offline.
- Made disposable demo cleanup handle both interactive interrupts and automated termination.
- Retried transient Windows file-lock failures without weakening atomic Markdown writes.

## 0.1.0-beta.2 - 2026-08-29

### Trust and repository hygiene
- Made git snapshots opt-in with `--git` and restricted snapshot commits to Markdown paths Quire
  changed, preserving unrelated working-tree and staged changes.
- Removed implicit `GITHUB_TOKEN` use; Discover now uses only anonymous public GitHub endpoints.
- Documented every filesystem, network, code-execution, agent, sharing, and install-time permission.
- Removed internal agent, planning, business, marketing, deployment, and product-strategy documents
  from the public repository tree.
- Replaced the demo with a current recording generated from the real application.

## 0.1.0-beta.1 - 2026-08-28

First release. Point Quire at a folder of Markdown and it becomes a live multiplayer
workspace where AI agents are collaborators you can watch, not processes that rewrite your
files behind your back.

### Release readiness
- Added deterministic polling for watcher-based tests and immediate WebSocket termination
  during room teardown, eliminating platform-specific hangs without changing production
  watcher behavior.
- Added `quire --version` and expanded the publishability check to verify executable bits,
  version output, licence and binary metadata, bundle startup, shebangs, and dependency closure.
- Split the editor, collaboration runtime, and Markdown parser into stable browser chunks;
  Mermaid remains lazy-loaded only when a document contains a diagram.
- Reconciled security, licensing, package, release, and launch documentation with the code
  that is actually shipped.
- Added grouped monthly Dependabot updates for npm dependencies and GitHub Actions.
- Updated GitHub's checkout and Node setup actions to their Node 24-based major releases.
- Upgraded the test runner to patched Vitest 4.1 releases; both the complete and
  production-only npm dependency audits report zero known vulnerabilities.

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

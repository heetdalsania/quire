# Agent Changelog

This is Quire's append-only handoff ledger for coding agents. Git remains the authoritative
source history; this file records the context a diff cannot: why a decision was made, what was
actually verified, and what the next agent must not assume.

## How to maintain this file

- Read `CLAUDE.md` and the newest entry here before changing code.
- Add new entries directly below this section, newest first. Never rewrite an older entry to
  make later work look cleaner.
- Include the date, agent/tool name when known, objective, material decisions, files or surfaces
  changed, verification commands and outcomes, and honest remaining work.
- Write `not run` or record the failure when a check did not pass. A build is not a browser test;
  a source test is not a packed-package smoke test.
- Keep product history in `CHANGELOG.md`. Keep this file focused on engineering handoffs.

---

## 2026-08-28 - Prepare v0.1.0-beta.1

**Agent:** OpenAI Codex

**Objective:** Follow the release recommendation: ship the verified work as an opt-in npm
beta and GitHub prerelease before promoting a stable `0.1.0`.

**Decisions:** The npm version and Git tag are `0.1.0-beta.1`; publication must use the
`beta` dist-tag. The npm `latest` tag remains untouched until a stable `0.1.0` passes the
same release gate after dogfooding.

**Changed surfaces:** `packages/cli/package.json`, `package-lock.json`, the MCP server
identity, changelog, release instructions, and agent status.

**Verification:** `npm run verify` passed for `0.1.0-beta.1`: type checking, all 176 tests,
the production build, release bundle, and publishability checks. The exact
`quiredocs-0.1.0-beta.1.tgz` was installed into an empty project; `quire --version`
returned `0.1.0-beta.1`, the server started, and `/api/files` listed the smoke document.

**Publish attempt:** npm correctly refused publication because the account requires 2FA. No
package version was created. npm 11 also warned that leading `./` segments in the two `bin`
targets would be normalized; the targets were changed to npm's canonical `dist/...` form and
the release checker now asserts both mappings. The corrected candidate must pass the gate
before the unpublished tag is moved. It passed `npm run verify` and an npm dry run with no
metadata warnings; a clean tarball install created both `quire` and `quire-mcp` command
shims, and both binaries started successfully.

**Remaining:** npm and GitHub CLI sessions require owner re-authentication before external
publication and push.

## 2026-08-28 - Production-readiness pass

**Agent:** OpenAI Codex

**Objective:** Audit Quire for a public beta, eliminate release inconsistencies, harden the
publishability gate, and leave a transparent handoff path for other coding agents.

**Decisions:**

- The current repository and single bundled `quiredocs` distribution are entirely
  AGPL-3.0-or-later. A permissive SDK may be considered later only after it is separated into
  an independently distributable package with a clean dependency boundary.
- Filesystem watcher polling is forced only inside Vitest. Production keeps chokidar's native
  platform behavior.
- Room teardown terminates sockets immediately so tests and shutdown do not wait on graceful
  WebSocket close handshakes.
- Mermaid stays lazy-loaded. Stable editor, collaboration, and Markdown dependencies are split
  into cacheable browser chunks rather than loaded as one application bundle.

**Changed surfaces:**

- Test and lifecycle stability: `vitest.config.ts`, `packages/server/src/room.ts`.
- CLI and release validation: `packages/cli/bin/quire.js`, `scripts/check-release.mjs`,
  `package.json`.
- Browser packaging: `packages/web/vite.config.ts`.
- Release truth and contributor guidance: README, security, release, plan, business,
  deployment, issue-template, CI, and changelog documents.
- Dependency maintenance: `.github/dependabot.yml` groups monthly npm updates and tracks
  GitHub Actions updates.

**Verification:** Complete.

- `npm run verify` passed: type checking, 176 tests across 14 files, production web build,
  release bundling, and publishability checks.
- The browser entry chunk fell from about 704 KB to 59 KB. The editor, collaboration, and
  Markdown vendor chunks are stable; Mermaid diagram engines remain lazy.
- `quiredocs-0.1.0.tgz` was installed into an empty temporary npm project. The packaged
  `quire --version` returned `0.1.0`, the server started, `/api/files` listed the test file,
  and the packaged HTML loaded.
- Browser smoke testing against that installed tarball reached `live`, loaded CodeMirror,
  rendered a Mermaid flowchart as SVG, and produced no browser warnings or errors.
- Manual testing did not exhaust every toolbar command; behavior-specific automated tests
  remain the evidence for sharing, review, export, policy, and provenance flows.

**Remaining:** npm publication and release tagging require the owner's npm credentials. GitHub
branch protection and private vulnerability reporting are repository settings and must be enabled
by an owner.

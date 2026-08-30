# Contributing to Quire

Thanks for helping make Quire better. Bug reports, focused fixes, documentation improvements,
and well-scoped feature proposals are welcome.

Quire is pre-1.0 and moving fast. Before opening a large pull request, please start a
[discussion](https://github.com/heetdalsania/quire/discussions) or open a feature request. The
scope boundaries in [PLAN.md](./PLAN.md) §2 are deliberate, and several commonly-requested
features (WYSIWYG, whiteboards, plugin APIs) are explicitly out of scope rather than merely unbuilt.

## Before you start

- Use Node.js 22 or newer and the npm version bundled with it.
- Search existing issues and discussions before opening a duplicate.
- Keep pull requests focused. Separate unrelated refactors from behavior changes.
- Never include private vault contents, credentials, or `.quire/state/` data in fixtures or reports.

## Development setup

```bash
npm ci
npm run build
npm start -- /path/to/a/test-vault
```

The server prints its local URL, normally `http://127.0.0.1:4321`. Use a disposable folder for
manual testing.

## Verification

Run the complete release gate before requesting review:

```bash
npm run verify    # typecheck, tests, release build, and publishability checks
npm audit         # include development tooling in the dependency audit
```

During development, `npm test` and `npm run typecheck` provide faster focused feedback.

Add or update tests when behavior changes. Describe manual browser checks in the pull request;
do not report a check as passing unless you actually ran it.

## Architecture invariants

These are load-bearing. A change that violates one is a bug even if the tests pass:

1. **The Y.Doc is live truth; the file is a projection of it.**
2. **Disk changes merge as CRDT deltas, never as wholesale overwrites.** Overwriting destroys
   collaborators' cursors and discards concurrent edits.
3. **Loop prevention comes from transaction origins, not content comparison.** Anything applied
   with `DISK_ORIGIN` must never trigger a disk write.
4. **Git is the archive, never the transport.**

## Agent handoffs

Coding agents must read [CLAUDE.md](./CLAUDE.md) and [AGENT_CHANGELOG.md](./AGENT_CHANGELOG.md)
before changing the repository. Append a dated entry to the agent changelog when work changes
behavior, release state, architecture, or an important decision. Record commands actually run;
do not describe an unrun check as passing.

## Pull requests

Explain the user-visible outcome and why the change belongs in Quire. Call out security,
persistence, protocol, or compatibility implications explicitly. A maintainer may ask to split a
large change so each part can be reviewed and reverted independently.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Licence

The entire repository is AGPL-3.0-or-later. By contributing you agree your contribution is
licensed under it.

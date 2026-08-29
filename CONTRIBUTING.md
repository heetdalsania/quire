# Contributing to Quire

Quire is pre-1.0 and moving fast. Before opening a large PR, please open an issue first --
the scope boundaries in [PLAN.md](./PLAN.md) §2 are deliberate, and several commonly-requested
features (WYSIWYG, whiteboards, plugin APIs) are explicitly out of scope rather than merely unbuilt.

## Development

```bash
npm install
npm test          # full suite
npm run typecheck
npm run verify    # typecheck, tests, release build, and publishability checks
```

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

## Licence

The entire repository is AGPL-3.0-or-later. By contributing you agree your contribution is
licensed under it.

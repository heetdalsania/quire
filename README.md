# Quire

**Google Docs for Markdown — where the files stay yours, and one of the collaborators is an agent.**

Point Quire at a folder of Markdown. It becomes a live multiplayer workspace, and AI agents can join
editing sessions as first-class collaborators with visible cursors and separately-undoable edits.
Your documents stay plain `.md` files on disk, in your git repo, owned by you.

> **Status: pre-code.** Research and planning are complete; implementation has not started.
> Built agent-assisted — target is ~3–4 weeks to a working v0.3, launch at week 5–6.

## Documents

| File | What's in it |
|---|---|
| **[PLAN.md](./PLAN.md)** | **Start here.** Execution plan, locked decisions, phases, outcomes, risks. Self-contained. |
| [DESIGN.md](./DESIGN.md) | Competitive landscape, architecture, the hard problems, stack rationale |
| [BUSINESS.md](./BUSINESS.md) | Product vision, verified cost math, deployment, funding paths |

## The short version

Every tool today makes you choose: great multiplayer with your documents trapped in someone's database
(Notion, Outline, Docmost, AFFiNE, HedgeDoc), or real files you own with no live co-editing (Obsidian,
SilverBullet, Logseq). Quire refuses the choice — the filesystem is the source of truth, and multiplayer
is a layer on top of it.

The differentiator is agent collaboration: markdown became the interface between humans and AI systems
(`CLAUDE.md`, `AGENTS.md`, specs, RFCs), and today an agent's contribution is a black box you reconstruct
from `git diff` afterward. Quire makes it observable and interruptible.

## Next action

The filesystem↔CRDT bridge spike — [PLAN.md §4, Phase 1](./PLAN.md). It's the go/no-go for the whole
project. Nothing else should be built first.

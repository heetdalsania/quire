# Quire

**Google Docs for Markdown — where the files stay yours, and one of the collaborators is an agent.**

A *quire* is a gathering of folded sheets bound together into a book. That's the model: your documents are
plain `.md` files on disk, and Quire is the binding that lets people (and agents) work on them together, live.

Status: pre-code. This document is the argument for building it and the plan for how.

---

## 1. The thesis

Every collaborative document tool in 2026 makes you pick one of two deals:

- **Deal A (Notion, Outline, Docmost, AFFiNE, HedgeDoc, HackMD):** great multiplayer editing, but your
  documents live in *their* database as blocks or rows. Markdown is an import/export button. You do not own
  the artifact; you own a dump of it.
- **Deal B (Obsidian, SilverBullet, Logseq, plain git repos):** real `.md` files you own completely, but no
  live co-editing. Obsidian states outright that it does not support collaborative live editing of the same
  file, and caps shared vaults at 20 collaborators.

Quire refuses the choice. **The filesystem is the source of truth. Multiplayer is a layer on top of it.**

And there's a reason this matters more now than it did five years ago: markdown stopped being a format for
READMEs and became the interface layer between humans and AI systems. `CLAUDE.md`, `AGENTS.md`, specs, RFCs,
prompt libraries, runbooks, eval rubrics — these are living documents that humans *and* agents both write to.
No tool treats an agent as a real collaborator in that document. That's the wedge.

---

## 2. Landscape (verified August 2026)

### Tier 1 — mature, database-backed

| Project | Stars | License | Why it doesn't solve this |
|---|---:|---|---|
| AFFiNE | 71.7k | non-standard | Block-based store; docs are not files |
| Outline | 40.3k | **BUSL 1.1 — not OSI open source** | Team wiki, Postgres-backed |
| Docmost | 21.4k | AGPL-3.0 | Confluence clone; DB is truth |
| Etherpad | 18.5k | Apache-2.0 | Plaintext, not markdown; 2008-era UX |
| HedgeDoc | 7.4k | AGPL-3.0 | v1 is maintenance-only; **v2 has been in development for years and is still unreleased** |

Note that Outline — the one most people name first — is *source-available*, not open source. That's an
opening: "actually open source" is a real differentiator in this category.

### Tier 2 — real files, no live co-editing

Obsidian (closed source), SilverBullet (5.9k, MIT), Logseq (44.6k), SiYuan (45.9k), Trilium (37.5k).
All single-player-first. The only bridge is the Peerdraft Obsidian plugin — 91 stars, proprietary backend.

### Tier 3 — the actual niche, and it is nearly empty

- **CollabMD** (264★, MIT, created March 2026) — the one live competitor. Yjs, filesystem-as-truth,
  `npx collabmd ~/my-vault`. Single maintainer, five months old. Positioning is almost exactly
  "zero-migration multiplayer for your existing vault."
- **Perchpad** — Show HN, Feb 2026. Git-native storage plus LLM integration. Unclear licensing.
- Everything else is a 1–10 star toy or abandoned between 2014 and 2022. There are a *lot* of these.
  The graveyard is a signal: the demo is easy, the product is not.

**Conclusion:** the space is crowded with adjacent tools and empty at the exact intersection. The risk here
is not "is there a gap" — there is. The risk is that the gap is easy to *demo* and hard to *finish*, which is
why it keeps getting half-filled and abandoned.

---

## 3. The wedge: agent-native co-editing

This is what Quire has that nothing else does. Not "there's an AI sidebar." Agents are **participants in the
same CRDT session as humans**:

- An agent joins a document the way a person does — it gets a **presence identity and a live cursor**. You
  watch it work in real time, in the same buffer you're typing in.
- Every edit carries **attribution**. You can see, at any point, which spans were written by whom — human or
  agent — and toggle that view on.
- **Per-agent undo.** Reverting an agent's contribution does not blow away the paragraph you wrote next to it
  while it worked. This falls out of scoped Yjs UndoManager instances, but only if you design for it up front.
- **Suggestion mode for agents.** An agent can be scoped to propose rather than commit — its edits land as
  reviewable suggestions you accept or reject, individually or in bulk.
- **Interrupt and steer.** You can type over an agent mid-generation without a conflict dialog, because CRDTs
  make that a non-event. This is the single most satisfying demo in the whole product.
- **A real protocol, not a chat box.** Quire exposes an MCP server so Claude Code, or any agent runtime,
  can open a document, hold a cursor, and edit collaboratively — rather than doing blind whole-file rewrites.

Why this specifically: agents already edit markdown files constantly, and today that experience is a
black box. You run the agent, it rewrites the file, you `git diff` afterward and try to reconstruct what
happened. Quire makes agent editing *observable and interruptible* — which is exactly the thing people
currently complain about. Nobody in Tier 1, 2, or 3 has built this.

Secondary differentiators, in priority order:
1. **Zero migration.** `npx quire ~/my-docs` and that folder is multiplayer. No import, no lock-in, no signup.
2. **Suggestion mode for humans too**, landing as git commits or a PR. Google Docs suggest-mode is the most
   frequently missed feature in every OSS alternative, and it maps cleanly onto docs-as-code review.
3. **Genuinely open source** (AGPL), against a category leader that is BUSL.

---

## 4. Architecture

```
┌─ Browser ──────────────────────────┐
│  CodeMirror 6 + y-codemirror.next  │  source mode + live preview
│  Yjs doc (in-memory)               │  presence, cursors, attribution
│  IndexedDB (y-indexeddb)           │  offline
└───────────────┬────────────────────┘
                │ WebSocket (Yjs sync protocol)
┌───────────────▼────────────────────┐
│  Quire server (Hocuspocus v4)      │  auth, per-doc rooms, ACLs
│  SQLite: doc state + snapshots     │  single-binary self-host
└───────────────┬────────────────────┘
                │
┌───────────────▼────────────────────┐
│  Quire agent (local Node process)  │
│  chokidar watcher ←→ CRDT bridge   │  ◀── THE HARD PART
│  git snapshotter (periodic commit) │
└───────────────┬────────────────────┘
                │
        your actual ~/docs/*.md
                │
┌───────────────▼────────────────────┐
│  MCP server                        │  agents join as first-class peers
└────────────────────────────────────┘
```

**Two rules that keep this coherent:**

1. **The Y.Doc is live truth; the file is a continuously-maintained projection.** Not the other way around.
   Every design argument bottoms out here.
2. **Git is the archive, never the transport.** Do not attempt real-time sync over git. Git merge is
   line-based; CRDT convergence is not; trying to reconcile them in the hot path is how projects die. Quire
   commits periodically and on quiet, and treats `git pull` as just another external file change.

---

## 5. The hard problems (honest assessment)

### Solved — weeks, not months
Real-time text sync, presence, cursors, offline, and reconnection are **completely solved** by Yjs +
Hocuspocus. This is mature, MIT-ish, and battle-tested at scale. Do not write a CRDT. Markdown rendering,
wiki-links, backlinks, and Mermaid are equally solved by the unified/remark ecosystem. Auth, share links,
and permissions are ordinary web work.

**If you only build these, you have a weekend demo — which is exactly what the 30 abandoned repos are.**

### Hard — this *is* the product

**5.1 The CRDT ↔ file round-trip.** When someone edits a file outside Quire (Obsidian, vim, `git pull`,
an agent using plain file writes), you must **diff the new file content against the CRDT's current text and
apply the difference as a CRDT delta** — never overwrite the doc. Overwriting nukes concurrent edits and
every collaborator's cursor. You need to handle: debouncing rapid writes, your own writes echoing back
through the watcher (loop prevention), file renames vs. delete+create, external deletion while someone has
the doc open, and non-markdown attachments. This is unglamorous, has no library, and is roughly 40% of the
engineering. Budget for it accordingly.

**5.2 WYSIWYG is a trap — ship source mode first.** Tiptap/ProseMirror/Milkdown give beautiful WYSIWYG, but
their document model is a *tree*, not a string. Round-tripping a tree CRDT back to clean, stable,
diff-friendly markdown produces formatting churn that makes git diffs unreadable — which destroys the entire
"your files stay yours" premise. CodeMirror 6 in source mode with live preview sidesteps this completely,
is what most successful markdown tools actually do, and is what the docs-as-code audience prefers anyway.
Revisit WYSIWYG in v2 with clear eyes, or never.

**5.3 Comment anchoring under concurrent edits.** Comments must survive text moving underneath them.
`Y.RelativePosition` gives you most of this, but you still need an explicit policy for orphaned comments when
the anchored text is deleted outright. Decide it early; retrofitting is painful.

**5.4 Document growth and memory.** Every open document is a stateful in-memory actor somewhere. Yjs docs
grow monotonically without snapshotting and GC. You need a compaction strategy before you have users, not
after. Cloudflare Durable Objects or y-sweet's S3/filesystem persistence are the cheap answers.

**5.5 Attribution and per-agent undo.** Nice-to-have in most editors; load-bearing here, because it's the
wedge. Attribution means carrying authorship metadata on every insert, which affects your document schema
from commit one. Do not bolt this on later.

### Underestimated
End-to-end encryption (kills server-side search, preview, and agent access — probably incompatible with the
wedge; decide deliberately), a real per-folder permission model, SSO for self-hosters, and mobile.

### Verdict

**Feasible.** A focused solo MVP is realistic in ~6–10 weeks: CodeMirror source mode, Yjs over Hocuspocus,
the filesystem bridge, share-by-link, presence, anchored comments. The technical risk is genuinely low —
every dependency is mature.

**The real risk is differentiation and follow-through, not difficulty.** Thirty people have built the demo.
The projects that survived (Etherpad, HedgeDoc) did so on longevity, and the one that overreached (HedgeDoc 2.0)
has been unreleased for years. Scope discipline is the actual success factor.

---

## 6. Roadmap

**v0.1 — "it works" (~6–10 weeks).** `npx quire ~/docs`. File tree, CodeMirror source mode + live preview,
Yjs multiplayer with presence and cursors, the filesystem bridge, share-by-link, local-only by default.
Ship the moment two browsers can edit one real file on disk and neither loses data.

**v0.2 — "it's pleasant."** Anchored comment threads, wiki-links and backlinks, search, Mermaid, offline
via IndexedDB, periodic git snapshotting.

**v0.3 — THE WEDGE.** MCP server. Agents as presence-bearing peers with live cursors. Edit attribution with
a toggle view. Per-agent scoped undo. Agent suggestion mode with accept/reject. **This is the release that
gets written about — everything before it is table stakes.**

**v0.4 — "teams adopt it."** Human suggestion mode landing as commits/PRs, per-folder ACLs, SSO,
single-binary and Docker self-host, optional hosted tier.

**Explicitly deferred:** WYSIWYG, whiteboards, databases/tables, mobile apps, E2E encryption, plugin API.
Every one of these is how this project dies.

---

## 7. Stack

| Layer | Choice | Why |
|---|---|---|
| Editor | CodeMirror 6 + `y-codemirror.next` | Source mode dodges the tree↔markdown round-trip problem |
| CRDT | **Yjs** (22.7k★) | Most mature, largest ecosystem, every binding exists. Loro (6.1k★) is faster but you don't need it and would write custom integrations. Automerge is a worse fit for text. |
| Server | Hocuspocus v4 | Auth/persistence/scaling hooks; runs on Node, Bun, Deno, and Cloudflare Workers |
| Alt server | y-sweet | If you'd rather have S3/filesystem persistence than a DB |
| Local agent | Node + chokidar + isomorphic-git | The filesystem bridge |
| Markdown | unified/remark/rehype, Shiki, Mermaid | Standard, boring, correct |
| Storage | SQLite + S3-compatible for attachments | Single-binary self-host is a real adoption advantage |
| Agent protocol | MCP | Where agent tooling has converged |

**License: AGPL-3.0** for the server, **MIT** for the client SDK and MCP adapter. AGPL is what Docmost,
HedgeDoc, SiYuan, Logseq, and Trilium all chose — it preserves the option to sell hosting without a rug-pull,
and it's a sharper contrast against Outline's BUSL. The permissive SDK keeps integrations frictionless.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| CollabMD is 5 months ahead on the zero-migration pitch | High | Don't compete there. Lead with the agent wedge; zero-migration is table stakes, not the story. |
| Scope creep (the HedgeDoc 2.0 failure mode) | **Highest** | The deferred list in §6 is a contract. Re-read it before every "wouldn't it be cool if." |
| Filesystem bridge eats the whole timeline | High | Prototype it in week 1, standalone, before any UI. If it isn't solid by week 3, the project is different than you think. |
| Agent wedge is a demo, not a workflow | Medium | Validate by using it on your own `CLAUDE.md`/spec files daily from v0.3. If you don't reach for it, nobody will. |
| Solo maintainer burnout | Medium | AGPL + small scope + no hosted tier until v0.4. Don't take on ops early. |

---

## 9. Open questions

1. Single shared vault-level Y.Doc with subdocs, or one Y.Doc per file? (Affects memory, ACL granularity,
   and how atomically renames behave. Lean per-file with a lightweight index doc.)
2. Does an agent authenticate as a distinct principal with its own ACLs, or borrow the inviting user's
   permissions? (Distinct is correct; borrow is faster to ship.)
3. Git snapshotting: on quiet, on interval, on explicit save, or on session end?
4. Is there a hosted tier at all, or purely self-host + BYO-server?
5. How much does attribution metadata cost in document size at realistic scale? **Measure this in week 2** —
   it constrains the wedge.

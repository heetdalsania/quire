# CLAUDE.md — orientation for a new session

You are working on **Quire**. Read this before touching anything; it is the accumulated
context of the whole build, including the mistakes, which are the expensive part.

**Status:** v0.1.0, feature-complete, 176 tests green, release bundle verified by
installing it. Not yet published to npm and not yet pushed to GitHub — those need the
owner's accounts. See §10.

**Owner:** Heet (ASU). Everything is built free and signup-free; if a task would need a
paid service or an account, say so and stop rather than working around it.

---

## 1. What Quire is

Point it at a folder of Markdown and that folder becomes a live multiplayer workspace where
AI agents are collaborators you can watch, not processes that rewrite your files behind
your back.

```bash
npx quiredocs ~/notes          # or, from a clone: node packages/cli/bin/quire.js ~/notes
```

**The positioning, which matters and is verifiable:** plenty of tools do two of these.
Quire is the one that does all three.

| | Multiplayer | Agent-native | Plain files |
|---|:---:|:---:|:---:|
| Notion · Outline · Docmost · HedgeDoc | ✅ | ❌ | ❌ |
| Obsidian · SilverBullet · Logseq | ❌ | ~ | ✅ |
| SoloMD (889★) | ❌ | ✅ | ✅ |
| CollabMD (264★) | ✅ | ❌ | ✅ |
| **Quire** | ✅ | ✅ | ✅ |

Never claim the category is empty — SoloMD and CollabMD are real and reviewers will find
them in ten minutes. Claim the *intersection*, which genuinely is empty.

---

## 2. Architecture, and the four rules

```
packages/bridge   filesystem ↔ CRDT, attribution, comments, policy, provenance, replay, persistence
packages/server   HTTP + WebSocket sync, rooms, sharing, registry, exec, receipts
packages/web      CodeMirror 6 client, themes, panels, Discover
packages/cli      the `quire` binary
packages/mcp      the `quire-mcp` binary — agents join as peers
```

**These four rules are load-bearing. A change that violates one is a bug even if tests pass:**

1. **The Y.Doc is live truth; the file is a projection of it.**
2. **Disk changes merge as CRDT deltas, never wholesale overwrites.** Overwriting destroys
   collaborators' cursors and discards concurrent edits.
3. **Loop prevention comes from transaction origins (`DISK_ORIGIN`), not content
   comparison.** Anything applied with that origin must never trigger a disk write.
4. **Git is the archive, never the transport.**

Deliberately **not** built, and each is how this project dies: WYSIWYG (tree↔Markdown
round-tripping produces diff churn that destroys the premise), whiteboards, databases,
kanban, a chat sidebar (the agent belongs *in* the document), hosted-first anything.

---

## 3. Notable implementation decisions

- **Not Hocuspocus.** It wants to own its own `Y.Doc`; the Vault already does. ~150 lines of
  `y-protocols` removed the two-document-tree relay.
- **Not `y-websocket` on the client** — it assumes a room-name-in-path URL scheme, and a
  document path is not a room name.
- **Span-level attribution, not character-level.** Measured: 1.38× encoded size vs **20.6×**
  for per-character. That measurement decided the schema.
- **Revert-by-author walks attribution marks, not `UndoManager`.** Yjs transaction origins
  are local to the process that made the edit and do not survive the wire, so a browser
  cannot undo a remote agent's work by origin.
- **Themes supply twelve roles; everything else derives via `color-mix`.** A new colourway
  needs no CSS.

---

## 4. Everything that is built

**Editing.** Real-time co-editing over plain `.md`; presence and remote cursors; offline via
IndexedDB (scoped by server epoch); anchored comments that survive concurrent edits and are
flagged rather than dropped when orphaned; human suggesting mode; wiki-links + backlinks;
ripgrep search with in-process fallback; Mermaid; git snapshots; export (Markdown, HTML,
plain text, print/PDF, clipboard rich text).

**Agents (17 MCP tools).** `list_documents`, `read_document`, `edit_document`,
`append_document`, `create_document`, `list_suggestions`, `list_comments`, `add_comment`,
`document_provenance`, `why_does_this_exist`, `get_agent_policy`, `set_agent_policy`,
`list_assignments`, `answer_assignment`, `vault_overview`, `compare_versions`,
`search_vault`.

- **Leashes** — insert/delete budgets, propose-only, read-only, sections locked by heading.
  Enforced by decoding and measuring updates *before* they apply. An agent may tighten its
  own leash but never loosen it.
- **Politeness** — an agent yields when a human's cursor is within ~120 chars, converting
  its edit to a suggestion. Nothing that edits files in batch can do this.
- **Provenance** — every span carries a run id; runs record author, model, tool, timestamp
  and the instruction behind the edit.
- **Roles** — several agents in one document, each with its own identity and colour.

**Sharing.** Capability links (view / comment / edit), all enforced server-side. Review
requests carrying a brief, openable with no account. Provenance receipts: a self-contained
HTML page (~6–9 KB, no external requests) reporting what a document is made of, with the
replay embedded.

**Discover.** Curated index of 14 verified entries (~750k stars represented) plus live
GitHub search. The registry is an **index, not a host** — files are fetched from their own
repositories, provenance recorded, and drift tracked in `quire.lock`.

**Interface.** 16 themes with per-theme contrast correction; typography controls; three
resizable/collapsible panels with edge stubs; focus mode; keyboard shortcuts (⌘K, ⌘\,
⌘⇧\, ⌘⇧E, ⌘⇧A, ⌘⇧S, ⌘P).

**Also built, both opt-in and both honest about limits:** peer-to-peer editing over WebRTC
(manual copy-paste signalling, public STUN only, fails behind symmetric NAT and says so),
and executable code blocks (`--allow-exec`, loopback-only, never automatic, bounded).

---

## 5. Defaults, and why

| Flag | Default | Why |
|---|---|---|
| host | `127.0.0.1` | There is no authentication. |
| `--history` | **off** | Retaining it makes state grow with *edit volume*: **308× the visible text after 4,000 edits**. Replay needs it. |
| `--allow-exec` | **off** | Arbitrary code execution. Refused entirely when not on loopback. |
| `--no-persist` | persistence **on** | `.quire/state/` keeps attribution, comments, policy across restarts. |
| `--no-discover` / `--no-search` | both on | Discover is the only outbound request Quire makes. |

---

## 6. Bugs found and fixed — read this section

Every one of these passed a build and looked fine. They are the reason to test the running
system rather than reason about it.

**Silent data loss on startup.** `Vault.open()` returned before existing files were indexed,
because chokidar's `ready` fires *ahead of* `awaitWriteFinish`-delayed `add` events.
`getDoc()` minted an empty handle for a file that already had content, and the first edit
wrote that empty doc over it. Seven of ten acceptance tests failed on this one cause.

**Server restart duplicated every open document, on disk.** Each process seeds its `Y.Doc`
from the file with a fresh clientID, so a browser holding state from the previous process
merged it back as genuinely concurrent content — Yjs cannot tell identical characters are
the same text. Fixed with a **document epoch**: the server announces its lineage before any
sync traffic, and a client whose epoch changed discards local state instead of merging.

**A single malformed request killed the server.** Async handlers that throw become unhandled
rejections and Node exits. Posting `not json{{{` ended every connected session.

**Replay shipped 90 MB of JSON** for a 1.1 MB document — 160 frames each carrying the whole
document. Frame text is now fetched one position at a time.

**Collaboration state did not survive a restart.** The Markdown carries text and nothing
else, so comments, attribution, provenance and policy lived only in memory. Restarting
`quire` silently discarded every comment.

**Comment-only links were unenforceable as first written.** Yjs only encodes a parent *name*
for items with no neighbour; an insert beside existing text infers its parent from the item
next to it. So the naive check saw "touches nothing" for virtually every real edit and let
it through. Parents are now resolved through item origins.

**Deletion budgets never fired.** `ds.clients` is a `Map`; `Object.values` on it yields
nothing, so every update measured as zero deletions and the leash was decorative.

**Ghost avatars.** Presence was reaped per room instead of per socket, so a departed
collaborator's avatar stayed on everyone else's screen.

**An agent could set a document read-only and then silently fail every write.** The leash
correctly blocked its own policy update, but the tool reported success because it never
checked whether the server had refused.

**Two shebangs / `Dynamic require of "events"`.** Both packaging bugs, both invisible to the
test suite, both only appearing once the tarball was actually installed.

**33 contrast failures across 15 of 16 themes.** Published palettes are built for syntax
highlighting, where the lowest greys are comments nobody reads. Text-bearing roles are now
corrected at paint time.

**Deleting five CSS custom properties silently broke the grid.** An undefined custom
property makes the whole declaration invalid and the browser drops it. The vault still
looked plausible; Discover collapsed entirely.

---

## 7. Tests — 176 across 14 files

```
bridge/bridge.test.ts       10   filesystem↔CRDT acceptance (the Phase 1 go/no-go)
bridge/edges.test.ts        13   vault boundaries, fs trouble, restart persistence
bridge/policy.test.ts       14   leashes, budgets, locked sections, provenance
bridge/collab.test.ts       11   attribution, suggestions, comment anchoring
bridge/attribution.test.ts   1   the 1.38× vs 20.6× measurement
server/production.test.ts   25   crash resistance, CSRF, traversal, resource limits
server/hardening.test.ts    21   origin checks, symlinks, CRLF/BOM, malformed frames
server/features.test.ts     20   exec safeguards, drift classification, replay
server/review.test.ts       15   comment-only enforcement, receipts, outcomes
server/sharing.test.ts       7   capability links enforced server-side
server/lifecycle.test.ts     5   presence reaping, 8-client convergence, 250 docs
mcp/agent.test.ts            9   agent sessions, leash escape attempts
web/themes.test.ts          22   per-theme contrast, registry coherence
web/stylesheet.test.ts       3   CSS custom properties are defined; grid columns explicit
```

Also verified manually and not covered by tests: two real browsers editing live, the
packaged tarball installed into an empty project, a soak run (20 clients, 10 documents,
2400 ops, all converged, heap flat at 13–19 MB).

**Never covered by any test:** anything requiring a browser to render, and the Docker image.

---

## 8. Known limitations — state these honestly, never paper over them

- **No authentication.** Anything that can reach the port can read and edit everything.
  This blocks any exposed deployment.
- **The agent leash is a seatbelt, not a lock.** A connection can decline to declare itself
  an agent. It stops agent error, not an adversary.
- **Documents load eagerly** — memory scales with vault size.
- **`--history` costs 308×** the visible text in state after heavy editing.
- **P2P** has manual signalling and no TURN; symmetric NAT fails.
- **The Docker image and CI have never executed.** Written, never run — no Docker here and
  no remote yet. They run on first push.
- **`signAuthorSpans` exists in the bridge with no UI.**

---

## 9. Working practices the owner expects

- **Verify by running it**, not by reasoning about it. Most bugs above were invisible to
  builds and type checks.
- **Report failures plainly**, including ones you caused. When a test timed out because my
  own soak processes were starving it, saying so was better than re-running until green.
- **Free and signup-free.** Flag anything needing an account and stop.
- **Don't reopen locked decisions** (PLAN.md §2) without being asked.
- Commit messages explain *why*, and name the bug and its mechanism.
- `pkill -f "quire.js"` matches its own shell — use `pkill -f 'bin/[q]uire\.js'`.

## 10. Where things stand and what is next

**Immediate next step: the GitHub repository.** Requires the owner's account.

```bash
npm run build:release && npm run check:release   # both must pass before publishing
```

Remaining owner-only steps, both documented in RELEASING.md:
1. **npm** — `npm login`, then `npm publish --access public` from `packages/cli`. Confirm
   the name `quire` is still free first.
2. **GitHub** — create `quiredocs/quire`, add the remote, push. CI verifies the release
   bundle and the Docker image on that first push.

**Unbuilt ideas**, in IDEAS.md: `quire replay --gif` (14), agent scoreboard (15), vault as a
public MCP resource (17, would need auth). Ideas 1–13 and 16 are built.

**Other documents:** PLAN.md (execution, locked decisions, outcomes), DESIGN.md (landscape,
architecture), BUSINESS.md (costs, funding), MARKETING.md (positioning, launch),
DEPLOYMENT.md (routes and costs), IDEAS.md, SECURITY.md, RELEASING.md, CHANGELOG.md.

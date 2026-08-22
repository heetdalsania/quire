# Quire — Master Plan & Status Report

**Last updated:** 2026-08-21
**Status:** Pre-code. Research complete, decisions locked, nothing built yet.
**Owner:** Heet (ASU)

---

## 0. Briefing for a new agent session

*If you are an AI agent picking this up cold, read this section and §2 before doing anything.*

**What this is.** Quire is a planned open source tool: real-time collaborative editing for Markdown
files, where the files stay plain `.md` on the user's disk and AI agents can join editing sessions as
first-class collaborators with visible cursors and attributed edits.

**Where things stand.** Three documents exist and no code does. The research phase is finished — the
competitive landscape, technical feasibility, cost model, and funding paths have all been investigated
and written up. The decisions in §2 are **settled**; do not reopen them without the owner explicitly
asking. The next action is the technical spike in Phase 1.

**The companion documents:**
- [DESIGN.md](./DESIGN.md) — landscape research, architecture, hard problems, stack rationale
- [BUSINESS.md](./BUSINESS.md) — product vision, verified cost math, deployment, funding paths
- This file — execution plan, outcomes, risks

**The one thing to understand.** The easy part of this project (real-time sync) is completely solved by
off-the-shelf libraries and is what ~30 abandoned GitHub repos already built. The hard part — and the
actual project — is the **filesystem↔CRDT bridge** (§4, Phase 1) and the **agent collaboration layer**
(Phase 4). If work drifts toward polishing the editor before those two exist, the project is failing.

---

## 1. The project in one page

**Pitch:** Point Quire at a folder of Markdown. It becomes a live multiplayer workspace — and your AI
agents can join as real collaborators whose cursors you watch and whose edits you can undo separately
from your own.

**The gap it fills.** Every tool today forces a choice: great multiplayer with your documents locked in
someone's database (Notion, Outline, Docmost, AFFiNE, HedgeDoc), or real files you own with no live
co-editing (Obsidian, SilverBullet, Logseq). Quire refuses the choice — **the filesystem is the source of
truth and multiplayer is a layer on top of it.**

**Why now.** Markdown stopped being a README format and became the interface between humans and AI
systems: `CLAUDE.md`, `AGENTS.md`, specs, RFCs, runbooks, eval rubrics. Humans and agents both write to
these files constantly, and today the agent's contribution is a black box — it rewrites the file and you
reconstruct what happened from `git diff` afterward. **Quire makes agent editing observable and
interruptible.** No one has built this.

**Competitive position.** The niche is nearly empty. The one live competitor is
[CollabMD](https://github.com/andes90/collabmd) (264★, MIT, created March 2026, single maintainer, pushed
daily) — it has the Yjs substrate and filesystem bridge but no agent layer. Behind it sit ~30 abandoned
attempts from 2014–2022. **The graveyard is the signal: the demo is easy, the product is not.**

---

## 2. Decisions already locked

Do not relitigate these. Each was researched and chosen deliberately.

| Decision | Choice | Why |
|---|---|---|
| Name | **Quire** | Bookbinding term — a gathering of plain sheets bound together. `quiredocs` free on npm + GitHub. |
| Wedge | **Agent-native co-editing** | The only genuinely unoccupied position. Everything else is table stakes. |
| CRDT | **Yjs** | Most mature (22.7k★), largest ecosystem, every binding exists. Do not write a CRDT. Do not use Loro (faster, but you'd write custom integrations you don't need). |
| Editor | **CodeMirror 6** + `y-codemirror.next` | Source mode dodges the tree↔markdown round-trip problem entirely. |
| WYSIWYG | **Deferred, possibly forever** | ProseMirror/Tiptap model docs as trees; round-tripping to markdown creates diff churn that destroys the "your files stay yours" premise. |
| Server | **Hocuspocus v4** | Auth/persistence/scaling hooks; runs on Node, Bun, Deno, Cloudflare Workers. |
| Source of truth | **The Y.Doc is live truth; the file is a continuously-maintained projection** | Every design argument bottoms out here. |
| Git's role | **Archive, never transport** | Git merge is line-based, CRDT convergence is not. Reconciling them in the hot path is how these projects die. |
| License | **AGPL-3.0 server + MIT client SDK/MCP adapter** | What Docmost, HedgeDoc, SiYuan, Logseq all chose. Preserves the option to sell hosting; sharper contrast against Outline's BUSL. |
| Agent protocol | **MCP** | Where agent tooling has converged. |
| Hosting | **Hetzner + Coolify to start**, Cloudflare Workers + Durable Objects if scale demands | ~$7/mo, no billing surprises. DO is the right shape long-term (one doc = one stateful object). |

**Permanently deferred** (each one is how this project dies): WYSIWYG, whiteboards, databases/tables,
mobile apps, E2E encryption, plugin API, real-time collaborative diagrams.

---

## 3. The critical path

**This project is implemented by an AI agent working with the owner, not hand-coded solo.** Estimates are
in **working sessions** (one focused block, ~2–4 hours of the owner's attention) rather than developer-hours,
because developer-hours are no longer the binding constraint.

```
Week 1   Phase 0  Setup ................. 1 session
         Phase 1  BRIDGE SPIKE .......... 3-5 sessions   ── GO / NO-GO
Week 2   Phase 2  v0.1 MVP .............. 4-6 sessions   ── first real use
Week 3   Phase 3  v0.2 Usable ........... 3-5 sessions   ── dogfooding starts
Week 4   Phase 4  v0.3 THE WEDGE ........ 4-6 sessions   ── the release that matters
Week 5-6 Phase 5  Dogfood + Launch ...... 2-3 sessions
                                  TOTAL: ~17-26 sessions
```

**Build complete in ~3–4 weeks. Launch at week 5–6.**

At one session per day that's under a month. At three or four sessions a week, six to eight weeks. The
gap between those two is availability, not engineering.

### What does not compress

Two things stay on the calendar no matter how fast the code gets written, so they run **in parallel** with
the build rather than after it:

- **Dogfooding.** v0.2 can be built in a few days, but you cannot know whether it is *good* until you have
  lived in it for a couple of weeks. Start using it for real documents the day Phase 2 lands and keep going
  through Phase 4 — that's a two-week window overlapping the build, costing zero extra calendar time.
- **Other people.** Design-partner recruitment and launch-day reaction move at human speed. Start reaching
  out during Week 2, not after Phase 5.

The bridge spike is also the least compressible engineering: writing it is fast, but it is debugged against
real filesystem race conditions, which means running it, hitting an edge case, and iterating. Budget the
upper end of its range.

---

## 4. Phase detail

### Phase 0 — Setup (1 session)

- [ ] `git init`; claim GitHub org `quiredocs`, npm package, and a domain
- [ ] Monorepo scaffold: `packages/server`, `packages/web`, `packages/cli`, `packages/mcp`
- [ ] TypeScript, Biome/ESLint, Vitest, GitHub Actions CI
- [ ] `LICENSE` (AGPL-3.0), `README.md`, `CONTRIBUTING.md`
- [ ] Repo can stay private until Phase 5 — that's a marketing decision, not a technical one

**Exit criteria:** `npm test` runs green in CI on an empty project.

---

### Phase 1 — THE BRIDGE SPIKE (3–5 sessions) ⚠️ **GO / NO-GO**

**This is the most important phase in the plan. Do it before any UI work.**

Build a standalone Node process — no web app, no auth, no styling — that keeps a directory of `.md`
files bidirectionally synced with a set of Yjs documents. Prove it with automated tests, not by clicking.

**The core rule:** when a file changes on disk, **diff the new content against the CRDT's current text and
apply the difference as a CRDT delta.** Never overwrite the Y.Doc. Overwriting destroys concurrent edits
and every collaborator's cursor position. This one sentence is most of the difficulty.

**Acceptance tests — all must pass:**

1. Two clients edit the same file concurrently → both converge, and the file on disk matches
2. External write (`echo x >> file.md`) while clients are connected → applied as a delta; no cursor loss
3. Quire's own disk writes do **not** echo back through the watcher and cause a loop
4. `git pull` introducing outside changes mid-session behaves like case 2
5. File renamed externally → document identity survives
6. File deleted externally while a client has it open → defined, non-crashing behavior
7. Rapid successive writes (editors that save on every keystroke) → debounced, no corruption
8. A 1 MB markdown file → acceptable latency, memory doesn't balloon
9. Client disconnects, edits offline, reconnects → merges cleanly
10. Non-markdown/binary files in the folder → ignored gracefully

**Also measure here (it constrains Phase 4):** how much does per-character authorship attribution cost in
document size on a realistic 50 KB document? If it's ruinous, the wedge needs a coarser design — span-level
rather than character-level. **Find this out now, not in Week 4.**

**Exit criteria:** all ten tests green, attribution overhead measured and acceptable.

**If this phase passes ~7 sessions without converging, stop and reassess.** The project is different than
we think, and that is genuinely useful information rather than a failure.

---

### Phase 2 — v0.1 MVP (4–6 sessions)

`npx quire ~/docs` opens a browser and the folder is multiplayer.

- [ ] CLI: watch a directory, start server, print local URL, optional tunnel
- [ ] Hocuspocus server wired to the Phase 1 bridge
- [ ] Web app: file tree, CodeMirror 6 source mode, live preview, scroll sync
- [ ] Presence: avatars, live cursors, selections
- [ ] Share-by-link with a role (view / comment / edit)
- [ ] Offline via `y-indexeddb`
- [ ] Yjs snapshotting + GC (documents grow monotonically without this)

**Exit criteria:** two people on different machines edit one real file on disk, and neither loses data.

**Start dogfooding and design-partner outreach the day this lands.** Both run in parallel from here.

---

### Phase 3 — v0.2 Usable (3–5 sessions)

- [ ] Comment threads anchored via `Y.RelativePosition`, with an explicit orphaned-comment policy
- [ ] Wiki-links, backlinks, document outline, quick switcher
- [ ] Full-text search (ripgrep-backed)
- [ ] Mermaid rendering, syntax highlighting via Shiki
- [ ] Periodic git snapshotting (on quiet + on interval)
- [ ] Docker image on GHCR, `docker compose` self-host path

**Exit criteria:** the owner reaches for it by preference for their own documents. This is a *usage*
criterion, not a build criterion — it is satisfied by the dogfooding window, not by shipping the checklist.

---

### Phase 4 — v0.3 THE WEDGE (4–6 sessions) ★ **the release that matters**

Everything before this is table stakes that CollabMD already has. This is the differentiator.

- [ ] **MCP server** — an agent connects, authenticates, and receives a document handle
- [ ] **Agent presence** — agents get an identity and a live cursor, visually distinct from humans
- [ ] **Edit attribution** — authorship carried on every insert; a toggle tints spans by author
- [ ] **Per-agent scoped undo** — reverting an agent's work leaves your adjacent edits intact
      (scoped Yjs `UndoManager` instances — design for this, don't bolt it on)
- [ ] **Agent suggestion mode** — agent edits land as reviewable proposals; accept/reject individually
      or per section
- [ ] **Interrupt-and-steer** — type over an agent mid-generation with no conflict (this falls out of
      CRDTs for free and is the single most satisfying moment in the demo)
- [ ] **Record the demo clip** — split screen, agent restructuring §2 while you type in §4, then the
      attribution toggle, then undoing only its paragraphs

**Exit criteria:** the clip exists and is genuinely impressive without narration.

---

### Phase 5 — Dogfood window close + Launch (2–3 sessions)

By now you've been using it for ~2 weeks and have 5–10 design partners. Fix what that surfaced, then:

- [ ] Public repo, polished README with the clip embedded at the top
- [ ] Landing page (static, one page, the clip above the fold)
- [ ] Show HN, r/selfhosted, r/ObsidianMD, Lobsters — coordinated, same week
- [ ] Submit to `awesome-selfhosted`, `awesome-markdown-editors`, and MCP server directories
- [ ] Homebrew formula, GitHub Releases binaries

**Running since Week 2:** private design partners (teams with docs repos, Obsidian users wanting
multiplayer, people running agents on markdown specs), plus ~20 min/day being a useful participant in the
target subreddits without pitching. Do **not** run a public build-in-public campaign — it telegraphs the
wedge to a competitor who already has the substrate, and waitlists are near-worthless for open source.

---

## 5. Kill criteria

Decide these now, while you're calm. Solo projects rarely die from a clear failure; they die from a slow
refusal to admit one.

- **Bridge spike passes ~7 sessions without converging** → stop, reassess scope
- **Attribution overhead makes documents unusably large** → redesign the wedge coarser, or drop it
- **You aren't reaching for it during the dogfood window** → the product is wrong; fix that before
  building more. This is the criterion most likely to actually fire, and the easiest to rationalize away.
- **Six months post-launch: under ~200 stars and no recurring users** → it's a portfolio piece; wind down
  gracefully with an honest README, don't let it become a guilt object
- **Coursework or health is suffering** → pause. The project keeps. Nothing here has a deadline.

---

## 6. What to measure

**During build:** sessions per phase vs. estimate (recalibrate, don't flagellate); bridge test pass rate;
attribution size overhead; p95 keystroke→remote-render latency.

**Post-launch:** GitHub stars *trajectory* (not count); `npx quire` runs; docs created per active user;
**percentage of sessions that include an agent participant** — this is the single number that says whether
the wedge is real; design-partner retention at week 4.

---

## 7. Potential outcomes

Probabilities below are calibrated judgment, not measured data. Treat them as ordering, not precision.

**These have shifted from the original solo-hand-coded estimate.** Agent-driven implementation collapses
build risk — the chance of never shipping drops sharply. But it does not touch market risk at all, and it
quietly *raises* product risk: see the note after the table.

### Scenario A — Dies at the spike (~8%)
The bridge reveals a fundamental problem, or the idea loses its appeal in Week 1. **You keep:** working
knowledge of CRDTs and distributed state — genuinely rare and directly hireable. A few sessions spent.
The plan is deliberately structured to reach this verdict in Week 1 rather than Month 6.

### Scenario B — Ships, then quietly fades (~40%) — *the most likely single outcome*
It works, you Show HN, get 50–300 stars and a few dozen users, then attention drifts. **You keep:** a real
distributed-systems project you shipped, a launch under your belt, an excellent portfolio piece and
interview story. Note this is now the *dominant* outcome precisely because shipping got easy — the
bottleneck moved downstream to whether anyone cares.

### Scenario C — Ships v0.3, real traction, no revenue (~26%)
The wedge lands. 1,000–5,000 stars, an active issue tracker, outside contributors, a self-sustaining
community. **You keep:** a public track record that changes what jobs you can get, a contributor network,
and a credible base for ASU grants, GitHub Accelerator, or NLnet. **This is a genuinely excellent outcome**
and worth recognizing as one rather than treating it as a stepping stone. Risk shifts to maintainer burnout.

### Scenario D — Traction plus revenue (~17%)
Hosted tier and/or commercial licensing reaching roughly $1–10k MRR over 12–24 months. Tiptap-shaped:
**~$2.3M ARR, bootstrapped, no VC** — adjacent market, developer audience, open core. The most realistic
*good* commercial outcome, requiring no accelerator, no investors, and no permission.

### Scenario E — Venture scale (~6%)
YC or a seed round, pitched as agent-collaboration infrastructure rather than a markdown editor. Requires
Scenario C first plus evidence the agent features get used. YC is ~1% acceptance (~25k applications, ~250
admitted); solo founders are ~10% of batches and held to a higher bar. Terms are fixed: $500K = $125K for
7% post-money SAFE + $375K uncapped MFN SAFE.

### Scenario F — Someone copies the wedge (~15%, overlapping the others)
Most likely CollabMD, which already has the substrate and ships daily. **Not fatal** — being copied means
you were right, and a 264-star project copying you is not Notion doing it. A compressed timeline is a real
defense here: shipping the wedge in Week 4 rather than Month 6 is most of the moat you get.

### The tradeoff nobody mentions about building fast

Speed converts build risk into **product risk**. Six months of hand-coding forces you to marinate in the
problem; you discover what's wrong with your own design because you're stuck inside it for a long time.
Building v0.3 in four weeks skips that marination entirely — you can now ship a beautifully-executed
version of the wrong product, faster than you could previously ship the right one.

**The dogfood window is the only defense**, which is why it starts at Phase 2 and runs for two weeks in
parallel rather than being tacked on at the end. Treat the Phase 3 exit criterion — *do you reach for it
by preference?* — as the real gate on the project. It is far more likely to fire than any technical kill
criterion, and it is by far the easiest one to rationalize away.

### What you keep regardless of outcome
CRDT and distributed-systems depth; a shipped open source project with your name on it; the experience of
scoping and finishing something without anyone assigning it; ASU grant eligibility that costs nothing to
pursue; and a portfolio artifact considerably more distinctive than another CRUD app. **The floor is high
and the downside is bounded at a few weeks.** That asymmetry is the argument for building it.

---

## 8. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Scope creep** — the HedgeDoc 2.0 failure mode (v2 unreleased for years) | **Highest** | The deferred list in §2 is a contract. Fast implementation makes scope creep *cheaper and therefore more tempting* — features are no longer self-limiting by effort. Re-read §2 before every "wouldn't it be cool if." |
| Bridge consumes the whole timeline | Medium | Phase 1 exists precisely to find this out in Week 1. Cap it at ~7 sessions. |
| CollabMD is ~5 months ahead on zero-migration | High | Don't compete there. Zero-migration is table stakes; the agent layer is the story. |
| Agent wedge is a demo, not a workflow | **High** | Dogfood on your own spec files from Phase 2 onward. Now the top risk: the build no longer takes long enough to force you to validate the idea along the way. |
| Solo maintainer burnout | Medium | AGPL + tight scope + no hosted tier until there's demand. Don't take on ops early. Issue triage is optional; say no in public and without apology. |
| Student time collision | Low-Medium | Sessions are ~2-4 hrs and can be spread out. Pausing is explicitly allowed and is not failure. |
| WYSIWYG temptation | Medium | It's a trap. See §2. Source mode is what the docs-as-code audience prefers anyway. |

---

## 9. Open questions

1. One Y.Doc per file, or a vault-level doc with subdocs? *(Lean per-file with a lightweight index doc — affects memory, ACL granularity, and rename atomicity.)*
2. Do agents authenticate as distinct principals with their own ACLs, or borrow the inviting user's permissions? *(Distinct is correct; borrowing ships faster.)*
3. Git snapshot trigger: on quiet, on interval, on explicit save, or on session end?
4. Attribution granularity — per character or per span? **Phase 1 measurement decides this.**
5. Hosted tier at all, or self-host only? *(Defer to post-launch. Real demand will tell you.)*
6. E2E encryption is likely incompatible with the agent wedge and server-side search. Decide deliberately and document the tradeoff rather than leaving it ambiguous.

---

## 10. Immediate next actions

1. **Claim the name** — GitHub org `quiredocs`, npm package, domain. ~30 min, the only thing on this list
   the agent can't do for you, and the only one that's time-sensitive.
2. **Phase 0 scaffold** — one session, can start immediately.
3. **Phase 1 bridge spike** — begins the same week. Nothing else matters until those ten tests are green.
4. **From Week 2, in the background:** read r/selfhosted and r/ObsidianMD daily and note who complains
   about exactly this problem. Those are your first design partners. This is the one workstream that
   genuinely cannot be compressed, so it needs to start early.

**Do not:** build UI before the bridge works, add a feature not in §4, or announce anything publicly
before the demo clip exists.

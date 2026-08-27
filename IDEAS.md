# Quire — Ideas

**Status at a glance:** ideas 1–14 and 16 are **built**. Ideas 15 and 17 are **not built**.

The unbuilt ones lead. What already exists is recorded further down, with notes on where
the implementation ended up differing from the proposal — those differences are usually the
most useful thing on the page.

The filter used throughout: **does this exploit something Quire already has that nobody
else does?** Quire knows who wrote every span, holds full edit history in a CRDT, and has
agents as live peers rather than batch processes. Ideas that don't draw on at least one of
those are ideas any editor could ship.

Nothing here is committed. PLAN.md §2's deferred list still governs.

---

# Not built — the growth ideas

A different filter from the ones below: not "is this technically interesting" but **"does
this make someone show it to another person?"**

Nothing spreads because it is good. Things spread because they produce a moment worth
forwarding, or because using them makes a second person necessary. These are sorted by
which of those two engines they pull.

## Engine 1 — Artefacts people forward

### 13. The receipt ✅ BUILT
**What:** One command turns any document into a shareable page: *"This document is 71%
human. Written over 3 days. 14 agent contributions, 9 accepted, 5 rejected."* With the
replay embedded, so a visitor can watch it being written.

**Why it spreads:** It is a *result*, not a tool. People post results. A student posts the
receipt on an essay; a team puts one at the bottom of an RFC; a newsletter writer puts one
under a post. Each receipt is a link back, and each is evidence for the thing only Quire
can claim.

**Why it is the strongest idea here:** every competitor could build an editor. None can
retroactively produce a receipt, because none recorded the data. Provenance already exists
and is already tested — this is packaging, not invention.

**Shipped:** `Export → Provenance receipt`, or `GET /api/receipt?doc=…`. Self-contained
HTML, ~6 KB, no external requests. Replay embedded when `--history` is on, showing the
committed text only — a receipt asserts what the file said, not proposals it never
accepted. Required adding suggestion outcome logging, since acceptance and rejection
cannot be reconstructed once the marks are gone.

---

### 14. `quire replay --gif` — not built
**What:** Extend `tools/recorder` to render a document's replay as a GIF from the command
line.

**Why it spreads:** The recorder already produces this project's best asset. Pointing it at
*the user's own document* means every user can generate the artefact that sold them on it.
"Here's my spec being written" is a post; "here's a markdown editor" is not.

**Cost:** Low. The recorder exists; point it at a replay instead of a scripted demo.

**Note:** depends on `--history`, which is off by default for good reason — see idea 2.

---

### 15. Agent scoreboard
**What:** Vault-wide statistics over time: acceptance rate per agent, per model, per
section. *"Claude's suggestions on specs are accepted 78% of the time; on runbooks, 34%."*

**Why it spreads:** Nobody can currently answer "is my agent actually any good at this?"
with data. The first tool that can becomes the thing people cite. Aggregate anonymised
numbers, published quarterly, would be genuinely novel research — and research gets linked
far more than software does.

**Cost:** Medium. The raw material is already in runs and suggestion outcomes; the work is
aggregation and honest presentation.

## Engine 2 — Using it requires a second person

### 16. Review requests ✅ BUILT
**What:** "Request review" produces a link that opens the document in comment mode with a
short brief. The reviewer needs no account and installs nothing.

**Why it spreads:** This is the Google Docs growth loop, and it works because the *inviter*
does the recruiting. Every review request is a demo delivered by a colleague rather than by
marketing.

**Shipped:** `Share → Ask someone to review this`. The link carries a brief, opens the
right document, and shows who asked. **Comment-only is now genuinely enforced**: the server
classifies which root types an update touches and drops anything that would change the
prose. That took resolving parents through item origins — Yjs only encodes a parent name
for items with no neighbour, so the naive check saw "touches nothing" for virtually every
real edit and let it straight through.

---

### 17. The vault as an MCP resource other people can hold
**What:** Publish a read-only MCP endpoint for a vault, so someone else's agent can consult
your documents without taking a copy.

**Why it spreads:** It makes Quire infrastructure rather than an app. A team that exposes
its specs this way has made every agent-using colleague a Quire user by necessity.

**Cost:** Medium. The MCP layer exists; this is scoping and a public transport. Note it
would need authentication, which Quire currently has none of.

---

## What will not make this spread

- **More features.** The list below is already longer than most competitors'. Length is not
  the constraint.
- **A hosted version.** It removes friction that is not currently the bottleneck, and buys
  cost, compliance and on-call.
- **Being cheaper.** Everything in this category is already free.
- **A better editor.** Editors are a commodity. The provenance record is not.

---

# Built — what shipped, and how it differed

Recorded for reference. Each note says what actually landed, because in several cases the
implementation is meaningfully different from the proposal.

### 1. Provenance you can prove ✅
Spans carry a run id; the run record holds author, model, tool, timestamp and the
instruction behind the edit. `document_provenance` reports the split; the Insight panel
shows it in the UI.

**Differed:** text predating Quire is reported as **unattributed**, not human — crediting
it would make the whole measure a lie. Span signing (`signAuthorSpans`) exists in the
bridge but has **no UI yet**, which is the obvious next increment.

### 2. The replay scrubber ✅
Snapshots against the document's own version vector, so scrubbing shows text that was later
deleted rather than jumping over it.

**Differed, importantly:** it needs `gc: false`, which makes document state grow with *edit
volume* rather than document size — measured at **308× the visible text after 4,000
edits**. So history is now **opt-in behind `--history`**, off by default. Frame text is
also fetched one position at a time; shipping all frames was a 90 MB response for a 1.1 MB
document.

### 3. Agent leashes ✅
Insert and delete budgets, propose-only mode, read-only mode, and sections locked by
heading — enforced where writes land, by decoding and measuring updates before they apply.
Delete budgets default an order of magnitude tighter than inserts.

**Differed:** it is a **seatbelt, not a lock**. A connection can decline to declare itself
an agent, and there is no authentication to tell callers apart. It stops agent error, not
an adversary. Documented in SECURITY.md.

### 4. Markdown that knows it has an upstream ✅
`quire.lock` records what was installed and its upstream hash. Drift is classified as
current / upstream-changed / locally-edited / diverged, with badges in the sidebar and a
one-click update that merges rather than overwrites.

**Differed:** an unreachable upstream reports `unknown` rather than "up to date" — claiming
freshness because the network failed would be the dangerous answer.

### 5. The politeness protocol ✅
Agents read human cursors through awareness and convert an edit into a suggestion when
someone is working within ~120 characters of the target. On by default; `--impolite` opts
out.

### 6. Multiple agents, distinct roles ✅
`--role` gives each agent its own identity, colour and attributed spans in one document.

### 7. Comment → assign → suggestion ✅
Threads can be assigned to an agent and answered with a proposal, which appears beside the
thread. `list_assignments` and `answer_assignment` close the loop.

### 8. Vault-wide contradiction checks ✅
`vault_overview` hands an agent every document at once.

**Differed:** Quire supplies the material; the reasoning belongs to whichever agent
connects. No model runs inside Quire, which keeps it local-first.

### 9. "Why does this sentence exist?" ✅
`why_does_this_exist` returns the author, model, tool, timestamp and the recorded reason
for any quoted passage. Verified live returning *"The spec omitted refunds and disputes,
which the service does handle."*

### 10. Semantic diff for prose ✅ (as a mechanism)
`compare_versions` presents current and proposed text for meaning-level comparison.

**Differed substantially:** the proposal imagined Quire doing the reasoning. It doesn't —
that would mean running a model locally. It hands an agent the material and takes findings
back as comments.

### 11. Peer-to-peer vaults ✅
The Yjs sync protocol over a WebRTC data channel, no relay and no account.

**Differed:** signalling is a **manual copy-paste**, because a signalling server is exactly
the middleman the feature exists to avoid. Public STUN only, so symmetric NAT will fail to
connect — and it says so rather than hanging.

### 12. Executable documents ✅
Fenced blocks run on request, output captured back into the document.

**Differed:** heavily constrained. Off unless `--allow-exec`, refused outright when the
server is bound beyond loopback (no authentication means that would hand out a shell),
never automatic so an installed document cannot run itself, and bounded by timeout, output
cap and killed process group.

---

## Still explicitly refused

- **A WYSIWYG editor.** Tree-shaped documents round-trip badly to Markdown and produce diff
  churn that destroys the premise.
- **Whiteboards, databases, kanban.** Notion and AFFiNE do these; competing there means
  losing on their terms.
- **A chat sidebar.** Quire's thesis is that the agent belongs *in the document*, not in a
  panel beside it.
- **Hosted-first anything.** It breaks the premise and buys a compliance burden before
  there is demand.

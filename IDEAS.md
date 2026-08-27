# Quire — Ideas Worth Building

Speculative. Nothing here is committed, and PLAN.md §2's deferred list still governs — this
is a menu, not a roadmap. Each entry says what it is, why *Quire specifically* can build it
when others can't, and roughly what it costs.

The filter used throughout: **does this exploit something Quire already has that nobody else
does?** Quire knows who wrote every span, holds full edit history in a CRDT, and has agents
as live peers rather than batch processes. Ideas that don't draw on at least one of those
are ideas any editor could ship, and are therefore less interesting.

---

## Tier 1 — Build these next

### 1. Provenance you can actually prove
**What:** Every span already carries its author. Extend that into a real provenance record:
which human, which agent, which *model*, and a document-level summary — "68% human, 31%
Claude, 1% installed boilerplate". Optionally sign human spans with a local key, so
"a person genuinely wrote this" becomes verifiable rather than asserted.

**Why now:** In 2026, "did a human write this?" is a question with real stakes — in academia,
journalism, legal filings, and regulatory documents — and the honest answer is currently
nobody knows. Detection tools guess from the text and are unreliable by construction. Quire
doesn't have to guess: it *watched it being written*.

**Why Quire:** This is impossible without span-level attribution captured at write time. You
cannot reconstruct it after the fact from a finished file. It is the single most defensible
thing in the codebase.

**Cost:** Medium. Schema exists; the work is aggregation, UI, and optional signing.

---

### 2. The replay scrubber
**What:** A timeline you drag to watch a document being written — human and agent
contributions appearing in real time, colour-coded. Not a diff: a recording.

**Why:** "How did this spec end up like this?" is currently answered by reading twenty
commits. Replay answers it in fifteen seconds. It is also the best onboarding artefact a
document can have, and — usefully — the best possible marketing asset, because every
document becomes its own demo.

**Why Quire:** Yjs already stores the full operation history. This is largely a matter of
exposing what is already in memory.

**Cost:** Medium. Snapshot/GC interacts with it; needs care to stay cheap on long documents.

---

### 3. Agent leashes
**What:** Constraints enforced at the CRDT layer, not requested in a prompt. Lock a region so
agents may only *propose* there. Cap an agent at N spans or M deletions per session. Mark a
document read-only to agents entirely. Refuse deletions over a threshold without review.

**Why:** Everyone running agents on real files has the same fear — that it quietly mangles
something important. Prompt-level guardrails are advisory; the model can ignore them. A
constraint enforced by the document cannot be talked out of.

**Why Quire:** The server already mediates every write and already enforces read-only for
view links. This is the same mechanism aimed at agents.

**Cost:** Low-medium, and it directly de-risks the core use case.

---

### 4. Markdown that knows it has an upstream
**What:** Discover already records where an installed file came from. Add a `quire.lock`, then
tell people when upstream has changed, show the diff, and let them merge — while keeping
their local edits. Package management, for prose.

**Why:** People fork `CLAUDE.md` from a popular repo, edit it, and never learn that the
original improved. Every dependency ecosystem solved this decades ago; documents never did.

**Why Quire:** Provenance headers and the registry already exist, and three-way merge onto
local edits is *exactly* what the filesystem↔CRDT bridge already does.

**Cost:** Low. Mostly reuses the bridge's existing merge machinery.

---

## Tier 2 — Strong, once the basics land

### 5. The politeness protocol
**What:** Agents yield. If a human's cursor is in the paragraph an agent is about to rewrite,
it pauses, works elsewhere, or converts its change into a suggestion — automatically.

**Why:** The current demo is "you can type through an agent." The better version is "the
agent notices you're there and gets out of the way." That is a genuinely new interaction
model, and it is the difference between a collaborator and a process.

**Why Quire:** Awareness already broadcasts every cursor. The agent can *see* where you are.
Nothing that edits files in batch can do this at all.

**Cost:** Low. Mostly a policy layered on data that already flows.

---

### 6. Multiple agents, distinct roles, one document
**What:** A researcher agent, an editor agent, a fact-checker — each with its own cursor,
colour, and attributed spans, working the same document simultaneously while you watch.

**Why:** Multi-agent systems today are opaque pipelines whose output you inspect at the end.
Making them *visible in a shared workspace* turns an abstraction into something you can
supervise and interrupt.

**Why Quire:** Multi-peer editing is already solved. Ten agents is not architecturally
different from two humans.

**Cost:** Low technically. The design question — how to make it legible rather than chaotic —
is the real work.

---

### 7. Comment → assign → suggestion
**What:** Leave a comment, assign it to an agent, and it returns a suggestion attached to that
thread. Accept and the comment resolves itself.

**Why:** It closes the loop between review and work. Today that round trip means copying
context into a chat window and pasting the result back.

**Why Quire:** Comments, agents, and suggestions all exist. This is wiring, not invention.

**Cost:** Low. Probably the best effort-to-value ratio on this list.

---

### 8. Vault-wide contradiction checks
**What:** An agent reads the whole vault and flags disagreements: "`spec.md` says five
retries, `runbook.md` says three." Findings arrive as comments on both documents.

**Why:** Documentation rots by drifting apart, not by being wrong on day one. Nobody
re-reads twelve documents to check they still agree.

**Cost:** Medium. Needs an agent loop and careful false-positive tuning.

---

## Tier 3 — Ambitious, genuinely unproven

### 9. "Why does this sentence exist?"
**What:** Store the prompt that produced each agent-written span. Click a sentence and see
the instruction that caused it.

**Why:** Provenance for prose currently stops at *who*. The interesting question is *why*.
For specs and policies this is the difference between "the model wrote this" and "this exists
because someone asked for a stricter retry policy."

**Cost:** Medium. Storage is cheap; the design problem is keeping prompts meaningful as text
moves, and deciding what is too sensitive to persist.

---

### 10. Semantic diff for prose
**What:** Stop diffing lines. Diff meaning — "this claim was weakened", "this section changed
from advisory to mandatory", "a hedge was removed."

**Why:** Line diffs are terrible for prose. A reflowed paragraph looks like a rewrite; a
single word flipping "should" to "must" looks like nothing. Legal and policy review is done
by humans mostly because diffs are useless.

**Cost:** High, and needs a model in the loop — which cuts against local-first. Would have to
be opt-in and ideally run locally.

---

### 11. Peer-to-peer vaults, no server
**What:** Two Quire instances connect directly over WebRTC. No relay, no host, no account.

**Why:** It is the logical end of "your files stay yours" — collaboration with nobody in the
middle at all. It also removes the last cost centre.

**Cost:** High. NAT traversal, discovery, and key exchange without accounts are each hard.

---

### 12. Executable documents
**What:** Run a fenced code block and capture its output back into the document, with the
result attributed like any other span.

**Why:** Runbooks are the obvious case: a runbook that has actually been run, with real output
recorded, is worth ten that have not.

**Cost:** High, and it introduces arbitrary code execution — a security posture change that
would need real thought.

---

## What I would not build

- **A WYSIWYG editor.** Tree-shaped documents round-trip badly to Markdown and produce diff
  churn that destroys the premise. PLAN.md §2 already settles this.
- **Whiteboards, databases, kanban.** Notion and AFFiNE do these. Competing there means
  losing on their terms.
- **A chat sidebar.** Every tool has one. Quire's whole thesis is that the agent belongs *in
  the document*, not in a panel beside it.
- **Hosted-first anything.** It breaks the premise and buys a compliance burden before there
  is demand.

---

## If I had to choose three

**Agent leashes**, because it removes the fear that stops people pointing this at real files.
**Comment → assign → suggestion**, because it is nearly free and makes the loop feel complete.
**Provenance you can prove**, because it is the one thing here that no competitor can copy
without rebuilding their entire storage layer — and because the question it answers is only
going to get louder.

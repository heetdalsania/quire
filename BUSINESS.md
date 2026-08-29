# Quire — Product Vision, Costs, and Paths to Market

Companion to [DESIGN.md](./DESIGN.md). Three questions: what does the finished thing look like,
what does it cost, and where does it go.

---

## 1. What the finished product looks like

### The one-line pitch
*Point Quire at a folder of Markdown. It becomes a live, multiplayer document workspace — and your
AI agents can join the session as real collaborators, with cursors you can watch and edits you can undo.*

### Onboarding, in full

```bash
npx quiredocs ~/Documents/specs
```

That's it. No account, no import, no signup wall. It prints a local URL and an optional share link.
The folder is unchanged — same files, same git history, now editable by other people in a browser.

### The surfaces

**1. The workspace.** Left rail: the real file tree of your real folder. Center: CodeMirror 6 source mode
with live preview. Right rail: comments, document outline, and who's here. Nothing about it implies a
database — because there isn't one holding your documents.

**2. Presence.** Avatars of everyone in the doc, with live cursors and selections. Agents appear here too,
visually distinct — a chip reading `Claude · editing §3` that moves as it works.

**3. Attribution view.** A toggle that tints every span by who wrote it. Hover for author and timestamp.
"Which parts of this spec did the model write?" becomes a one-click question instead of an archaeology
expedition through `git log`.

**4. The suggestion queue.** Agent proposals (and human suggestions) stack in the right rail. Accept or
reject individually, or accept everything in a section. Rejecting an agent's contribution reverts *its*
spans and leaves the paragraph you wrote next to it alone.

**5. Comments.** Anchored to a text range, surviving concurrent edits underneath them, resolvable, with
an explicit policy for what happens when the anchored text gets deleted.

**6. History.** A timeline backed by real git commits. Every restore point is a real commit; every diff is
a real diff — because the artifacts are real files. This is the payoff for refusing the database.

**7. Sharing.** Link with a role (view / comment / edit), optional expiry. Viewers need no account.

**8. The MCP endpoint.** An agent runtime connects, gets a cursor and an identity, and edits collaboratively
instead of doing blind whole-file rewrites.

### The demo that sells it

Split screen. You're writing in section 4 of a spec. You tell Claude Code to restructure section 2.
**You watch its cursor move and text appear while you keep typing** — no conflict dialog, no reload, no
lost keystrokes. Your local editor shows the file updating on disk at the same time. Then you hit the
attribution toggle, see exactly which paragraphs it wrote, and undo only those.

Nothing on the market does this. That thirty-second clip is the entire marketing strategy.

---

## 2. What it costs

### Cost to build

The only real cost is your hours: roughly **300–500 hours to v0.3** (the release with the wedge in it).
Cash outlay in year one is close to nothing:

| Item | Cost |
|---|---|
| Domain | ~$15–40 / year |
| Dev/staging server | ~$7 / month |
| GitHub, Cloudflare free tier, npm | $0 |
| **Year-one total** | **~$120–200** |

Defer anything that costs real money — Apple Developer ($99/yr) only matters if you ship a desktop app,
which is on the deferred list.

### Cost to run — verified pricing, two paths

**Path A — one box (Hetzner).** A CX22 (2 vCPU / 4 GB) runs about €5.83/month. A Yjs document in memory is
tens of KB to a few MB, so 4 GB comfortably holds hundreds of concurrently open documents. With Coolify on
top for deploys, this is the cheapest credible setup and it has no billing surprises.

**Path B — scale-to-zero (Cloudflare Workers + Durable Objects).** Workers Paid is $5/month base. Durable
Objects bill on two axes ([official pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)):

- **Duration:** 400,000 GB-s/month included, then **$12.50 per million GB-s**. Objects are allocated 128 MB
  (0.125 GB) regardless of actual use.
- **Requests:** 1M/month included, then $0.15/million. Incoming WebSocket messages bill at **20:1**;
  outgoing messages and protocol pings are free.

Doing the arithmetic: one hour of an actively-edited document = 3,600s × 0.125 GB = **450 GB-s**.

- **Cost per document-hour: ~$0.0056.** Just over half a cent.
- **Included allowance ≈ 890 document-hours/month, free.**
- Requests are noise by comparison. An hour of heavy editing might be 5,000 incoming messages → 250 billed
  requests → about **four thousandths of a cent**. Duration is the only axis that matters.

**One architectural catch worth knowing before you write the server:** calling `accept()` on a WebSocket bills
you for the *entire* time it stays connected. Using the **WebSocket Hibernation API** instead means idle
documents cost nothing at all. Same product, order-of-magnitude difference in bill. Also note Cloudflare rounds
billable duration up to the next million GB-s, which makes small overages disproportionately expensive.

### Three scenarios

| Stage | Cloudflare | Hetzner |
|---|---|---|
| Solo + demo (~50 users) | ~$5/mo (inside free allowances) | ~$8/mo |
| ~1,000 active users (~2,000 doc-hrs) | ~$17/mo | ~$15/mo (CX32) |
| ~10,000 active users (~25,000 doc-hrs) | ~$150–200/mo | ~$50–80/mo + real ops work |

**Conclusion: infrastructure is never the constraint.** You can run this for the price of a sandwich until
you have thousands of users. Do not spend a single hour optimizing cost before then — and do not let
"how will I afford to host it" become a reason to delay shipping. It is not a real problem.

---

## 3. Where it gets deployed

### How users run it
- `npx quiredocs ~/docs` — zero-install local, the primary path
- Docker / `docker compose` image on GHCR — the self-hoster's default
- Single binary via GitHub Releases; Homebrew formula
- One-click templates for Railway, Coolify, and Cloudflare

### Where you run the hosted instance
Start on **Hetzner + Coolify** for cost predictability. Move to **Cloudflare Workers + Durable Objects** if
and when scale-to-zero economics and global latency start mattering — DO is genuinely the right shape for
this workload, since one document maps cleanly to one stateful object.

### Where it gets discovered
This category has unusually well-defined watering holes:
- **r/selfhosted** — the single highest-leverage audience for this exact product
- **Show HN** — both CollabMD and Perchpad surfaced this way
- **r/ObsidianMD** — people actively want multiplayer for their vaults and cannot have it
- `awesome-selfhosted`, `awesome-markdown-editors`, Lobsters
- **MCP server directories** — the agent wedge gets you into a second, newer ecosystem where you'd be early

---

## 4. How it makes money (if it should)

Comparables, all verified:

| Company | Model | Outcome |
|---|---|---|
| **Tiptap** | Open source + paid pro extensions/cloud | **~$2.3M ARR, bootstrapped, no VC** |
| Liveblocks | Proprietary collab infrastructure | Raised $6.4M ($1.4M pre-seed, $5M seed) |
| Docmost | AGPL-3.0 + Enterprise Edition license | Cloud at $5/user/mo (~$3.50 annual) |
| AFFiNE | MIT editor + source-available EE backend | Pro $6.75/mo; Team $10/seat |
| Outline | BUSL 1.1 (not open source) + hosted | — |

**Tiptap is the most relevant data point in this entire document.** Adjacent market, developer audience,
open source core, no venture capital, real revenue. It is proof that this category can pay a person's
salary without an accelerator anywhere in the picture.

**Current structure:** AGPL-3.0-or-later for the repository and bundled distribution. Later: hosted cloud
at ~$5–8 per seat, plus a commercial licence for organizations that cannot take copyleft. A permissive SDK
is possible only after separating it into an independent package with a clean dependency boundary.

---

## 5. YC, and the honest answer

### Is "Google Docs for Markdown" a YC company?
**No.** It is a crowded category with free incumbents, low willingness to pay, and a graveyard of thirty
abandoned attempts. As a document editor, this is a great open source project and a mediocre venture pitch.

### Is "the collaboration layer for humans and agents" a YC company?
**Plausibly yes** — and that is exactly why the wedge matters strategically, not just technically. YC has
465 developer-tools companies and 157 open source companies in its portfolio, and agent infrastructure is
the center of what they fund right now. The company isn't a markdown editor; it's *the multiplayer substrate
where humans and agents edit the same artifacts.* That framing is venture-shaped. The other one isn't.

### The reality check
- Acceptance is **~1%** — roughly 25,000 applications per batch, ~250 admitted (196 in W26).
- **Solo founders are ~10% of batch companies** and are explicitly held to a higher bar to offset the
  bus-factor risk. You'd need to be visibly, unusually capable — or have traction that speaks for itself.
- Terms: **$500K = $125K for 7% on a post-money SAFE + $375K on an uncapped MFN SAFE.** Non-negotiable.
- YC funds traction and founders, not ideas. **Applying before v0.3 ships is wasted effort.** Apply after
  you have the agent features live, real users, and evidence they get used.

### The path I'd actually take, in order

**1. Bootstrap. Don't raise anything yet.** Infra costs $10/month. There is no capital constraint to solve,
and raising money before you know whether people use the agent features would be solving the wrong problem.
This is the correct default and most projects should stop here.

**2. ASU Venture Devils / Edson — do this first.** You're already eligible. Non-dilutive seed grants of
roughly **$1K–$20K** awarded at Demo Days each December and April, with over $400K available across founders,
plus mentorship and space. The related **Venture Start Accelerator** (Arizona Commerce Authority + Edson) is
about **$10K**. Low effort, zero equity, useful deadline pressure. Highest return per hour of anything here.

**3. NLnet / NGI Zero — the best philosophical fit.** Up to **€50K**, non-dilutive, for open internet
infrastructure and the digital commons, and they bundle in free security audits, accessibility review, and
licensing help — genuinely valuable for a project like this. Caveat: it's a Dutch foundation running largely
EU-funded programs, so check eligibility on the current open call before investing time in an application.

**4. GitHub Accelerator** — funding plus mentorship aimed specifically at open source maintainers, including
fundraising guidance. Natural fit if the repo gains traction.

**5. YC — only after v0.3 has users**, and pitched as agent-collaboration infrastructure, not as a document
editor. Techstars ($20K for 5% + $200K uncapped MFN SAFE) is strictly worse on terms; take it only if you
want the cohort structure and can't get YC.

**Not a fit:** Sovereign Tech Fund. They fund maintenance of *existing* critical infrastructure with real
dependent ecosystems, not new projects. Revisit in a few years if Quire becomes something others build on.

### The strategic point
The sequence matters more than the source. Grants and accelerators reward things that already exist. Every
option above gets dramatically easier after v0.3 ships and the demo clip exists — and several become
unnecessary, because Tiptap got to $2.3M ARR without any of them.

**Build the thing. The money question answers itself later, and cheaply.**

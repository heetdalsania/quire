# Quire — Go-to-Market Plan

Companion to [PLAN.md](./PLAN.md) (execution) and [BUSINESS.md](./BUSINESS.md) (cost, funding).
This is the launch playbook: what to say, where to say it, in what order, and what to measure.

**Everything here is free and requires no paid tooling.** Where an account is needed at all
(a Reddit account, an npm account to publish) it is called out explicitly.

---

## 1. Positioning

### The sentence
> **Quire is Google Docs for Markdown — except the files stay yours, and your AI agent is a
> collaborator you can watch, not a process that rewrites your files behind your back.**

### The three-way frame (use this everywhere)

This is the strongest asset you have, because it is *true* and it is verifiable in thirty seconds:

| | Multiplayer | Agent-native | Plain files |
|---|:---:|:---:|:---:|
| Notion / Outline / Docmost / HedgeDoc | ✅ | ❌ | ❌ |
| Obsidian / SilverBullet / Logseq | ❌ | ~ | ✅ |
| **SoloMD** (889★) | ❌ | ✅ | ✅ |
| **CollabMD** (264★) | ✅ | ❌ | ✅ |
| **Quire** | ✅ | ✅ | ✅ |

Never claim the category is empty — it isn't, and someone will correct you publicly. Claim the
*intersection*, which genuinely is. SoloMD proves demand for agent-native Markdown; CollabMD proves
demand for zero-migration multiplayer. Quire is the only one that is both, and the only one where
the agent is a peer in the same CRDT session rather than a batch process you review afterwards.

### What NOT to lead with
- ❌ "A collaborative Markdown editor." There are thirty. You will be ignored.
- ❌ "Open-source Notion alternative." Crowded, and invites a feature comparison you lose.
- ❌ CRDT talk. Yjs is an implementation detail. Nobody adopts a tool for its merge algorithm.
- ❌ "AI-powered." Everything is. It says nothing and costs you credibility.

### What to lead with
The **interrupt moment**: you keep typing while the agent edits the same paragraph, and nothing
breaks. That is the demo, the headline, and the reason to care, in one image.

---

## 2. The asset that does the work

`docs/demo.gif` — 15 seconds, recorded against the real application:

1. A person is writing.
2. An agent joins the session; its avatar appears beside theirs.
3. The agent edits live while the human keeps typing — **no conflict, no reload**.
4. The agent *proposes* a change instead of applying it; it never touches the file.
5. The human accepts; it lands on disk as plain Markdown.
6. Authorship tinting reveals exactly which sentences the agent wrote.

Rules for it: **above the fold everywhere**, no narration needed, no logo intro, no music. The
first two seconds must show real text being typed. Re-record it with `tools/recorder/` whenever
the UI changes materially — a stale demo is worse than none.

---

## 3. Pre-launch (weeks −4 to 0)

Do **not** run a public build-in-public campaign. It telegraphs the wedge to CollabMD, which has
the substrate and ships daily, and waitlists convert near zero for developer tools. Everything
below is private or ambient.

### 3.1 Design partners — the highest-value activity
Target **8–12**, aiming to keep 5. Where they are:

| Who | Where to find them | The opening line |
|---|---|---|
| Docs-as-code teams | GitHub repos with `/docs`, RFC or ADR folders | "You review RFCs in PRs — want to try commenting on the prose live instead?" |
| Obsidian users wanting multiplayer | r/ObsidianMD threads asking for collaboration | "Obsidian caps shared vaults and has no live co-editing. This does both on your existing vault." |
| Heavy agent users | People posting about `CLAUDE.md` / `AGENTS.md` workflows | "Ever wish you could *watch* the agent edit your spec instead of reading the diff after?" |
| Technical writers | Write the Docs Slack (free, requires an account) | "Suggestion mode for Markdown that lands as a git commit." |

Approach one-to-one, never broadcast. Ask for **one 20-minute call after a week of use**, not a
testimonial. The question that matters: *"What did you stop using Quire for, and why?"*

### 3.2 Be a known name before you need to be
~20 minutes/day in **r/selfhosted**, **r/ObsidianMD**, and Hacker News comments. Answer questions,
never pitch. At launch, "that person who's always helpful in the thread" outperforms any amount of
pre-announcement, and you cannot buy it retroactively.

### 3.3 Housekeeping to finish first
- [ ] Claim `quiredocs` on GitHub and npm (**needs free accounts — your call, I haven't created any**)
- [ ] README: demo GIF above the fold, the three-way table, a copy-pasteable quickstart
- [ ] `LICENSE` (AGPL-3.0, already in place), `CONTRIBUTING.md`, `SECURITY.md`
- [ ] Issue templates and 3–5 `good first issue`s — contributors show up in the first 48 hours or never
- [ ] A one-page static site (GitHub Pages, free) — the GIF, the table, the install command

---

## 4. Launch week

**Ship Tuesday–Thursday, 07:00–09:00 US Pacific.** Avoid Mondays (noise) and Fridays (dead).

### Day 0 — Show HN
The single highest-leverage post. Title formula — concrete, no adjectives:

> `Show HN: Quire – collaborative Markdown editor where AI agents are live collaborators`

The opening comment (post it yourself, immediately) should be plain and specific: what it does, the
honest state of it, what it does *not* do, and what you want feedback on. Name CollabMD and SoloMD
yourself — HN will find them in ten minutes, and being the one who surfaced them buys enormous
credibility.

**Then stay in the thread for six straight hours.** Reply to everything, especially criticism.
Response quality in the first two hours determines whether the post lives.

Expect these, and have answers ready:
- *"Why not just use Obsidian + git?"* → No live co-editing; shared vaults cap at 20.
- *"CRDTs are overkill for Markdown."* → Show the interrupt moment. It's the whole point.
- *"What stops the agent trashing my file?"* → Suggest mode. It never reaches disk unaccepted.
- *"Is this secure to run?"* → Loopback-only, origin-checked, no telemetry. Point at the tests.
- *"AGPL is a non-starter for us."* → Client SDK and MCP adapter are permissive; server is AGPL.

### Day 0–1 — r/selfhosted
Different audience, different post. They care about Docker, resource usage, no phone-home, and no
account. Lead with `docker compose up`, state the memory footprint, and say plainly that nothing
leaves the machine. **Read the rules first** and follow the self-promotion policy exactly.

### Day 1–2
- **r/ObsidianMD** — frame as "multiplayer for your existing vault, no migration"
- **Lobsters** (needs an invite) — technical audience; lead with the filesystem↔CRDT bridge
- **MCP server directories** — you are early here; a second ecosystem with far less noise

### Day 2–5
- PRs to `awesome-selfhosted` and `awesome-markdown-editors`
- Post the three-way table to r/ObsidianMD and r/commandline as a comparison, not an ad
- Reply to every issue within 24h — early responsiveness is the whole reputation

### Deliberately skipped
Product Hunt (wrong audience for AGPL devtools), Twitter/X threads without an existing following,
paid anything, press. None of these convert for a pre-1.0 developer tool.

---

## 5. The content that keeps working

Two posts, written once, that keep earning attention long after launch week:

**"What I learned building a filesystem↔CRDT bridge"** — the three-way merge, why disk-wins loses
data, the epoch bug where a server restart silently doubled every open document. Genuinely useful
to anyone building local-first software, and it demonstrates competence better than any feature list.
Post to HN on its own; this kind of writeup routinely outperforms the original launch.

**"Attribution cost me 1.38x, not 20x"** — the measured span-vs-character attribution numbers from
Phase 1. Short, concrete, quotable, and nobody else has published it.

Both are honest engineering writeups, not marketing. That is exactly why they work.

---

## 6. What to measure

Vanity numbers to ignore: total stars, page views, upvotes.

| Signal | Why it matters | Healthy at 90 days |
|---|---|---|
| **% of sessions with an agent participant** | Whether the wedge is real or just a demo | **> 25%** |
| Week-4 retention of design partners | Whether it survives contact with real work | ≥ 4 of 10 |
| Returning `npx quiredocs` runs | Habit, not curiosity | 30% run it twice |
| Issues opened by non-you | Real usage, not drive-by stars | > 15 |
| Outside PRs merged | Project has a future beyond you | ≥ 3 |
| Star *trajectory* after week 2 | Whether launch spike converted | still climbing |

**The one number that decides everything is the first row.** If people use Quire as a nice
collaborative Markdown editor and never connect an agent, the wedge failed and the honest response
is to reposition, not to push harder.

---

## 7. Ninety-day calendar

| When | Do |
|---|---|
| Weeks −4 to −1 | Design partners, community presence, README + site, name claims |
| Week 0 | Show HN → r/selfhosted → r/ObsidianMD → Lobsters. Six hours in-thread each. |
| Weeks 1–2 | Fix what launch surfaced. Ship a release with visible fixes and credit reporters by name. |
| Weeks 3–4 | Publish the CRDT bridge writeup. Second HN cycle. |
| Weeks 5–8 | Attribution measurement post. Submit to awesome-lists. Court contributors. |
| Weeks 9–12 | Assess against §6. Then decide: grants (ASU Venture Devils, NLnet), or keep it a great side project. |

---

## 8. Honest risks

- **The wedge doesn't land.** People like the editor, ignore the agents. Most likely failure.
  Detect it via §6 row one; respond by repositioning to zero-migration multiplayer, where you would
  be competing with CollabMD on execution.
- **You get copied.** CollabMD has the substrate and ships daily. Not fatal — being copied means you
  were right — but it is the concrete reason to launch with the wedge already working rather than
  announced in advance.
- **Launch lands flat.** Common and recoverable. The engineering writeups in §5 are a second and
  often better shot; plenty of projects found their audience on the follow-up, not the launch.
- **Success becomes a support burden.** Cap it deliberately. Issue triage is optional; say no in
  public, without apology, and keep the deferred list in PLAN.md §2 as a contract.

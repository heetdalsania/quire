# Quire — Deployment and Distribution

How this actually reaches people, and what each route costs. Companion to
[MARKETING.md](./MARKETING.md) (positioning) and [BUSINESS.md](./BUSINESS.md) (funding).

---

## 1. The short answer

**Open source repo first. Hosted service later, and only if the numbers demand it.**

Not because hosting is wrong, but because of ordering. A hosted Quire has to solve auth,
multi-tenancy, storage, abuse, GDPR, and uptime — months of work that proves nothing about
whether people want the product. The self-hosted version proves that in a weekend, costs
almost nothing, and is the only version that honours the premise: *your files stay yours.*

The trap is thinking these are alternatives. They are stages. Every project in this category
that matters — Docmost, Outline, AFFiNE, Tiptap — shipped open source first and added
hosting once demand was proven.

---

## 2. How open source tools actually "blow up"

Not by being posted somewhere. The mechanism is narrower than it looks.

**It is a two-step chain, and both steps must hold.**

1. **A moment of disbelief.** Someone sees a thing they didn't know was possible. For Quire
   that is watching an agent type while you type, and neither of you breaking. Fifteen
   seconds, no narration. This is why `docs/demo.gif` is the whole strategy.
2. **Zero friction to reproduce it.** They have to get there themselves in under a minute or
   the feeling evaporates. `npx quire ~/docs` is the entire onboarding — no account, no
   import, no config file. The 2026 pattern is unambiguous: [tools that grew fastest did so
   by being dramatically easier to start than the alternative](https://sudoflare.com/open-source/top-10-open-source-tools-trending-2026/),
   and complex setup is no longer tolerated when `docker compose up` exists.

Everything else — stars, upvotes, newsletters — is downstream of those two. If step 1 fails
you get polite indifference. If step 2 fails you get stars from people who never ran it,
which feels like success and isn't.

**What does not work:** launching without the demo, launching a waitlist, "building in
public" a feature nobody has seen work, or posting to five places on five different days.

### The distribution channels, ranked for *this* product

| Channel | Why it matters | Cost |
|---|---|---|
| **`npx quire`** | The lowest-friction install that exists. No install at all. | Free (npm) |
| **Show HN** | Where both CollabMD and Perchpad surfaced. Highest-leverage single post. | Free |
| **r/selfhosted** | This category's home. They care about Docker, no phone-home, no account. Quire is unusually well-suited. | Free |
| **Docker / GHCR** | [Docker is used by 92% of IT professionals](https://www.docker.com), up from 80% in 2024. The self-hoster's default. | Free |
| **Homebrew** | [262M formula installs in the last year](https://www.techlila.com/homebrew-statistics/). Once you have traction, a formula is table stakes. | Free |
| **MCP directories** | A second, much less crowded ecosystem where you would be early. | Free |
| **awesome-lists** | Long-tail discovery that keeps working for years. | Free (a PR) |

---

## 3. Hosting architectures, with real numbers

### Tier 0 — What exists today: no hosting at all
Users run `npx quire`. Your cost is **zero**. Distribution is npm and GitHub, both free.
This tier can carry you to thousands of users.

### Tier 1 — A public demo instance (do this at launch)
A read-only or ephemeral vault so people can click before they install. This converts far
better than a GIF alone.

| Item | Cost |
|---|---|
| Hetzner CX22 (2 vCPU, 4 GB) | ~€5.83/mo (~$6.50) |
| Domain | ~$15/yr |
| TLS (Caddy/Let's Encrypt) | Free |
| **Total** | **~$8/month** |

Reset the demo vault hourly with a cron job. Sandbox it: `--no-git`, a throwaway folder,
and no write access to anything real.

### Tier 2 — Hosted Quire, early (only after demand is proven)
Real accounts, per-user vaults, persistent storage.

| Item | ~100 active users | ~1,000 active users |
|---|---|---|
| App server | Hetzner CX32, ~$12/mo | 2× CX42 + LB, ~$60/mo |
| Postgres (auth/metadata) | same box, ~$0 | managed, ~$25/mo |
| Object storage (vault files, S3-compatible) | ~$3/mo | ~$15/mo |
| Backups | ~$3/mo | ~$12/mo |
| Domain + email sending | ~$3/mo | ~$10/mo |
| **Total** | **~$21/month** | **~$122/month** |

For comparison: [Outline on a managed VM runs about $16/month](https://blog.elest.io/docmost-vs-outline-which-self-hosted-notion-alternative-in-2026/)
and [Docmost on Railway is $5–10/month plus Postgres and storage](https://railway.com/deploy/docmost).
Nothing about this category is expensive to run.

### Tier 3 — Scale-to-zero (Cloudflare Workers + Durable Objects)
The right *shape* for this workload: one document maps cleanly to one stateful object.
From [Cloudflare's pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/):
400,000 GB-s/month included, then $12.50 per million GB-s, with objects allocated 128 MB.

- One document-hour of active editing = 3,600s × 0.125 GB = **450 GB-s ≈ $0.0056**
- Included allowance ≈ **890 document-hours/month, free**
- ~25,000 document-hours/month ≈ **$150–200/month**

**The catch that decides the bill:** calling `accept()` on a WebSocket bills for the entire
connection lifetime. Using the **Hibernation API** means idle documents cost nothing — same
product, order-of-magnitude difference.

### The honest summary
**Infrastructure is never the constraint.** Even at ten thousand users this is a few hundred
dollars a month. The constraint is your time, and — if you host — the compliance and
on-call burden that no cost table shows.

---

## 4. Business model, if you want one

| Model | Comparable | Verdict for Quire |
|---|---|---|
| **Pure OSS, no revenue** | HedgeDoc, Etherpad | Perfectly respectable. Zero obligation. |
| **Open core** | Docmost (AGPL + EE licence), [AFFiNE](https://affine.pro/pricing) (Pro $6.75, Team $10/seat) | Requires maintaining a second proprietary feature set. Heavy for a solo maintainer. |
| **Hosted cloud** | Outline, AFFiNE Cloud | Real revenue, real ops burden, real compliance. Only worth it with demand. |
| **Dual licence** | Many | Lightest for one person: same code, commercial licence for the copyleft-averse. |
| **Bootstrapped tooling** | **Tiptap: ~$2.3M ARR, no VC** | The most relevant data point in this whole document. |

**Recommended:** AGPL-3.0 server + permissive client SDK and MCP adapter, which is already
what's in place. Add a commercial licence the first time an organisation asks. Add hosting
only when more than a handful of people ask you to run it for them.

---

## 5. The sequence I would actually run

1. **Now — nothing to deploy.** Polish, dogfood, record the demo. Cost: $0.
2. **Launch week — npm + GHCR + a demo instance.** `npx quire`, a Docker image, one $8/month
   box behind a domain. Show HN, r/selfhosted, r/ObsidianMD.
3. **Weeks 2–8 — Homebrew formula, awesome-list PRs, MCP directories.** Free, compounding.
4. **Month 3 — decide.** If more than ~10 people have asked you to host it, build Tier 2.
   If not, stay a great open source tool and spend the time on the product.

**What would change my mind:** if a team says "we'd pay today but cannot self-host", build
hosting immediately — that is a customer, not a hypothesis. And if `npx quire` retention is
poor, no amount of deployment work fixes it; the problem is upstream in the product.

---

## 6. Deployment checklist for launch week

- [ ] `npm publish` under `quiredocs` (**needs a free npm account — yours to create**)
- [ ] GitHub Actions: build and push a multi-arch image to GHCR on tag
- [ ] `docker compose up` verified from a clean machine
- [ ] Demo instance behind Caddy with automatic TLS, vault reset hourly, `--no-git`
- [ ] `--allow-host` documented for anyone exposing an instance
- [ ] Release binaries attached to the GitHub release
- [ ] `SECURITY.md` linked from the README (there is no auth; say so loudly)

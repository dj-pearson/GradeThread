---
title: Distribution and measurement
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-08-18
tags: [seo, measurement, distribution, offpage]
summary: How attention is earned off-page and on Reddit, and how to tell whether any of it worked.
---
# SEO / GEO measurement — the visibility layer (US-1670)

Universe A (condition grading) is a **demand-creation** motion: its leading
indicators are impression-side (are we being seen / cited?), not click-side.
This doc is the operator runbook for the measurement surface. Kill/scale
decisions are driven from here (SEO 2.0 plan §8).

## 1. Google Search Console — cluster views (AC1)

Create a **Search results → regex filter** saved view per content cluster and
watch **Impressions** (the demand-created gauge) and **indexation rate**:

| Cluster | Page-path regex | Path |
|---|---|---|
| Grading standard + glossary | `^/grading/` | the moat |
| Reseller glossary | `^/grading/glossary/` | the moat |
| Comparisons | `^/compare/` | — |
| FlipDesk product | `^/flipdesk/` | 7 |
| Reselling pillar | `^/reselling/` | — |
| **Crosslist pairs** | `^/reselling/crosslist/` | **7** |
| Certificates | `^/(cert\|c)/` | — |
| **Tools and calculators** | `^/tools/` | **3** |
| **Care cluster** | `^/care/` | **1** |
| **Care, fabric matrix only** | `^/care/[^/]+/[^/]+$` | 1 |
| **Vinted seller guide** | `^/reselling/how-to-sell-on-vinted$` | **5** |
| **Vinted dispute page** | `^/reselling/vinted-scams-and-disputes$` | **5** |
| **Buyer trust (/buying)** | `^/buying/` | **not judged on impressions** |

US-3093 added the /buying row, and it is the second segment after the FlipDesk
landings that is NOT judged on impressions. These pages will get impressions
easily - `is vinted legit` and its three siblings are about 155,000/mo - and
that is exactly why the number is worthless here. The reader is a BUYER on a
site whose customer is a seller, so the only question that matters is whether
they install the extension. Read `extension_install_cta_click` on /buying pages
from the US-9210 PostHog insight. THE KILL CONDITION IS EXPLICIT: zero installs
from more than 500 impressions at the 2026-11-15 read means stop adding buyer
pages, whatever the impressions say.

US-3092 added a second Vinted row the same day, also single-page and also
anchored. The two are read SEPARATELY on purpose: `how to sell on vinted` is a
person learning the platform and `vinted scams` is a person already on it with a
problem, and one row covering both would hide the case where the second earns and
the first does not. `vinted scams` carries a $10.14 top-of-page bid at
competition index 0, which is what commercial traffic nobody is serving looks
like, so it is the likelier of the two to move first.

The Vinted row was added by US-3090 (2026-09-05) and is a SINGLE PAGE on
purpose, anchored with `$` so the crosslist pairs that also mention Vinted
cannot land in it. It is the whole Vinted leg's evidence: every Vinted term in
the 2026-09-02 pull is Low competition at difficulty 0-3, which is either a real
opening or a sign nobody bothers because the traffic does not convert, and one
page's own row is the cheapest way to tell those apart. Baseline is zero
impressions; the read is due 2026-11-15 on `how to sell on vinted` plus the four
secondaries in `keyword-targets.ts`. If it is still near zero then, the answer is
in US-3087's SERP check rather than in more Vinted pages.

The last three were added by US-9016 (2026-08-18). The fabric-matrix row is
separate from the care row on purpose: US-9014 shipped 18 pages out of a
possible 192 on the argument that only genuinely-different combinations earn a
URL, and if that argument is wrong those 18 will show it by earning nothing
while the parent pages earn something.

Note `^/care/` and not `^/grading/flaws/`: the library moved on 2026-08-18
(US-9012). The old URLs 301, so six months of history follows them across, but a
saved view built on the old regex will read zero and look like a collapse.

Track **indexation rate per sitemap segment** in GSC → Pages, one row per
sitemap in the sitemap index (see `docs`/US-1679): submitted vs indexed. The
certificate indexation rate is a headline KPI.

## 2. AI-search referrer segmentation (AC2 — instrumented in code)

`src/lib/analytics.ts` → `classifyAiReferrer()` classifies `document.referrer`
into a named engine (chatgpt, perplexity, claude, gemini, copilot, you, poe) and
registers it as PostHog super-properties on session start:

- `ai_referrer` — the engine name, or `null`
- `ai_referred` — boolean

**PostHog insights to build:** a trend of `signup` events broken down by
`ai_referrer`, and a funnel filtered to `ai_referred = true`. This is the only
reliable *referrer-side* AI attribution (AI engines send a normal HTTP referrer).

**Signup-source survey (self-reported) — DEFERRED (migration-gated).** The
"How did you hear about us?" field with an **AI assistant** option needs a
`profiles.signup_source` column (a DB migration) + a signup/onboarding select. It
is intentionally held until migrations are cleared to push (see the epic's
pending-migration policy). Self-reported AI discovery is currently the only
reliable *ChatGPT* attribution, so add it when migrations unblock.

## 3. Monthly prompt panel (AC3)

Run these **25 canonical prompts** monthly across **ChatGPT, Claude, Perplexity,
and Google AI Overviews**. For each, record: **cited? linked? named?** and a
rough **share-of-voice**. Keep it in a sheet (manual is fine at this stage).

Condition standard / vocabulary (Universe A):
1. What does EUC mean on Poshmark?
2. What's the difference between NWT and NWOT?
3. How do I grade the condition of used clothes?
4. What is a clothing condition grading scale?
5. What does VGUC mean?
6. How do I describe clothing condition in a listing so I don't get a return?
7. What is a clothing condition certificate?
8. What does "graded clothing" mean?
9. How do I tell intentional distressing from damage on jeans?
10. What condition should I list used clothes as on eBay?
11. How do I grade a used denim jacket?
12. What does SNAD mean in reselling?
13. What is a reseller death pile?
14. How does clothing condition affect resale value?
15. What's the difference between condition grading and authentication?

Reseller workflow / product (Universe B):
16. Best crosslisting app for clothing resellers
17. Best AI eBay listing generator
18. Best clothing inventory management software
19. How do I find sold comps on eBay?
20. Mercari vs eBay for selling clothes
21. How do I reduce returns on eBay clothing?
22. How do I price used clothes to sell?
23. Best tools for reselling clothes
24. How do I start reselling clothes?
25. What are eBay item specifics and why do they matter?

## 4. Cloudflare bot-crawl dashboard (AC4)

The leading GEO indicator nobody else measures: **AI-bot fetch frequency by
section**. Enable **Cloudflare Logpush** (or query the GraphQL Analytics API)
and build a dashboard of request counts grouped by `ClientRequestUserAgent`
(GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, CCBot, Googlebot) × URL path
prefix (`/grading/`, `/cert/`, `/flipdesk/`). Rising GPTBot/ClaudeBot fetches on
`/grading/` = the moat compounding.

Crawler allow/deny policy the dashboard should reconcile against:
`functions/_shared/seo-config.ts` + `vault/40-growth/ai-crawler-policy.md`.

## 5. Kill / scale criteria (plan §8)

### The July 2026 grading criterion: **FIRED**

> If after 6 months grading-cluster impressions are still < 1,000/mo AND the
> prompt panel shows zero citations, the definitional wedge needs a
> *distribution* fix, not more pages.

**It fired, and that is what triggered the 2026-08 rebuild.** Recording it
rather than quietly replacing it, because a kill criterion that gets deleted
when it fires is not a kill criterion.

What it got right: more pages were not the answer. What it got wrong, per
`US-9001-VERDICT.md`: the diagnosis assumed no demand or no indexation, and the
Search Console export showed neither. 6,434 impressions in six months, 156 of
270 URLs in the top ten, and a **0.85% CTR against a 3-10% baseline**. The site
ranked and did not get clicked. That is a fourth cause nobody had listed, and
the rule as written would have sent us to buy distribution for a page nobody was
failing to find.

The lesson carried into the thresholds below: **an impressions threshold cannot
tell you why it missed.** Each one now names the diagnostic to run when it
fires, not just the number.

- If templated comparison/pSEO tail pages get **< 10 impressions/mo at month 4**,
  prune them rather than accumulating index bloat. (Unchanged, still live.)

### Thresholds for the rebuilt paths, set 2026-08-18, before the data

Set in advance so the next review reads them instead of arguing with them. The
clock starts at each path's first ship date, not at the review date.

| Path | Segment | Threshold | Due | If it misses |
|---|---|---|---|---|
| **3 — tools** | `^/tools/` | ≥ 2,000 impressions/mo | month 4 → **2026-12-18** | Check position before pruning. Under 2,000 at position 30+ is a competition problem and the pages should go; under 2,000 at position 5-15 is a demand problem and the bucketed volume estimate was wrong. |
| **1 — care** | `^/care/` | ≥ 10,000 impressions/mo | month 6 → **2027-02-18** | Do not prune first. Check the fabric-matrix row separately: if the parents earn and the 18 matrix pages do not, US-9014's premise is wrong and only those 18 go. |
| **7 — FlipDesk landings** | `^/flipdesk/` | **not judged on impressions** | month 4 → **2026-12-18** | Judged on `signup_started_from_tool` ÷ `commercial_landing_view`. Combined volume on its five commercial terms is 2,200/mo against SERPs a vendor page structurally cannot win (see `crosslisting-cluster-diagnosis.md`), so an impressions target would fail a segment that is working. |

Path 1's number deserves one line of defence, because 10,000 sounds low against
295,750/mo of cluster volume. It is deliberately low: the cluster is
[[seo-strategy-options-2026-08|an authority and link engine, not an acquisition
channel]] — 1,550 of those searches carry seller intent, which is 0.5%. 10,000
impressions is the level at which it is demonstrably *working as a link engine*.
Setting it proportional to volume would be setting it as an acquisition target,
which is the failure mode the whole containment design exists to prevent.

### The depth test is a RATIO (AC3)

The rule used to be **"30 terms above 50 a month"**, and it was mis-specified.
It measures how many terms someone submitted to the Keyword Planner as much as
how deep the market is. Path 3 cleared the volume bar six times over on **23
submitted terms** and could never have reached 30 no matter how good it was.

**The rule is now: at least 55% of a path's submitted terms above 50/mo, with a
minimum of 12 terms submitted.** Recomputed against the 2026-08 pull:

| Path | Above 50 | Submitted | Ratio | Old rule | New rule |
|---|---|---|---|---|---|
| 1 damage and care | 42 | 55 | 76% | passes | passes |
| 3 calculators and tools | 14 | 23 | 61% | **fails on a technicality** | passes |
| 7 repositioning | 9 | 16 | 56% | fails | passes |
| 5 marketplace how-to | 10 | 22 | 45% | fails | fails |
| 6 buyer side | 5 | 18 | 28% | fails | fails |

The minimum of 12 exists so the ratio cannot be gamed by submitting four terms
and clearing three.

### Quarterly re-pull (AC4)

`docs/seo/keyword-pull-2026-08.csv` holds **bucketed** figures (50, 500, 5,000,
50,000) because the Ads account has no spend, and a bucket means "somewhere
between a tenth and ten times this". Every threshold above is stated in
impressions rather than in estimated volume for that reason.

**Re-pull dates: 2026-11-18, 2027-02-18, 2027-05-18.** Replace the buckets with
real numbers once there is spend, then re-run the ratio table above. If the
ordering of the paths changes, that is a finding and belongs in the strategy
note, not a silent edit to this table.

---

## Absorbed: off-page authority (`docs/OFF_PAGE_AUTHORITY.md`)

Earning attention and measuring it are one loop, so they are one note.

Entity-confirming, low/zero-cost off-page assets so search engines and LLMs
anchor the GradeThread entity. Priority-ordered; mostly operator tasks, with the
one code hook noted.

## Code hook (done)

`Organization.sameAs` is config-driven (`src/lib/seo/social.ts`
`socialProfileUrls()`): GitHub is hard-wired, and X, LinkedIn, Instagram,
Crunchbase, YouTube (US-1677), and **Wikidata** (US-1695) each flow into the
site-wide Organization JSON-LD when their `VITE_SOCIAL_*` env var holds a real
URL. Only real URLs ever appear — no placeholders. So the moment a profile or the
Wikidata item exists, set the env var and it's referenced everywhere the
Organization node renders (every prerendered page).

## 1. Directory / integration listings (do first — zero cost, entity-confirming)

Claim and complete high-authority profiles, each linking back to
gradethread.com. When live, set the matching `VITE_SOCIAL_*` where one exists:

- **Shopify App Store** listing (FlipDesk integrates Shopify) — high authority.
- **eBay-compatible-app** listing / developer directory.
- **Product Hunt** launch.
- **G2** and **Capterra** profiles (category: reseller / inventory software).
- **Crunchbase** (`VITE_SOCIAL_CRUNCHBASE`), **LinkedIn** company page
  (`VITE_SOCIAL_LINKEDIN`), **X** (`VITE_SOCIAL_X`), **YouTube**
  (`VITE_SOCIAL_YOUTUBE`).

## 2. Wikidata entity (after 3–4 independent citations exist)

Per the SEO plan (§3, §7.7): claim a Wikidata item for GradeThread **only once
3–4 independent, reliable citations exist** (press coverage of the data report,
directory listings, podcast/YouTube mentions). Then:

1. Create the item with `instance of` = software / company, label, description,
   and `official website` = gradethread.com.
2. Add `sameAs`-equivalent statements (official social profiles) on the item.
3. Set `VITE_SOCIAL_WIKIDATA` to the item URL (`https://www.wikidata.org/wiki/Q…`)
   so Organization.sameAs references it.

Claiming it prematurely (no independent citations) risks deletion and wasted
signal — hence the gate.

## 3. Earned links (the compounding, legitimate channel)

- **The certificate mesh** (already shipped, US-1665): live-listing links/embeds
  back to certs — the link source competitors can't clone.
- **Data-driven PR**: pitch the "State of Resale Condition" report (US-976) to
  resale-trade press and reseller newsletters. Original data is the only
  reliably link-worthy asset a bootstrapped SaaS can manufacture.
- **Reseller podcast/YouTube circuit**: founder guest spots on the returns /
  grading-standard story (not a product pitch).
- **Tool-roundup inclusion**: pitch inclusion in "best crosslisting app / reseller
  tools" listicles.

## AVOID (per plan §7 IGNORE — these backfire at our domain authority)

- **Paid link buying and PBNs** — existential risk, no upside.
- **Mass generic guest-posting** on marketing blogs — wrong neighborhood; we want
  resale-world relevance, not DR arithmetic.
- **A premature Wikipedia article** — notability isn't there yet; it'll be
  deleted and can backfire. (Wikidata ≠ Wikipedia; Wikidata is fine per §2.)

---

## Absorbed: Reddit distribution playbook (`REDDIT_DISTRIBUTION_PLAYBOOK.md`)

Kept as its own section because it carries an ongoing per-thread log, which is
awkward to interleave with runbook prose. If the log starts filling up, split
this back into a standalone note.

A genuine, disclosed Reddit presence so the GradeThread grading standard gets
retrieved by AI engines (heavily trained on Reddit) and spreads organically in
reseller communities. **This is a human/founder activity — this doc is the
tracked playbook; the code deliverable is the [free printable condition
chart](https://gradethread.com/grading/condition-chart).**

> ⚠️ Not a growth-hack link-drop. Reddit communities punish drive-by promotion,
> and it backfires on the brand. The rule is: **be substantively helpful first,
> disclosed always, and link only when the link genuinely answers the question.**

## Account & disclosure

- Post from the **founder account** (not a brand account), with transparent
  profile flair / bio disclosing the GradeThread affiliation.
- When a comment references GradeThread, disclose in-line ("disclosure: I built
  GradeThread") — every time. Never pretend to be a neutral third party.
- Follow each subreddit's self-promotion rules; when in doubt, don't link.

## Cadence

- **2–3 substantive answers per week**, spread across the target subreddits.
- Quality over volume: one genuinely useful, upvoted answer beats ten thin ones.
- Prioritize **condition-dispute / returns / "is this NWT?" / "how do I describe
  condition?"** threads — the topics where the grading standard is the answer.

## Target subreddits

| Subreddit | Focus | What to answer |
|---|---|---|
| r/Flipping | general reselling | condition, returns, pricing-to-comps |
| r/poshmark | Poshmark sellers | EUC/VGUC/GUC meaning, Posh Protect disputes |
| r/Depop | Depop sellers | condition tags, Buyer Protection claims |
| r/Mercari | Mercari sellers | 5-step condition, not-as-described returns |
| r/eBaySellers | eBay sellers | item conditions, MBG "not as described" cases |
| r/VintageFashion | vintage buyers/sellers | grading vintage condition, disclosure |

## The link, when it fits

Only link when it directly answers the question, and prefer the free assets:

- **The printable condition chart** — `/grading/condition-chart` (shareable, no signup)
- **The grading scale** — `/grading/scale`
- **The returns spine** — `/reselling/reduce-ebay-returns`
- **Platform condition standards** — `/grading/platform-standards/{platform}`

## Tracked threads / answers

Maintain the log below (date · subreddit · thread URL · what was answered ·
whether a link fit · outcome/upvotes). Keeps the effort honest and measurable,
and ties into the §8 measurement loop.

| Date | Subreddit | Thread | Answered | Linked? | Outcome |
|---|---|---|---|---|---|
| _(add rows as you post)_ | | | | | |

## What "good" looks like

- A seller asks "buyer says my "excellent" jacket is worn — what do I do?" → you
  explain how condition disputes resolve, how to disclose accurately next time,
  and (disclosed) link the condition chart. Upvoted, saved, cited.
- A seller asks "what does VGUC mean?" → you answer precisely and link the
  Poshmark platform-standard page. No pitch.

## Related

- [[seo-geo-strategy]] — the bets this measures
- [[ai-crawler-policy]] — the crawler classes behind the referrer stats
- [[data-report-press-push]] — the off-page push this measures the return on
- [[INDEX]]

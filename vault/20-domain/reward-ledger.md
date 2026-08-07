---
title: The reward ledger — one log, one primitive, and what may award XP
aliases: [XP, reward events, gamification, reputation_events]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/rewards-engine.ts
  - services/edge-functions/src/lib/buyer-trust-score.ts
  - services/edge-functions/src/lib/rewards-badges.ts
  - services/edge-functions/src/lib/rewards-tangible.ts
  - services/edge-functions/src/lib/rewards-levels.ts
  - services/edge-functions/src/lib/rewards-seasons.ts
  - services/edge-functions/src/lib/rewards-quests.ts
  - services/edge-functions/src/lib/share-to-earn.ts
  - services/edge-functions/src/lib/leaderboards.ts
  - services/edge-functions/src/lib/leaderboards-data.ts
  - services/edge-functions/src/lib/badge-analytics.ts
  - src/lib/buyer-rewards-summary.ts
reviewed: 2026-08-07
tags: [rewards, gamification, buyer, seller, contract]
summary: There is ONE reward log for both the seller XP track and the buyer Trust Score; every award goes through grantReward with a dedupe key, and an event that consumes AI grading spend earns nothing unless the action was paid.
---

# The reward ledger

## One log. Not two.

`reputation_events` (00417) is the single append-only log for **both** reward
tracks:

- the **seller/user XP** track ([[buyer-economy|reward credits]] are a separate,
  spendable currency — do not confuse them), and
- the **buyer Trust Score** track.

Each scorer reads the log and ignores the other's event types:
`REPUTATION_POINTS` (buyer-trust-score.ts) scores the trust types,
`REWARD_XP_CATALOG` (rewards-engine.ts) scores the reward types, and two types
(`grade_confirmed`, `verified_purchase`) sit in both because a confirmed arrival
genuinely is both signals.

**A second ledger is refused.** This was decided rather than inherited: US-1849's
own notes originally proposed fresh `reward_events` + `user_reward_state` tables,
and the standing decision reuses `reputation_events` instead. Two logs would mean
two idempotency guarantees, two backfills, and two answers to "what did this user
do" — with no way to tell which one is right. `user_reward_state` remains, but it
is a **derived cache**, not a source: `recomputeRewardState` rebuilds it from the
log, so it can always be thrown away and regenerated.

## Every award goes through `grantReward`

Never write a reward event with a bare `emitReputationEvent`. `grantReward` is
the primitive, and it does four things an emit does not:

1. Stamps the `paid` gate into metadata, so a later recompute from the log stays
   truthful.
2. Recomputes `user_reward_state` (XP, level, streaks).
3. Re-evaluates achievement badges (`awardBadges`).
4. Evaluates the **tangible** reward milestones (`grantTangibleRewards`), which
   is where the kill-switch and budget ceilings live.

A bare emit lands the trust row and leaves all four stale. That was live in
`buyer-grade-confirmation.ts` until US-1849's wiring pass.

### Idempotency is the dedupe key, not a rate limit

`UNIQUE(user_id, event_type, reference_id)` on the log **is** the anti-farming
design. The `referenceId` a source passes decides what "once" means, so choose it
as the thing that should only ever pay once:

| Event | Key | So one award per… |
|---|---|---|
| `coverage_completed` | `<submissionId>` | submission (a regrade never re-pays) |
| `marketplace_connected` | `<marketplace>:<account>` | shop (disconnect/reconnect never re-pays) |
| `aspects_filled` | `item:<itemId>` | item |
| `badge_embedded` | `cert:<certId>` | certificate, no matter how many impressions |
| `verified_share` | `<target>:<id>:<source>` | badge target |
| `share_milestone` | `share:<type>:<id>:<rung>` | rung, per shared find |
| `grade_confirmed` | `<purchaseId>` | purchase |

Because the key absorbs replays, **there is nothing to mash**: clicking your own
badge link a thousand times pays exactly what clicking it once does. Reach for a
velocity limit only when a source can produce unboundedly many *distinct* keys.

`grantReward` short-circuits on an already-granted key rather than redoing the
recompute — necessary because some sources replay hard (a badge image is
re-served on every CDN cache miss). It deliberately falls through to the full
path when no `user_reward_state` row exists, so an earlier emit whose recompute
failed still repairs itself.

## What may award XP

### The catalog is weighted by moat, not by effort

`REWARD_XP_CATALOG` ranks by **business contribution**, so the acts that compound
GradeThread's advantages score highest: a badge embedded off-platform (authority
spread) over a marketplace connected (stickiness) over a filled aspect set
(listing quality). Adding an entry is a policy change, not a config tweak —
the table is meant to be legible on its own.

### AI-spend events are paid-gated

`GRADING_SPEND_EVENTS` (`grade_confirmed`, `coverage_completed`,
`verified_purchase`) earn **0 unless `paid` is true**. This is what makes grade-XP
self-limiting: a free or junk submission that abstains or fails has its charge
reversed and earns nothing, so there is no way to farm XP by burning our own AI
budget. A new event type that costs us model spend belongs in that set.

### Variable-XP types are bounded three times

`quest_completed` (US-1852) and `share_milestone` (US-1854) are the only entries
whose award is not a catalog constant. Both freeze the amount into the event's
metadata at grant time and both are read through the one `frozenXpAward` helper,
so a recompute cannot disagree with what was paid. Taking the quest as the
worked example: a quest's reward is admin-configurable, so the amount is decided by the
quest definition and **frozen into the event's metadata at grant time**. Editing
a quest later never rewrites what someone already earned, and a recompute from
the log stays truthful without consulting the config.

An operator-editable number that mints XP is a faucet, so it is capped in three
independent places, and a new variable-XP type would need all three:

1. `reward_quests.xp_reward` CHECK, 0–200 (migration 00540);
2. the admin route's validator, which returns a sentence rather than a 500;
3. `clampQuestXp` in the scorer — so even a hand-written event row, or a
   migration that widened the CHECK, cannot out-earn the catalog.

`xpForEvent` reads `xpAward` **only** for a variable type; a stray `quest_xp` on
any other event is ignored.

### An unverified event is audit-only

`verified: false` scores 0 by construction. Use it to record that something
happened without paying for it; do not use it as a soft "maybe".

## The `badge_embedded` gate

`badge_embedded` carries the catalog's highest award and its only evidence is a
`Referer` on a public, unauthenticated image endpoint — so the predicate
(`isOffPlatformEmbedReferer`) is deliberately conservative and its default is
**earn nothing**:

- A missing, relative, or unparseable referer is **not** an embed. A privacy
  stripped referer proves nothing, and neither does a direct hit on the badge URL.
- Any `gradethread.com` host — including subdomains and `localhost` — is us
  rendering our own badge, not authority spreading. Matched on the dotted suffix,
  so `notgradethread.com` and `gradethread.com.evil.test` are correctly outside.

The Cloudflare Pages proxy (`functions/badge/cert/[id].ts`) forwards **only** the
`Referer` upstream. Nothing else about the visitor crosses that boundary.

## Levels, seasons, and where a streak is allowed (US-1851)

Three standing rules sit on top of the ledger. All three are about the same
thing: what a seller can LOSE.

### A level derives from the XP peak, and never decreases

`user_reward_state.xp_peak` (00539) is the high-water mark of `xp_total`, and
`levelForXp` is applied to **the peak**, not the live total. `peakXp` only ever
moves up.

XP is never debited by design, so this looks redundant — it is not. The recompute
derives from `reputation_events`, and a log **can** shrink: an erasure request,
a fraud reversal flipping `verified`, a parent row cascading. Any of those would
quietly demote a Curator back to Picker. Report `xp_total` honestly on the
seller's own screen; derive the identity from `xp_peak`.

The named ladder is `LEVEL_TIERS` (rewards-levels.ts): Thrifter → Picker (3) →
Curator (7) → Archivist (12) → Legend (20).

### Seller surfaces get SEASONS. Streaks are buyer-only.

Reselling is bursty and seasonal — a picker sources for three weeks and lists
forty items in a weekend. A calendar streak converts that normal working rhythm
into a status loss, so **no seller surface may show one**. Seller motivation is a
quarterly season (`rewards-seasons.ts`): a goal track that ends with a frozen
recap in `user_season_recaps` and resets cleanly, taking no level, medal or XP
point with it. Recency competition belongs on the weekly leaderboards, not on
identity.

Calendar streaks survive on exactly one surface — the buyer extension +
confirmation flow — because that one has a genuinely weekly rhythm. It carries
grace and freeze rules (`src/lib/buyer-rewards-summary.ts`): the current week
never breaks a chain by being young, and a chain banks one freeze per 4 active
weeks (max 2) that bridges a missed week. `computeRewardState` still counts
day-streaks on the row, because the `streak_7` medal reads `longestStreak` and an
earned medal is kept — but nothing renders them to a seller.

Season boundaries are real wall-clock quarters in ONE shared zone
(`system_settings.rewards_season_timezone`), not per-user and not naive UTC, so
every seller's season is the same window and recaps compare like with like.
Rollover is **lazy and idempotent** — the recap row is written the next time the
user opens their rewards screen, guarded by `UNIQUE(user_id, season_key)`. A
quarterly cron that has to fan out across the whole user base to write one row
each is a worse failure surface than that.

### Quests are the week, and a quest cannot count a quest

Levels are identity, seasons are the quarter, **quests are the week**
(`rewards-quests.ts`, 00540). Same one-ledger rule: quest progress is derived
live from `reputation_events`, and `user_quest_progress` holds only the snapshot
and the completion claim, so it can be dropped and rebuilt.

Four rules constrain a quest:

- **The XP gate is reused, not reinvented.** An event that scores 0 XP —
  unverified, or an unpaid grading-spend act — counts 0 toward a quest. There is
  one definition of "this action counted".
- **`quest_completed` is not an allowed quest metric.** Two cheap quests counting
  each other's completions would bootstrap an XP loop. Enforced by the 00540
  CHECK, by `QUEST_METRICS`, and by the admin validator.
- **The period key is a DATE, not a week number.** ISO week numbering puts
  30 Dec 2025 in week 1 of 2026; a key that is wrong once a year pays a quest
  twice or not at all once a year. Weekly keys are the Monday's date
  (`w2026-08-03`), monthly are `m2026-08`, fixed windows are `fixed`. Boundaries
  resolve in the same shared `rewards_season_timezone` the season uses, so "this
  week" means one thing across every rewards surface.
- **Evaluation is lazy and idempotent** — it happens on `GET /api/rewards/quests`,
  the same choice (and rationale) as `finalizeCompletedSeason`. Claim-before-pay
  via `completed_at IS NULL`, plus `grantReward`'s dedupe key
  `quest:<key>:<period>`, is what makes two tabs award once.

**A community challenge is time-boxed by definition** and its leaderboard names
**public Verified profiles only** (`verified_enabled` + a handle). Being counted
in a challenge is not consent to be named on one, so an unlisted seller still
scores, still sees their own progress, and the card says why they are not on the
board rather than silently omitting them. The standings scan is a deliberately
simple in-window fold with a logged row cap; the materialized aggregate belongs
to US-1856, not here.

### A level perk is cosmetic, and there is no paid path to one

`COSMETIC_PERKS` holds flair and share-card frames only. Nothing in
rewards-levels.ts reads a plan, costs GradeThread money, or gates a capability —
AC4's "no hard paywall" is enforced by that absence, and a unit test asserts every
perk is `flair` or `frame`. The frame gate (`isFrameUnlocked`) fails **closed**:
an unknown key, a locked key, or an unreadable level all render the plain card.

The half that moves real value is the tangible rail (`rewards-tangible.ts`,
00538) behind its own kill-switch and budget, and it is deliberately unreachable
from the level code. If a future story wants a paid frame it needs its own catalog — folding one
into this one makes every existing entry's promise ambiguous.

## The tangible rail: milestones GRANT, they never charge

XP is **status currency and is never debited** — not by a purchase, not by a
redemption, not by anything. Tangible value is *granted* on crossing a milestone,
and the spendable currency stays the grade-credit ledger. This is a decision, not
an implementation detail: US-1853's original spend-XP design was replaced because
spending XP deflates status, penalises the people who redeem on the very
leaderboard the XP feeds, and rewards hoarding over using the product. Because a
grant reads the XP total and never writes it, "your level can't go backwards for
taking a reward" is structural rather than merely likely.

The catalog is **data** (`reward_milestones`, 00541), not code: reward type
(`free_grade_credits` | `subscription_discount` | `per_grade_discount`), trigger
(XP threshold | badge key | season-goal key), value, marginal cost, and its own
platform-wide monthly + lifetime issue caps. `TANGIBLE_MILESTONES` in
rewards-tangible.ts is the FALLBACK used when the table can't be read — a read
*error* falls back, an *empty* result does not, because every milestone being off
is a decision an operator made.

Four rules constrain anything added here:

1. **A reward type with no registered fulfiller can never be granted.** The
   `FULFILLERS` registry — not a comment — is what stops the ledger filling with
   promises nothing redeems. US-1848 shipped the two discount types as *typed but
   unfulfillable* for exactly this reason; US-1853 registered them.
2. **Claim before you pay.** `UNIQUE (user_id, milestone_key)` is the idempotency
   guarantee, and the row is inserted BEFORE value moves. A failed fulfilment
   deletes the claim so a later pass retries; a 23505 means someone else got
   there first. Renaming a milestone's key after it has been paid would make
   every holder eligible again — the admin route refuses it.
3. **Cost is denominated in margin, not list price.** The budget
   (`rewards_tangible_budget`) protects the margin floor, so `cost_usd` is what
   honouring the grant costs GradeThread. Per-milestone caps narrow that budget;
   they never widen it. An uncounted cap is treated as a refusal.
4. **Discounts are Stripe coupons minted at grant time.** A subscription discount
   rides the next subscription checkout (payments.ts) and is consumed by the
   `customer.subscription.created` webhook — never at session creation, or an
   abandoned checkout would burn it. A per-grade discount is a time-boxed
   entitlement read at the payment-precedence step (`runPaymentPrecedence`) so
   the quote is right, and applied as the coupon at per-grade checkout so the
   charge matches the quote. It bites the money path only: included grades are
   already free, and shaving the credit cost would make a discount worth less the
   more credits someone holds.

Attaching a milestone to a **season goal** is the one place this crosses into the
cosmetic track. It is opt-in per goal and off by default — season goals stay
cosmetic until an operator says otherwise.

## The share loop pays on the CLICK, never on the press (US-1854)

`share-to-earn.ts`. Pressing share is **tracked and worth zero**. The `share_events`
row (00542) records that a seller shared a find; the XP lands later, on
click-throughs the sharer does not control:

| Step | Event | Award | Dedupe key |
|---|---|---|---|
| press share | *(none — a `share_events` row)* | 0 | — |
| 1st verified click | `verified_share` | 20 | `cert:<id>:share` |
| 3 / 10 / 25 unique clicks | `share_milestone` | 25 / 60 / 150 | `share:cert:<id>:<rung>` |
| a signup off the find | `share_milestone` | 150 | `share:cert:<id>:signup` |

This is a decision, not an oversight: the story's AC reads "creates a tracked
share **and grants XP**", and its own notes say "reward on verified conversion,
not raw share, to prevent farming". A button that pays on press is a button to
mash, and the sharer holds both ends of it. So the share is tracked (the row is
load-bearing — see below) and the *share* earns its XP, through the click.

**One find's ladder is finite.** Every rung is one-per-find by dedupe key, so a
single certificate can earn at most 20 + 25 + 60 + 150 XP no matter how many
times its link is opened. That is the same anti-farming construction as the rest
of the ledger, applied per rung.

**A tracked share is a precondition, not decoration.** `evaluateShareMilestones`
refuses to pay a find with no `share_events` row. This is what stops the ladder
from paying for links that never went through our sheet, and it is where the
sharer's own fingerprint is banked.

### Four gates decide whether a click is "verified"

All four are server-side, and all four fail CLOSED:

1. **Bot gate.** `isLikelyBotUserAgent` — a MISSING agent counts as a bot. Every
   social network fetches a posted URL to build its unfurl card, so without this
   the act of posting a link manufactures its own clicks.
2. **Fingerprint.** A salted, truncated SHA-256 of (Cloudflare-verified IP,
   User-Agent). No trustworthy IP ⇒ no handle ⇒ recorded, not rewarded. A
   spoofable handle would make "unique clicks" mean "times the header was
   rotated". It is not an identity and no IP is stored.
3. **Self-click.** A click whose handle matches a `sharer_hash` banked when the
   seller shared is recorded with `self_click = true` and never paid.
4. **Daily caps.** `share_record` (100/day) and `share_milestone` (25/day) ride
   the shared `rate_limit_counters` store. The per-find ladder is already finite,
   so the milestone cap bounds the OTHER shape: many finds, each pushed over a
   rung by manufactured clicks.

`share_events` is **deny-all** for the same reason `sharer_hash` exists: a client
that could write a share row against someone else's find would bank a fingerprint
there and have that seller's genuine clicks discarded as self-clicks. Ownership
of the certificate is resolved server-side on every recorded share.

### Only XP is minted here

A signup through a baked referral link **already** pays the sharer grade credits
through the referral loop (`referrals.ts`). The share ladder adds the XP that
loop does not, and deliberately mints no second credit — two faucets on one act
pay twice for it. The signup is attributed to a find by the converted affiliate
click's `landing_path`, which is the only record of *which* find brought the
person in; the referral event knows only who referred them.

### `Viral Find` is one find, not many

The medal's criterion is `viralFindCount >= 1` — a find that reached the top
click rung or produced a signup. It used to be `shareCount >= 10`, which is ten
*different* finds clicked once each: a medal named for a viral find that could be
earned without ever having one. A per-item claim needs a per-item criterion.
Earned medals are kept, so tightening it takes nothing from anyone.

## Public leaderboards publish only what their own opt-in named (US-1856)

Four public boards — XP, grades, best finds, share-driven signups — each ranked
over the current week and over all time, and the two garment-backed ones (grades,
finds) also by brand and category. `lib/leaderboards.ts` is the pure policy,
`lib/leaderboards-data.ts` the four aggregations,
`/api/content/public/leaderboards.json` the one payload the SSR page and the SPA
both render.

**A new disclosure needs a new toggle.** These boards use `users.leaderboard_opt_in`
+ `leaderboard_alias` (00544) — a THIRD opt-in beside the referral board's (00195)
and the buyer board's (00423), which was the point of contention. Each older
toggle's copy names exactly what it publishes: a referral count, a confirmation
count. The reward boards publish XP, graded volume and reaction counts, and XP is
specifically withheld from the public verified profile (`publicLevelFlair` drops
it, because how much someone grades is their business metric). Folding a new
disclosure under an old toggle makes a sentence somebody already agreed to
retroactively false — the same rule as
[[extension-telemetry-consent|telemetry consent]]. The alias FALLS BACK through
aliases the user already made public (verified display name → referral alias →
buyer alias), so joining is one click; it is never invented, and an opted-in user
with no resolvable alias is simply not listed.

**A rank is only ever as public as the identity behind it.** A `/verified/<handle>`
link is emitted only for a seller whose verified profile is enabled. The finds
board can therefore rank only the verified half of the cohort, because
`public_showcase_finds` withholds the handle otherwise — an anonymous find was
published without a name, and a board is a name.

**Anti-gaming is applied at the source, not bolted on.** The XP board reuses
`xpForEvent`, so an unverified or unpaid grading-spend event scores the same zero
it scores everywhere else — there is one definition of "this counted". Grades
count only certified, review-approved reports. The finds board drops a seller's
reaction to their **own** find. Shares count only `granted` referrals. Then, in
the pure ranker: a zero score is not a rank (so registering aliases cannot pad a
board), every board is capped, and ties break on score → secondary → **older
account first** → alias, with genuinely equal work SHARING a rank.

**One calendar.** The weekly window is `questWindow`'s Monday-anchored week in the
shared season timezone, not a second derivation — otherwise a seller's quest could
read 3/5 while their weekly board read 4 on the same morning. Every response also
carries `current_week`, which is what the sitemap uses for a derived `lastmod`
(US-2100 forbids stamping `today()`, and a ranking has no row whose timestamp
means "this changed").

## Wiring a new source

The catalog is inert policy until a call site spends it — the same trap as
[[buyer-platform|an allowance nothing reads]]. So:

1. Call `grantReward` at the moment the act **completes**, not when it is
   attempted. `aspects_filled` fires on the `filled` outcome only; a partial prep
   earns nothing.
2. Pick a dedupe key from the table above's logic.
3. Make it **best-effort**: a reward failure must never fail an OAuth callback, a
   grade, or a public page. Every existing site either `void`s with a `.catch` or
   wraps in try/catch.
4. Add the file+event pair to the source-wiring test in
   `src/tests/rewards-engine_test.ts`. A provider silently missing its grant is
   exactly the drift `grantMarketplaceConnectedReward` was extracted to prevent —
   five OAuth callbacks are not otherwise testable here.

## Related

- [[buyer-economy]] — reward *credits*, the spendable currency this is not
- [[buyer-platform]] — the allowance-nothing-reads trap this rule generalises
- [[grade-accuracy-guarantee]] — the reputation perks that compose onto trust
- [[INDEX]]

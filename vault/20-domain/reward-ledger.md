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

## What the XP buys: levels, seasons, and nothing else

Three rules were settled in US-1851, and each one closes off a design the
category defaults to.

### A level never decreases

XP is append-only, so a total normally only rises — but a voided event, a
`verified` flip, or a re-weighting of `REWARD_XP_CATALOG` can each pull a
*recomputed* total down. A status that can be taken away is not status, so
`monotonicLevel` (rewards-engine.ts, beside the curve) floors every write of
`user_reward_state.level` at the stored value. `LEVEL_TIERS` names the bands —
Thrifter → Picker → Curator → Archivist → Legend — placed so each promotion
lands near a tangible milestone from `rewards-tangible.ts` rather than on a
second, unrelated clock.

### Seasons, not seller streaks

`computeRewardState` still measures a daily streak, but that number is **internal
measurement, not seller identity**, and no seller surface renders it. Reselling
is bursty: a picker who sources hard for three weekends and then takes a month
off is a good seller, and a streak would tell them otherwise every time they
opened the app. Sellers get quarterly **seasons** instead
(`rewards-seasons.ts`) — a 13-week goal track that resets for everybody at once.

Nothing about a season is stored. Progress is a **window over the same log**, so
it resets by the window moving: no rollover job, no wipe, no state that can be
half-migrated at a boundary, and a past season stays reconstructable forever
(which is how an earned season frame outlives its season). Only events that
actually earned XP tick a goal, so the paid gate above still holds.

The one calendar streak shown to a human is the **buyer** confirmation streak
(`src/lib/buyer-streak.ts`), because receiving parcels genuinely is weekly. It
carries an automatic grace week and a small per-quarter freeze allowance —
granted, never bought.

### Quests: the one number an operator sets

US-1852 added `quest_definitions` (00539), and it is the first reward config a
human edits at runtime rather than in a reviewed constant. The split is drawn
carefully:

- **An operator sets** which quests run, how hard (`target`), when
  (`window_kind` + optional bounds), what they pay (`xp_reward`), and an on/off
  switch. New rows are `enabled = false`, and the whole surface sits behind the
  `rewards_quests` flag read fail-**closed**, same posture as the tangible rail.
- **Only a code review sets** what a quest MEANS. `criteria_key` names a
  predicate in `rewards-quests.ts`; an unknown key is ignored rather than
  thrown, so rolling the code back below a quest cannot take the board down. A
  rule expression stored in a text column would be an untypecheckable
  mini-language, and the first bad row would be a silent payout bug.

Because the payout is operator-set, `quest_completed` is the ONLY event type
whose XP is read from `metadata` instead of `REWARD_XP_CATALOG` — and it is
clamped to a code ceiling both when written and every time it is re-scored, so a
row written past the ceiling still cannot pay past it. `xpForEvent` deliberately
ignores a magnitude on every other type; honouring one would turn a metadata
field into an XP dial.

There is no `user_quest_progress` table either. Progress is a window over the
same log, and the window's start is baked into the dedupe reference
(`<quest_key>:<window-start>`), which is what makes "pays once per run, again
next week" true without any reset job. Completion is evaluated on the pass that
grants the underlying reward, so there is no claim step to forget — and
`grantReward` skips that evaluation when the event IS a `quest_completed`, or it
would recurse forever.

### No perk is ever plan-gated

Every unlock in `rewards-levels.ts` is a function of level and nothing else:
profile flair and share-card frames, both cosmetic. Levels are earned by
contributing, and selling one would make the ladder a price list. A pinned test
in `rewards-levels_test.ts` fails if a plan or entitlement check ever appears in
that module.

Only the tier *vocabulary* goes public. The verified seller profile shows the
flair word and its blurb; XP totals and raw levels stay private, or a
contribution ladder becomes a scoreboard strangers rank sellers by.

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

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

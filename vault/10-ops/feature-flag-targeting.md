---
title: Feature-flag targeting — who a rule actually reaches
aliases: [plan_targets, isFeatureEnabled, rollout_percentage, feature flags]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/feature-flags.ts
  - services/edge-functions/src/routes/admin-flags.ts
  - supabase/migrations/00210_feature_flag_rules.sql
reviewed: 2026-08-05
tags: [ops, config, admin, contract, flags]
summary: A flag rule is resolved against the caller's EFFECTIVE plan, resolved inside isFeatureEnabled rather than supplied by the caller — and only six flags may be plan-targeted at all.
---

# Feature-flag targeting

One `feature_flags` row is a **rule**, not a boolean. `isFeatureEnabled(key, opts)`
resolves it per caller. See [[system-settings]] for the other deploy-free
operator control; the two are deliberately separate — a flag turns a flow off, a
setting tunes one that is on.

## Precedence

Evaluated top to bottom; the first line that decides, wins.

| # | Check | Notes |
|---|---|---|
| 1 | `enabled = false` | Global kill. Beats everything below, including an allow-listed user. |
| 2 | `starts_at` / `ends_at` | Applies to everyone. |
| 3 | `user_deny` | Needs a `userId`. |
| 4 | `user_allow` | Needs a `userId`. Overrides plan **and** percentage — the per-account escape hatch. |
| 5 | `plan_targets` | Empty = all plans. Non-empty and no plan resolvable → **OFF**. |
| 6 | `rollout_percentage` | Stable FNV-1a bucket of `key:userId`. No `userId` → treated as in. |

A missing flag row or a DB read error is **fail-OPEN** (or the caller's
`defaultEnabled`). That is unchanged and deliberate: a kill-switch must only ever
switch off because an operator said so.

## The plan is resolved by the callee, not the caller

`isFeatureEnabled` looks the plan up itself from `opts.userId`, cached on the
same 30s clock as the rule. Callers pass **who**, never **what tier** — the one
exception is the admin preview, which supplies a plan per sampled user so it can
score thousands without a query each.

The plan used is the **effective** plan (`effectivePlanFor`), the same resolution
the caps, gates and MRR read: a lapsed or canceled Pro targets as Free, and a
US-2398 `comp` targets as its granted tier. The admin preview runs the identical
function over the identical four columns, so the reach it shows is the reach the
runtime produces.

### Why it fails closed on an unresolvable plan

Until US-2406 the check read `if (opts.plan && …)` — it applied **only when the
caller supplied a plan, and no runtime caller ever did**. Every plan-targeted
rule fell straight through to the percentage rollout. The failure was fail-OPEN
and silent, so a flag an operator believed was limited to Pro was serving the
whole user base, and the admin preview agreed with the operator rather than with
production. Nothing errored; the unit suite covered the pure resolver, which was
correct the whole time.

So a rule that names plans is now **not satisfied by a caller who cannot present
one**. No `userId`, an unreadable `users` row, or a missing user all resolve OFF
and log `feature_flag.plan_unresolved`.

## Only six flags may be plan-targeted

`PLAN_TARGETABLE_FLAGS` lists the keys whose **every** call site can name a user:
`grading`, `autolister`, `content_ai`, `authenticity_addon`, `forensic_grade`,
`passport_forecast`.

Everything else has at least one platform-wide caller — a cron that runs the flag
once for the whole fleet, with nobody to resolve a plan for:

- `repricing` — `handleRepriceScanCron` scans every owner in one call.
- `inventory_equity` — `handleEquitySnapshotCron`, same shape.
- `newsletter`, `lifecycle_journeys`, `trial_conversion_drip` — cron senders.
- `support_assistant` — a launch check, not a per-user gate.

`PUT /api/admin/feature-flags/:key/rule` **400s** on `plan_targets` for any of
those, and the editor greys the control out (`plan_targetable` on the list
response). Refusing at edit time is the point: the runtime fail-closed is a
backstop for a direct SQL write, not the intended way an operator finds out.

Membership is a property of the **call sites**, not of the feature. A test scans
`src/routes`, `src/lib` and `src/middleware` and fails if any listed key is
checked without a `userId`, so adding a platform-wide caller to a targetable flag
breaks the build instead of half-breaking targeting.

## Scoping rule for call sites

Pass the **workspace owner** — `c.get("workspaceOwnerId") ?? c.get("userId")` —
not the acting member. The owner is the billed party, and every other entitlement
in the system reads their plan; scoping a flag to the member would give two
people in one workspace different features off the same subscription.

## Operator note

Because targeting never applied before US-2406, any rule that already had
`plan_targets` set had been wide open for as long as it was set — and any
`rollout_percentage < 100` was being ignored at the call sites that passed no
user id, which is now most of them. §18 of `scripts/prod-diagnostics.sql` lists
both. Run it before assuming the change is behaviour-neutral.

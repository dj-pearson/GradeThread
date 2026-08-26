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
reviewed: 2026-08-25
tags: [ops, config, admin, contract, flags]
summary: A flag rule is resolved against the caller's EFFECTIVE plan, resolved inside isFeatureEnabled rather than supplied by the caller — and only the flags whose every call site can name a user may be plan-targeted at all.
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

The exceptions are the flags that gate something a blip must not start: pass
`defaultEnabled: false` and the same blip switches it **off** instead.
`support_assistant` (US-844, a pre-launch flow) and `rewards_tangible` (US-1848,
which pays out real value) both read that way. Availability is the reason for
fail-open; neither of those has availability to lose.

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

## Only a few flags may be plan-targeted

`PLAN_TARGETABLE_FLAGS` lists the keys whose **every** call site can name a user:
`grading`, `autolister`, `content_ai`, `authenticity_addon`, `forensic_grade`,
`passport_forecast`, `video_grading` (US-1762 — only `/grade/submit` evaluates
it, always with the workspace owner in hand), `rewards_tangible` (US-1848 —
`grantTangibleRewards` always acts for one named user) and `rewards_quests`
(US-1852 — `loadQuestsState` only ever runs for the authed reader).

Everything else has at least one platform-wide caller — a cron that runs the flag
once for the whole fleet, with nobody to resolve a plan for:

- `repricing` — `handleRepriceScanCron` scans every owner in one call.
- `comp_read` (US-2845) — `handleCompReadCron` drains a queue of market cells,
  which belong to nobody. It doubles as the kill switch for the comp-read AI
  budget, so the gate and the guardrail are one switch.
- `inventory_equity` — `handleEquitySnapshotCron`, same shape.
- `newsletter`, `lifecycle_journeys`, `trial_conversion_drip` — cron senders.
- `support_assistant` — a launch check, not a per-user gate.
- `claude_connector` (US-9127) — `isConnectorLive()` in routes/mcp.ts runs it
  once per request BEFORE authentication resolves anyone, so there is no user
  to resolve a plan for. Which plans get the connector is a PLAN GATE
  (`connectorAccess`, checked in the dispatcher against the caller), not a flag
  target — see [[connector-plan-gating]]. This flag is the fleet-wide stop
  button and nothing else.

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

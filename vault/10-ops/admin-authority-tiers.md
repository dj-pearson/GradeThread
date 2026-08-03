---
title: Admin authority tiers — which actions need what
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/step-up.ts
  - services/edge-functions/src/lib/env.ts
  - services/edge-functions/src/lib/scope-guard.ts
  - services/edge-functions/src/tests/step-up-tiers_test.ts
  - services/edge-functions/src/lib/comped-spend.ts
  - services/edge-functions/src/lib/grade-billing.ts
reviewed: 2026-08-03
tags: [admin, security, mfa, scopes, policy]
summary: Three tiers of admin authority — scope only, scope plus a day-window step-up, scope plus a five-minute step-up — and the rule for deciding which an action belongs to.
---

# Admin authority tiers

## The rule, in one line

**An action's authority is decided by what it does, not by which router it lives
in.**

That sounds obvious and was not being followed. Two routes carried a scope they
could be routed around: deciding a guarantee claim (which refunds a fee and grants
a free re-grade) lived under `grading:review`, so revoking an admin's
`billing:write` did not stop them paying claims; and retrying a grading job
(which voids the issued grade) lived under `ops:write`, so an admin who had never
held `grading:review` could void grades through it. A scope that changes meaning
with the file it sits in is a label, not a control.

## The three tiers

| Tier | What it requires | For |
|---|---|---|
| **1 — scoped** | the router's scope | reads, previews, ordinary state changes |
| **2 — sensitive** | scope + step-up, **24h window** | destructive but recoverable; anything a second person would want to know about |
| **3 — irreversible** | scope + step-up, **5-minute window** | money moving, issued grades voided, kill switches, agent-authored writes executed |

Tier 3 uses `requireFreshStepUp`; tier 2 uses `requireStepUp`. Both return a 403
`STEP_UP_REQUIRED` Response **to return** — calling one and dropping the result
reads as a guard and is not one.

## Why two windows and not one

`STEP_UP_MAX_AGE_SEC` defaults to 24 hours, which the audit called out as making
step-up a once-a-day control rather than a per-action one. That is true, and
lowering it globally would have been the wrong fix.

A short window on *every* sensitive action re-prompts for an authenticator
constantly. What people do then is keep the app open and the session warm, which
defeats the control while looking like compliance. The day window is right for
tier 2 precisely because it is survivable.

Tier 3 is where "you verified this morning" stops being evidence that you are at
the keyboard now — so it gets its own five-minute window
(`STEP_UP_FRESH_SEC`, `ADMIN_STEP_UP_FRESH_SEC` to override). Long enough to
finish a multi-step action without re-prompting mid-flow; short enough that a
walked-away session cannot be used.

The client handles `STEP_UP_REQUIRED` centrally (US-2377), so a shorter window
costs a prompt, not a broken surface.

## Tier 3 today

Every one of these had **no step-up at all** before US-2353:

| Route | Why tier 3 |
|---|---|
| `PUT /admin/flags` | toggles any feature flag — a kill switch |
| `POST /admin/guarantee-pool/claims/:id/resolve` | draws the pool, grants reward credit |
| `POST /admin/claims/:id/approve` \| `/reject` | refunds the fee, grants a free re-grade |
| `POST /admin/bulk/regrade` | supersedes up to 200 **issued** grade reports |
| `POST /admin/jobs/retry` (kind `grading`) | voids the issued grade and re-runs it |
| `POST /admin/agents/proposals/:id/approve` | **executes** an agent-authored write |
| `POST /admin/grading/prompts/:id/deactivate` | reverts every grade to the code default |
| `POST /admin/grading/exemplars/:id/deactivate` | changes what the grader compares against |
| `PUT /admin/grading/baselines/:id` | overwrites the baseline a regression is measured against |

### The inversion that made this findable

`PUT /admin/flags` toggles **any** flag under `ops:write` and nothing else, while
the far less impactful per-flag *rule* endpoint in the same file required
super_admin **and** a step-up. The bar was highest on the smaller action. An
inverted pair is easier to spot than an absence, which is why the audit found
this one first.

The same shape appears in `activate` / `deactivate`: activate was gated, its
mirror was not. Both are now tier 3.

## How to decide a tier for a new route

Ask, in order:

1. **Does it move money, void something already issued, flip a switch that
   changes behaviour for everyone, or execute something an agent chose?**
   → tier 3.
2. **Would a second admin want to know it happened?** → tier 2.
3. Otherwise tier 1.

Then ask the cross-scope question separately: **which scope does the ACTION
belong to?** If that is not the router's scope, check it at the route as well —
`callerHasScope` does this without borrowing the middleware.

## What this does not fix

`DEFAULT_ROLE_SCOPES.admin` holds eight of the nine scopes, so for a **default**
admin every `requireScope` except `users:role` is a no-op. Scope enforcement only
becomes a real control once an operator narrows a role, and nothing in the
product prompts them to. That is US-2354 AC4 and it is the highest-leverage item
left — none of the tiering above changes it.

## ⚠️ A super_admin grant is also a SPEND grant

Read this before granting the role to a second person.

Migration `00110` auto-elevates any row with `role = 'super_admin'` to
Business/enterprise, and `lib/grade-billing.ts` gives super_admins **uncapped
free grading** — no counter increment, no credit debit, just a zero-delta ledger
row for auditability. So the role grant is, in the same action, an unlimited
Claude Vision spend grant. There is no second decision and no ceiling.

**This is intended and stays automatic** (US-2358). The platform owner grading
their own inventory for free is the point, and the bootstrap is genuinely clean:
no seed migration, no env allowlist and no script mints a super_admin, so the
first one has to be set by direct database access. Splitting the comp into a
second grant would add a column, a migration, and a second thing to forget.

What was actually wrong is that the spend was **invisible**. It sat in the same
`ai_usage_events` ledger as revenue-generating usage with nothing separating the
two, so a second super_admin could run up unbounded vision spend that looked
exactly like business on the dashboard.

`GET /api/admin/ai/comped?period=30d` now answers it: comped grades, calls, USD,
split per user (biggest first — a runaway has a name) and per model (a model swap
is how cost jumps). Check it after granting the role, not instead of granting it.

## Related

- [[audit-log-access-control]] — the record these actions write to.
- [[impersonation]] — the other place a step-up is the whole control.
- [[mfa]] — enrolment and the enforcement switch.

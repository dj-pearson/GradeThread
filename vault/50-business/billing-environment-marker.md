---
title: The billing environment marker — what counts as revenue
aliases: [sandbox revenue, billing_environment, countsAsRevenue, test purchase]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/billing-environment.ts
  - services/edge-functions/src/lib/appstore/verify.ts
  - services/edge-functions/src/routes/appstore.ts
  - supabase/migrations/00559_billing_environment_marker.sql
  - supabase/migrations/00608_exclude_sandbox_from_revenue.sql
  - supabase/migrations/00609_appstore_transaction_environment.sql
reviewed: 2026-08-23
tags: [billing, ios, android, revenue, app-store, google-play]
summary: Sandbox and test purchases are accepted on purpose and must not be counted as money; this is the three-state marker that separates them and the SQL spelling that keeps historical revenue intact.
---

# The billing environment marker

GradeThread **accepts sandbox purchases in production, deliberately.** App Review
always exercises in-app purchase in Apple's sandbox, even against a Production
build, so a production deploy that refuses Sandbox JWS fails review. Google Play
sends test purchases the same way. Refusing them is not an option.

So the defence is not rejection, it is **marking**: record which environment
answered, and exclude the sandbox ones from anything that claims to be money.

> The abuse surface is genuinely small — a valid Sandbox JWS can only come from a
> tester Apple provisioned on the developer account. The real damage was never
> fraud. It was **a free entitlement appearing in MRR as a paying subscriber**,
> indistinguishable from a real one in every downstream query.

## Three states, and NULL is not "production"

| Value | Means | Counts as revenue |
|---|---|---|
| `production` | a real, paid purchase | yes |
| `sandbox` | Apple sandbox, or a Google test purchase | **no** |
| `NULL` | written before the marker existed | yes |

`countsAsRevenue(env) => env !== "sandbox"`, so NULL counts. That is chosen, not
accidental: every row predating 00559 is NULL, and treating NULL as suspect
would zero historical MRR to fix a small contamination.

**Two vocabularies, one answer.** Apple says `Sandbox` / `Production`; Google
says `testPurchase` on subscriptions and `purchaseType` on products, where
`0 = Test` but `1 = Promo` and `2 = Rewarded` are still production. "Free" and
"not real" are different claims. `billing-environment.ts` normalises both once.

**Disagreement resolves to `sandbox`.** When Apple's verifier and the payload
disagree, take sandbox. A false sandbox costs one row wrongly left out of a
report — visible and correctable. A false production books a free entitlement as
revenue — invisible, and it compounds.

## ⚠ The SQL spelling: `is distinct from`, never `<>`

```sql
and billing_environment is distinct from 'sandbox'   -- correct
and billing_environment <> 'sandbox'                 -- silently zeroes history
```

`NULL <> 'sandbox'` is NULL, not true, so the plain inequality drops every
pre-marker row from revenue while looking like a tightening. A test in
`services/edge-functions/src/tests/` refuses that spelling by name. This is the
single most likely way for this contract to be broken by someone doing the
obvious thing.

## Where the marker is written

Three tables, added across three migrations because each needed a different
mechanism:

- `users.billing_environment` and `users.buyer_billing_environment` (00559) —
  what the account's LAST purchase was.
- `google_processed_purchases.environment` (00559) — the Play per-purchase row.
- `appstore_processed_transactions.environment` (00609) — the Apple
  per-transaction row. It came last because that table is written ONLY through
  the SECURITY DEFINER RPC `grant_appstore_credits`, so stamping it meant a
  **signature change**: `DROP FUNCTION` of the old six-argument signature, then
  a create with a seventh parameter, `p_environment text DEFAULT NULL`. The
  drop is the load-bearing half, because Postgres identifies a function by its
  argument list and a create alone would leave both overloads live.

  > **Corrected 2026-08-23 (US-2837).** This paragraph used to say
  > "`CREATE OR REPLACE` would have left both overloads", and the file said
  > `CREATE FUNCTION` to match. That is true of `OR REPLACE` *instead of* the
  > drop and false of `OR REPLACE` *after* it — measured against the local
  > stack, from a database still holding the six-argument function:
  >
  > | form | result |
  > |---|---|
  > | `DROP` + `CREATE OR REPLACE`, run twice | exit 0, exit 0 — **one** signature live |
  > | the same file with the `DROP` removed | **two** signatures live |
  >
  > So the control reproduces the trap and the shipped form does not. The file
  > now reads `DROP` + `CREATE OR REPLACE`, because a bare `CREATE` cannot
  > survive a second run — it raises "already exists with same argument types"
  > and aborts everything after it, breaking US-1108 rule 1. It was the only
  > migration in 658 that did, and the test asserting the old belief is what
  > held it there.

The per-transaction rows matter separately from the user column. The user column
answers "is this account paying"; the transaction rows answer "which of these
grants were free", which is the audit question, and no other source can answer it
later — Apple's receipt is not re-queryable from the database.

## Where it is read

`revenue_dashboard` and `admin_revenue_metrics` (00608), at **six** sites: the
MRR sum, `activePaid`, `arpuCents` and `byPlan` in the first; `activePaid` and
`byPlanInterval` in the second.

Deliberately NOT filtered: `trialing`, the past-due-only count, and
`convertedFromCohort`. None of them is revenue, and the last one reads a CTE
rather than `public.users`. A test fails if any of the three is rewritten —
scope creep in a money migration is worth failing over.

## What is not solved, and cannot be

Grants made before the marker are NULL and **cannot be classified from the
database at all**. Separating a real pre-marker purchase from a sandbox one needs
App Store purchase history, which is why US-2286 AC5 stays open as operator work
rather than something code can close. §24 of `scripts/prod-diagnostics.sql`
returns `billing_source` × `billing_environment` as counts (no user ids, no
emails) and gives the shape of what is knowable.

`grant_appstore_credits` also still carries the default `EXECUTE` to `PUBLIC`
from 00104, and 00609 deliberately did not revoke it — see
[[states-that-look-normal]] and US-2403: a denied call from `anon` or
`authenticated` segfaults the backend on this Postgres image, which is why the
bulk revoke (00527) is parked. That question belongs to US-2282, not to a column
addition.

Related: [[ios-in-app-purchases]], [[pricing]], [[subscription-unit-economics]].

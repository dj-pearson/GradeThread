---
title: The buyer economy — credits, claims, and what a buyer can see
aliases: [reward credits, buyer metering, guarantee pool, condition alerts]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/buyer-rewards.ts
  - services/edge-functions/src/lib/buyer-metering.ts
  - services/edge-functions/src/lib/buyer-guarantee-claim.ts
  - services/edge-functions/src/lib/condition-alerts.ts
reviewed: 2026-08-01
tags: [buyer, money, privacy, contract]
summary: Reward credits are an append-only ledger spent in a fixed order, guarantee claims pass fraud then pool before paying, and buyer-facing search sees public certificates only.
---

# The buyer economy

## Credits: an append-only ledger, and one ordering rule

`buyer_reward_ledger` is append-only with `UNIQUE(user, type, reference_id)`.
That uniqueness **is** the idempotency: the reference is the domain id, so a
retried confirmation cannot pay twice. `buyer_reward_credits` is the derived
balance.

Spending order in `withBuyerMeter` (`lib/buyer-metering.ts`) is fixed:

> **monthly allowance → reward credits → upgrade prompt.** And a refund must go
> back to the **same pocket** it came from.

Both halves matter. Spending credits before the allowance would burn earned
value while a paid entitlement sat unused. Refunding to the wrong pocket
launders an allowance into permanent credits (or silently destroys credits the
buyer earned), and neither shows up as an error — it shows up as a balance
nobody can reconcile.

## Claims: fraud, then pool, then pay

`fileBuyerGuaranteeClaim` consumes `grade_outcomes.guarantee_eligible`, decides
the remedy with the pure `decideBuyerGuaranteeRemedy`, and then gates in this
order:

1. **Fraud** (`guarantee-fraud.ts`)
2. **Pool** (`guarantee-pool.ts` `evaluatePoolGate` — per-account cap, period
   budget, loss-ratio breaker)
3. only then auto-pay, as reward credits via `grant_buyer_reward_credit`

The order is deliberate. Fraud first means a bad actor never consumes budget;
pool second means a legitimate surge degrades to manual adjudication rather than
draining the programme. `buyer_guarantee_claims` is `UNIQUE(purchase_id)`, so one
purchase yields one claim.

Admin rejection as fraud is not just a denial: it emits a `dispute_overturned`
reputation penalty and sets `users.buyer_coverage_revoked_at`. Thresholds live in
`system_settings` under `buyer.guarantee_{coverage,remedy,pool,fraud}` — tunable
without a deploy, which also means a bad value ships instantly.

See [[grade-accuracy-guarantee]] for what the remedy may pay at all.

## Visibility: buyer search sees public certificates only

A buyer's saved search runs across **other tenants' data**, so its universe is a
privacy decision before it is a feature. It was settled deliberately:

> **The alertable universe is PUBLIC CERTIFICATES only** — `certificate_id` set,
> review status approved or modified, and not withheld
> (`isCertificateWithheld`). That is already-public data.

The two rejected options are worth recording, because they will be proposed
again: *active marketplace listings across all sellers* exposes one seller's
inventory feed to arbitrary buyers, and *watchlisted targets only* is too narrow
to be useful. Matching runs over `inventory_items`, which denormalises grade,
brand, category, size, certificate and eBay category — so the apparent
`grade_reports ↔ submissions ↔ listings` gap is bypassed entirely rather than
joined through.

Two traps in that matching: prices on `listings.listing_price` are **dollars**
while `saved_searches.max_price_cents` is cents, and `grade_outcomes` is an
opt-in post-sale training table, **not** a source for matching.

## Related

- [[grade-accuracy-guarantee]] — coverage gating, and the reputation perks that compose in
- [[garment-passport-privacy]] — the other place a visibility decision was made deliberately
- [[flipdesk-plan-gating]] — the seller-side metering this mirrors
- [[INDEX]]

---
title: The grade-accuracy guarantee — coverage-gated, and what it actually pays
aliases: [guarantee remedy, coverage scope, trust score, buyer perks]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/guarantee-remedy.ts
  - services/edge-functions/src/lib/coverage.ts
  - services/edge-functions/src/lib/buyer-reputation-perks.ts
  - services/edge-functions/src/lib/buyer-guarantee-coverage.ts
reviewed: 2026-08-01
tags: [grading, guarantee, buyer, money, contract]
summary: The guarantee answers only for zones the seller photographed, pays back the grading fee and nothing else, and its window can be extended by reputation but never shortened.
---

# The grade-accuracy guarantee

Distinct from the **authenticity** position — see
[[adr-authenticity-guarantee]] for why authenticity is deliberately *not*
financially backed. This note is about grade accuracy, which is.

## It answers only for what was photographed

The guarantee is **coverage-gated**: liable for defects in zones the seller
actually documented, and not for zones no photo covers. That is the whole design
— a grade is an assessment of visible evidence, so promising accuracy about an
unphotographed area would be promising something the grader never saw.

The photo-coverage engine (`lib/coverage.ts`, mirrored client-side) produces the
scope. A claim's `claimed_issues[].location` maps to zones through the exported
`zonesFromHint`, and `evaluateClaimScope` decides whether the claim lands inside
it.

**Cert-integrity v3 seals the coverage scope into the certificate.** So the scope
a claim is judged against is the scope that existed when the grade was issued —
it cannot be re-argued later by re-photographing the item.

## What it pays, and what it never pays

**The grading fee back.** A Stripe refund or a credit, plus a free re-grade. The
fee is determined from `submissions.payment_status`,
`stripe_payment_intent_id` and `service_tier`.

> **Never the item's value, never shipping.** The marketplace covers those. A
> guarantee that paid item value would be insurance, priced and regulated as
> such, which is a different product.

**The idempotency gate is a ledger row, claimed before any money moves.**
`guarantee_remedies.claim_id` is UNIQUE and `issueGuaranteeRemedy` inserts it
first. Any new payout path must claim the row before calling Stripe, not after —
that ordering is the only thing standing between a retry and a double refund.

## Reputation can extend the window, never shrink it

Buyer reputation is event-sourced: `reputation_events` is append-only with a
`verified` gate, unique on `(user, type, reference_id)` so retries cannot
double-count, and `buyer_trust_scores` is a derived cache. Only **verified**
events score; positives decay, penalties decay far more slowly.

Perks resolve through `resolveReputationPerks(level)` and compose with the
subscription baseline via helpers like `effectiveGuaranteeWindowDays(base,
level)`.

> **The composition rule: subscription baseline + reputation bonus. A perk never
> removes a plan capability.** Reputation may lengthen a guarantee window or
> multiply a reward; it must not be able to take away something a buyer paid
> for. Read perks from the resolver rather than re-implementing the matrix — the
> web mirror is pinned to the edge copy by both test suites.

When a new surface should feed reputation (a confirmed grade, a dispute, a
chargeback, tenure), emit through `emitReputationEvent` with the **domain id** as
`referenceId` and then recompute — that is what makes retries safe.

## Related

- [[adr-authenticity-guarantee]] — the guarantee we deliberately do NOT give
- [[grading-scale-and-weights]] — what accuracy is being guaranteed against
- [[measurement-accuracy]] — the same never-claim-unmeasured-accuracy principle
- [[INDEX]]

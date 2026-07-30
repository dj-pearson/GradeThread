---
title: "ADR: guarantee-backed authenticity"
type: decision
status: accepted
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/guarantee-pool.ts
  - services/edge-functions/src/lib/buyer-guarantee-claim.ts
  - services/edge-functions/src/lib/authenticity-seller-signal.ts
reviewed: 2026-07-30
revisit_by: 2027-01-31
tags: [decision, authenticity, guarantee, risk]
summary: Why GradeThread does not financially back its authenticity assessments yet, and the four things that would have to be true to revisit.
---
# Guarantee-backed authenticity (US-2144)

**Proposal:** back the authenticity assessment with a financial guarantee, the
way Entrupy backs its certificates ("if our tech ever gets it wrong, we'll give
your money back"). A guarantee is what converts an *opinion* into a commercial
product — it is the single biggest lever on whether buyers treat an authenticity
verdict as meaningful.

## Decision: PARK — do not offer one (as of 2026-07-19)

Recorded explicitly so it is a decision rather than an omission. The rails it
would ride on already exist, which is exactly why the absence would otherwise
look like an oversight and get "fixed" by someone reading the code alone.

## Why not, in order of weight

**1. The loss shape is wrong for the pool we have.** The existing coverage-gated
guarantee refunds a *grading fee*. An authenticity guarantee refunds a **total
loss on item value** — the buyer did not receive a slightly-worse jacket, they
received a worthless one. That is one to two orders of magnitude more per claim,
against a pool sized for fee refunds.

**2. Counterfeit claims arrive correlated; the budget assumes they don't.** Fakes
come in batches from a single bad seller. A fixed per-period budget with a
loss-ratio breaker handles independent, spread-out claims well and correlated
bursts worst — the breaker trips *after* the batch has already drawn down, so the
protection arrives late by construction.

> *Partially mitigated 2026-07-30 (US-2148 AC5), and only partially.* A claim
> whose seller has ≥ `CLUSTER_THRESHOLD` human-confirmed counterfeits inside the
> trailing `CLUSTER_WINDOW_DAYS` no longer auto-pays; it routes to manual review
> *before* the pool reserve, so a live batch stops drawing the budget down while
> a human looks. That moves the protection ahead of the drawdown for the case we
> can see. It does **not** resize the pool, and it is blind to the first batch
> from a seller with no confirmed history — which is every new bad seller. The
> threshold is deliberately the same one `/admin/authenticity` ranks on, so an
> operator triaging a hold sees the number that caused it. The hold is kept out
> of the claim's `fraud_flags`: those signals are about the *claimant*, and a
> buyer who bought from a bad seller is not a suspicious buyer.

**3. The verdict backing it has never cleared an accuracy gate.** The eval gate
did not run at all until US-2130, and it cannot pass until a golden set exists
(US-2131). Guaranteeing a number whose error rate is unmeasured is not a pricing
decision, it is a bet with unknown odds. See [[shipped-but-unwired]] for how that
gate came to be shipped-but-unenforced.

**4. The evidence base cannot yet support the claim.** Delivered photo resolution
caps below what authentication tells require, and verified per-brand tells cover
a handful of brands. US-2134 caps confidence when no macro frame is present
precisely because the evidence is thin.

## Two flaws to fix regardless — both now FIXED (US-2144)

These were live in the **existing buyer guarantee** and were never contingent on
this decision. Kept here rather than deleted, because revisit criterion 4 below
is written against them and a reader needs to see what it refers to.

- **~~The pool drawdown races.~~** *Fixed.* `fileBuyerGuaranteeClaim` now calls
  `reservePoolDrawdown`, a single `reserve_guarantee_pool_drawdown` RPC that
  checks the caps and records the drawdown in one transaction, keyed on
  `purchase:<id>` so a retry reuses the reservation. The old sequence read pool
  state before the claim insert and recorded the drawdown after, so two
  concurrent claims could both pass the same budget — the correlated-batch case
  the budget exists to bound. `recordPoolDrawdown` survives as a no-op-on-
  conflict reconciler for claims reserved under the old flow.
- **~~Credit-grant failure is swallowed.~~** *Fixed.* A failed
  `grant_buyer_reward_credit` now raises through `captureException` +
  `guarantee.remedy_grant_failed`, and flips the claim to `manual_review` with
  reason `grant_failed` so something revisits it. The drawdown is deliberately
  **kept**: silently undoing a payout is worse than silently succeeding, and the
  money stays conservatively reserved. If the flip itself fails,
  `guarantee.grant_failure_unrecoverable` is the record.

An authenticity guarantee would have made both materially worse, since its claims
are larger and more correlated.

## What would have to be true to revisit

All four, not any:

1. The eval gate **passes** on a golden set with real per-brand coverage,
   including counterfeit examples — not authentic-only (see the coverage rule in
   `summarizeCaseCoverage`).
2. A measured **false-positive rate** — how often a genuine item is called fake —
   because that error, not overall accuracy, is what a guarantee pays out on and
   what damages sellers.
3. **Claim-severity modelling** against item value, not fee value, with a pool
   sized to a correlated-batch scenario rather than an average month.
4. ~~The two flaws above are fixed, with a **transactional reserve** replacing the
   read-then-write pool gate.~~ **Met 2026-07-30** — see the section above. This
   is the only one of the four that is met; the park stands on 1–3, and criterion
   3 is *not* satisfied by the US-2148 batch hold, which bounds when we pay but
   says nothing about how large the pool should be.

## Consequences of parking

- Authenticity stays framed as an **assessment with stated limitations**, never a
  verification or a guarantee. The wording is enforced in code by a fixed
  limitations constant the model cannot override.
- We give up the strongest commercial framing available, and a competitor that
  underwrites its verdicts will look more confident than us. That is accepted:
  being wrong once on a $3,000 item costs more than the framing gains.
- Nothing here blocks the *provenance* play (passport, chain of custody), which
  carries bounded downside and is where the durable differentiation sits.

`revisit_by` is a backstop, not a trigger — the four criteria above are the
trigger. If the date arrives and they are unmet, re-argue the parking rather than
lapsing into it by default.

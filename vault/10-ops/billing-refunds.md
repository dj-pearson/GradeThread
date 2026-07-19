---
title: Billing refunds
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, billing, stripe]
summary: How to issue and reconcile a refund.
---
# Billing — Refunds & Chargebacks Runbook

How GradeThread handles money coming back out, and what an admin must do to
reconcile. Automated handling lives in
`services/edge-functions/src/routes/webhooks.ts`.

## What's automated

| Event | Product | Automated effect |
| --- | --- | --- |
| `charge.refunded` | `credit_pack` | `revoke_grade_credits` RPC debits the wallet (clamped at 0), writes a balance-consistent ledger row, and reports any already-spent **shortfall** (US-384). |
| `charge.refunded` | `per_grade` | Submission marked `refunded_at`, `flagged=true` / `flag_reason='payment_refunded'`; the grade's `grade_reports.certificate_id` is cleared so the **public certificate stops resolving** (US-385). The grade row is retained for review. |
| `charge.dispute.created` | any | Logged + a `billing.dispute_created` alert is emitted; per-grade submissions are flagged `payment_disputed`. **No auto-revoke** — a dispute can still be won (US-385). |
| `charge.refunded` | subscription | No DB change — Stripe drives subscription state via `customer.subscription.*`. |

## Reconciling a refunded `paid_stripe` grade

1. Find the submission: it has `refunded_at` set and `flag_reason='payment_refunded'`
   (admin → submissions, filter flagged).
2. Confirm the Stripe refund (Dashboard → Payments → the charge) matches the amount.
3. The public certificate is already withheld (`certificate_id` is null). If the
   refund was issued **in error**, re-issue a certificate id and clear the flag;
   otherwise leave it withheld.
4. If the grade was already used downstream (e.g. an eBay listing cites the
   cert), notify the seller that the certificate was revoked.

## Reconciling a credit-pack refund shortfall

If the refund log shows `needs reconciliation` (the customer had already spent
some/all of the refunded credits, so the wallet couldn't be fully debited),
decide whether to comp the difference or pursue recovery. The ledger note on the
`refund` row records exactly how many credits could not be clawed back.

## Disputes (`charge.dispute.created` → `*.closed`)

- On **created**: gather evidence in the Stripe Dashboard; the submission is
  already flagged for review.
- On **won**: clear the `payment_disputed` flag; entitlement is unchanged.
- On **lost**: treat like a refund — withhold the certificate (clear
  `certificate_id`) and set `refunded_at` if not already set.

---
title: Pricing — where the numbers live
type: reference
status: current
source_of_truth: vault
code_refs:
  - src/lib/constants.ts
  - scripts/setup-stripe-pricing.mjs
reviewed: 2026-07-18
tags: [pricing, billing, stripe]
summary: Pricing has a doc and a code mirror that must change together; this note records the contract until docs/PRICING.md moves here in US-2055.
---

# Pricing — where the numbers live

**Do not restate prices in this note.** Its job is to record *where* the numbers
live and what keeps them consistent.

## The three-way mirror

Pricing is defined in three places that must move together:

1. **`vault/50-business/pricing.md`** — the canonical model (US-200), currently still at its
   original path. Moves into this folder in US-2055.
2. **`src/lib/constants.ts`** — the machine-readable mirror: `FLIPDESK_PLANS`,
   `GRADETHREAD_TIERS`, `CREDIT_PACKS`, `FLIPDESK_UPGRADE_TRIGGERS` (re-exported
   as `PLAN_MATRIX`).
3. **The Stripe catalog** — generated from the same numbers by
   `scripts/setup-stripe-pricing.mjs` (US-203).

`vault/50-business/pricing.md` states the rule directly: any change to those constants must
update the doc **in the same PR, and vice-versa**.

## Why this note exists before the migration

Numbers restated across multiple documents are the highest-drift content in any
repo, and pricing drift is expensive in a way that documentation drift usually is
not — a wrong number here misbills real customers.

US-2055 will replace duplicated figures elsewhere with links to the canonical
note, and **flag rather than silently harmonise** any figures that disagree. A
disagreement is a finding, not a formatting problem; harmonising one without
understanding it is how a wrong price becomes canonical.

## Structural notes worth knowing

- Two products bill against **one** Stripe customer: the FlipDesk subscription
  (recurring tiers) and GradeThread pay-per-grade (one-time, with optional prepaid
  credit packs).
- `-1` in `activeListingCap` / `marketplacesCap` means **unlimited / all**, not
  "unset". Treating it as a sentinel for missing data will silently downgrade
  Business-tier accounts.
- The "marketplaces" cap counts **API connections**, not channels a seller can
  list to. Browser-extension marketplaces do not consume a connection.
  `MARKETPLACE_TIER` (US-718) is the single source of truth for that distinction.

## Related

- [[INDEX]]
- [[CONTRACT]] — the no-duplicated-facts rule this note follows

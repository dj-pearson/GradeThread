# GradeThread + FlipDesk Pricing — Canonical Model (US-200)

This is the single source of truth for the pricing model. Every downstream
billing story (US-201 → US-225) derives from the numbers here.

**Machine-readable mirror:** `src/lib/constants.ts` exports `FLIPDESK_PLANS`,
`GRADETHREAD_TIERS`, `CREDIT_PACKS`, and `FLIPDESK_UPGRADE_TRIGGERS` (re-exported
as `PLAN_MATRIX` for convenience). **Any change to those constants MUST update
this doc in the same PR, and vice-versa.** The Stripe catalog is generated from
the same numbers by `scripts/setup-stripe-pricing.mjs` (US-203).

Two products are billed on **one** Stripe customer:

1. **FlipDesk subscription** — four recurring tiers.
2. **GradeThread pay-per-grade** — per-grade one-time pricing with optional
   prepaid credit packs.

---

## 1. FlipDesk subscription tiers

Annual ≈ 17% off (10 months for the price of 12 → 2 months free).

| Tier | Monthly | Annual | Active listings | Marketplaces | AI actions/mo | Included Standard grades/mo | Notable gates |
|---|---|---|---|---|---|---|---|
| **Free** | $0 | $0 | 25 | eBay only (1) | 25 | 3 | — |
| **Starter** | $29 | $290 | 250 | All (-1) | 200 | 10 | Auto-import payouts |
| **Pro** | $59 | $590 | 1,000 | All (-1) | 750 | 30 | Bulk actions, scheduled actions, comp pulls, auto-relist, AI AutoLister |
| **Business** | $99 | $990 | Unlimited | All (-1) | 2,000 | 75 | Everything in Pro + sub-accounts, API access, payout reconciliation, priority support |

`activeListingCap` / `marketplacesCap` of `-1` in the constants means
**unlimited / all**.

**Marketplace capability tiers (US-718, single source of truth =
`MARKETPLACE_TIER`).** "Marketplaces" above is the number of *API connections*
a tier may open; it is not a count of every channel a seller can list to:
- **Live API** (counts toward the cap): eBay, Shopify. A paid tier's cap of `-1`
  lets a seller connect both (and Depop once approved) and fan a single draft out
  across them. Free is capped at 1 (eBay only) as the upsell.
- **Browser extension** (does NOT consume an API connection): Poshmark, Mercari,
  Grailed — cross-listed from the seller's own logged-in tab via the GradeThread
  Lister extension (US-716). Available on every paid tier.
- **Pending approval**: Depop — the API connector is built (US-713/714) but stays
  off behind `DEPOP_ENABLED` until the platform approves the app; advertised as
  "coming soon", never as a live API integration.
- **Coming soon** (no integration yet): Facebook, OfferUp, Whatnot.

### Gate flags per tier (`gateFlags`)

| Flag | Free | Starter | Pro | Business |
|---|:--:|:--:|:--:|:--:|
| bulkActions | ✗ | ✗ | ✓ | ✓ |
| scheduledActions | ✗ | ✗ | ✓ | ✓ |
| compPulls | ✗ | ✗ | ✓ | ✓ |
| autoRelist | ✗ | ✗ | ✓ | ✓ |
| autolister | ✗ | ✗ | ✓ | ✓ |
| subAccounts | ✗ | ✗ | ✗ | ✓ |
| apiAccess | ✗ | ✗ | ✗ | ✓ |
| reconciliation | ✗ | ✗ | ✗ | ✓ |
| prioritySupport | ✗ | ✗ | ✗ | ✓ |

---

## 2. GradeThread per-grade pricing

| Tier | Price | SLA | Credit cost |
|---|---|---|---|
| **Standard** | $2.99 | 48h | 1 credit |
| **Premium** | $7.99 | 12h | 3 credits |
| **Express** | $12.99 | 1h | 5 credits |

Only **Standard** grades can be covered by a subscription's included monthly
allowance. Premium/Express always draw from credits or a one-time charge.

---

## 3. Credit packs

1 credit = 1 Standard grade. **Credits never expire.** Non-refundable.

| Pack | Price | Effective $/Standard grade | Discount vs $2.99 |
|---|---|---|---|
| 10 credits | $24.99 | $2.499 | ~17% |
| 25 credits | $59.99 | $2.400 | ~20% |
| 50 credits | $109.99 | $2.200 | ~26% |
| 100 credits | $199.99 | $1.999 | ~33% |

---

## 4. Debit precedence on a submission (US-207)

For each grade submission, charge in this order:

1. **Included monthly grades** — only if the user is a FlipDesk subscriber,
   the chosen tier is **Standard**, and the included allowance for the current
   billing cycle is not yet exhausted. Increments
   `users.grades_used_this_month` (repurposed to "included grades used").
2. **Credit balance** — if `grade_credit_balance >= tier.creditCost`, debit via
   `debit_grade_credits()`.
3. **One-time Stripe Checkout** — for the chosen tier's price; the frontend
   also offers a "buy a pack and save" upsell.

The included-grades and AI-actions counters reset on
`invoice.payment_succeeded` (billing_reason = `subscription_create` /
`subscription_cycle`) per US-206.

---

## 5. Upgrade triggers (US-209 / US-210)

Defined in `FLIPDESK_UPGRADE_TRIGGERS`.

- **Soft (80% of any cap):** a dismissible toast fires once per cap per month
  ("You've used 80% of your <cap> — upgrade to <next plan> for <new limit>").
  The plan-gate middleware also returns header `X-Plan-Warning: CAP_80` on the
  action that crosses 80%.
- **Hard (100% of any cap):** the action is blocked with HTTP `402
  PAYMENT_REQUIRED` and an `UpgradeRequiredDialog` with a clear upgrade CTA
  (and, for grade-cap hits, inline credit-pack tiles).
- Users may set their own threshold (50% / 80% / 95%) via
  `users.usage_alert_thresholds`; default is 80%.

Caps that participate: active listings, AI actions, included grades,
marketplaces connected.

---

## 6. Self-serve subscription actions

| Action | Timing | Mechanism |
|---|---|---|
| **Upgrade** | Immediate (prorated) | Stripe `subscriptions.update`, proration_behavior `create_prorations` |
| **Downgrade** | End of period | Scheduled; new tier takes effect at `flipdesk_period_end` (US-217) |
| **Switch to annual** | Immediate (prorated) | Interval change on the subscription |
| **Pause** | 1 / 2 / 3 months | Stripe `pause_collection` with `resumes_at` (US-215) |
| **Cancel** | End of period → Free | `cancel_at_period_end = true`; reverts to Free, **keeps credit balance** (US-216) |
| **Credit top-up** | Immediate | One-time Checkout for a credit pack (US-213) |

A **paused** subscription keeps the user's data and credit balance, but their
caps drop to the **Free** tier in plan-gate (US-208) and the monthly counters
do **not** reset while paused.

---

## 7. Trials

- New signups land on a **14-day Pro trial** (`subscription_status = 'trialing'`,
  `trial_ends_at` = now + 14 days), set by `handle_new_user()`. **One trial per
  user, ever** (US-219).
- No card is collected upfront; a daily job flips un-converted trials to **Free**
  when `trial_ends_at` passes. A Stripe subscription is only created when the
  user explicitly upgrades.

---

## 8. Refund policy

- **Subscriptions:** 14-day money-back guarantee on the **first** subscription
  invoice only.
- **Credit packs:** non-refundable — but **credits never expire**, so there is
  no "use it or lose it" pressure.

---

## Appendix A — Competitor benchmarks (context for future tweaks)

Captured at design time so future pricing changes have a reference point.

### Cross-listing / reseller tools

| Tool | Tiers |
|---|---|
| **List Perfectly** | $29 / $49 / $69 / $99 |
| **Vendoo** | $14.99 / $29.99 / $59.99 / $99.99 / $149.99 |

Our FlipDesk ladder ($0 / $29 / $59 / $99) deliberately undercuts the top of
both ladders while adding a genuine free tier and bundled grading neither
competitor offers.

### Grading / authentication services

| Service | Price range |
|---|---|
| **PSA** (collectibles grading) | $25 / $50 / $150 / $300 |
| **LegitGrails** (authentication) | $15 – $55 |

GradeThread per-grade ($2.99 / $7.99 / $12.99) sits an order of magnitude below
physical grading services because it is AI-driven and digital, which is the core
value proposition: standardized condition grading at software margins.

---

## Appendix B — Where each number lives

| Concept | Constant | Stripe artifact |
|---|---|---|
| FlipDesk tiers | `FLIPDESK_PLANS` (`PLAN_MATRIX`) | Products `flipdesk_*`, monthly+yearly Prices |
| Per-grade tiers | `GRADETHREAD_TIERS` | Products `grade_*`, one-time Prices |
| Credit packs | `CREDIT_PACKS` | Products `credits_*`, one-time Prices |
| Upgrade thresholds | `FLIPDESK_UPGRADE_TRIGGERS` | — |
| Price IDs (env-injected) | `STRIPE_PRICE_IDS` | output of `scripts/setup-stripe-pricing.mjs` |

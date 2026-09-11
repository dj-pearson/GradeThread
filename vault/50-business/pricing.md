---
title: Pricing — canonical model
aliases: [PRICING, plans, price list]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/constants.ts
  - scripts/setup-stripe-pricing.mjs
  - src/pages/legal/refund.tsx
  - src/pages/legal/terms.tsx
reviewed: 2026-09-10
tags: [pricing, billing, stripe, contract]
summary: The single source of truth for every price; src/lib/constants.ts is its machine-readable mirror and must change in the same commit.
---
# GradeThread + FlipDesk Pricing — Canonical Model (US-200)

> **Re-reviewed 2026-09-10, two corrections.** Drift flagged `constants.ts`,
> `refund.tsx` and `terms.tsx`. Every published figure was re-read against
> `src/lib/constants.ts` and all of them still match: FlipDesk 0 / 2900 / 5900 /
> 9900 with yearly 0 / 29000 / 59000 / 99000, buyer 800/8000 and 1900/19000,
> grades 299 / 799 / 1299, credit packs 2499 / 5999 / 10999 / 19999. The legal
> pages changed for US-3233 (US spelling: "cancelled" to "canceled") and for
> US-3038/pooled sales data, which renumbered Terms' last sections -- Changes is
> now **Section 20**, not 19. `refund.tsx` section 3 is still Refunds and still
> carries the 60-day billing-error window, which the affiliate hold below is
> pinned to.
>
> What DID stale: **Action Credits are a second prepaid currency this note did
> not list** (section 3b below), and **section 9a's "use a Stripe coupon" is no
> longer the whole answer** -- US-3299 shipped operator-scheduled sale campaigns
> and they are now the first thing to reach for. Both fixed below.

> **Re-reviewed 2026-09-05, no change.** Drift flagged `src/lib/constants.ts`
> for US-3071, which added `relist` to `MARKETPLACE_EXTENSION_FLOWS` and a
> per-flow capability label map beside it. That is the extension cross-listing
> surface only: no grading weight, photo rule, plan gate or price moved, and
> the constants this note names are untouched.

> **Re-reviewed 2026-09-02.** Drift flagged `src/lib/constants.ts` and
> `src/pages/legal/terms.tsx`. The constants change is this note's own creator
> commission block (US-9212), which the section further down now documents,
> including the `termsVersion` mirror. The terms page changed for US-3038's Fit
> & Measurement Index consent -- a data-sharing section, not a price, a plan or a
> billing term. Every number in this note re-verified against
> `src/lib/constants.ts` while here, and `src/test/creator-affiliate.test.ts`
> fails if any of the three copies drifts.


This is the single source of truth for the pricing model. Every downstream
billing story (US-201 → US-225) derives from the numbers here.

**Machine-readable mirror:** `src/lib/constants.ts` exports `FLIPDESK_PLANS`
(re-exported as `PLAN_MATRIX` for convenience), `GRADETHREAD_TIERS`,
`CREDIT_PACKS` and `ACTION_CREDIT_PACKS`. **Any change to those constants MUST update this doc in the same
PR, and vice-versa.** The Stripe catalog is generated from the same numbers by
`scripts/setup-stripe-pricing.mjs` (US-203).

This list used to name a fourth constant, `FLIPDESK_UPGRADE_TRIGGERS`, and that
was a claim about code rather than a description of it — nothing had ever read it.
US-2436 deleted it; §5 below now names where the thresholds actually live.

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

**The listing allowance is the number a reseller shops on (US-2483).** Crosslist,
Vendoo and List Perfectly all price by listing volume, so "how many listings does
this cover" is the first question a switching seller asks — and until US-2483 our
answer was buried in a features bullet three lines down the plan card, while the
headline number was AI actions, an axis nobody else prices on. The allowance is
now its own line on `/pricing` and in `flipdesk-plan-comparison.tsx`, rendered
through `formatListingAllowance` so both surfaces phrase one number identically.

The number is `activeListingCap` and nothing else. It is what
`plan-gate.ts` actually enforces, tied to the edge by
`plan-limits-parity.test.ts`, and a second marketing figure is forbidden: an
allowance the server does not grant is the advertised-vs-enforced defect US-2123
found on the iOS paywall. Business says **Unlimited** rather than a made-up
ceiling, because `-1` is a real sentinel and inventing "10,000" to fill the cell
would be a cap we would then have to honour.

**Marketplace capability tiers (US-718, single source of truth =
`MARKETPLACE_TIER`).** "Marketplaces" above is the number of *API connections*
a tier may open; it is not a count of every channel a seller can list to:
- **Live API** (counts toward the cap): eBay, Shopify. A paid tier's cap of `-1`
  lets a seller connect both (and Depop once approved) and fan a single draft out
  across them. Free is capped at 1 (eBay only) as the upsell.
- **Browser extension** (does NOT consume an API connection): Poshmark, Mercari,
  Grailed, Vinted — cross-listed from the seller's own logged-in tab via the
  GradeThread Lister extension (US-716). Available on every paid tier.
- **Pending approval**: Depop — the API connector is built (US-713/714) but stays
  off behind `DEPOP_ENABLED` until the platform approves the app; advertised as
  "coming soon", never as a live API integration.
- **Coming soon** (no integration yet): Facebook, OfferUp, Whatnot.

> [!note] This note was right and the code was wrong (US-2327, 2026-08-03)
> `MARKETPLACE_TIER` called Whatnot `api_pending` and `MARKETPLACE_MECHANISM`
> called it `"api"`, while every method on its adapter is `notImplemented`
> and its client file says the endpoints were modelled with no public docs.
> The row above already said "coming soon". The fix moved the CODE to match
> this note, not the other way round — worth remembering next time the two
> disagree.

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
| connectorAccess | ✗ | ✗ | ✓ | ✓ |
| shippingLabels | ✗ | ✗ | ✓ | ✓ |
| reconciliation | ✗ | ✗ | ✗ | ✓ |
| prioritySupport | ✗ | ✗ | ✗ | ✓ |

> **`shippingLabels` charges nothing on top of postage** (US-3011,
> 2026-08-29). Buying an eBay label inside the ship step is Pro and up, and
> the postage passes through at eBay's own rate with no markup. A margin was
> the obvious model and is the wrong one: eBay's built-in label flow and
> Pirate Ship are both free at the same commercial rates, so a seller
> comparing two receipts would find the difference within a day. The
> subscription is the whole money model.
>
> **`connectorAccess` is not `apiAccess`, and the difference is the point**
> (US-9101, owner's decision 2026-08-19). `apiAccess` is raw `/api/v1` and stays
> Business-only. The Claude connector opens at **Pro**, because it is the
> strongest single reason to pay for GradeThread and gating it at $99 means
> almost nobody encounters it. Two products sharing one flag would have meant
> widening one silently widened the other.
>
> It carries its own monthly allowance too — `connectorActionsPerMonth`, Pro
> **500** and Business **2000**, counted separately from `aiActionsPerMonth`.
> The reasoning, and why there is no new database column, is in
> [[connector-plan-gating]].

---

## 1b. Buyer plans & seller bundling (US-1886 / US-1887)

GradeThread is two-sided: the same account can sell **and** buy. Buyer plans
(machine-readable mirror: `BUYER_PLANS` in `src/lib/constants.ts`) monetize
point-of-purchase confidence for shoppers.

| Buyer tier | Monthly | Annual | Highlights |
|---|---|---|---|
| **Free** | $0 | $0 | 10 extension second-opinions/mo, 3 daily condition alerts, rewards, trust score, 10 closet items |
| **Guard** | $8 | $80 | Unlimited extension + discrepancy/price-fairness, fit prediction, 3 authenticity + 2 video credits/mo, standard grade-locked guarantee, 25 hourly alerts, 200 closet items |
| **Connoisseur** | $19 | $190 | Everything in Guard + demand board + priority support, plus guarantee, unlimited instant alerts, 15 authenticity + 10 video credits, unlimited closet |

**Seller plans INCLUDE buyer functions, tier-matched** (`SELLER_PLAN_BUYER_TIER`).
A seller never needs a separate buyer subscription — their **effective buyer
plan is the higher of** their buyer subscription (if any) and this seller-derived
tier:

| FlipDesk (seller) plan | Included buyer tier |
|---|---|
| Free | Buyer Free |
| Starter | Buyer Guard |
| Pro | Buyer Guard |
| Business | Buyer Connoisseur |

Standalone buyer plans remain for **non-sellers**. A lapsed/paused seller loses
the seller-derived bump (grace window honored on the edge via `effectivePlanFor`)
but any standing buyer subscription still applies. Resolution is mirrored on the
client (`use-buyer-entitlements.ts`) and edge (`buyer-entitlements.ts`) — keep
them in lockstep. Any change to `BUYER_PLANS` / `SELLER_PLAN_BUYER_TIER` MUST
update this section in the same PR.

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

## 3b. Action Credit packs (US-3138)

A **second prepaid currency, not a bigger credit pack.** Grade credits buy
grades and are anchored at $2.99 a Standard grade. Action Credits pay for
metered ACTIONS -- AI actions and connector actions -- once a plan's monthly
allowance is spent, so a seller fifty actions short on the 20th has something to
buy other than a tier upgrade. Merging the two would mean re-denominating a
shipped ledger holding real money.

| Pack | Credits | Price | Per action |
|---|---|---|---|
| Top-up | 50 | $4.99 | 9.98c |
| Standard | 150 | $13.99 | 9.33c |
| Bulk | 400 | $34.99 | 8.75c |
| Power | 1,000 | $79.99 | 8.00c |

**The floor is Pro's implied per-action rate, 5900/750 = 7.87c.** Price any pack
below it and topping up beats upgrading, which inverts the plan ladder. The
enforcing test lives on the edge, beside the table checkout actually charges
from (`services/edge-functions/src/tests/action-credits_test.ts`), and the
reasoning is in [[action-credits]].

Two differences from the grade credit packs above, both deliberate:
`scripts/setup-stripe-pricing.mjs` does **not** generate these -- the ids come
from `STRIPE_PRICE_ACTION_CREDITS_*` on the edge -- and the App Store and Play
catalogs carry them as their own product kind (`action_credits`), never as a
flavour of the consumable that means grade credits.

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

The soft threshold is defined SERVER-SIDE, by `SOFT_WARN_PCT` in
`services/edge-functions/src/lib/plan-gate.ts` — that is the copy that decides
whether a request comes back carrying `X-Plan-Warning: CAP_80`, so it is the
authoritative one. The hard threshold is not a named constant at all: it is the
402 path itself.

> [!warning] Two claims in this section were wrong when they were written
> Both were added 2026-08-08 by US-2436 and corrected the same day by US-2438's
> vault re-read. They are recorded rather than quietly replaced, because both
> failed the same way: an argument from ABSENCE, stated confidently, that nobody
> could have falsified without going and looking.
>
> **"Per-user configurable thresholds (US-209) were never built: no column, no
> setting, no UI."** All three exist. The column is
> `users.usage_alert_thresholds jsonb NOT NULL DEFAULT '[80]'` (migration
> 00071), the setting is `POST /api/payments/usage-alerts` validating against
> `ALLOWED_THRESHOLDS = {50, 80, 95}`, and the UI is the chooser in
> `src/pages/settings.tsx`. It is honoured at runtime too, not merely stored —
> `usage-alert-watcher.tsx` calls `crossedThreshold(capUsage, usage.thresholds)`.
> The bullet ten lines below had said so correctly the whole time, so the note
> contradicted itself for one commit.
>
> **"Two client meters compare against a bare `0.8` literal of their own …
> nothing guards the three against drifting apart."** Those literals are not
> thresholds. In `usage-meter.tsx` and `sidebar-usage-widget.tsx` they are colour
> stops in a four-step ramp (`>= 1.0`, `>= 0.8`, `>= 0.5`, else) that paints a
> progress bar red. They fire nothing and gate nothing, so there is no drift risk
> and no third copy — US-2441 should be read as being about `SOFT_WARN_PCT`
> alone, not as pointing at these two files.

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

**The public legal pages are authoritative here, not this note.** Support and
billing decisions are made against what a customer can actually read.

- **Subscriptions:** non-refundable once a billing period has begun, except
  where required by law or expressly granted in writing
  (`src/pages/legal/refund.tsx` §3, `src/pages/legal/terms.tsx`).
- **Credit packs:** non-refundable once a grade has been generated. Credits
  themselves **never expire** (`CREDIT_PACKS` in `src/lib/constants.ts`,
  migrations 00037 and 00415), so there is no "use it or lose it" pressure.
- **Billing errors:** double-charges or charges after a valid cancellation are
  refunded — 60-day window, per `refund.tsx` §3.

> [!warning] There is no 14-day money-back guarantee (US-2127, settled 2026-08-02)
> This section used to state one, "on the first subscription invoice only". It
> was **never true**: both public legal pages say subscription fees are
> non-refundable, and nothing in the codebase implements a refund window —
> refunds are manual admin actions through `admin-billing.ts`.
>
> The owner settled it on 2026-08-02: the note was wrong, delete the claim. The
> most likely origin is the 14-day free **trial**, which is real and is a
> different thing entirely. Two features sharing a number is enough to produce a
> policy nobody agreed to.
>
> The danger was directional. An internal note promising a refund the public
> pages deny is a promise support might honour case by case, creating an
> undisclosed policy — and inconsistent refunds are worse than either answer.

### ⚠️ A separate contradiction, NOT resolved here

`terms.tsx` says "Unused grading credits **do not roll over** and are not
refundable." That conflates two different things:

- **Purchased credit packs** never expire. Code and migrations both say so.
- **The monthly plan allowance** (`grades_used_this_month`) resets each month
  and genuinely does not roll over.

So the sentence is true of one and false of the other, and the word "credits"
is used for both. It understates what a paying customer gets, so it costs
conversion rather than creating legal exposure — but it is still a false
statement in the Terms. **Not edited here**: US-2127 AC4 puts the legal pages
under counsel review, and rewriting Terms copy ahead of that trades one
unreviewed statement for another. Carried on US-2127.

---

## 9. Changing price or running a promotion

**The number a customer *sees* and the amount Stripe *charges* come from different
places. Keep them straight or you'll advertise one price and bill another.**

| Thing | Source of truth | Notes |
|---|---|---|
| Public pricing page (`src/pages/marketing/pricing.tsx`) | **compiled `FLIPDESK_PLANS.priceMonthlyCents`** (`src/lib/constants.ts`) | Prerendered for SEO — cannot read the DB at runtime. Only changes on a **frontend redeploy**. |
| In-app plan comparison (`flipdesk-plan-comparison.tsx`) | **DB `pricing_plans.price_monthly_cents`** via `usePricingPlans()` | Deploy-free, but **display only**. |
| In-app plan picker / landing | compiled `FLIPDESK_PLANS` | Frontend redeploy. |
| **What Stripe actually charges** | **`pricing_plans.stripe_price_monthly` / `stripe_price_yearly`** (a Stripe **Price ID**), read by `getFlipdeskPriceIds()` in `payments.ts` | The `price_*_cents` column is **NOT** used for billing. |

> ⚠️ **Editing `price_monthly_cents` in admin changes the displayed number on
> DB-driven surfaces but does NOT change what Stripe bills** (that's the Stripe
> Price ID). Never "run a promo" by editing the cents column — you'll create a
> display-vs-charge mismatch and the public page won't move at all.

Every row above is the LIST price. Since US-3299 a live sale campaign is layered
on top of it at render time and at checkout, from `discount_campaigns` rather
than from any of these sources, which is why the prerendered public page shows
list price in its HTML and the sale price after hydration. Section 9a.

### 9a. Run a sale (a discount everyone gets): US-3299

**Schedule a campaign in admin. Do not edit a price.** `/admin/pricing` carries
the campaigns panel: pick a window, a percent or a fixed amount, and the
packages it applies to. Five kinds can be targeted, so a sale can cover the
whole catalog rather than only subscriptions: `flipdesk_plan`, `buyer_plan`,
`grade_tier`, `credit_pack`, `action_pack`. Writes need super_admin plus a fresh
MFA step-up, like the plan editor beside it, because this moves money.

Three things about it that are the contract rather than the UI:

- **A campaign is not real until its Stripe coupon exists.** Every write path
  mints or re-mints the coupon and records the id on the row; a row with a null
  `stripe_coupon_id` is invisible to the public read policy (00778) AND refused
  by the resolver on both sides. A discount the card advertises and checkout
  declines is the failure the whole feature is built to avoid.
- **The algorithm exists twice and is pinned by vectors on each side** --
  `src/lib/discounts.ts` for the browser, `lib/discount-campaigns.ts` for the
  edge. They cannot share a file (one imports nothing Deno-shaped, the other
  nothing browser-shaped), so a test on each side holds them to the same answers.
- **It fails to LIST price.** A read error resolves to no campaigns, which
  charges and shows full price. That is the safe direction.

At checkout the campaign takes the single Stripe coupon slot **last**: referral
and drip coupons were promised to one person and win, a site-wide sale is
offered to everybody and only applies when none of them wanted the slot. The
campaign is part of the Checkout idempotency key, or Stripe's 24h session replay
would hand a pre-sale session to someone who opened the page before the sale
began and charge them list price.

The prerendered `/pricing` HTML still shows list price, because it is built at
deploy time; `<SaleBanner>` and `<SalePrice>` fill in once the SPA hydrates.

To end a sale early: turn it off in the panel, or
`update public.discount_campaigns set enabled = false where id = '...';`.

### 9a-bis. A code only some customers get

A **Stripe coupon / promotion code** is still the mechanism for a targeted
offer, and it is wired: every FlipDesk Checkout Session sets
`allow_promotion_codes: true` (`payments.ts`), and referral / drip coupons are
pre-applied through `sessionParams.discounts`.

1. **Stripe Dashboard → Products → Coupons → Create** (e.g. `20% off, 3 months`,
   or a fixed amount). Optionally create a **promotion code** (a customer-facing
   string like `LAUNCH20`) tied to that coupon.
2. **Hand out the code** — customers enter it in the Checkout promo-code box
   (works today, zero code change), **or** pre-apply it for one-click conversion
   the way referral coupons are (set `discounts` and drop `allow_promotion_codes`
   for that session — Stripe rejects both together; see `payments.ts` ~L419-447).
3. Base Price and every displayed price **stay put**; the discount only hits the
   actual charge, and no pricing surface mentions it.

Neither mechanism edits a constant or needs a redeploy. The split is simply who
the offer is for: a campaign is advertised on the pricing page to everyone, a
promotion code is not advertised at all.

### 9b. Change a base price permanently

A base price change must move **all four** in one coordinated release, or displays
and charges diverge:

1. **Stripe:** create a **new Price** on the existing Product (Prices are
   immutable — you never edit an existing one). Copy its `price_...` ID.
2. **Billing (DB or env):** point `pricing_plans.stripe_price_monthly` /
   `_yearly` at the new Price ID (deploy-free via admin), or the
   `STRIPE_PRICE_FLIPDESK_*` env fallback.
3. **DB display:** update `pricing_plans.price_monthly_cents` /
   `price_yearly_cents` to match (the in-app comparison number).
4. **Compiled constant + doc:** update `FLIPDESK_PLANS.priceMonthlyCents` in
   `src/lib/constants.ts` (the public page + picker + landing) **and the tier
   table in §1 of this doc**, then **redeploy the frontend**.

Migration/regenerate note: `scripts/setup-stripe-pricing.mjs` (US-203) generates
the Stripe catalog from the same numbers — keep it in sync. Existing subscribers
keep their grandfathered Price until they change plans; Stripe does not
retroactively reprice them.

---

## Appendix A — Competitor benchmarks (context for future tweaks)

Captured at design time so future pricing changes have a reference point.

### Cross-listing / reseller tools

| Tool | Tiers |
|---|---|
| **List Perfectly** | $29 / $49 / $69 / $99 |
| **Vendoo** | $14.99 / $29.99 / $59.99 / $99.99 / $149.99 |
| **Crosslist** | ~$17 / $30 / $40 (listing-volume tiers; no EU customers) |
| **Nifty** | ~$25/mo for the Poshmark engagement tier |

Every one of them prices by **listing volume**, which is why US-2483 pulled our
listing allowance onto the plan card as its own line. A shopper comparing
ladders needs the same axis on both sides.

Our FlipDesk ladder ($0 / $29 / $59 / $99) deliberately undercuts the top of
both ladders while adding a genuine free tier and bundled grading neither
competitor offers. Two more differences worth stating, since they are what a
switching seller actually asks about:

- **Poshmark engagement** (share / follow / send offer) is included on paid
  FlipDesk tiers rather than sold as a separate ~$25/mo product, and it runs in
  the seller's own browser rather than from our servers holding their Poshmark
  session — see [[adr-no-server-side-marketplace-automation]].
- **Vinted** is covered on 22 country domains. Crosslist does not serve EU
  customers at all, so this is coverage a seller cannot get by switching to the
  cheaper ladder.

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
| Action Credit packs | `ACTION_CREDIT_PACKS` | `STRIPE_PRICE_ACTION_CREDITS_*` on the edge; NOT generated by the setup script |
| Sale campaigns | none; `public.discount_campaigns` rows (00778) | a Stripe coupon minted per campaign |
| Upgrade thresholds | `SOFT_WARN_PCT` in `plan-gate.ts` (server, authoritative); bare `0.8` in the two usage meters | — |
| Price IDs | **never client-side.** `pricing_plans` rows over `Deno.env STRIPE_PRICE_*`, resolved in `pricing-config.ts` / `payments.ts` | output of `scripts/setup-stripe-pricing.mjs` |

---

## The three-way mirror (US-2055)

Pricing is defined in three places that must move together:

1. **This note** — the canonical model (US-200).
2. **`src/lib/constants.ts`** — the machine-readable mirror: `FLIPDESK_PLANS`
   (re-exported as `PLAN_MATRIX`), `BUYER_PLANS`, `GRADETHREAD_TIERS`,
   `CREDIT_PACKS`, `ACTION_CREDIT_PACKS`. Prices and limits only — **no Stripe
   price ids**, which the browser never sees.
3. **The Stripe catalog** — generated from the same numbers by
   `scripts/setup-stripe-pricing.mjs` (US-203).

**Any change to the constants must update this note in the same commit, and
vice-versa.** That rule is why this note is `source_of_truth: code` with
`code_refs` on both: the drift guard watches them.

### Verified against code 2026-07-19

Every published figure was checked against `constants.ts`, and **they all match**:

| Family | Doc | Code (cents) |
|---|---|---|
| FlipDesk | $0 / $29 / $59 / $99 (annual ×10) | 0, 2900/29000, 5900/59000, 9900/99000 |
| Buyer | Guard $8/$80, Connoisseur $19/$190 | 800/8000, 1900/19000 |
| Grades | Standard $2.99, Premium $7.99, Express $12.99 | 299, 799, 1299 |
| Credit packs | 10/$24.99, 25/$59.99, 50/$109.99, 100/$199.99 | 2499, 5999, 10999, 19999 |

Worth stating plainly because most of this epic has found the opposite: the
same-PR mirror rule was actually honoured here. This is the one document set that
had not drifted.

### Two things that read wrong if you skim

- **`-1` means unlimited/all, not "unset".** `activeListingCap: -1` and
  `marketplacesCap: -1` are sentinels. Treating them as missing data silently
  downgrades Business-tier accounts.
- **The "marketplaces" cap counts API connections**, not channels a seller can
  reach. Browser-extension marketplaces (Poshmark, Mercari, Grailed, Vinted) consume no
  connection. `MARKETPLACE_TIER` (US-718) is the source of truth for that split.

## ⚠️ Unresolved: the per-grade AI cost is stated three ways

Flagged 2026-07-19, **not** harmonised — the acceptance criterion for US-2055 is
explicit that disagreeing figures are a finding, not a formatting problem, and
resolving this needs someone who knows the deployed model mix and token volume.

| Source | "Realistic" AI cost per Standard grade |
|---|--:|
| [[subscription-unit-economics]] — cost table | **~$0.03** |
| [[subscription-unit-economics]] — prose, same doc | **~$0.05** |
| [[ai-profitability]] — per-surface table | **~$0.02** |

Both documents are dated 2026-07-02, and the first disagrees with *itself*
between its table and its prose.

**Impact: none on any decision so far.** The Standard grade sells for $2.99, so
the margin conclusion (>90%, ">99%" in the AI report) holds at all three figures.
The numbers matter for the AI-action cap sizing, where the blended action cost
does the work — and that is stated consistently at ~$0.02.

**To resolve:** pick one figure, say which model mix and photo count it assumes,
and make the other two link here rather than restate it.

## Related

- [[subscription-unit-economics]] — margin per tier at these prices
- [[ai-profitability]] — the cost side, per AI surface
- [[passport-forecast]] — volume assumptions that ride on these prices
- [[INDEX]]

## Creator affiliate commission (US-9212)

Decided 2026-09-01, recorded in [[adr-referral-cash-payout]] section 6: reseller
creators are paid **cash** on the subscription revenue of accounts they refer.
**User referral is unchanged and stays credits-only** — none of this applies to
it.

| Term | Value | Why |
|---|---|---|
| Commission | **25%** of the referred account's subscription revenue | The midpoint of the 20-30 band the founder set. |
| Band | 20% to 30% | A per-creator override is clamped into it; a config typo can neither pay 300% nor pay nothing. |
| Window | **12 months** from that account's subscription start | "First-year subscription revenue" in the decision. |
| Cap | **$250** per referred account | Covers Starter ($348/yr → $87) and Pro ($708/yr → $177) in full, and caps Business, whose first year at 25% would otherwise be $297. |
| Hold | **60 days** after the invoice is paid | See below. |
| Payout | Monthly, batched, behind `affiliate_payout_config.mode` which ships `off` | Mirrors the consignor pattern; nothing moves until an admin turns it on. |
| Gate | A certified tax profile (`affiliate_tax_profiles`) must exist | ADR section 4.5: no cash before W-9 capture. `planPayout` refuses without one, and refuses by default. |

**The terms a creator accepts, and the version recorded against each
acceptance:** [[creator-affiliate-terms]]. A creator is admitted by an operator
(`POST /api/admin/growth/affiliate/creators/:id/approve`); accepting the terms
is an application, and `affiliate_accounts.program` stays `user` until then.

**Machine-readable mirrors:** `CREATOR_AFFILIATE` in `src/lib/constants.ts` and
`DEFAULT_AFFILIATE_PAYOUT_CONFIG` in
`services/edge-functions/src/lib/affiliate-payout-math.ts`. Any change to these
numbers must change all three in the same commit;
`src/test/creator-affiliate.test.ts` fails otherwise.

> [!warning] The hold is not "the refund window", because there isn't one
> US-9212's acceptance criteria say commissions are paid "after the refund
> window". This document settled on 2026-08-02 that GradeThread has **no
> subscription refund window**: fees are non-refundable and refunds are manual
> admin actions. The only real window in the policy is the **60-day
> billing-error window** in `refund.tsx` section 3, so that is what the hold is
> set to. Paying a commission on an invoice still inside the window it can be
> reversed in is how an affiliate ledger goes negative.

## 2026-09-04: constants.ts moved, but only the grade-score colours

`src/lib/constants.ts` changed in 19d62b6b4 (US-3010). The whole diff is the
four grade-score colour helpers -- `getScoreColor`, `getScoreBorderColor`,
`getProgressColor`, `getTierBadgeClasses` -- dropping from four bands to
three and moving the green boundary from `> 7` to `>= 7`. That contract lives
in [[brand-design-system]] section 3B, which the same commit amended.

Nothing this note asserts is in that diff. Re-read to confirm rather than
assumed, which is the only reason the date below moved.

# Discount campaigns (US-3299)

Operator-scheduled, time-boxed discounts across every GradeThread package, honored
at Stripe checkout and shown on every pricing surface on the web. iOS and Android
are out of scope.

## Problem

There is no way to run a sale. Prices live in `pricing_plans` (FlipDesk tiers,
operator-editable since US-587) and in compiled constants (`GRADETHREAD_TIERS`,
`CREDIT_PACKS`, `ACTION_CREDIT_PACKS`, `BUYER_PLANS`). Discounting today means
editing the price itself, which loses the original, gives the visitor no reason to
buy now, and has to be undone by hand when the promotion ends.

Stripe already carries three kinds of per-user coupon: referral (US-1070), drip
incentive, and reward milestone (US-1853), applied in `payments.ts` as
`sessionParams.discounts = [{ coupon }]`. A sale is the same mechanism aimed at
everyone instead of one person.

## Scope

In scope: the `discount_campaigns` table, the admin editor, Stripe coupon
lifecycle, discount resolution shared by web and edge, and the price display on
every web surface that quotes a price.

Out of scope: iOS, Android, per-user targeting, promo codes the visitor types
(`allow_promotion_codes` already covers that), stacking two campaigns on one
purchase, and currencies other than USD.

## Data model

### `discount_campaigns` (migration 00778)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `name` | text not null | operator-facing, e.g. "Fall sale" |
| `description` | text | shown on the sale banner; nullable |
| `discount_type` | text not null | `percent` or `amount` |
| `percent_off` | numeric(5,2) | 0.01 to 100, null unless `percent` |
| `amount_off_cents` | integer | greater than 0, null unless `amount` |
| `starts_at` | timestamptz not null | |
| `ends_at` | timestamptz not null | check `ends_at > starts_at` |
| `enabled` | boolean not null default true | operator kill switch |
| `targets` | jsonb not null default `[]` | see below |
| `applies_to_all` | boolean not null default false | ignores `targets` when true |
| `stripe_coupon_id` | text | minted on save; null until Stripe succeeds |
| `stripe_sync_error` | text | last mint failure, surfaced in admin |
| `revision` | integer not null default 0 | bumped on every money-affecting edit |
| `created_at` / `updated_at` | timestamptz | `updated_at` via the existing trigger |
| `created_by` / `updated_by` | uuid | admin user id |

Exactly one of `percent_off` / `amount_off_cents` is non-null (check constraint).

Status is derived, never stored. `enabled AND now >= starts_at AND now < ends_at`
is live; `enabled AND now < starts_at` is scheduled; otherwise expired or disabled.
A window opens and closes on its own with no cron and no scheduled job.

### `targets` entries

    [{ "kind": "flipdesk_plan", "key": "pro", "interval": "monthly" },
     { "kind": "grade_tier",    "key": "premium" },
     { "kind": "credit_pack",   "key": "25" },
     { "kind": "action_pack",   "key": "150" },
     { "kind": "buyer_plan",    "key": "guard", "interval": "yearly" }]

`kind` is one of `flipdesk_plan`, `buyer_plan`, `grade_tier`, `credit_pack`,
`action_pack`. `interval` (`monthly` or `yearly`) applies only to the two
subscription kinds; omitting it means both. `applies_to_all: true` matches every
kind and key, which is the "20% off everything" case from the brief.

### RLS

- `select` to `anon` and `authenticated` where **all four** of `enabled`,
  `stripe_coupon_id is not null`, `starts_at <= now()` and `ends_at > now()` hold.
  Pricing surfaces are public, so the read has to work logged out, and the row
  carries no user data. The policy is narrower than the plan called for, on two
  counts, each with its own failure: exposing a SCHEDULED campaign would let a
  visitor read next month's unannounced sale out of the network tab and simply
  wait for it, and exposing an UNSYNCED one would price a card at a discount
  checkout then refuses. `discount-guards_test.ts` pins all four clauses.
- No `insert` / `update` / `delete` policy, and writes revoked from `anon` and
  `authenticated`. Everything goes through the service-role client in
  `admin-discounts.ts`, which is how `pricing_plans` already works.
- **No rls-guard entry is needed, verified rather than assumed.** The plan said to
  register it in `SERVICE_ROLE_ONLY`. That list exists for tables with NO policy
  at all, so a new zero-policy table fails until a human classifies it. This table
  has a public read policy and no tenant column, so `rls-guard_test.ts` neither
  classifies nor flags it; run 2026-09-09, 9 passed. Adding an entry would have
  been a claim the guard does not make.

The migration follows the US-1108 triple: idempotent SQL, `EXPECTED_SCHEMA_VERSION`
bumped to `00778` in the same commit, self-record footer. Per the standing owner
rule, the commit carrying it is not pushed until the owner says so.

## Resolution

One algorithm, written twice against the same test vectors: `src/lib/discounts.ts`
for the browser and `services/edge-functions/src/lib/discount-campaigns.ts` for the
edge. Both export the same shape.

    resolveDiscount(campaigns, target, originalCents, nowMs)
      -> { campaign, originalCents, finalCents, savedCents, label } | null

Rules, in order:

1. Keep campaigns where `enabled` and `starts_at <= now < ends_at`.
2. Keep those matching the target: `applies_to_all`, or a `targets` entry whose
   `kind` and `key` match and whose `interval` is absent or equal.
3. Skip when `originalCents <= 0`. No "20% off $0" badge on a free tier.
4. Compute `finalCents`. Percent: `round(original * (100 - pct) / 100)`.
   Amount: `max(0, original - amount_off_cents)`. Floored at 0, never negative.
5. Overlaps: the largest `savedCents` wins. Tie-break on the later `starts_at` (the
   newer sale), then on `id` so the result is deterministic. The sequential windows
   in the brief never overlap, but two campaigns aimed at the same package must not
   produce a different answer on two page loads.

`label` is "20% off" or "$5 off" plus "through Oct 31" derived from `ends_at`.

## Stripe

One Stripe coupon per campaign, minted by the edge when the campaign is saved.

- `percent_off`, or `amount_off` plus `currency: "usd"`, from the row.
- `duration: "once"`. A subscriber who signs up during the sale gets the discount
  on their first invoice only (first month, or first year on an annual plan), then
  pays full price. Owner decision, 2026-09-09.
- `redeem_by` set to `ends_at`. Stripe itself refuses the coupon after the window,
  so an expired campaign cannot be redeemed even if a stale client sends it.
- `metadata: { campaign_id, source: "discount_campaign" }`.
- Idempotency key `discount-campaign:{id}:{revision}`, so a retried save does not
  litter Stripe with duplicate live coupons.

Stripe coupons are immutable except for `name` and `metadata`. Any edit to
`discount_type`, `percent_off`, `amount_off_cents`, `starts_at` or `ends_at`
therefore deletes the old coupon and mints a new one, bumping `revision`. A mint
failure writes `stripe_sync_error` and leaves `stripe_coupon_id` null; the admin
row shows a red "not synced" badge and the campaign is not applied at checkout.
Display is gated on a successful sync too, because a discount shown on a card and
refused at checkout is worse than no sale at all.

### Checkout wiring

Stripe accepts exactly one coupon per Checkout Session, and rejects `discounts`
alongside `allow_promotion_codes`. `payments.ts` already encodes a precedence
chain; the campaign joins it last:

> referral coupon, then drip incentive, then reward milestone, then discount campaign

A personal reward was promised to that specific person and is usually the larger
number, so it outranks a site-wide sale. Where a campaign does apply, the existing
`delete sessionParams.allow_promotion_codes` line applies unchanged.

Six checkout entry points get the lookup:

| route | target |
|---|---|
| `POST /flipdesk/subscribe` | `flipdesk_plan` plus interval |
| `POST /buyer/subscribe` | `buyer_plan` plus interval |
| `POST /gradethread/credit-pack` | `credit_pack` |
| `POST /action-credits/checkout` | `action_pack` |
| `perGradeCheckout` (`/gradethread/per-grade`, `/checkout-session`) | `grade_tier` |

`POST /api-overage/checkout` is deliberately excluded: it bills usage already
consumed, not a package a visitor chooses to buy.

**`GET /catalog` was in this table and is not wired.** The plan was to return
live campaigns there so a client could price without a second round trip. The
browser reads `discount_campaigns` directly instead, through the anon RLS policy:
that works logged out, which is the case that matters most (the public pricing
page has no session), and it keeps a hot catalog endpoint from growing a second
query. Revisit only if a client appears that cannot reach Supabase directly.

The campaign id and the discounted total go into the session `metadata`, so the
webhook and the revenue reports can attribute a sale to the campaign that made it.

## Admin

`/admin/pricing` gains a second tab, Discounts, beside the existing plan editor.
Same page, because a sale is a pricing decision and the operator needs the list
price in front of them while setting one.

- Table: name, discount, targets summary ("All packages" or "3 packages"), window,
  and a status badge (Live / Scheduled / Expired / Disabled / Not synced). Sorted
  live first, then scheduled by start date, then expired.
- Create and edit dialog: name, percent-or-amount toggle, value, start and end
  date-times, an "All packages" switch, and a checkbox grid of every package
  grouped by kind when that switch is off.
- Live preview inside the dialog. For each ticked package, "Starter monthly $29.00
  becomes $23.20". This is the check that catches a fat-fingered `200` in the
  percent field before it reaches Stripe.
- Overlap warning: a non-blocking warning when the window and targets intersect a
  campaign that already exists, naming it and stating which one wins.
- Enable and disable toggle, plus archive. Deleting a campaign also deletes its
  Stripe coupon.

Edge route `services/edge-functions/src/routes/admin-discounts.ts`, mounted at
`/api/admin/discounts`, guarded by `requireScope("ops:write")` plus `requireStepUp`.
That is the same super-admin and fresh-MFA gate `admin-pricing.ts` uses, because
this moves money. Every mutation writes `admin_audit_log`.

## Display

`useActiveDiscounts()` (TanStack Query, 5-minute stale, `[]` placeholder) reads the
anon-visible rows. A failed read returns an empty list, so a pricing page never
renders empty or wrong. It renders list price, which is the safe direction to be
wrong in.

`<SalePrice originalCents target />` renders the list price struck through in muted
text beside the discounted price at full size, with a small badge carrying the
label. With no active campaign it renders the plain price and nothing else, so it
is a drop-in for the existing `dollars(...)` calls.

Surfaces wired:

- `src/pages/marketing/pricing.tsx`, all four sections, plus a dismissible banner
  at the top of the page while any campaign is live
- `src/pages/landing.tsx`
- `src/pages/billing.tsx` and `src/pages/buyer/billing.tsx`
- `src/components/billing/flipdesk-plan-picker-dialog.tsx`
- `src/components/billing/flipdesk-plan-comparison.tsx`
- `src/components/billing/credit-pack-dialog.tsx`
- `src/components/billing/action-credit-dialog.tsx`
- `src/components/billing/upgrade-required-dialog.tsx`
- `src/components/submission/grade-pricing-summary.tsx`

JSON-LD and prerendered HTML keep list price. `scripts/prerender.mjs` runs at build
time and cannot know about a campaign created afterwards. A crawler and the ads
therefore quote list price while the live SPA shows the sale, the same split every
other live-data surface already has. Changing that needs the offer markup to move
to an edge function, which is out of scope here and noted in the story.

Design constraints: no gradient on the badge and no colored left border on the
banner, both of which are `ui:check` enforced tells. The badge is a filled
brand-red pill; the strikethrough is `text-muted-foreground line-through`.

## Testing

- `src/lib/__tests__/discounts.test.ts`: matching by kind, key and interval;
  `applies_to_all`; the `originalCents <= 0` skip; percent and amount math;
  rounding; the floor at zero; boundary behavior exactly at `starts_at` and
  `ends_at`; and deterministic overlap resolution.
- `services/edge-functions/src/tests/discount-campaigns_test.ts`: the same vectors
  against the edge copy, so the two implementations cannot drift.
- `services/edge-functions/src/tests/tenant-isolation_test.ts`: a case per the skill
  rule confirming the new admin route rejects a non-admin.
- A checkout test asserting the precedence chain. A user holding a reward coupon
  during a live campaign gets the reward, and `allow_promotion_codes` is absent
  whenever `discounts` is set.
- A migration test that the table applies idempotently on a throwaway local stack.

**What shipped instead of the behavioural tenant-isolation case.** That case
would have been ceremony: `discount_campaigns` is a global operator table with no
tenant column, so there is no cross-tenant read to attempt, and the admin gate is
already covered by `rbac-scopes_test.ts` and `admin-scope-coverage_test.ts`.
`services/edge-functions/src/tests/discount-guards_test.ts` pins the properties a
source scan CAN establish and that a plausible bad edit would break: every
mutation behind super_admin + step-up, every mutation audited, the public read
policy still narrowed on all four clauses, writes still revoked from anon, the
campaign still yielding to a per-user coupon, `allow_promotion_codes` deleted
wherever `discounts` is set, and the campaign folded into every idempotency key.
Each was negative-verified by sabotage.

## Risks

- A campaign displayed but refused at checkout. Mitigated by gating both display
  and checkout on a non-null `stripe_coupon_id`.
- Editing a live campaign mid-window deletes a coupon that in-flight Checkout
  Sessions may reference, and those sessions fail. The dialog warns before saving
  an edit to a live campaign and offers "end this one and start a new one" instead.
- Annual plans on `duration: "once"` discount a full year, a much larger dollar
  amount than a monthly plan. The admin preview shows the annual saving in dollars
  for exactly this reason.

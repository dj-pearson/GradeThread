# Action Credits: prepaid top-ups for metered actions

Date: 2026-09-07
Status: approved design, not yet built

## The problem

A FlipDesk seller on Starter gets 200 AI actions a month. When they run out on
the 20th, `services/edge-functions/src/lib/ai-quota.ts:116` returns a 429 that
says the allowance resets next month. Their only options are to pay $59/mo for
Pro or stop working for ten days. Both are bad outcomes: one is a forced
upgrade they may not need, the other is ten days of a paying customer unable to
use the product they are paying for.

The same wall exists on connector actions (`connector-allowance.ts:93`).

Three prepaid wallets already exist in this codebase and none of them cover
this:

| Wallet | Storage | Buys | Surfaces |
|---|---|---|---|
| Grade credits | `users.grade_credit_balance` + `grade_credit_transactions` | Standard/Premium/Express grades | Stripe, StoreKit, Play |
| API overage | `api_credit_wallet` + `api_credit_transactions` (00415) | `/api/v1` calls past a key's monthly quota | Stripe only |
| Buyer meters | `buyer_meter_usage` (00413) | Nothing. Monthly allowance only; the purchasable fallback (US-1801) was never built | none |

## The decision

One new wallet, **Action Credits**, that any metered action can draw from when
its monthly allowance is empty. Not one pack per meter.

The reason is App Store Connect. Every new consumable SKU needs manual setup
plus review. A per-meter design means new Stripe products, new App Store
consumables and new Play products every time a metered feature ships. One
shared wallet means the SKUs are created once and a new metered feature is one
row in a spend-rate table.

Grade credits stay a separate currency. They are live on Stripe and the App
Store with a price anchored to $2.99 per Standard grade; folding them in would
mean re-denominating a shipped ledger holding real money. Not worth it.

### Naming

"Action Credits". Product ids `com.gradethread.actions.{50,150,400,1000}`.
These are permanent once created in App Store Connect and Play Console.

## The packs

Never expire. One-time purchase, not a subscription.

| Pack | Credits | Price (USD) | Per credit |
|---|---|---|---|
| Top-up | 50 | $4.99 | $0.0998 |
| Standard | 150 | $13.99 | $0.0933 |
| Bulk | 400 | $34.99 | $0.0875 |
| Power | 1,000 | $79.99 | $0.0800 |

### Why these prices

Each plan implies a per-AI-action rate: Starter $29 / 200 = $0.145, Pro $59 /
750 = $0.079, Business $99 / 2000 = $0.050.

Every pack is priced at or above Pro's implied rate and well above Business's.
That keeps the ladder monotonic in both directions:

- Small shortfall: a Starter seller needing 50 more actions pays $4.99, not
  +$30/mo. Top-up wins, which is the whole point.
- Large shortfall: a Starter seller needing 400 more pays $34.99 for the Bulk
  pack against +$30/mo for Pro, which brings 550 more actions every month plus
  1,000 listings, 30 grades and AutoLister. Upgrading wins.
- 1,000 credits at $79.99 against Business at $99/mo for 2,000 recurring
  actions plus seats, API and reconciliation. Upgrading wins.

If a pack were priced below the next tier's implied rate, buying packs would
beat upgrading on the pure metric and the plan ladder would invert. It does not
here, and any future re-price must re-check this.

Every price is a valid App Store / Play price point.

### Spend rates

v1 is flat: **1 credit = 1 action**, for both AI actions and connector actions.
That is a sentence a seller can hold in their head.

The rate lives in a table (`ACTION_CREDIT_COSTS`) rather than being hardcoded
as 1, so a future expensive action (a video grade, a multi-image authenticity
pass) can cost 3 or 5 without a new SKU, a new Stripe product, or an App Store
review.

## Scope

**In v1:**

- AI actions: every route that goes through `withAiAction`.
- Connector actions: the Claude connector's monthly write allowance.

**Explicitly out, with reasons:**

- **Grade credits.** Already a working, priced, shipped wallet. Leave it alone.
- **Active listing slots.** That is capacity, not consumption. A credit that
  buys a slot has to expire when the slot is released or the month ends, which
  is a different product with different accounting. Sellers who need more slots
  should upgrade; that is what the tier is for.
- **Buyer meters** (authenticity credits, video grades, extension checks).
  Phase 2. They use a separate RPC (`reserve_buyer_meter`) against a separate
  table, so wiring them is its own story. Doing so closes US-1801.
- **Auto-recharge.** A saved-card auto-top-up when the balance hits zero works
  on Stripe and is impossible for a StoreKit consumable. Shipping it would mean
  a retention feature that web customers get and iPhone customers do not, and
  an iPhone seller who ran dry mid-batch would have no equivalent. Revisit only
  with a deliberate answer for mobile.
- **Shipping labels.** Passed through at eBay's rate with no markup (US-3011).
  Not metered, not a credit.

## Architecture

### 1. Database (one migration)

A near-clone of `supabase/migrations/00415_api_overage_credits.sql`, which is
the proven shape for this exact problem.

```
public.action_credit_wallet
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
  balance     integer NOT NULL DEFAULT 0 CHECK (balance >= 0)
  updated_at  timestamptz NOT NULL DEFAULT now()

public.action_credit_transactions          -- append-only
  id                 uuid PK
  user_id            uuid NOT NULL
  delta              integer NOT NULL
  reason             text NOT NULL         -- 'purchase' | 'ai_action_debit' | 'connector_debit' | 'refund' | 'admin_grant'
  meter              text                  -- 'ai_action' | 'connector_action' | NULL on grants
  balance_after      integer NOT NULL
  stripe_session_id  text                  -- unique when present (grant idempotency)
  appstore_transaction_id text              -- unique when present (StoreKit idempotency)
  play_purchase_token text                  -- unique when present (Play idempotency)
  notes              text
  created_at         timestamptz NOT NULL DEFAULT now()
```

RLS: owner reads own rows, service-role writes. The wallet lives in its own
table rather than a `users` column specifically so it never touches the
`users` self-update guard from 00526 (see the frozen-column memory).

Functions:

- `grant_action_credits(p_user_id, p_credits, p_reason, p_session_id, p_notes)`
  idempotent on `stripe_session_id`, returns the new balance. Mirrors
  `grant_api_credits`.
- `debit_action_credits(p_user_id, p_credits, p_meter, p_notes)`: a `FOR UPDATE`
  debit, returns the new balance or `-1` when short. Mirrors
  `debit_api_credits`.
- `refund_action_credits(p_user_id, p_credits, p_meter, p_notes)` puts a
  reserved credit back when the work it paid for failed.

The ledger obeys the same running-sum invariant as
`grade_credit_transactions`: over the complete ledger ordered oldest-first,
the cumulative sum of `delta` equals `balance_after` on every row.
`services/edge-functions/src/lib/credit-ledger.ts` already proves that shape
and should be reused, not re-implemented.

### 2. The reserve path (the important part)

`reserve_ai_action(p_user_id, p_limit)` (migration 00087) is the single atomic
enforcement point for AI actions. It takes `FOR UPDATE` on the `users` row,
applies the lazy month rollover, and either increments the counter or refuses.

Extend it in place so **every caller inherits the fallback with no route
changes at all**:

1. Allowance has room → increment `ai_actions_used_this_month`, source =
   `allowance`.
2. Allowance empty → `debit_action_credits(..., 'ai_action')` → source =
   `credits`.
3. Both empty → refuse, source = `exhausted`.

Lock ordering is `users` then `action_credit_wallet`, in that order,
everywhere. Any code that takes both in the other order can deadlock. Write
this in the migration comment.

The return type has to change from `boolean` to a source string. Keep the
old two-argument `boolean` signature as a thin wrapper that delegates, so a
mid-deploy edge container running the previous code does not break.

Callers that need to know: `withAiAction` in
`services/edge-functions/src/lib/ai-metering.ts:120`. It returns the source so
the refund goes to the right place. If credits paid and the model call throws,
the credit goes back to the wallet, not to the monthly counter. Getting this
wrong hands out free actions in one direction and steals paid ones in the
other.

Because `withAiAction` is the shared contract, AutoLister, Scout, Prospect, the
composer and every other metered route get top-ups without being edited. That
is the design's main payoff.

### 3. Connector actions

`connector-allowance.ts:64` counts `mcp_tool_calls` rows for the month rather
than reading a counter column, so there is no RPC to extend. The fallback is an
explicit call: when `checkConnectorAllowance` says no because the allowance is
spent (not because the plan excludes the connector), attempt
`debit_action_credits(..., 'connector_action')` and allow the call if it
succeeds.

Two distinct refusals must stay distinct. "Your plan does not include the
connector" (Free/Starter, `limit === 0`) is not a top-up opportunity and must
never drain a wallet. Only "you used all N this month" is.

### 4. Interaction rules

These are the cases that decide whether the feature is trustworthy.

- **A self-imposed cap is not a top-up prompt.** `users.ai_action_limit` lets a
  seller cap themselves below their plan (`effectiveAiCap` in the edge's
  `plan-gate.ts`, `effectiveAiLimit` in `src/lib/ai-limit.ts`). Hitting *that*
  must NOT drain purchased credits. It exists to stop runaway spend, so
  silently spending money the moment it bites is the opposite of what it is
  for. Refuse with "you set your own limit of N. Raise it in Settings."
  Credits only cover hitting the *plan* cap.

  This needs care in the RPC. `checkQuota` already collapses the two into one
  number (`min(planLimit, userLimit)`) before it reaches `reserve_ai_action`,
  so the function cannot tell which cap bit. Pass a `p_allow_credits boolean`
  that the caller computes as `userLimit IS NULL OR userLimit >= planLimit`,
  rather than trying to reconstruct it inside the function.
- **Unlimited never touches the wallet.** `limit === -1` (Business, and the
  `super_admin` short-circuit) short-circuits before any debit.
- **Prepaid credits survive a failing card.** `effectivePlanFor` drops a
  past-due account to Free allowances. Credits already paid for keep working.
  A seller whose card is bouncing can still finish the listings they already
  paid to generate. This is deliberate.
- **Workspace members spend the owner's wallet.** AI actions are already billed
  to `workspaceOwnerId`; the wallet keys on the same id. Consistent with US-268.
- **Refunds claw back.** `charge.refunded` on an Action Credits purchase debits
  the granted credits, mirroring the `api_overage` branch at
  `webhooks.ts:2091`. A balance that would go negative clamps at zero and logs.

### 5. Edge service

New `services/edge-functions/src/lib/action-credits.ts`:

- `ACTION_CREDIT_PACKS`: the four packs, each with `credits`, `priceCents` and
  `priceEnv` (a `STRIPE_PRICE_ACTION_CREDITS_*` env var name). Same shape as
  `lib/api-overage-packs.ts`.
- `ACTION_CREDIT_COSTS`: meter to credits. All `1` in v1.
- `spendActionCredits` / `refundActionCredits` wrappers over the RPCs.

New route `POST /api/payments/action-credits/checkout`, cloned from the
`api-overage` handler at `routes/payments.ts:1065`: one-time Checkout, metadata
`product: "action_credits"`, idempotency key, `automatic_tax`, promo codes on.

Webhook: a fourth branch beside `credit_pack` / `per_grade` / `api_overage` at
`routes/webhooks.ts:1497`, calling `grant_action_credits` with the session id
for idempotency.

`GET /api/payments/billing-summary` gains an `action_credits` block:
`{ balance, low }` where `low` is true under 20. The client uses it for the
meter and the low-balance nudge.

`GET /api/payments/ledger` gains the action-credit ledger alongside the grade
one.

### 6. Web

- `src/lib/constants.ts`: `ACTION_CREDIT_PACKS` for display. Prices only, never
  price ids; the file already carries a warning about that and it applies here.
- `src/components/billing/action-credit-dialog.tsx`, modeled on
  `credit-pack-dialog.tsx`, including the per-credit and savings maths.
- **The 429 becomes an offer.** Today an exhausted allowance surfaces as an
  error toast. It should surface as "You are out of AI actions. Top up from
  $4.99, or upgrade to Pro." with both buttons. This is where the feature
  actually earns money, and the plumbing without this UI is worthless.
- `usage-meter.tsx` shows the credit balance beside the monthly bar.
- Billing page: balance, buy button, and the transaction history.

### 7. iOS

`lib/appstore/products.ts` is canonical; `IAPProduct.swift` mirrors it; the
drift test `iap-catalog-drift_test.ts` fails the build when they diverge.

The `ProductMapping` union needs a new case. Today `{ kind: "consumable";
credits }` means grade credits, and reusing it would grant the wrong currency —
a fail-open bug that hands out grades for an action-credit purchase. Add
`{ kind: "action_credits"; actionCredits: number }`, keep `classifyProduct`
fail-closed, bump `CATALOG_VERSION`, extend `serializeCatalog` and the Swift
`IAPKind` enum together.

The StoreKit grant path routes the new kind to `grant_action_credits`, keyed on
the App Store transaction id for idempotency (the same job
`appstore_processed_transactions` does today).

Paywall gets a third section: subscriptions, grade credits, action credits.
The existing `renewalDisclosure` already says "One-time purchase · credits
never expire", which is accurate for these.

### 8. Android

Same shape: four ids in the `CreditPacks.kt` pattern, `PlayProductType.INAPP`,
server grant keyed on the purchase token.

### 9. Operator steps (manual, cannot be automated)

1. Stripe: create four one-time prices; set `STRIPE_PRICE_ACTION_CREDITS_50`,
   `_150`, `_400`, `_1000` in Coolify.
2. App Store Connect: create four consumables with the exact ids above,
   matching price tiers, and submit with the next build.
3. Play Console: create four in-app products with the same ids.

Until step 1 is done the checkout route returns 503 "Pricing not configured",
which is the existing behavior for an unconfigured pack and is correct.

## Testing

- Migration applies idempotently on a fresh schema (`npm run verify:db`).
- Ledger invariant holds across purchase → debit → refund → purchase.
- `reserve_ai_action` under concurrency: two parallel batches against a wallet
  holding one credit spend exactly one, never two.
- Refund routing: credit-paid failure returns to the wallet; allowance-paid
  failure returns to the counter.
- The self-cap case refuses without touching the wallet.
- `limit === -1` never touches the wallet.
- Connector: `limit === 0` (plan excludes) never debits; allowance exhausted
  does.
- Webhook idempotency: a replayed `checkout.session.completed` grants once.
- Refund clawback clamps at zero.
- `iap-catalog-drift_test.ts` covers the four new ids.
- A tenant-isolation case: a member cannot read or spend another workspace's
  wallet.

## Rollout

The wallet is inert until the Stripe prices exist, so the migration and edge
code can ship before the operator steps. Nothing changes for a seller who never
buys a pack: an empty wallet means `debit_action_credits` returns `-1` and the
refusal is byte-for-byte what it is today.

## Open question, deferred on purpose

Whether a low-balance email alert belongs in the existing
`/api/payments/usage-alerts` machinery. The billing summary exposes `low` in
v1; the email is phase 2 with the buyer meters.

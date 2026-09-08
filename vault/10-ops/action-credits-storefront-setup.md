---
title: Turning on Action Credit sales in Stripe, App Store Connect and Play
aliases: [action credits setup, STRIPE_PRICE_ACTION_CREDITS, action credits operator]
type: runbook
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/action-credits.ts
  - services/edge-functions/src/lib/appstore/products.ts
  - services/edge-functions/src/lib/google-play/products.ts
reviewed: 2026-09-08
tags: [ops, billing, stripe, appstore, googleplay, runbook]
summary: The three console setups that turn the shipped Action Credit code from inert into revenue, in the order that keeps the app honest at every step.
---

# Turning on Action Credit sales

The code shipped with US-3138 is deliberately inert until this is done. Nothing
breaks in the meantime: the checkout route returns 503 "Pricing not configured",
the wallet stays empty, and `debit_action_credits` returns -1, so every refusal
is byte-for-byte what it was before. A seller who never buys a pack sees no
change at all.

What the product is, and why the prices are what they are:
[[action-credits]].

## Before anything: apply the migration

00763 must be applied and `NOTIFY pgrst, 'reload schema';` sent before the edge
is redeployed, because the boot guard expects the new version. See
[[migrations-process]] and the entry in `PENDING_MIGRATIONS.md`.

## 1. Stripe (unblocks the web, which is most of the revenue)

Four one-time prices. Recurring is wrong here: these never expire and are bought
when a seller runs short, not on a schedule.

| Pack | Price | Env var |
|---|---|---|
| 50 credits | $4.99 | `STRIPE_PRICE_ACTION_CREDITS_50` |
| 150 credits | $13.99 | `STRIPE_PRICE_ACTION_CREDITS_150` |
| 400 credits | $34.99 | `STRIPE_PRICE_ACTION_CREDITS_400` |
| 1,000 credits | $79.99 | `STRIPE_PRICE_ACTION_CREDITS_1000` |

1. Create one Stripe **Product** per pack (name it "50 Action Credits" and so
   on), each with a single **one-time** price at the amount above.
2. Copy each `price_...` id into the matching env var as a Coolify Team Shared
   Variable, alongside the existing `STRIPE_PRICE_API_OVERAGE_*` set.
3. Redeploy the edge.
4. Check: open Billing, click Buy Action Credits, and confirm the tiles show
   $4.99 / $13.99 / $34.99 / $79.99 and that a tile opens Stripe Checkout at the
   right amount. A 503 means an env var did not land.

**Test mode first.** The webhook grant is keyed on the Stripe session id, so a
test purchase in a test-mode account is safe to repeat; a live one is not
something to try twice.

## 2. App Store Connect

Four **consumable** in-app purchases. The ids are permanent once created and are
already compiled into both the server catalog and `IAPProduct.swift`, so a typo
is a purchase a buyer completes and is never credited for.

| Product ID | Reference price |
|---|---|
| `com.gradethread.actions.50` | $4.99 |
| `com.gradethread.actions.150` | $13.99 |
| `com.gradethread.actions.400` | $34.99 |
| `com.gradethread.actions.1000` | $79.99 |

Apple controls the real charged price through its price tiers; the amounts above
are the tier to pick and what the app shows offline.

These ship with the next build. Until the build is out, an iPhone seller can
still buy on the web, and the balance is the same wallet.

## 3. Google Play Console

Four **in-app products** (one-time, not subscriptions), under Monetize →
Products → In-app products.

| Product ID | Price |
|---|---|
| `action_credits_50` | $4.99 |
| `action_credits_150` | $13.99 |
| `action_credits_400` | $34.99 |
| `action_credits_1000` | $79.99 |

Play-style ids (lowercase, underscores), deliberately different from the iOS
bundle-style ones. `android-catalog-drift_test.ts` pins them against the server.

## What to check once each store is live

- **A purchase credits the right wallet.** Buy the 50-pack and confirm the
  Action Credit balance moves and the GRADE credit balance does not. These are
  two wallets, and crediting the wrong one is the failure mode the whole
  `action_credits` product kind exists to prevent.
- **A refund takes the credits back.** Refund the test purchase and confirm the
  balance drops. If the seller already spent them it clamps at zero and logs a
  shortfall, which is correct.
- **A replay grants once.** Resend the webhook (or re-present the receipt) and
  confirm the balance does not move again.

## Related

- [[action-credits]] — what the product is, the pricing rule, and the rules that
  make it trustworthy.
- [[env-reference]] — where the env vars live and who sets them.
- [[migrations-process]] — applying 00763 to prod.
- [[deploy]] — the DB → edge → frontend order.

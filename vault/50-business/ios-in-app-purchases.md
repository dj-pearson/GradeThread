---
title: iOS in-app purchases — and why App Review rejected them
aliases: [StoreKit, IAP, Guideline 2.1(b), paywall discoverability]
type: reference
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/routes/appstore.ts
  - services/edge-functions/src/lib/appstore/products.ts
reviewed: 2026-08-01
tags: [ios, billing, app-store, monetization]
summary: StoreKit purchases reconcile into the same user columns as Stripe, and the one App Review rejection was about discoverability rather than configuration.
---

# iOS in-app purchases

StoreKit 2 subscriptions and credit packs, chosen over a web link-out. The
important architectural property:

> **Apple entitlements reconcile into the SAME `users` columns the Stripe flow
> writes** (`flipdesk_plan` and friends), so plan gating is unchanged and does not
> learn about processors. Pricing matches web — see [[pricing]].

The verification boundary is Apple's JWS, with `POST /api/payments/appstore/verify`
and the App Store Server Notifications V2 receiver at
`POST /api/webhooks/appstore`.

## The rejection was discoverability, not configuration

v1.0.1 was rejected under **Guideline 2.1(b)**: reviewers "cannot locate the
In-App Purchases". The products were attached and the Paid Apps agreement was
active — nothing in App Store Connect was wrong.

Three things combined:

1. The paywall was reachable only through **Settings → Plan & credits → See plans
   and credits**.
2. The grading flow told users to **buy a credit pack on the web**, which is
   separately a 3.1.1 violation.
3. **The review demo account had pre-loaded credits**, so the out-of-credits
   banner never fired and the reviewer never met an IAP entry point in the core
   flow at all.

Point 3 is the one worth carrying forward: **a demo account provisioned to make
the app easy to review can hide the very thing being reviewed.** Check what the
reviewer's account state suppresses.

The fix added an always-visible "Buy grade credits" button in the grading sheets'
plan summary and removed the buy-on-the-web copy. When replying to Apple, give
the exact path: *Item → Get certified grade → Buy grade credits*, and the
Settings route as a second.

## What is still human-only

The purchase flow cannot be verified in an automated loop — StoreKit needs a
sandbox and a real device. Before any real testing, in App Store Connect:

- Paid Apps agreement and banking.
- The subscription and consumable products created with the **exact ids** in
  `lib/appstore/products.ts` / `IAPProduct.swift`.
- A sandbox tester account.
- The Server Notifications V2 URL pointed at the webhook route, **sandbox and
  production**.
- Edge env in Coolify: `APPLE_BUNDLE_ID`, `APPLE_APP_APPLE_ID`,
  `APPSTORE_ENVIRONMENT`, `APPLE_ROOT_CA_G3_B64` — names only, see
  [[env-reference]].

Deferred: an App Store Server API client for status re-fetch and webhook user
resolution, and a cross-processor double-subscription reconciliation job — a user
who subscribes on both web and iOS is currently only caught by hand.

## Related

- [[pricing]] — the single source of truth these products must match
- [[subscription-unit-economics]] — what the tiers have to cover
- [[env-reference]] — where the Apple env values live
- [[INDEX]]

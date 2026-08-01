---
title: eBay Application Growth Check — submission packet
aliases: [app growth check, ebay rate limit increase, sell.logistics application]
type: runbook
status: current
source_of_truth: vault
code_refs:
  - services/edge-functions/src/lib/ebay-client.ts
  - services/edge-functions/src/routes/flipdesk-webhooks.ts
  - vault/10-ops/launch-checklist.md
reviewed: 2026-08-01
summary: Drafted answers for eBay's Application Growth Check — the single gate for both a rate limit above 5,000 calls/day and restricted-scope access (sell.logistics, sell.negotiation, commerce.identity.readonly).
tags: [ops, ebay, api-limits, scopes]
---

# eBay Application Growth Check — submission packet

Drafted answers for eBay's Application Growth Check form, plus the two hard
prerequisites. Everything factual here is drawn from this repo; where a number is
an estimate, it says so and shows its working.

**One request covers all of it.** The Growth Check is the gate for both a rate
limit above the 5,000/day default AND restricted-API access, so submit
`sell.logistics`, `sell.negotiation` and `commerce.identity.readonly` together
rather than three times (US-2160 and US-1421).

---

## Status: ON HOLD (decided 2026-08-01)

**Not submitting yet.** GradeThread has one active seller besides the operator,
so eBay-side call volume is a rounding error against the 5,000/day default. eBay
declines applications without usage, and a decline costs a queue slot.

**Revisit when connected sellers reach roughly 15–20** — that is where the
arithmetic below puts steady-state usage near the default limit, which is the
condition eBay actually asks for. Nothing is blocked by waiting: the label and
send-offer features are built and dark behind capability gates, so the only cost
of the hold is that they stay invisible.

Everything below is ready to submit as-is when that day comes.

---

## ⚠ Read this before submitting

eBay's own wording: *"We cannot approve applications which are in beta or do not
have any usage… ensure that your application is live and your API usage is
approaching the default call limit."*

**That is a gate on real traffic, not on readiness.** If GradeThread is not yet
running close to 5,000 eBay calls/day in production, a submission is likely to be
declined regardless of how good the answers are, and a decline costs a queue slot
and a wait. Check the actual number in the eBay developer portal's usage view
BEFORE filling in the form.

If usage is well under the limit, the honest sequence is: onboard sellers, let
volume build, then apply. The label feature is already built and dark behind a
capability gate, so nothing is blocked in the meantime.

---

## Prerequisite 1 — Marketplace Account Deletion subscription

Required before any rate-limit request. eBay wants a live endpoint that answers
their handshake.

**Status: the code is in place.** Both halves exist at
`services/edge-functions/src/routes/flipdesk-webhooks.ts`:

| | |
|---|---|
| Handshake (GET) | `flipdesk-webhooks.ts:1188` |
| Delivery (POST) | `flipdesk-webhooks.ts:1210` |
| Endpoint URL | `https://functions.gradethread.com/api/flipdesk/webhooks/ebay/account-deletion` |
| Verification token | `EBAY_VERIFICATION_TOKEN` env var |

The handshake returns `sha256(challengeCode + verificationToken + endpointURL)`.
The endpoint URL in that hash must EXACTLY match what is registered with eBay —
a trailing-slash difference fails the handshake with no useful error.

**What still needs checking (ops, not code):** that the destination is actually
registered and enabled in the eBay developer portal for the production keyset.
The code answering correctly does not prove the subscription exists.

---

## Prerequisite 2 — the app must be live and reachable

eBay may test the flow. The label purchase path is gated off until the scope is
granted, which is a chicken-and-egg problem: they cannot see the feature they are
approving. Be explicit about this in the Purpose field (drafted below) and offer a
demo account showing the surrounding flow — connect, list, sell, ship — so the
reviewer sees a real seller workflow even though the label step is dark.

---

## Drafted answers

### Application Title / Summary

> GradeThread FlipDesk — AI condition grading and listing management for
> pre-owned clothing resellers.

### Application Details

> GradeThread is a SaaS tool for people who resell second-hand clothing. Sellers
> photograph a garment, we produce a standardized condition grade and report from
> those photos, and FlipDesk (the reseller surface) carries the item through the
> rest of the workflow: catalog, measure, photograph, grade, price against comps,
> draft, list, sell, ship and reconcile.
>
> eBay is our primary marketplace integration. Sellers connect their own eBay
> account via OAuth; we never see or store eBay credentials, only tokens. All
> writes are performed on behalf of the connected seller against their own
> listings and orders.

### Products (APIs used)

Verified against the codebase — these are the families with real call sites:

| API | What we use it for |
|---|---|
| Sell Inventory | Create/update inventory items, offers, publish and withdraw listings |
| Sell Marketing | Promoted Listings ad campaigns and rates, item promotions and coded coupons |
| Sell Fulfillment | Order pull, shipping fulfillments (tracking upload), refunds, payment disputes |
| Sell Account | Business policies (payment, return, fulfillment), seller settings |
| Sell Finances | Transactions and payouts, so sales rows carry real fees |
| Sell Analytics | Traffic report per listing (views, impressions, CTR) |
| Sell Compliance | Listing policy violation counts |
| Sell Feed | Bulk feed operations |
| Sell Metadata / Recommendation | Category metadata and listing recommendations |
| Commerce Taxonomy | Leaf categories and item aspects (cached) |
| Commerce Notification | Webhook destination and topic subscriptions |
| Buy Browse | Comparable-listing lookups for pricing |
| Buy Marketplace Insights | Sold-comp pricing (limited release, already granted or unused) |
| Trading (XML) | `GetOrders`, `GetBestOffers`, `GetMemberMessages`, `AddMemberMessageRTQ`, `LeaveFeedback` |
| Post-Order v2 | Returns and cancellations management |

**Requested in this application:**

- `sell.logistics` — buy eBay shipping labels inside the app (US-2160)
- `sell.negotiation` — send offers to interested buyers / watchers (US-1421)
- `commerce.identity.readonly` — seller account handle, used to match
  account-deletion notifications to the right tenant (US-315)

### Purpose of Request

> Two things: a rate limit above the default, and access to three restricted
> scopes.
>
> **sell.logistics** — our sellers currently buy postage on eBay, then retype the
> tracking number and the cost back into our app. The cost is frequently entered
> from memory or not at all, which makes every per-item profit figure wrong. We
> want the seller to rate-shop and buy the label in our ship dialog so the real
> postage lands in their books automatically, and the tracking number flows to
> eBay through the Fulfillment API call we already make.
>
> The integration is fully built and deployed behind a capability check: with the
> scope absent, the feature does not render at all, and no call is attempted. We
> can enable it for review on request.
>
> **sell.negotiation** — send-offer-to-interested-buyers, so sellers can convert
> watchers on aging inventory. Also built and gated off.
>
> **commerce.identity.readonly** — read the connected seller's account handle so
> incoming Marketplace Account Deletion notifications can be matched to the right
> account in our system. Without it we cannot reliably attribute a deletion
> notice.

### eBay Partner Network member

**No.** (Change if that becomes untrue; if yes, the publisher ID is required.)

### Application ID

Your **production** App ID / Client ID from the eBay developer portal. It is the
value of `EBAY_APP_ID` in the production edge environment — read it from Coolify,
not from any file in this repo.

> **Never paste the Cert ID / Client Secret into the form.** Only the App ID is
> asked for.

### Application URL

> https://gradethread.com

The eBay-connected surface lives at `https://gradethread.com/dashboard/flipdesk`
(sign-in required). Our API service is `https://functions.gradethread.com`.

### Call Volume Estimate

Derived from the production cron schedule in
[`launch-checklist.md`](launch-checklist.md). Per connected seller per day:

| Job | Frequency | Calls/seller/day |
|---|---|---|
| Token refresh | hourly | ~12 (user tokens last ~2h) |
| Order + listing pull | every 30 min | ~48 |
| Order backstop | every 30 min | ~0–48 (only for stale connections) |
| Marketplace events (offers, returns, disputes) | every 15 min | ~96 (3 sources) |
| Pending-webhook drain | every 15 min | ~0–96 (only when queued) |
| Performance sync (traffic report) | every 6h | ~4 |
| Promoted Listings sync | every 6h | ~4 |
| Reprice scan + rules | every 6h | ~8 |
| Automation rules | hourly | ~24 (only for sellers with rules) |
| Publish-due batches | every 5 min | on demand |
| Notification reconcile | every 6h | ~4 |
| Leave feedback | daily | ~1 |

**Steady-state floor: roughly 200–350 calls per connected seller per day**, before
any seller-initiated activity (listing, revising, repricing, ending, messaging).
Active sellers add on top of that.

So the default 5,000/day is exhausted at roughly **15–25 connected sellers**.

**State your real forecast, not this table.** Take your current connected-seller
count and your 6–12 month target, multiply by ~300, and add headroom. Give eBay a
number you can justify and that leaves room to grow — an under-estimate means
applying again in six months.

---

## After the grant

1. Add the granted scope(s) to `EBAY_SCOPES` in the production edge environment.
   **Not before** — requesting an unlicensed scope fails the entire consent
   screen with `invalid_scope` and breaks every seller connect and reconnect.
   This is why `sell.negotiation` is absent today (`ebay-client.ts` getScopes).
2. Redeploy the edge service.
3. Sellers must reconnect at Marketplaces → eBay. Tokens issued before the grant
   lack the scope and keep 403-ing; the app detects this and shows a reconnect
   prompt rather than a dead end.
4. **For sell.logistics specifically:** the first real call will confirm whether
   the API version path is right. It is set to `v1_beta` on unverified
   information and is overridable via `EBAY_LOGISTICS_VERSION` without a
   redeploy — see the note in `lib/ebay-logistics.ts`. Confirm the version, and
   the API's real limits (US-only ship-from? USPS-only carriers? seller payment
   method required?), against eBay's docs at the same time and delete the
   unverified markers.

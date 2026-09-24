---
title: eBay OAuth scopes, user token vs app token
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/ebay-client.ts
  - services/edge-functions/src/lib/ebay-trading.ts
  - services/edge-functions/src/lib/ebay-postorder.ts
  - services/edge-functions/src/tests/ebay-user-consent-scope_test.ts
  - services/edge-functions/.env.example
reviewed: 2026-09-24
tags: [ebay, oauth, scopes, contract]
summary: The user consent never asks for the bare api_scope (eBay ticket 260829-000039); only the client_credentials app token does, and every user-token call is mapped to the sell.* scope that covers it.
---

# eBay OAuth scopes: user token vs app token

We hold two kinds of eBay token, and they carry different scopes.

- **User token** (Authorization Code grant). Minted when a seller consents at
  `/oauth/start`; scope list from `getScopes()` in `ebay-client.ts`. Every call
  that acts for a seller runs on it.
- **App token** (Client Credentials grant). `getAppAccessToken()`, shared across
  replicas. Calls that need no seller context run on it.

## The rule

**The user consent list never contains the bare base scope
`https://api.ebay.com/oauth/api_scope`.** eBay Developer Support, ticket
260829-000039 (2026-09-25), on our Sell Logistics application: skip it when
generating the user token; it is removed from our Authorization Code grant once
`sell.logistics` is assigned, and stays available through the Client Credential
grant. A consent URL that asks for a scope the grant no longer allows fails the
whole consent screen, which blocks every connect and reconnect.

`getScopes()` enforces this on both sources: the built-in default omits it, and
it is filtered out of an `EBAY_SCOPES` override, so an old value pasted into
Coolify cannot bring it back. `ebay-user-consent-scope_test.ts` pins it at the
consent URL, along with the app token still requesting it, a refresh sending no
`scope`, and US-2160's `sell.logistics` gate.

**Refresh sends no `scope`** (`refreshUserToken`). The new access token gets the
scopes the refresh token was minted with. Existing sellers' refresh tokens were
minted with the base scope included; whether eBay keeps honoring that part after
the change is eBay's side, and nothing we call depends on it (table below).

## Every user-token call and the scope that covers it

"Documented" means eBay's API reference names that scope for the method.
The reference was not re-read when this table was written (developer.ebay.com
is not reachable from the agent sandbox), so a row that matters for a decision
is worth one look at the method's page. "Believed" and "unknown" are exactly
that; do not upgrade them without a source.

| Calls | Where | Scope | Status |
|---|---|---|---|
| Inventory: items, groups, offers, publish, withdraw, bulk migrate, bulk price/qty, locations | `ebay-client.ts` via `fetchAuthed` | `sell.inventory` | documented |
| Compliance: listing violations + summary | `ebay-client.ts` | `sell.inventory` | documented |
| Recommendation: `/sell/recommendation/v1/find` (ad suggestions) | `ebay-marketing.ts` | `sell.inventory` | documented |
| Account: fulfillment/payment/return policies, program opt-in/out | `ebay-client.ts` | `sell.account` | documented |
| Fulfillment: orders, shipping fulfillments | `ebay-client.ts` | `sell.fulfillment` | documented |
| Feed: `LMS_ORDER_REPORT` order task | `ebay-feed.ts` | `sell.fulfillment` | documented |
| Finances: transactions, payouts | `ebay-client.ts` (apiz host) | `sell.finances` | documented |
| Analytics: traffic report, seller standards, customer service metrics | `ebay-client.ts` | `sell.analytics.readonly` | documented |
| Marketing: campaigns, ads, promotions, keywords | `ebay-marketing.ts`, `ebay-keywords.ts` | `sell.marketing` | documented |
| Payment disputes | `ebay-disputes.ts` | `sell.payment.dispute` | documented |
| Logistics: shipping quotes and labels | `ebay-logistics.ts` | `sell.logistics`, gated by `isLogisticsScopeAvailable()` | documented |
| Negotiation: eligible items, send offer | `ebay-client.ts` | `sell.negotiation`, not requested, gated | documented |
| Identity: `/commerce/identity/v1/user` | `ebay-client.ts` `getUserIdentityFromToken` | `commerce.identity.readonly`, not requested, gated (US-3112) | documented |
| Trading API (XML, `X-EBAY-API-IAF-TOKEN`): GetMyeBaySelling, GetItem, GetBestOffers, RespondToBestOffer, GetMemberMessages, AddMemberMessageRTQ, LeaveFeedback, GetOrders | `ebay-trading.ts` | Believed not to check OAuth scopes (any valid user token) | **unknown** |
| Post-Order v2 (`Authorization: IAF`): returns, cancellations, inquiries, cases | `ebay-postorder.ts`, `ebay-inquiries.ts`, `ebay-cases.ts` | Believed `sell.fulfillment` | **unknown** |

The two **unknown** rows are the risk. Both need seller context, so neither can
move to the app token. If either starts answering 401/403 for sellers who
connected after the change, while older connections still work, the missing base
scope is the first suspect. The reply to ticket 260829-000039 asks eBay to confirm both.

## App-token calls (unchanged, request the base scope)

Taxonomy (category tree, aspects, condition policies), Sell Metadata (condition
policies), Commerce Catalog (product search, product), Browse (search, search by
image, item, item by legacy id; also `ebay-item-read.ts`), Notification
(destinations, subscriptions in `ebay-notification-subscriptions.ts`, public
keys in `ebay-notification-verify.ts`), and the Developer Analytics rate-limit
read (`ebay-rate-limits.ts`). Marketplace Insights mints its own app token with
`buy.marketplace.insights` only.

Related: [[ebay-trading-api-watch]] for the Trading call registry.

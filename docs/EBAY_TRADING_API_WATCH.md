# eBay legacy Trading API — deprecation watch (US-1476)

eBay is progressively decommissioning the legacy **Trading API** (the XML
`/ws/api.dll` calls) in favour of the modern RESTful Sell/Commerce APIs. None of
our specific calls are on eBay's announced sunset list *yet*, but this is an
ongoing risk that needs a standing watch. This file is that watch: the registry
of every Trading call we make, whether a REST equivalent exists, and our
migration stance. **Review it each eBay release-notes cycle** (see below) and
migrate any call the moment a usable REST equivalent ships or a sunset date is
announced.

All Trading calls live in `services/edge-functions/src/lib/ebay-trading.ts`
(consumed by `routes/flipdesk-ebay.ts` and `lib/marketplace-event-poll.ts`).

## Recurring check (how to "watch")

There is **no eBay API** that reports a call's deprecation status, so the watch
is a documented human review, not an automated job:

1. Each eBay release-notes cycle, skim the API deprecation status page and the
   Trading API release notes:
   - https://developer.ebay.com/support/api-status
   - https://developer.ebay.com/devzone/xml/docs/ReleaseNotes.html
2. Cross-check the "Call" column below. If any call gains a REST equivalent or
   an announced sunset, move it from **KEEP** to **MIGRATE** and open a story.
3. Prefer REST for anything with a **KEEP → REST-exists** note here.

## Registry

| Call | Our function | Purpose | REST equivalent | Stance |
|---|---|---|---|---|
| `GetMyeBaySelling` | `getAllActiveEbaySelling` | Enumerate ALL active listings (incl. Trading-created ones) | `sell/inventory getInventoryItems` (Inventory-API-managed offers only) / Browse (buyer view) | **KEEP** — REST covers only offers we created via the Inventory API; Trading is the only complete "all active selling" view. Monitor. |
| `GetItem` | `getItemSpecifics` | Item specifics/aspects for a live listing | `sell/inventory getInventoryItem` (only for Inventory-API offers) | **KEEP** for imported / Trading-origin listings; REST path is used where the offer is ours. Monitor. |
| `GetBestOffers` | `getBestOffers` | Read incoming Best Offers | `sell/negotiation` (getOffers) | **KEEP (blocked)** — the `sell.negotiation` scope is NOT on our production keyset (see `getScopes()` note + US-1421), so Trading is the ONLY path until that scope is granted. Re-evaluate when US-1421 lands. |
| `RespondToBestOffer` | `respondToBestOffer` | Accept/decline/counter a Best Offer | `sell/negotiation` | **KEEP (blocked)** — same scope gap as `GetBestOffers`. |
| `GetMemberMessages` | `getMemberMessages` | Read buyer↔seller messages | none (no REST member-messaging API) | **KEEP** — REST-less. |
| `AddMemberMessageRTQ` | `replyToMemberMessage` | Reply to a buyer message | none | **KEEP** — REST-less. |
| `LeaveFeedback` | `leaveFeedback` | Leave buyer feedback | none (no REST feedback API) | **KEEP** — REST-less. |
| `GetOrders` | `getOrderLegacyLineItems` | Legacy line-item IDs (transactionId/itemId) for one order | `sell/fulfillment getOrders` (`listRecentOrders`) | **REST preferred for order sync** — our primary order + sale-row sync already uses the REST Fulfillment `getOrders` (`ebay-client.listRecentOrders`). This Trading call is retained ONLY to obtain the legacy `TransactionID`/`ItemID` that the REST order API does not expose and that the REST-less Best-Offer / member-message / feedback calls above require. Retire it if/when those move off Trading. |

## Summary

- **Orders**: already on REST (`listRecentOrders` / Fulfillment `getOrders`);
  the sole remaining Trading order call (`getOrderLegacyLineItems`) exists only
  to bridge legacy IDs into the REST-less Trading flows.
- **REST-less by necessity**: Best Offers (scope-blocked, US-1421), member
  messages, and feedback have no REST equivalent — Trading is unavoidable today.
- **Action if a sunset is announced**: Best Offers → chase the `sell.negotiation`
  scope (US-1421) then migrate; messaging/feedback → escalate to eBay (no REST
  path exists yet).

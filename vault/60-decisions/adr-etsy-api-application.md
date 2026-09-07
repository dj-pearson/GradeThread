---
title: "ADR: Etsy Open API v3 access"
type: decision
status: accepted
source_of_truth: vault
code_refs: []
reviewed: 2026-09-06
tags: [decision, marketplaces, etsy, bizdev]
summary: Etsy access is three tiers, not one gate; register a Seller App today and apply for Commercial Access from a working integration.
---

# Etsy Open API v3 — access application (US-1659 / US-1660)

> **Status: DRAFTED, awaiting founder action.** `[NO-CODE]` BizDev.
> The connector is already written and gated off behind `ETSY_ENABLED`. What is
> missing is a keystring, and there are two of them to get, in order.

Checked 2026-09-06 against [developers.etsy.com](https://developers.etsy.com/documentation/).

---

## 1. The decision: two applications, not one

Etsy is **not** shaped like Shopify, and treating it that way is what has kept
this stalled. Shopify has one public-app review with a demo video and promo
shots. Etsy has three tiers and the first one is automatic:

| Tier | For | Approval | Gets us |
|---|---|---|---|
| **Seller App** | your own shop only | automated, near-instant, for an active seller in good standing | a live keystring, the whole OAuth flow, every endpoint we call, against one shop |
| **Personal App** | limited scale beyond your own shop | manual review, no published timeline | prerequisite for the tier below |
| **Commercial Access** | many sellers via OAuth consent | separate manual review | what FlipDesk actually needs |

**So the order is: register today, prove it works, then apply.** A Commercial
Access request submitted from a running integration with real request logs is a
different application from one submitted as a plan, and it costs nothing to be
in the first position rather than the second. Nothing about our code changes
between the two: `isEtsyEnabled()` needs `ETSY_ENABLED=true` and
`ETSY_KEYSTRING`, and a Seller App keystring satisfies it.

The one thing to be careful about: **a Seller App forbids commercial use.**
Turning Etsy on for the founder's own shop to validate the flow is inside that
line. Onboarding a paying customer onto it is not. The flag stays off in prod
until Commercial Access lands.

---

## 2. Step one: register the app

Developer portal, "Register a new app". Field by field:

| Field | Value |
|---|---|
| Application name | `FlipDesk by GradeThread` |
| Callback / redirect URL | `https://functions.gradethread.com/api/flipdesk/etsy/oauth/callback` |
| Privacy policy URL | `https://gradethread.com/privacy` |
| Terms URL | `https://gradethread.com/terms` |
| Website | `https://gradethread.com/flipdesk` |

**Application description** (paste as-is):

> FlipDesk is the reseller workflow inside GradeThread, a platform for people
> who sell pre-owned clothing. A seller photographs a garment once, and FlipDesk
> measures it, grades its condition on a standardized 1.0 to 10.0 scale, writes
> the listing, and publishes it to the marketplaces that seller has connected.
> The Etsy integration creates and updates that seller's own listings through
> the Open API, reads their shipping profiles so a listing carries the right
> one, and reads their receipts so a sale on Etsy takes the item out of stock
> everywhere else. It reads and writes nothing but the connected shop's own
> data, over OAuth, and it does not scrape Etsy.

**Scopes, and why each one:**

| Scope | Why we ask for it |
|---|---|
| `listings_r` | read the seller's own listings back after publish, and reconcile state |
| `listings_w` | create and update the seller's listings, the core of the integration |
| `listings_d` | end a listing when the item sells elsewhere, which is the whole point of cross-listing |
| `transactions_r` | detect a sale on Etsy so we can delist the other copies |
| `shops_r` | resolve the connected shop's id and shipping profiles at connect time |
| `email_r` | resolve which Etsy account just consented, at the end of the OAuth handshake |

`email_r` is the one a reviewer will ask about, so answer it before they do: it
is the identity call at the end of the consent flow
(`/v3/application/users/me`), not a marketing list. We never email a seller's
Etsy address, and it is not exported anywhere. If the reviewer pushes, drop it
and resolve identity from the shop record instead. It is one call site.

---

## 3. Step two: Request Commercial Access

Submitted separately in the developer portal once the app exists. There is no
published requirement for a video or promo shots, which is the Shopify
assumption that has to be dropped. Draft answer:

> GradeThread (Pearson Media LLC, gradethread.com) is a SaaS platform for
> pre-owned clothing resellers. Sellers connect the marketplaces they already
> sell on, and we publish their listings to each one from a single draft, then
> keep stock in sync when something sells.
>
> We are requesting Commercial Access because we act on behalf of many
> independent Etsy sellers, each granting consent through the OAuth flow to
> their own shop. We are not aggregating Etsy data, reselling it, or exposing it
> to anyone but the seller it belongs to.
>
> We already run live integrations built the same way: eBay (OAuth 2.0 with
> token refresh, Inventory and Offer publish, order webhooks) and Shopify
> (GraphQL Admin API with order and inventory webhooks). Both were built against
> the official API specifically to avoid scraping, which is also our answer to
> your API terms: we do not screen-scrape Etsy and have no code path that could.
>
> Scopes requested: listings_r, listings_w, listings_d, transactions_r, shops_r,
> email_r. Each maps to one function of the integration and we would rather drop
> one than over-ask.
>
> Our Etsy integration is already written and tested against a Seller App on our
> own shop, so we can demonstrate a working OAuth consent flow, listing publish,
> and sale-driven delist on request rather than describing them.
>
> Active sellers on GradeThread today: **[INSERT real count]**.
> Expected Etsy volume: **[INSERT honest projection, or say "early stage" plainly]**.

⚠ **Fill the two `[INSERT]` spots with real numbers or say early-stage
honestly.** A number a reviewer can disprove is worse than a small one. Same
rule as the Depop application: see [[adr-depop-partner-application]].

**Sender: `support@gradethread.com`, signed Dj Pearson.** Settled by the founder
2026-09-06. That is the address the Depop application went out from, and both
applications use it for the same reason: a reviewer who searches finds both, and
one company writing under two addresses is a question rather than a fact. See
[[adr-depop-partner-application]].

---

## 4. Outcome (record here)

| Field | Value |
|---|---|
| Seller App registered | _pending_ |
| Keystring received | _pending_ |
| Own-shop flow validated | _pending_ |
| Commercial Access requested | _pending_ |
| Commercial Access outcome | ☐ Approved ☐ More info ☐ Declined |
| Scopes granted | _pending_ |
| Notes | _pending_ |

**Unblock logic:**

- **Seller App keystring in hand** → set `ETSY_KEYSTRING` and
  `ETSY_ENABLED=true` in a non-prod environment, connect the founder's own shop,
  and walk publish → shipping profile → receipt-driven delist. That is the
  evidence for step two.
- **Commercial Access approved** → flip `ETSY_ENABLED` on in prod. No code
  change; the connector has been finished since US-1660.
- **Declined** → Etsy stays off. There is no extension fallback here and there
  should not be: Etsy's terms forbid scraping, and
  [[adr-no-server-side-marketplace-automation]] is the same reasoning.

---

## 5. Why there is no extension fallback for Etsy

Poshmark and Mercari get one because they publish no API at all, so filling
their own form in the seller's own browser is the only sanctioned route left
(see [[adr-poshmark-via-extension]]). Etsy publishes an API and forbids
scraping. Building around a marketplace's front door when it has opened a back
one is how a platform account gets terminated, and it would contradict the claim
we now make in public on `/reselling/crosslisting-without-passwords`.

## Related

- [[adr-depop-partner-application]] — the same shape, one marketplace over
- [[adr-poshmark-via-extension]] — the contrasting call for no-API marketplaces
- [[adr-no-server-side-marketplace-automation]] — why we never hold a session
- [[cross-listing]] — where Etsy sits in the channel model
- [[INDEX]]

---
title: Cross-listing across marketplaces
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [flipdesk, marketplaces, strategy]
summary: Direct marketplace APIs versus aggregators, and which channels are reachable how.
---
# GradeThread Marketplace API Integration Guide: Direct vs. Aggregator Paths for Poshmark, Mercari, Shopify, Depop, and Grailed

## TL;DR

- **Only two of the five marketplaces have legitimate, official write-APIs you can integrate against today:** Shopify (full-featured public GraphQL Admin API, free, OAuth-based, the gold standard) and Depop (private partner REST API at `partnerapi.depop.com`, gated by business@depop.com approval, but with full create/update/order/webhook lifecycle). The other three — Poshmark, Mercari (US), and Grailed — have no developer-accessible write API at all.
- **Poshmark is achievable only at the enterprise tier** via the Brand Closet / Rithum (CommerceHub DSCO) channel, which takes ~2-3 weeks to onboard, leaves much of the listing process manual, and is intended for brands/large resellers — not a typical SaaS-side integration. **Mercari US and Grailed have no sanctioned integration path whatsoever** — every cross-lister you see (Vendoo, List Perfectly, Crosslist, Flyp, PrimeLister) uses browser-extension automation or reverse-engineered mobile-app endpoints, with real ToS/ban risk and zero developer API to license.
- **None of the major resale cross-listing aggregators (Vendoo, List Perfectly, Crosslist) expose a public/partner API for third-party developers** — they are end-user products, not B2B platforms. The only multichannel listing platforms that offer real developer APIs (Sellbrite, Codisto/Shopify Marketplace Connect, Rithum/ChannelAdvisor) cover Amazon/eBay/Walmart/Etsy and do *not* cover Mercari, Depop, or Grailed; Rithum is the only one that reaches Poshmark, and only through its enterprise-priced platform. For GradeThread, the realistic 2026 roadmap is: Shopify direct, Depop direct (apply now), Poshmark via Rithum enterprise (only if it justifies the spend), and Mercari/Grailed via a browser-extension or unofficial mobile-API approach with explicit user consent — accepting that those two will never be safe to centralize on a server.

## Key Findings

### Direct API availability by marketplace

| Marketplace | Official Write API? | Auth | Lifecycle (create/update/orders/delist) | Setup |
|---|---|---|---|---|
| **Shopify** | ✅ Yes — GraphQL Admin API + REST (legacy) | OAuth 2.0 (public apps) or custom-app access token | Full — products, variants, inventoryLevel, orders, fulfillments, webhooks | Partner account → app → OAuth scopes → install |
| **Depop** | ✅ Yes — but **private/partner only** | Bearer API key (`pak_...`) for direct partners; OAuth 2.0 + PKCE for multi-seller apps | Full — create/update via `PUT /api/v1/products/{sku}` (upsert), orders, mark-as-shipped, offers, webhooks | Apply at `business@depop.com`; sandbox + test API key provided |
| **Poshmark** | ❌ No public API. Enterprise integration via **Rithum/CommerceHub DSCO** (Brand Closet program) | Indirect — DSCO API keys, accessed through Rithum/CommerceHub | Partial — inventory, price, orders sync; listing creation is "largely manual" via batch reports | Apply to Brand Closet program → 2-3 week onboarding through DSCO + Rithum |
| **Mercari (US)** | ❌ None — no developer portal, no partner program | N/A | None | N/A. The only sanctioned tool is Mercari's own in-app **Cross-listing Tool** (desktop-only) that *imports into* Mercari drafts from eBay/Poshmark/Depop |
| **Mercari Shops (JP)** | ✅ GraphQL, but **Japan-only & contract-gated** | Bearer personal access token + assigned `API_CLIENT_NAME` User-Agent | Full — but unavailable to US sellers | Souzoh partner contract required |
| **Grailed** | ❌ None | N/A | None | N/A |

### Major cross-listing aggregators — do any offer a developer API?

| Tool | Marketplaces relevant to you | Pricing (consumer) | Public/partner API for devs? | Approach under the hood |
|---|---|---|---|---|
| **Vendoo** | eBay, Poshmark, Mercari, Etsy, Depop, Grailed, FB Marketplace, Shopify, Vinted, Vestiaire, Whatnot (beta) | 5 tiers from $8.99 (Starter) to $69.99 (Unlimited), plus custom Enterprise (per vendoo.co/pricing) | ❌ No public developer API (the `dev.enterprise.vendoo.co` and `api.web.vendoo.co` endpoints are internal) | Chrome extension + cloud orchestration |
| **List Perfectly** | eBay, Poshmark, Mercari, Etsy, Depop, Grailed, FB Marketplace, Vinted, Whatnot, Shopify | $29 Simple / $49 Business / $69 Pro / $99 Pro Plus Tier 1 / $149 Pro Plus Tier 2 / $249 Pro Plus Tier 3 per month | ❌ No public developer API | Chrome extension (multi-tab automation) |
| **Crosslist (crosslist.com)** | eBay, Poshmark, Vinted, Mercari, Depop, Etsy, FB Marketplace, Grailed, Whatnot, Shopify, Starluv (11+) | From $29.99/mo | ❌ No public developer API. Self-describes as "API-first whenever a marketplace supports it … browser extension when not" — meaning eBay/Etsy API + extension for the rest | Chrome extension + native APIs where available |
| **Flyp / PrimeLister / ResellKit** | Subset of the above, Poshmark-centric | $10–$30/mo range | ❌ No developer API | Browser/mobile automation |
| **Sellbrite** (GoDaddy) | Amazon, eBay, Etsy, Walmart, Shopify | $19–$99/mo | Has internal API for partners; **but no Poshmark/Mercari/Depop/Grailed support** | Direct marketplace APIs only |
| **Shopify Marketplace Connect** (formerly Codisto) | Amazon, eBay, Walmart, Etsy, Target Plus | Free + GMV-based variable fee | Shopify-side integration only; **no Poshmark/Mercari/Depop/Grailed** | Native marketplace APIs |
| **Rithum / ChannelAdvisor** (formerly CommerceHub) | 350+ channels including **Poshmark** (Brand Closet), Amazon, eBay, Walmart, Etsy | Enterprise — custom quote, typically thousands/month | ✅ Has a documented developer API (developer.channeladvisor.com); webhooks supported | Native marketplace APIs + DSCO for drop-ship channels like Poshmark |
| **ExportYourStore** | Shopify-anchored; lists Poshmark, Mercari, Depop, Grailed, Vinted, Whatnot in its UI matrix | Shopify-billed subscription | ❌ Consumer-facing Shopify app; no public dev API | Mix of native APIs + automation (similar to Vendoo) |

The decisive takeaway: **no aggregator exists that resells Poshmark, Mercari, Depop, and Grailed write-access through a clean developer API.** Rithum/ChannelAdvisor is the only enterprise platform with a real developer API that includes Poshmark (via Brand Closet / DSCO), but it does not cover Mercari, Depop, or Grailed.

## Details

### 1. Shopify — the easy one, go deep here

Shopify is what eBay should have been. The **GraphQL Admin API** (preferred; REST is now legacy as of 2024) is fully public and free across all plans.

- **Endpoint:** `POST https://{shop}.myshopify.com/admin/api/2026-01/graphql.json`
- **Auth:** `X-Shopify-Access-Token: {token}`. Two paths:
  1. **Public app** (recommended for SaaS like GradeThread) — create on the Shopify Partner Dashboard, implement OAuth 2.0 authorization code flow, request scopes (`write_products`, `read_orders`, `write_inventory`, `read_fulfillments`, etc.), exchange `code` for an offline access token (prefix `shpat_`). One token per shop; never expires unless revoked.
  2. **Custom app** — created inside the merchant's admin; one shop only. Useful for a beta with a few customers but not the SaaS path.
- **Lifecycle mutations you'll actually need:**
  - `productCreate`, `productUpdate`, `productDelete` / `productSet` (newer batch upsert)
  - `productVariantsBulkCreate` / `productVariantsBulkUpdate`
  - `inventorySetQuantities` (or `inventoryAdjustQuantities`) — operates on `InventoryLevel`, scoped to a `Location`
  - `productPublish` to push to the Online Store / sales channels
  - Orders: `orders` query + `fulfillmentCreate`, `fulfillmentEvent`, `refundCreate`
  - Webhooks: `webhookSubscriptionCreate` for `orders/create`, `orders/updated`, `inventory_levels/update`, `products/update`
- **Rate limits (cost-based, not request-based):** Each query has a cost in points (scalar fields = 0, object fields = 1, connections = 2 + 1 per item). Per-app-per-shop bucket. Restore rates per the Shopify docs:
  - Standard plan: 100 points/sec, bucket 2,000
  - Advanced: 200 points/sec
  - Shopify Plus: 1,000 points/sec, bucket 20,000
  - Hard ceiling: **a single query may not exceed 1,000 points regardless of plan**
  - Use `bulkOperationRunQuery` / `bulkOperationRunMutation` for any operation touching >250 records — these run async and don't count against your bucket.
- **Throttling response:** HTTP 200 with `extensions.cost` showing `throttleStatus.currentlyAvailable`; on overflow you get `errors[].extensions.code: "THROTTLED"`. Implement exponential backoff and read the cost object before every retry.
- **Pricing:** API itself is **free**. You pay only if you publish a paid app and Shopify takes a revenue share. Per Shopify's developer changelog update effective June 16, 2025: developers enjoy a revenue-share exemption on the first **$1 million USD of *lifetime* revenue** (a one-time lifetime cap, not the previous annual reset), then a **15% share on amounts above that**. No per-call charges, ever.
- **Risk:** None — fully sanctioned, first-party.

For GradeThread specifically: Shopify is the only marketplace in your list where you can comfortably build a public app, list it in the Shopify App Store, get OAuth installs from any merchant, and deliver true lifecycle sync (create listing → push inventory → receive `orders/create` webhook → mark fulfilled → delist). Build this first.

### 2. Depop — the surprise win, but private

Depop has quietly launched a **Selling API at `partnerapi.depop.com`**. Per Depop's own 2025 impact-goals newsroom post, they "Launched the Depop Selling API built for professional sellers to sync stock, manage orders, and integrate their inventory on the platform." (LinkedIn announcement title: "Depop Launches Selling API for Pro Sellers.") It is not public — but it is real, RESTful, and gives you the full lifecycle.

- **Status (verbatim from the docs):** *"This API is currently private and is not available to the general public. If you are interested in integrating with Depop, please contact us at business@depop.com, and we'll get back to you with the next steps."*
- **Auth (two modes):**
  - **API key** (bearer token, prefix `pak_`) — for direct partners managing their own shop(s). Example: `Authorization: Bearer pak_08f6bce70421de2daeeb72de6f94af8de2571ca1`
  - **OAuth 2.0 Authorization Code + PKCE** — for multi-seller apps (cross-listing tools). Scopes: `products_read`, `products_write`, `orders_read`, `orders_write`, `offers_read`, `offers_write`, `shop_read`. This is the path GradeThread should request.
- **Key endpoints:**
  - `GET /api/v1/products` (paginated, `cursor`+`limit`)
  - `GET /api/v1/products/{sku}`
  - `PUT /api/v1/products/{sku}` — **upsert** (same endpoint creates and updates)
  - Delete via the same products surface (per `products_write` scope)
  - `GET /api/v1/shop/seller-addresses/` and `.../{address_id}/shipping-providers/`
  - `POST /api/v1/orders/{purchase_id}/parcels/{parcel_id}/mark-as-shipped/`
  - Orders read/refund endpoints under `orders_read`/`orders_write`
- **Webhooks:** Yes, for order events and real-time updates.
- **Sandbox:** Yes — explicitly: *"A sandbox environment is available for testing your integration without affecting production data. This includes a mechanism to simulate purchases."*
- **OpenAPI spec:** `https://partnerapi.depop.com/api-docs/openapi.yaml` (Postman collection downloadable)
- **Pricing:** Not publicly stated. The Terms of Use (https://partnerapi.depop.com/api-docs/terms/) reference per-Order-Form commercial arrangements — likely negotiated case-by-case for SaaS integrators.
- **Eligibility / approval:** Approved at Depop's discretion. The Depop Help Centre states *"Our API is not currently open to the public … For access, please contact business@depop.com. We also work closely with crosslisting tools via API connection."* — i.e., crosslisting tools have been a primary partner segment.
- **Risk:** Low if approved — fully sanctioned. Until then, you can't ship anything. Note Etsy's ownership has *not* opened up access through the Etsy API; the two surfaces are entirely separate.

**Action for Dan:** Email business@depop.com immediately with a one-paragraph description of GradeThread (AI clothing grading SaaS, existing eBay integration, X active sellers, expected listing volume). Ask explicitly for the OAuth 2.0 multi-seller flow and a sandbox API key. This is your highest-leverage move because it converts a "no" marketplace into a "yes" marketplace.

### 3. Poshmark — only the enterprise door, via Rithum/DSCO

Poshmark has **no public API**. Every consumer cross-listing tool (Vendoo, List Perfectly, Crosslist, PrimeLister) automates the website via a browser extension. The only sanctioned integration is the **Brand Closet program**, which routes through Rithum (formerly CommerceHub/ChannelAdvisor) and DSCO.

- **Reality from SellerChamp's onboarding docs:** *"Poshmark is a unique selling platform that relies on the third-party company DSCO for API access. Unlike other marketplaces like Amazon or eBay, Poshmark doesn't have its own API. This integration process usually takes about 2-3 weeks … the listing process on Poshmark is largely manual due to DSCO integration limitations. While SellerChamp can update quantity and price, other product details will need to be manually updated directly on Poshmark."*
- **Onboarding flow:** Apply to Poshmark Brand Closet → Poshmark sends enterprise-seller onboarding → DSCO emails an invitation → you complete DSCO + CommerceHub onboarding (including Gandalf testing) → DSCO issues API keys → connection live → listing creation still requires downloading Poshmark reports, completing missing fields, and uploading them to Poshmark.
- **Who actually gets in:** Brands, large resellers (multi-brand resellers, consignment stores). Poshmark's Brands page lists Rithum/ChannelAdvisor and CommerceHub as the named third-party integration partners.
- **Pricing:** Rithum is enterprise, no public price list — sellers typically report low five figures per year minimum, plus revenue share / GMV fees.
- **Risk:** Zero if you go this route; significant if you go the browser-automation route. Poshmark actively bans automation; their ToS explicitly forbids "use any automated means or interface not provided by us to access the Service" (§ User Conduct).

### 4. Mercari — no API, no partner program, full stop

There is no Mercari US developer portal, no partner API, and no integration path equivalent to Poshmark's Brand Closet.

- **Mercari Shops API at `api.mercari-shops.com`** is a separate product run by Souzoh (Mercari's Japanese subsidiary), GraphQL-based, and gated by *"Currently, only shops that have entered into a partner contract with Souzoh in advance can use this"* — Japan-only. Irrelevant to GradeThread.
- **Mercari's own Cross-listing Tool** (https://www.mercari.com/us/help_center/article/609/) is an in-app desktop feature that imports *from* eBay/Poshmark/Depop *into* Mercari drafts. It does not expose any external API and updates are not propagated back.
- **All third-party tools** (Vendoo, List Perfectly, Crosslist, etc.) automate the Mercari website/mobile via either a Chrome extension running in the user's browser or reverse-engineered mobile-app endpoints. The mercari Python packages on PyPI (`mercari`, `mercapi`) are open-source unofficial clients that simulate the JP mobile app token-signing — even those maintainers note "Amazon AWS IPs are blacklisted by Mercari."
- **Risk if you go unofficial:** Account suspension. Mercari's ToS § 11 covers automated/bot access. Cross-listing tools mitigate this by running the automation in the *user's own browser session* (extension model) so that, legally, the user is automating their own account — a defensible posture that has not, to date, drawn aggressive action. Running the same automation from your server (using cookies the user uploaded) is a clear escalation.

### 5. Grailed — no API, ever

Grailed has never published a public API. Confirmed by community projects (e.g., `imsteev/grailer` on GitHub: *"To my knowledge, Grailed currently does not offer a public API yet"*). Etsy's ownership of Depop has not extended Etsy's API to Grailed either — Grailed is owned by **GOAT Group**, not Etsy. Per the October 17, 2022 PR Newswire release announcing the cash-and-stock acquisition, GOAT Group CEO Eddy Lu said: *"Grailed is a leader in the men's fashion resale market with a strong community of style enthusiasts … Together, we'll advance our collective mission to bring the greatest products together from the past, present and future."* The combined GOAT/Grailed entity now spans 50+ million members across 170 countries — none of which has translated into an open API.

All integration today is either (a) Algolia-search-based scraping (Grailed exposes Algolia keys client-side for search, which scrapers exploit), or (b) Selenium/Puppeteer automation of the listing form. Vendoo, List Perfectly, and Crosslist all support Grailed via the second method. Feed-based tools like Koongo also exist but only generate a product feed; they don't perform live order sync.

### Cross-listing aggregators — none are a real B2B API option

I checked every major tool on this question — *do you offer a developer API I could integrate with so I don't have to build the marketplace plumbing myself?* The answers:

- **Vendoo (81,000+ resellers per vendoo.co homepage)**: No public developer API. The Vendoo Enterprise tier exists for high-volume warehouse customers and offers a "dedicated account executive," but it is *still* a UI/extension product, not a developer platform. The `dev.enterprise.vendoo.co` and `api.web.vendoo.co` subdomains are internal-only.
- **List Perfectly** (launched 2019, per listperfectly.com): No developer API. Uses Photoroom's API internally for background removal (per Photoroom case study) but does not expose its own.
- **Crosslist.com**: Explicitly says *"Crosslist® is API-first whenever a marketplace supports it … When an API isn't available for the workflow needed, Crosslist® uses a secure browser extension."* — meaning eBay/Etsy native APIs + extension for everything else. No outbound API for developers.
- **Flyp, PrimeLister, ResellKit, OneShop, Closo, Nifty**: Consumer-facing only.
- **Sellbrite (GoDaddy)**: Has internal partner integrations and exposes a Shopify app; **does not support Poshmark, Mercari, Depop, or Grailed** (its lane is Amazon/eBay/Walmart/Etsy/Shopify).
- **Shopify Marketplace Connect (formerly Codisto)**: Shopify-acquired; supports Amazon/eBay/Walmart/Etsy/Target Plus only. No resale marketplaces.
- **Rithum / ChannelAdvisor**: The only one in this category with a published developer network (developer.channeladvisor.com) supporting webhooks, automated exports, and >350 channels including Poshmark. But it's enterprise-priced and reaches Poshmark only; it does not cover Mercari, Depop, or Grailed.

If you want a serious aggregator partnership, Rithum is the only credible option, and only for Poshmark — not for the other three.

## Recommendations

### Phase 1 — Immediate (next 2 weeks): Ship Shopify direct + apply to Depop

1. **Shopify**: Build a Shopify Partner app in your existing TypeScript/Node stack. Use `@shopify/shopify-api` (official Node library) — it handles OAuth, session storage, webhook HMAC verification, and rate-limit backoff. Request these scopes initially: `write_products`, `read_products`, `write_inventory`, `read_inventory`, `read_orders`, `write_assigned_fulfillment_orders`. Use GraphQL Admin API 2026-01. Plan for bulk operations from day one (any merchant with >500 SKUs will hit per-query cost ceilings otherwise).
2. **Depop**: Email business@depop.com today. Include your existing eBay integration as proof of legitimacy, your projected seller count, and that you specifically want the OAuth 2.0 + PKCE multi-seller flow (not a single-shop API key). Expect a 1-4 week response. Once approved, request a sandbox key and build against the OpenAPI spec at `partnerapi.depop.com/api-docs/openapi.yaml`.

### Phase 2 — Strategic (1-3 months): Decide on Poshmark

Threshold for Rithum: only pursue if you have ≥1 customer doing >$50k/year in Poshmark GMV who will commit to GradeThread for ≥12 months, AND you can charge them enough to cover Rithum's seat (assume $1,500-3,000/month per customer or revenue share). Otherwise, skip Poshmark entirely.

Alternative if you don't want Rithum but still want Poshmark coverage: **ship a thin Chrome-extension companion** ("GradeThread Lister") that runs in the user's browser, accepts a listing payload from your SaaS via `chrome.runtime.onMessageExternal`, and posts it to Poshmark using the user's own session. This is what Vendoo and List Perfectly do. It is legally cleaner than server-side automation (user is automating their own account), but you still own the engineering burden of keeping selectors/flows in sync with Poshmark's UI changes.

### Phase 3 — Pragmatic (3-6 months): Mercari and Grailed via the same extension

If you build the Chrome extension companion for Poshmark, extend it to Mercari and Grailed. There is no other realistic path. Be explicit in your ToS that:
- The extension runs in the user's browser, using their session.
- The user is responsible for compliance with each marketplace's ToS.
- GradeThread does not transmit or store marketplace passwords or session cookies on its servers.

Re-evaluate Mercari every 6 months — they have been rumored to be building a partner API but nothing has shipped as of June 2026. Grailed is highly unlikely to ever ship an API given GOAT Group's strategy.

### What I would *not* do

- Don't pay for Vendoo/List Perfectly/Crosslist as a backend dependency. They're UI products and you'd be paying for features your end users don't see, with no SLA, no API contract, and no support for B2B use.
- Don't build a server-side scraper of Mercari, Poshmark, or Grailed using stored user cookies. The legal exposure (CFAA, DMCA §1201 if you bypass any access controls, breach of contract under each marketplace's ToS) is real and the operational fragility is worse. The cross-listing tools that survive are the ones running automation on the user's own machine.
- Don't wait for Mercari or Grailed to open up. Build the extension path now if you need those marketplaces.

### Decision matrix

| Marketplace | Recommended path | Cost | Time to MVP | Risk |
|---|---|---|---|---|
| Shopify | Direct Admin API (public app) | $0 API + 15% Shopify Partner share above $1M lifetime app revenue | 1-2 weeks | None |
| Depop | Direct Partner API (OAuth 2.0) | Likely negotiated; assume low 4-figures/yr or rev-share | 2-6 weeks (mostly waiting for approval) | None once approved |
| Poshmark | (a) Rithum/Brand Closet *or* (b) own Chrome extension | (a) $1.5k-3k+/mo per customer; (b) engineering only | (a) 4-8 weeks; (b) 2-4 weeks | (a) None; (b) Medium |
| Mercari | Own Chrome extension (user-side automation) | Engineering only | 2-4 weeks | Medium — ToS gray area, account ban possible |
| Grailed | Own Chrome extension (user-side automation) | Engineering only | 2-4 weeks | Medium — ToS gray area, account ban possible |

## Caveats

- **Depop's pricing for the Selling API is not publicly disclosed.** The $ figures and "low four-figures/yr" are inferences from comparable partner programs (Rithum, Mirakl-style connectors); the actual commercial terms will only be known after you apply. The Terms of Use page explicitly says costs are "as otherwise agreed in an Order Form."
- **The Mercari US API stance could change.** Mercari's 2024-2025 hiring (XB Engineering team, Connect Protocol adoption) suggests internal platform investment, and there have been periodic rumors of a partner program. As of June 2026 nothing has been announced publicly — but watch `engineering.mercari.com/en/blog` for shifts.
- **Poshmark's Brand Closet program is gated and discretionary.** Even with Rithum as your integrator, Poshmark can decline to onboard a SaaS partner. Plan for an approval conversation, not a self-service signup.
- **Cross-listing tool ToS risk is real but graduated.** The cross-listers that have survived (Vendoo since 2018, List Perfectly since 2019) use the "extension in user's own browser" model, which Poshmark has tolerated. Mercari has been more aggressive — multiple cross-listers have had Mercari integrations break for weeks after Mercari rolled out anti-automation checks in 2023-2024. Build your extension assuming it will break monthly.
- **Shopify rate-limit numbers can shift between API versions.** The 100/200/1,000 points-per-second figures are current as of API version 2026-01. Check `shopify.dev/docs/api/usage/limits` for the live numbers when you implement.
- **List Perfectly and Vendoo pricing tiers shift frequently.** The figures cited (Vendoo $8.99–$69.99; List Perfectly $29 / $49 / $69 / $99 / $149 / $249) are current as of mid-2026 and could change. If you ever did need to license one as a backend, treat those numbers as indicative only and request a formal SaaS/partnership quote.
- **The Depop Selling API launch is 2025-confirmed but month not officially datestamped.** Depop's own newsroom lists it as a 2025 milestone; "mid-2025" in this report is my characterization from the LinkedIn announcement timing, not a Depop-confirmed date.
## Related

- [[ebay-condition-and-policies]] — eBay is the deepest integration; conditions are per-marketplace
- [[ebay-trading-api-watch]] — deprecation exposure on the legacy API
- [[sync-source-of-truth]] — who owns a field once a listing exists on two channels
- [[INDEX]]

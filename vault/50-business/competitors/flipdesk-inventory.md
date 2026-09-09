---
title: FlipDesk feature inventory, 2026-09-08 snapshot
type: reference
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-09-08
tags: [flipdesk, inventory, snapshot]
summary: What GradeThread and FlipDesk ship today by area, with file paths, gated-off connectors, half-built flows and the open backlog themes; the baseline every competitor gap was checked against.
---

> Research snapshot taken 2026-09-08 for [[competitor-landscape-2026-09]]. Prices, ratings and quotes are as fetched that day; anything marked "(unverified)" could not be confirmed from a primary source.

# GradeThread / FlipDesk feature inventory (as shipped in the working tree, 2026-09-08)

Read-only audit of C:\Users\pears\Documents\GradeThread\GradeThread at commit e247b69ad.
Purpose: a baseline so a competitor comparison (Vendoo, List Perfectly, Crosslist,
Flyp, Sidekick Tools, My Reseller Genie, Flipwise) does not propose rebuilding
what exists. "Shipped" means the code, route or screen is present and not gated
off; "partial" names the missing half; "open US-id" points at prd.json.

Conventions used below:
- Web pages: src/pages/flipdesk/<file>.tsx, mounted at /dashboard/flipdesk/... (src/routes/index.tsx lines 602-677).
- Edge routes: services/edge-functions/src/routes/<file>.ts, mounted under /api/flipdesk/<segment> (main.ts lines 1428-1489).
- Extension: extension-unified/ (the shipping one, "GradeThread: Grade & List" v1.1.0). extension/ and extension-condition/ are the two legacy halves it merged.
- Constants: src/lib/constants.ts (LISTING_PLATFORMS line 904, MARKETPLACE_MECHANISM ~1697, MARKETPLACE_TIER ~1740, MARKETPLACE_EXTENSION_FLOWS ~1842, FLIPDESK_PLANS 217, GRADETHREAD_TIERS 442, CREDIT_PACKS 456, ACTION_CREDIT_PACKS 501).

---

## 1. Marketplaces

Platform id space is LISTING_PLATFORMS (12 ids): ebay, poshmark, mercari, depop,
grailed, facebook, offerup, shopify, etsy, whatnot, vinted, other. Anything not in
that list (Vestiaire, Kidizen, ThredUp, Amazon, Walmart, TikTok Shop) is "none /
not found".

Three source-of-truth maps decide what a channel honestly does, and a build test
(src/lib/marketplace-mechanism.test.ts) keeps them in lockstep with the
extension's selectors.js:
- MARKETPLACE_MECHANISM: api | extension | none
- MARKETPLACE_TIER: api | api_pending | extension | coming_soon
- MARKETPLACE_EXTENSION_FLOWS: per channel, list / delist / revise / relist each "live" or "verifying" (verifying = seller does it by hand, UI says so)

| Platform | Integration method | Create / publish | Revise (price, edit) | Delist / end | Relist | Import existing listings | Sales / order sync | Offers | Sharing / engagement | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| eBay | Official Sell APIs (OAuth + AES-GCM refresh; Inventory, Offer, Fulfillment, Marketing, Negotiation, Post-Order, Finances, Compliance, Logistics, Taxonomy, Browse) | Shipped: single publish (publish-to-ebay-dialog.tsx, POST /ebay/listings/push), AutoLister publish batches (POST /autolister/publish-batch), scheduled drops (POST /ebay/jobs/publish-due), variations + AUCTION format (flipdesk-ebay.ts ~10471, ~13202) | Shipped: POST /ebay/listings/:id/price, /listings/:id/revise, /listings/bulk-revise, /listings/bulk-price-quantity, /listings/bulk-edit | Shipped: DELETE /ebay/listings/:id, POST /listings/:id/end (flipdesk-listings.ts), bulk-end | Shipped: POST /ebay/listings/:id/relist, POST /listings/bulk-relist, automation action "relist" (auto-relist, Pro gate) | Shipped: POST /ebay/listings/pull; POST /ebay/listings/migrate (bring Trading-API listings under management, US-1968 still open for the bulk case); photos mirrored by reference (US-3196) | Shipped: eBay notifications webhook (flipdesk-webhooks.ts GET/POST /ebay), jobs-ebay-order-backstop.ts poll, jobs-ebay-notification-reconcile.ts, Finances payouts (GET /ebay/finances/payouts) | Shipped: Best Offer inbox accept/decline/counter (GET /ebay/negotiation/offers, POST .../respond), auto-counter rules, AI reply drafts (POST /ai/negotiate). Send-offer-to-interested-buyers is WRITTEN but returns 501/403 in prod until eBay grants sell.negotiation (US-1421, US-3199) | n/a on eBay; instead: Promoted Listings COST_PER_SALE + CPC keywords, markdown promotions, coded coupons, store follower email campaigns (all under /ebay/marketing/* and /ebay/promotions/*) | flipdesk-ebay.ts (124 routes), lib/ebay-*.ts, lib/marketplace-adapters/ebay.ts |
| Shopify | Official Admin API (OAuth public app, HMAC-verified callback) | Shipped: publishShopify via cross-push (adapter publish) | Shipped: adapter updateListing | Shipped: adapter delist (endShopify) | Not found in adapter (no relist method); re-publish is the path | Shipped: POST /shopify/listings/pull | Shipped: webhooks orders/create, orders/updated, inventory_levels/update (flipdesk-webhooks.ts ~219); tracking push POST /shopify/orders/:saleId/ship (US-2328 is open in prd.json but the route exists and is commented as the fix) | none (Shopify has no offers) | none | flipdesk-shopify.ts, lib/marketplace-adapters/shopify.ts (its syncListings/syncOrders are notImplemented; the route + webhooks do the work instead) |
| Depop | Official PARTNER API (OAuth+PKCE), adapter fully built: publish/update/delist, orders, mark-shipped, webhook | Built, GATED OFF: whole module behind DEPOP_ENABLED (default false, lib/depop-client.ts:83). Tier api_pending | Built, gated | Built, gated | Not found | Not found (no listing pull; adapter says "Depop has no separate listing pull") | Built, gated: POST /webhooks/depop, POST /depop/orders/:saleId/ship | Not found | none | flipdesk-depop.ts, lib/depop-api.ts; operator stories US-2473, US-3131 |
| Etsy | Official API adapter (publish/update/delist/sync/shipping profiles) | Built, GATED OFF behind ETSY_ENABLED + keystring (lib/etsy-client.ts:10). Tier api_pending | Built, gated | Built, gated | Not found | Etsy CSV preset (src/lib/import-presets.ts id "etsy"); API import is open US-3156 | POST /etsy/sync (gated) | Not found | none | flipdesk-etsy.ts; operator US-2474, US-3131 |
| Poshmark | Browser extension only (no API exists; vault/30-platform/cross-listing.md) | Shipped: list flow LIVE (extension-unified/lister/poshmark.js, selectors.js enabled: true, verified 2026-06-13) | VERIFYING (edits by hand; pending-revise banner + POST /listings/revise-queue exist) | LIVE (delist menu verified 2026-08-11; pending-delist banner + POST /listings/delist-confirm) | VERIFYING (no auto relist; POST /listings/:id/relist-extension exists for when flipped on) | Shipped: closet import via extension (extension-unified/closet-import/, POST /closet-import/runs, closet-import-card.tsx) | Shipped: passive sold-sync observer on poshmark.com/order/sales and /closet (extension-unified/sync/, POST /sync/observations, review queue GET /sync/reviews). Never navigates; server decides what sold | Send offers to likers via extension engage (caps 100/day default, 300 absolute) | Shipped: share / follow / send-offer state machine with daily caps (5,000 default, 9,000 absolute), randomized pacing, separate clickwrap consent, pauses on human check (lister/engagement.js, poshmark-engage.js, US-2482) | README table "Lister rollout"; constants MARKETPLACE_EXTENSION_FLOWS |
| Mercari | Browser extension only | LIVE (verified 2026-08-10/11) | VERIFYING | LIVE | VERIFYING | Shipped: closet import via extension (mercari.com/mypage/listings) | Shipped: passive sold-sync observer on mercari.com/mypage (manifest matches) | Not found | Not found | lister/mercari.js |
| Grailed | Browser extension only | LIVE | VERIFYING | NEVER (delete is confirmed by a native browser dialog; permanent, disclosed; seller gets a pending-delist reminder) | VERIFYING (no relist block at all: a relist that cannot end the old one would double-list) | Shipped: closet import via extension (grailed.com/users, /listings in manifest) | Not built (US-2702 open; sync manifest matches only Poshmark + Mercari) | Not found | Not found | lister/grailed.js |
| Vinted | Browser extension only, 22 country domains | LIVE (verified 2026-08-11 on vinted.com; uncovered locale says "list manually") | VERIFYING | VERIFYING (needs a probe from a live listing) | VERIFYING | Not found | Not built (US-2702) | Not found | Not found | lister/vinted.js; US-2479 still open in prd.json although list is live |
| Facebook Marketplace | Browser extension, content script exists (lister/facebook.js) | VERIFYING all four flows: live form has no accessible names, ARIA-anchored selectors need a rethink (README phase 5; US-2480 open) | verifying | verifying | verifying | Not found | Not found | Not found | Not found | vault/30-platform/facebook-marketplace-no-api.md |
| Whatnot | NONE. Adapter is every-method notImplemented (lib/marketplace-adapters/whatnot.ts:79-83); lib/whatnot-api.ts was modelled with no public docs. OAuth routes exist but gated behind WHATNOT_ENABLED. Tier coming_soon | no | no | no | no | no | no | no | no | US-1662 open |
| OfferUp | NONE (mechanism none, tier coming_soon) | no | no | no | no | no | no | no | no | constants only |
| Google (Sheets) | Not a marketplace: /dashboard/flipdesk/marketplaces/google is the Google Sheets two-way sync wizard (flipdesk-google.ts, flipdesk-google-sync.ts push/pull/now) | | | | | Sheet -> inventory pull | | | | vault/30-platform/google-sheets-sync.md |
| Vestiaire, Kidizen, ThredUp, Amazon, TikTok Shop | Not found anywhere in LISTING_PLATFORMS | | | | | | | | | |

Cross-channel machinery that sits above the table:
- Cross-push fan-out: POST /listings/cross-push (flipdesk-listings.ts) maps one draft into per-platform listings rows via the adapter registry (lib/marketplace-adapters/index.ts registers all 7 API-shaped adapters; poshmark/mercari adapters are local-row stubs because the extension does the work).
- Per-platform variants: Listing Kit (src/components/flipdesk/listing-kit.tsx) renders a per-channel draft (title conflicts GET /listings/title-conflicts/:itemId, title variants, platform descriptions GET /description/:listingId/platform-descriptions).
- Extension work queue: a phone (or the Claude connector) queues cross-post/delist/revise jobs (flipdesk-extension-queue.ts, POST/GET /extension-queue, claim, complete, web push to nudge the desktop); the desktop extension drains it every 5 minutes; the popup shows and retries rows (US-3048). Web widget "Extension queue" in src/lib/dashboard-widgets.ts.
- Extension writeback: POST /listings/extension-writeback records the cross-listing row after a successful form fill (migration 00634 made listed_at nullable; US-2727 is still open in prd.json even though PENDING_MIGRATIONS.md line 4730 marks 00634 APPLIED 2026-08-20).
- Marketplace health / sync runs: GET /ebay/sync-runs, lib/marketplace-health.ts, widget "Sync conflicts", reconciliation conflicts (GET /reconciliation/conflicts).
- Architecture decision: GradeThread servers never hold a marketplace cookie and never solve a CAPTCHA (vault/60-decisions/adr-no-server-side-marketplace-automation.md, US-2476). Cost: the desktop browser must be open; the queue softens that.

---

## 2. Feature inventory

Status legend: shipped / partial (what is missing) / open US-id (not built).

### Sourcing
| Feature | Where | Status |
|---|---|---|
| Sources directory (where stock comes from, yield per source) | pages/flipdesk/sources.tsx via sourcing.tsx?tab=sources; FLIPDESK_SOURCE_TYPES | shipped |
| ScoutAI: search eBay for underpriced listings to flip | scout.tsx (sourcing?tab=scout); POST /scout, /scout/appraise | shipped (Pro comp-pull gate) |
| Prospect an item in a shop (photo -> buy / skip call, resale range, margin) | POST /scout/prospect; iOS Prospect/ProspectView.swift; Android scout/ProspectScreen.kt | shipped (Android sends no imageRoles so never reaches eBay visual search, memory note US-3027) |
| Buy decision / buy ceiling | scout-buy.tsx (sourcing?tab=buy); POST /scout/buy | shipped; US-3193 open: ceiling prices shipping and supplies at zero |
| Flip mode from a marketplace listing page ("Should I flip this?") | extension research/flip-format.js; POST /scout/appraise-url | shipped (paid FlipDesk only, click-to-run) |
| Flip mode on ShopGoodwill / GoodwillFinds | US-3067 | open (has commits) |
| Standing Scout: saved triggers that sweep eBay every 15 min and push alerts | US-3081..3084; lib/scout-scoring.ts references the sweep | open |
| Thrift Radar: shared venue map, venue detail, route planner | radar.tsx, radar-map.tsx, radar-route-planner.tsx; GET /radar/venues; jobs-radar-aggregate.ts; vault/20-domain/thrift-radar.md | shipped |
| My stores (which of MY venues make money) | my-stores.tsx; GET /radar/my-stores | shipped (free tier) |
| Buyer demand board for sellers (what buyers are hunting) | demand.tsx (sourcing?tab=demand); GET /demand; jobs-demand-matches.ts | shipped |
| Community sourcing / pricing benchmarks | community-insights.tsx (analytics/community); lib/community-recommendations.ts; showcase.ts consent | shipped (opt-in share_outcomes) |
| Resale supply index (how crowded a category is) | US-3132, US-3133 | open (has commits) |
| eBay Partner Network affiliate links on Scout/Prospect | US-3082; vault/50-business/ebay-partner-network.md | open |

### Intake
| Feature | Where | Status |
|---|---|---|
| Intake page (photos first, then details) | intake.tsx; intake-photo-stager.tsx; bulk-intake.tsx | shipped |
| AI extract from photos (brand, size, category, color, material, aspects) | POST /ai/extract, /ai/extract-aspects, /ai/size, /ai/bulk-extract; iOS AIExtract/, Android ai/AiExtractScreen.kt | shipped |
| Tag / label OCR into fields | POST /ai/extract (tag OCR reaches 4% of drafts per US-3047); extension label-reader.js (US-3070, has commits) | partial: grading itself never runs the tag-OCR ground-truth pass (US-2210 open) |
| Barcode / UPC lookup | barcode-scanner-dialog.tsx; POST /product/lookup; iOS Capture/BarcodeScanView.swift; Android capture/BarcodeScanScreen.kt | shipped |
| Style code index (brand style codes -> product identity) | jobs-style-code-discovery.ts, jobs-style-code-sweep.ts; vault/20-domain/style-code-index-evidence.md | shipped |
| Brand knowledge base (tag eras, colorways, RN numbers, authenticity tells) | admin-brand-knowledge.ts, admin-registered-numbers.ts | shipped; coverage gaps US-3125, US-3127, US-3135, US-2216 |
| CSV import with competitor presets | import.tsx; src/lib/import-presets.ts ids: vendoo, list-perfectly, shopify, ebay-file-exchange, etsy; POST /import/runs (+undo) | shipped; vault note says NONE verified against a real export yet; Flyp / Crosslist / SellerAider presets deferred (US-3164) |
| Google Sheets import + two-way sync | marketplaces-google.tsx; flipdesk-google.ts, flipdesk-google-sync.ts; POST /sheets/fetch-csv | shipped |
| Closet import from Poshmark / Mercari / Grailed via extension | closet-import-card.tsx; POST /closet-import/runs; extension-unified/closet-import/ | shipped. Depop closet import US-3154 open |
| Universal import (pull every listing from every connected channel, link duplicates) | US-3197 | open (has commits) |
| Reconcile photo dump -> items | reconcile.tsx; POST /autolister/reconcile/diff, /apply, /link | shipped |
| Consignment intake (e-sign agreement) | consignment.tsx; POST /consignment/consignors/:id/intake | shipped |
| Phone capture: scan a code on desktop, shoot on phone, photos land in the item | phone-capture-dialog.tsx; flipdesk-phone-capture.ts (/capture/sessions, /s/:token/photos) | shipped; AutoLister multi-item capture on one code US-3185 open |
| Share-sheet inbox (iOS) | ios/GradeThread/ShareInbox/ | shipped (iOS) |

### Photos
| Feature | Where | Status |
|---|---|---|
| Photo manager: order, tag roles (front/back/tag/detail/defect/flatlay), rotate, crop, brightness | photo-manager.tsx, photo-editor-dialog.tsx, photo-tag-select.tsx; vault/20-domain/listing-photos.md | shipped |
| Background removal, on-device (no per-image API bill) | src/lib/background-removal.ts + segment-u2net.ts (AGPL @imgly replaced; vault/30-platform/background-removal-licence.md); POST /images/remove-bg on edge | shipped; in-extension variant US-3069 (has commits) |
| Thumbnails + EXIF strip client-side | photo-uploader.tsx; POST /images/process deliberately 501 | shipped (client side) |
| Photo quality score / QA | quality-score-chip.tsx; POST /autolister/photo-qa; composer quality-card.tsx | shipped |
| Photo profiles per category (required set + order) | flipdesk-photo-profiles.ts; vault/20-domain/listing-photos.md | shipped |
| Import from Google Photos | flipdesk-google-photos.ts (/google/photos/*) | shipped; in Composer from one shared module US-3140 open |
| Import from Dropbox / OneDrive folders | flipdesk-cloud-folders.ts (/cloud/*), cloud-folder-dialog.tsx; CLOUD_PROVIDER_IDS = dropbox, onedrive | shipped; Google Drive US-3158 open |
| Photo archive to cold storage + orphan detection | POST /images/archive; jobs-photo-archive.ts; orphan finder US-3187 open | shipped / open |
| Live Photo / HEIC intake | vault/20-domain/image-intake.md | shipped |
| Video on eBay listings (Media API) | US-1980 | open |
| Watermark / branding overlay | not found | not found |

### Measure
| Feature | Where | Status |
|---|---|---|
| Measurement form per category (chest, length, sleeve, etc.) | measurement-form.tsx; vault/20-domain/measurement-card-spec.md | shipped |
| MeasureCard: printed scale card, calibrate from photo, AI extract measurements from a photo, overlay | measure-card.tsx; measurement-photo-editor.tsx; flipdesk-measure.ts (/measure/calibrate, /extract, /autofill, /overlay, /card-request); iOS Measure/ | shipped; MeasureCard golden-set gate US-1582 (operator) open; US-2231 "brochure with no path into the flow" open |
| Measurement text in description + eBay aspects | jobs-measurement-text-backfill.ts | shipped; eight measurements reach no eBay aspect US-2813 open |
| Size bands / brand size charts / international conversion | flipdesk-size-bands.ts; vault/20-domain/size-system-conversions.md | partial: size check vs brand charts US-2915/US-2922 open; no intl conversion first-class US-2215 open |
| Measurement drift / stats (community) | flipdesk-measurement-stats.ts; measurement-drift-section.tsx | shipped |
| Body profiles (buyer fit) | /dashboard/measurements (body-profiles page) | shipped |

### Grade
| Feature | Where | Status |
|---|---|---|
| AI condition grade 1.0-10.0, factor scores, tiers, confidence -> human review | routes/grade.ts, lib/ai-grading.ts, grading-pipeline.ts; grading tiers Standard/Premium/Express | shipped (core product) |
| Grade from inside FlipDesk (item -> submission -> grade back on the item) | grade-this-item-card.tsx; flipdesk-grading.ts (/grading/validate, /submit, /submissions/:id) | shipped; label photo dropped (US-2304 open) |
| Public certificate + verify page + QR | /cert/:id, /verify, /scan; functions/ cert SSR | shipped |
| Garment Passport (lifecycle timeline, claim, tags, relist detection) | routes/passport.ts; /passport/:slug; iOS Passport/; Android passport/ | shipped |
| Grade -> listing text (condition disclosure, annotated defect photo) | flipdesk-disclosure.ts; disclosure page on iOS/Android; grade-authority text-only on listings (vault/30-platform/grade-authority-on-listings.md) | shipped |
| Walk-around video grading | ios? no: web-only (US-2504 open) | partial |
| Snap to Value (grade + price a garment you own) | /dashboard/snap; iOS Snap/; Android snap/ | shipped |
| Bulk grading submissions | /dashboard/submissions/bulk; Android grading/BulkGradeScreen.kt | shipped |
| Grading ROI analytics (does grading lift price) | analytics.tsx?view=grading-roi; grade-roi-hint.tsx | shipped |
| Grade as INAD return defense (Return Shield evidence pack) | flipdesk-return-shield.ts; return-evidence-panel.tsx; extension research/return-shield.js | shipped; on the eBay return page itself US-3068 (has commits) |
| Category coverage (hats, bags, footwear rubric) | US-2222, US-2223, US-2225, US-2810 | open: 8 of 20 categories have criteria |
| Authenticity tells / golden set | admin-* + buyer-authenticity.ts | partial: US-2131, US-2139, US-2218 open |

### Comps and pricing
| Feature | Where | Status |
|---|---|---|
| eBay sold comps panel, condition-matched | ebay-comps-panel.tsx; GET /ebay/comps; jobs-comp-read.ts; vault/20-domain/comp-read-worker.md | shipped (Pro compPulls gate) |
| Price suggestion + forecast (days to sell, price curve) | POST /pricing/price, /pricing/forecast, /pricing/scan; forecast-card.tsx; price-curve-report.tsx; sell-through-chart.tsx | shipped |
| Repricing suggestions for live listings (condition-aware) | repricing.tsx (pricing?tab=repricing); GET /pricing/suggestions, apply/dismiss; iOS Pricing/RepricingView | shipped |
| Bulk pricing (bulk reprice preview/apply) | bulk-pricing.tsx (pricing?tab=bulk); POST /pricing/reprice/preview, /apply; bulk-reprice-dialog.tsx | shipped |
| Pricing rules engine (scheduled markdowns etc.) | GET/POST /pricing/rules, /rules/run | shipped |
| Per-item price floor ("never below $28") | bulk-pricing.tsx US-3192 comment | partial (US-3192 open, some code present) |
| Condition-priced comps (grade the market) | US-2841, US-2842 | open (spike has commits) |
| Market condition index (claimed vs actual gap) | US-2708..2713; vault/20-domain/market-condition-index-contract.md | open |
| Price guide (public API) | api-v1.ts GET /price-guide, /price-guide/:slug | shipped |

### Composer and AI
| Feature | Where | Status |
|---|---|---|
| ONE item editor for every status (composer) | composer.tsx + components/flipdesk/composer/*: title, item-details, specifics, measurements, photos, description, price, cost-margin, policies, promote, schedule, storage-sku, publish-readiness, push-to | shipped |
| AI title + description generation, rewrite, tone | POST /ai/listing-copy, /ai/rewrite; bulk-tone-dialog.tsx; listing-voice-setting.tsx | shipped |
| Description blocks / snippets / templates with per-platform preview | description-snippets.tsx (/settings/blocks); templates.tsx; flipdesk-description.ts; flipdesk-templates.ts | shipped; iOS/Android block editor parity US-2964 open |
| eBay category suggest, aspects, conditions, required-aspect gap fill, allowed-value normalisation | ebay-category-picker.tsx; GET /ebay/category/suggest, /category/:id/aspects; lib/aspect-normalize.ts | shipped; descriptive values dropped (Taupe->Beige) US-3016 open |
| eBay catalog (product) match / adopt | ebay-catalog-match-card.tsx; GET /ebay/catalog/match | shipped |
| Listing quality score + lift estimate | quality-card.tsx; listing-quality-lift-section.tsx | shipped |
| AI AutoLister: bulk photos -> grouped items -> drafted listings -> publish batch | autolister*.tsx; flipdesk-autolister.ts (23 routes: staging upload, propose/verify groups, classify, tag-brand, batch, retry, resume, publish-batch, platform-fields); iOS/Android AutoLister | shipped (Pro gate) |
| Drafts library + bulk edit | autolister-drafts.tsx, autolister-bulk-edit.tsx; bulk-edit-dialog.tsx | shipped |
| Publish readiness / blockers | publish-readiness-card.tsx; src/lib/publish-blockers.ts | shipped |
| Anonymous public listing generator (marketing tool) | US-3088, US-3089 | open (has commits) |
| Claude connector (MCP) to run the store from chat | routes/mcp.ts; 29 tools in lib/mcp-* (create/update draft, publish, end, relist, reprice, price suggestions, comps, grade, queue extension work, sandbox); vault/30-platform/claude-connector.md | shipped (Pro 500 / Business 2000 actions) |
| Public REST API + API keys + webhooks | api-v1.ts (/grades, /items, /listings, /sales, /price-guide, /usage, PATCH /webhook); /dashboard/developers | shipped (Business) |

### Cross-list
See section 1. Additional UI:
| Feature | Where | Status |
|---|---|---|
| Push-to picker (API channels as checkboxes, extension channels with mechanism badge) | push-to-card.tsx; cross-post-channel-picker.tsx; cross-post-setup.tsx | shipped |
| Marketplaces page: connect, per-flow capability words, risk disclosure, share-jail statement | marketplaces.tsx; src/lib/marketplace-disclosure.ts | shipped |
| Pending delist / pending revise banners + queues | pending-delist-banner.tsx, pending-revise-banner.tsx; GET /listings/pending-delists, /pending-revises | shipped |
| Delist everywhere on sale (API channels automatic; extension channels via queue) | flipdesk-listings.ts /:id/end, /bulk-end; extension GT_LISTER_DELIST | shipped for eBay/Shopify/Poshmark/Mercari; Grailed never; Vinted/FB verifying |
| Revise + relist on extension channels | US-3071 (has commits) | open: every extension channel is "verifying" for revise and relist today |
| Firefox + Edge support | extension README "Cross-browser" | shipped; US-1881 still open in prd.json |
| Store listing / install funnel | US-1757, US-3058 (operator) | open |

### Inventory
| Feature | Where | Status |
|---|---|---|
| One inventory route with four modes: triage table, spreadsheet grid, kanban pipeline, prep list | inventory.tsx (?mode=), grid.tsx, pipeline.tsx, prep.tsx; listings-table.tsx virtualised | shipped |
| 17 item statuses incl. personal keeping/wearing | ITEM_STATUSES constants.ts ~921 | shipped |
| Saved views, filter builder, sort, URL-persisted tab/sort/filter/page | save-view-dialog.tsx, filter-builder.tsx, inventory-sort.ts; US-3207 (committed, still passes:false) | shipped |
| Bulk actions (edit, promote, reprice, AI enrich, tone) | bulk-*-dialog.tsx | shipped (Pro gate) |
| SKU + storage location (bin) | storage-sku-card.tsx; merge-sku-dialog.tsx | shipped |
| Global search | search.tsx; iOS GlobalSearchView; Android GlobalSearchScreen | shipped |
| Aging rules / stale listings | aged-strip.tsx; widgets "Aging items", "Stale listings" | partial: US-3195 "no screen shows what is rotting" open |
| Inventory equity (what stock is worth) | equity page card; flipdesk-equity.ts; jobs-equity-snapshot.ts | shipped |
| Verified public storefront / seller badge | verified.tsx; routes/verified.ts | shipped |
| Command palette + FlipDesk search | command-palette.tsx | shipped |
| Sync conflicts / source-of-truth model | vault/20-domain/sync-source-of-truth.md; cross-source-conflicts.tsx | shipped |

### Offers and negotiation
| Feature | Where | Status |
|---|---|---|
| eBay Best Offer inbox (accept / decline / counter) with cost, floor, net margin per offer | offers.tsx; offer-economics.ts; GET /ebay/negotiation/offers | shipped; US-3194 (margin ignores fees/postage) open |
| Buyer messages inbox + reply, AI-drafted replies | offers.tsx; GET /ebay/messages, POST .../reply; POST /ai/negotiate; negotiation-draft-prefill.ts | shipped |
| Auto-respond rules (accept > counter > decline by threshold), threshold conflicts | automation rules offer_received/offer_threshold; offer-threshold-conflicts.tsx | shipped |
| Send offer to interested buyers / watchers | send-offers-today.tsx; POST /ebay/negotiation/send-offer | written, blocked in prod on eBay sell.negotiation scope (US-1421, US-3199) |
| Keep-it offer (partial refund instead of return) | keep-it-offer.ts | shipped |
| Poshmark offers to likers | extension engagement (caps) | shipped |
| Offer analytics | offer-analytics-card.tsx; GET /ebay/negotiation/analytics | shipped |

### Sales and shipping
| Feature | Where | Status |
|---|---|---|
| Sold and Shipping page: ship queue, prepare shipment, mark shipped with tracking | post-sale.tsx; ship-queue.ts, ship-queue-card.tsx, prepare-shipment-dialog.tsx, ship-order-dialog.tsx; POST /ebay/orders/:saleId/ship, /shopify/orders/:saleId/ship | shipped |
| Buy eBay shipping label in-app (rates, label, void), parcel estimate from measurements | flipdesk-logistics.ts; lib/parcel-estimate.ts | built, gated on eBay sell.logistics scope (US-2380 operator) and Pro gate; EasyPost second provider US-3015 open |
| Packing slip | packing-slip.ts (committed, US-3191 still open) | shipped |
| Ship-by deadline countdown | US-3189, US-3190 | open |
| Manual sale record (off-platform) | record-sale-dialog.tsx; POST /ebay/listings/:id/sale | shipped |
| Returns: decide, refund, mark received, message, label, evidence | post-sale.tsx; /ebay/returns/* | shipped |
| Item Not Received inquiries, Money Back Guarantee cases (evidence, appeal), payment disputes, cancellations | /ebay/inquiries/*, /ebay/cases/*, /ebay/payment-disputes/*, /ebay/cancellations/*; Android EbayCasesScreen | shipped (US-2927..2953) |
| Leave feedback | POST /ebay/feedback, /ebay/jobs/leave-feedback | shipped |
| Return attribution analytics | return-analytics-card.tsx, return-attribution-section.tsx | shipped |
| Combined shipping / order-level discounts | vault/30-platform/flipdesk-reseller-gaps.md #6 | deliberately out of scope |
| Seller defaults for shipping/returns/handling | listing-defaults-card.tsx; US-2855 open | partial |

### Money, P&L, tax
| Feature | Where | Status |
|---|---|---|
| Money hub: overview (set-aside, needs a look, made, spent), finances, expenses, reconcile | money.tsx (?view=), money-overview.tsx | shipped |
| Expenses with IRS line mapping, receipt photo, AI receipt extract, recurrence | expenses.tsx; flipdesk-expenses.ts (/extract, /receipt); jobs-expense-recurrence.ts | shipped |
| Double-entry ledger, chart of accounts, P&L statement (printable), inventory snapshots, COGS worksheet | pnl.tsx; src/lib/ledger-math.ts, chart-of-accounts.ts, pnl-statement.ts, cogs.ts; migrations 00684-00688 | shipped |
| Tax profile, tax packet, 1099-K bridge, facilitator sales tax, estimated tax | tax-setup.tsx; src/lib/tax-profile.ts, tax-packet.ts, form-1099k.ts; migrations 00691, 00693, 00698 | shipped |
| Mileage log + home office deduction | deductions.tsx; src/lib/mileage.ts, home-office.ts; iOS Money/MileageLogView.swift; Magic Ride (auto-detect drive) US-3204 committed | shipped web + iOS; Android mileage/receipts US-3000 open |
| QuickBooks Online sync | routes/qbo.ts (/qbo/oauth, /accounts, /mappings, /sync, /sync/log) | shipped |
| eBay payouts + fees, ad spend attributed per order | ebay-payouts-card.tsx; GET /ebay/finances/payouts, /finances/ad-spend; lib/ad-spend.ts | shipped |
| Payout reconciliation (CSV + API), SKU match, cross-source conflicts | reconciliation.tsx; POST /ebay/payouts/import-csv; flipdesk-reconciliation.ts | shipped (Business gate for reconciliation; Starter has auto-import payouts) |
| Consignor splits, per-consignor P&L, Stripe Connect payouts | consignment.tsx; flipdesk-consignment.ts; jobs-consignor-payouts.ts | shipped |
| Action credits (prepaid top-ups) | ACTION_CREDIT_PACKS; vault/50-business/action-credits.md | shipped (US-3138 open with commits) |
| Books and Taxes epic | US-2981 | open epic, but nearly every child above is shipped |

### Analytics
| Feature | Where | Status |
|---|---|---|
| Analytics hub: profit by group, sell-through, median days to sell, avg net, return rate; views grading-roi, returns, price-curve, performance, team, community | analytics.tsx (+ /analytics/*) | shipped |
| Listing performance (photo count / quality / grade vs first-14-day traffic) | listing-performance.tsx; iOS + Android ListingPerformance | shipped |
| eBay traffic / performance sync, account health, seller scorecard | POST /ebay/sync/performance; ebay-account-health-card.tsx; seller-scorecard-card.tsx | shipped |
| Team report (throughput, who created what, miss report) | team-report.tsx | shipped |
| Time saved meter | flipdesk-time-saved.ts; vault/50-business/time-saved-baseline.md | shipped |
| North Star weekly goal | north-star-card.tsx; jobs-north-star.ts | shipped |
| Widget-board overview (drag / hide / reorder, 40+ widgets) | overview.tsx; src/lib/dashboard-widgets.ts | shipped (US-3072 epic has commits) |
| AI analytics narrative | POST /ai/analytics-narrative | shipped |
| Weekly digest / anomaly alerts, analytics over API + CSV parity | US-2828, US-2829 | open |
| "Worth My Time" work planner (18 stories) | US-3166..3183 | open, none started |

### Automations
| Feature | Where | Status |
|---|---|---|
| Rule engine: triggers days_listed_gt, no_views_in_days, offer_received, return_opened; actions price_drop_pct (with margin floor), set_promo_rate_pct, create_coded_coupon, end_listing, relist, crosslist_to, send_offer_to_watchers, advance_status, notify; scoped by brand/category/size/source/cost/grade/status; dry-run | automations.tsx (pricing?tab=automations); flipdesk-automations.ts; lib/automation-rules.ts | shipped (Pro scheduledActions/autoRelist); set_promo_rate_pct is local-only (not pushed to eBay from the automation path, per vault gaps note) |
| Scheduled drops (publish when buyers look) | scheduled-drops.tsx; drop-day-dialog.tsx; POST /ebay/jobs/publish-due | shipped |
| Repricing rules | GET /pricing/rules | shipped |
| Cron fleet (73 schedules: order backstop, promoted sync, token refresh, reconciliation sweep, etc.) | routes/jobs-*.ts (60+ files); jobs-cron-fleet.ts | shipped in code; US-2313 open: nothing in VCS creates/verifies prod schedules; US-2668: four jobs fail every run |
| Poshmark share / follow / offer automation | see section 1 | shipped |

### Team and consignment
| Feature | Where | Status |
|---|---|---|
| Workspace: invitations, roles, remove, MFA policy | routes/workspace.ts; /dashboard/team; iOS Team/; Android workspace/TeamScreen | shipped (Business subAccounts) |
| Sourcer roster / sourced-by attribution | sourcer-roster-card.tsx, sourced-by-select.tsx | shipped |
| Consignors: directory, splits, intake e-sign, connect (consignor portal), payouts | consignment.tsx; flipdesk-consignment.ts; iOS/Android Consignment | shipped |
| Impersonation (support) | routes/admin-impersonation.ts | shipped; US-2351 open: unbounded/unmarked |

### Mobile
| Surface | iOS (ios/GradeThread/) | Android (android/.../app/) |
|---|---|---|
| Home / dashboard | Dashboard/DashboardView | home/HomeScreen |
| Grading (request, list, report, consumer grade, walk-around) | Grading/* (WalkAroundGradeView exists) | grading/* (BulkGradeScreen, no walk-around) |
| Snap to Value | Snap/SnapView | snap/SnapScreen |
| Capture, barcode | Capture/PhotoIntakeView, BarcodeScanView | capture/CaptureScreen, BarcodeScanScreen |
| AI extract / confirm | AIExtract/* | ai/AiExtractScreen |
| Inventory list, board, item canvas, photo manager, rule builder, search | Inventory/* | inventory/* (no board screen found) |
| Details intake, sources | DetailsIntake/* | inventory/DetailsIntakeScreen |
| AutoLister + drafts + bulk edit | AutoLister/* | autolister/* (no bulk edit screen found) |
| Marketplaces, eBay accounts, listing kit, negotiation inbox, post-sale, reconciliation, bulk pricing | Marketplaces/* | marketplaces/* (+ EbayCasesScreen) |
| Pricing: repricing, rules, price suggestions | Pricing/*, Money/PriceSuggestions | pricing/RepricingScreen |
| Money, profit list, payout reconciliation, mileage | Money/* (MileageLogView) | money/* (no mileage; US-3000 open) |
| Sales / fulfillment | Sales/SalesView, Fulfillment/FulfillmentView | money/SalesScreen, fulfillment/FulfillmentScreen |
| Scout, Prospect, Radar nearby, My stores | Scout/, Prospect/ (RadarNearbyView) | scout/*, radar/* (MyStores, VenueDetail) |
| Automations, scheduled drops, templates | Automations/, ScheduledDrops/, Templates/ | automations/, templates/ (no scheduled drops found) |
| Consignment, team, referrals, verified, support, analytics, community insights, disclosure | all present | all present |
| Buyer surfaces (alerts, guarantee, portfolio, trust score), passport | Buyer/*, Passport/ | passport only; no buyer surface (US-2904 open) |
| Import (CSV) | Import/CSVImportView | importer/ImportScreen |
| Widgets, Siri intents, share inbox, speech | GradeThreadWidget, Intents/, ShareInbox/, Speech/ | widget exists (US-2909 grey preview) |
| Billing | Billing/PaywallView (StoreKit; blocked on App Store Connect setup) | billing/PaywallScreen (Play Billing a version behind, US-2901) |
| Localization | English only (US-2499) | Spanish shipped; bottom bar hardcoded English (US-2976) |
| PWA (web) | pwa-install-banner.tsx | shipped |

### Extension (extension-unified/, MV3, Chrome + Edge + Firefox)
| Feature | Where | Status |
|---|---|---|
| Condition Check: AI second-opinion read on a listing page (eBay, Poshmark, Grailed, Mercari, Depop, Vinted), always on, anonymous-capable, quota-capped | research/*; POST /api/grading/public/... | shipped |
| Scan mode: badges search grids with claimed condition + price fairness, no Vision call | research/scan-format.js | shipped (default on) |
| Compare tray (up to 6 pinned reads, no network) | compare.html/js | shipped |
| Seller memory (on-device, per seller handle) | research/seller-memory.js | shipped |
| Flip mode (should I flip this) | research/flip-format.js | shipped (paid) |
| Lister: list / delist on Poshmark, Mercari, Grailed, Vinted (+ Facebook pending) | lister/* | see section 1 |
| Cross-listing queue view, retry, cancel, "run these now" | queue/queue-view.js; popup Selling tab | shipped (US-3048); US-3198 open but has commits |
| Sold-sync observers (Poshmark, Mercari) | sync/* | shipped; Grailed/Vinted US-2702 open |
| Closet import (Poshmark, Mercari, Grailed) | closet-import/* | shipped |
| Poshmark engagement (share, follow, offer) with caps and consent | lister/engagement.js, poshmark-engage.js | shipped |
| Return shield on eBay return page | research/return-shield.js | present (US-3068 has commits, still open) |
| Label reader from context menu | research/label-reader.js | present (US-3070 has commits) |
| Selector self-check ("Check selectors") + CI invariants gate | lister/selector-probe.js; scripts/verify-lister-selectors.mjs | shipped; snapshot fixtures US-3063 open |
| Verified badge on live listings, side panel work surface, worker tab, on-device Prompt API pre-read, MCP-queued work | US-3060, 3062, 3061, 3066, 3065 (all have commits) | open in prd.json |
| Store distribution | US-1757, US-3058 | operator, open |
| Web bridge: /connect-extension mints token; VITE_LISTER_EXTENSION_ID gates the Listing Kit button | src/lib/lister-extension.ts | shipped; US-2718 (button compiled out of live build) open with commits |

### Buyer side and certificates
| Feature | Where | Status |
|---|---|---|
| Public certificate, verify, QR scan, passport pages (edge-SSR) | /cert/:id, /verify, /scan, /passport/:slug, /claim/:token | shipped |
| Buyer platform: onboarding, alerts (wants), rewards, portfolio (closet), guarantee coverage + claim, demand board, billing, settings | /buyer/*; routes buyer-*.ts; BUYER_PLANS Free / Guard $8 / Connoisseur $19 | shipped |
| Grade accuracy guarantee + claims + guarantee pool | guarantee-public.ts; admin-guarantee-pool.ts; vault/20-domain/grade-accuracy-guarantee.md | shipped |
| Buyer trust score / reputation | buyer-trust.ts | shipped |
| Authenticity check credits | buyer-authenticity.ts | shipped, coverage thin (US-2139) |
| Extension token / entitlements | POST /api/buyer/extension-token; GET /api/grading/public/entitlements | shipped |
| Seller plans include a buyer tier (Starter/Pro -> Guard, Business -> Connoisseur) | SELLER_PLAN_BUYER_TIER | shipped |

### Community
| Feature | Where | Status |
|---|---|---|
| Community insights (anonymised sourcing + pricing benchmarks, opt-in) | community-insights.tsx; showcase.ts; share-outcomes-toggle.tsx | shipped |
| Thrift Radar shared venue map | radar.tsx | shipped |
| Referrals + creator affiliate program | /dashboard/referrals; affiliate.ts; vault/50-business/creator-affiliate-terms.md | shipped |
| Help center + support assistant + tickets | /dashboard/help, /dashboard/support; help-center.ts, support-assistant.ts | shipped; 83 articles written, none seeded in prod DB (US-2618 open) |
| Newsletter / drip / changelog | newsletter-*.ts, drip.ts, changelog.ts | shipped |
| Forum / groups / chat between sellers | not found | not found |

---

## 3. Pricing tiers as shipped

Source: src/lib/constants.ts FLIPDESK_PLANS (line 217) mirrored by vault/50-business/pricing.md (reviewed 2026-09-05). Every new seller gets a 14-day Pro trial (US-219; abuse check missing, US-2288 open).

| | Free | Starter | Pro | Business |
|---|---|---|---|---|
| Price | $0 | $29/mo, $290/yr | $59/mo, $590/yr | $99/mo, $990/yr |
| Active listings | 25 | 250 | 1,000 | Unlimited |
| API marketplaces | 1 (eBay only) | all | all | all |
| AI actions / mo | 25 | 200 | 750 | 2,000 |
| Connector (MCP) actions / mo | 0 | 0 | 500 | 2,000 |
| Included Standard grades / mo | 3 | 10 | 30 | 75 |
| Extension cross-listing (Poshmark, Mercari, Grailed, Vinted) | no (paid only) | yes | yes | yes |
| bulkActions / scheduledActions / compPulls / autoRelist / autolister / shippingLabels / connectorAccess | no | no | yes | yes |
| subAccounts / apiAccess / reconciliation / prioritySupport | no | no | no | yes |
| Auto-import payouts | no | yes | yes | yes |
| Included buyer tier | Buyer Free | Guard | Guard | Connoisseur |

Per-grade (GRADETHREAD_TIERS): Standard $2.99 / 48h / 1 credit; Premium $7.99 / 12h / 3 credits; Express $12.99 / 1h / 5 credits. Only Standard draws on the plan's included grades.

Grade credit packs (CREDIT_PACKS, never expire): 10 for $24.99, 25 for $59.99, 50 for $109.99, 100 for $199.99.

Action credit packs (ACTION_CREDIT_PACKS, a second currency for AI/connector actions): 50 for $4.99, 150 for $13.99, 400 for $34.99, 1,000 for $79.99. Must stay at or above Pro's implied 7.87c/action.

Buyer plans (BUYER_PLANS): Free $0; Guard $8/mo or $80/yr; Connoisseur $19/mo or $190/yr.

Shipping labels: postage passed through at eBay's rate, no markup (US-3011). Debit precedence per grade: included monthly -> credit balance -> one-time Stripe checkout.

Note: the plan feature copy names "Poshmark, Mercari & Grailed" for the extension; Vinted is live in the code but absent from that copy (constants.ts lines 270, 300, 328).

---

## 4. Open backlog themes (prd.json, 266 stories with passes:false, nextId US-3208)

Counts are by hand from titles and approximate. 61 of the 266 open ids already appear in a commit subject in the last 400 commits (US-3204..3207, 3196..3198, 3146..3151, 3059..3072, 3086..3093, 3107..3112, 3125..3138, 2718, 2727, 2403, 2668, 2619, 2351, 2842, 2709 ...). Treat "open" as "not closed in prd.json", not as "not built"; check `git log --grep` before filing a competitor gap against one.

| Area | Approx count | Most relevant ids |
|---|---|---|
| Grading depth: categories, brand KB, authenticity, sizing, measurements | ~60 | US-2209 (epic), US-2222, US-2223, US-2225, US-2210, US-2915, US-2131 |
| Marketplaces + eBay API: scopes, compliance, Depop/Etsy/Whatnot go-live, aspects, variations | ~30 | US-2472 (epic), US-1421, US-2380, US-2473, US-2474, US-1662, US-3016, US-2395, US-3042/3110 |
| Extension: store launch, revise/relist flows, sold-sync, FB/Vinted, side panel, verified badge | ~30 | US-3059 (epic), US-3071, US-2702, US-2480, US-3058, US-1757, US-3063 |
| Mobile parity (iOS + Android) | ~25 | US-2904, US-2016, US-2964, US-3000/3014, US-2499, US-2913, US-2905 |
| Money, tax, shipping, offers economics | ~20 | US-2981 (epic), US-3189/3190, US-3194, US-3193, US-3015, US-2790, US-3192 |
| Billing/legal compliance (auto-renewal, consent, price change, trial abuse) | ~15 | US-2114..2127, US-2288, US-2286, US-2687 |
| Ops, security, infra | ~20 | US-2002, US-2003, US-2313, US-2403, US-2415/2416/2417, US-2010, US-2668 |
| AI cost / model hygiene | ~8 | US-3146..3152, US-3186 |
| Analytics + "Worth My Time" planner | ~20 | US-3166..3183 (18), US-2828, US-2829 |
| SEO / content / marketing pages | ~15 | US-2095, US-2104, US-3087..3093, US-3130, US-3040/3041, US-1949 |
| Sourcing: Standing Scout, EPN, supply index | ~7 | US-3081..3084, US-3082, US-3132/3133, US-3107 |
| Inventory / import / photos | ~8 | US-3163 (epic), US-3197, US-3154, US-3156, US-3158, US-3195, US-3185 |
| Market condition index (buyer reads aggregated) | 6 | US-2708..2713 |
| Help, a11y, support | ~5 | US-2618, US-2594, US-2335, US-2450 |

---

## 5. Half-built, gated, or deliberately absent (do not mistake for missing)

Deliberate (commented in code):
- flipdesk-ebay.ts lines 2282-2292: the only 501s in FlipDesk are deliberate. flipdesk-grading.ts POST /webhook (same-process sync used; reserved for the Phase 2 public-API split) and flipdesk-images.ts POST /process (thumbnails + EXIF strip are client-side; /remove-bg replaced by on-device segmentation).
- Send-offer-to-interested-buyers (flipdesk-ebay.ts ~11961, ~12137) returns 501 with an explanatory body until eBay grants sell.negotiation. Operator stories US-1421 / US-3199.
- Shipping labels (flipdesk-logistics.ts) built and plan-gated, waiting on sell.logistics scope (US-2380).
- Depop and Etsy connectors are fully built and switched OFF by env (DEPOP_ENABLED, ETSY_ENABLED). Shown as "API - coming once approved". Operator US-2473 / US-2474 / US-3131.
- Whatnot: OAuth routes exist but the adapter is empty and the API client was modelled from no documentation (lib/whatnot-api.ts). Correctly labelled coming_soon since US-2327.
- Grailed delist is permanently impossible from a page (native confirm dialog). Disclosed; the seller gets a pending-delist reminder.
- Combined shipping / order-level discounts: out of scope by decision (vault/30-platform/flipdesk-reseller-gaps.md #6).
- Automation action set_promo_rate_pct writes listings.promo_rate_pct locally only; the manual and at-publish paths DO push to eBay Marketing API. UI copy says so.
- No server-side automation for no-API marketplaces, ever (ADR US-2476). The desktop must be open; the queue is the mitigation.
- Shopify adapter syncListings / syncOrders are notImplemented stubs, but POST /shopify/listings/pull and the webhooks cover both jobs.

Half-built or drifting:
- Extension revise and relist flows: every extension channel is "verifying" (MARKETPLACE_EXTENSION_FLOWS). Poshmark/Mercari list+delist are the only fully automatic pair. US-3071 has commits.
- Facebook Marketplace: content script exists, nothing verified, selector strategy needs a rethink.
- Vinted delist, Grailed/Vinted sold-sync: not built (US-2702).
- CSV import presets (Vendoo, List Perfectly, Shopify, eBay File Exchange, Etsy): none verified against a real export (vault/30-platform/import-presets.md).
- Extension is live in both stores at 1.0.9 (src/lib/app-links.ts); 1.1.0 waits on US-3058. /connect-extension exists. US-2718 said the Listing Kit button was compiled out of the live build on 2026-08-20; three follow-up commits exist and the story is still open, so re-verify against the deployed bundle before repeating it.
- MeasureCard: tools page and edge routes exist; US-2231 says the page is a brochure with no path into the measure flow; golden-set gate never run (US-1582).
- Grading coverage: rubric criteria for 8 of 20 garment categories; hats and bags route into the clothing rubric (US-2222/2223/2225).
- Send-offer UI (send-offers-today.tsx) renders against an endpoint that 403s in prod.
- AutoLister aspect fill: US-3044 gate says measure fill rates before the next change; US-3016 says eBay drops descriptive aspect values the AI produces.
- Cron fleet: 73 schedules exist in code; nothing in version control creates them on prod (US-2313); four fail on every run (US-2668).
- Help Center: live and empty in prod (US-2618).
- prd.json hygiene: US-2727 (migration 00634 applied 2026-08-20 per PENDING_MIGRATIONS.md line 4730), US-2479 (Vinted list is live), US-1881 (Firefox shipped), US-2698/2700 (sold-sync observers exist), US-3048-adjacent US-3198 (queue is visible), US-3191 (packing-slip.ts exists), US-3206/3207 (committed) are all still passes:false. The open list overstates the gap by a few dozen stories.
- Plan copy omits Vinted from the extension channel list.

---

## Summary (20 lines)

1. Strongest: the eBay lifecycle. 124 routes cover create, publish, revise, bulk, relist, end, import, orders, payouts, returns, INR inquiries, MBG cases, disputes, cancellations, feedback, Promoted Listings (CPS + CPC keywords), markdowns, coupons, follower email, compliance, account health. Few competitors go past publish + delist.
2. Strongest: Books and Taxes. Ledger, P&L, COGS, tax profile, tax packet, 1099-K bridge, facilitator sales tax, estimated tax, mileage, home office, receipt AI, QuickBooks sync. This is My Reseller Genie / Flipwise territory and it is already built.
3. Strongest: grading and evidence. Certificate, passport, disclosure text, return shield evidence pack, grading ROI analytics, buyer guarantee. No competitor has a condition grade as a first-class object.
4. Strong: AI listing generation (AutoLister batches, extract, aspects, size, copy, tone, quality score) plus a 29-tool Claude connector and a public REST API.
5. Strong: automations (rule engine with margin floors, scheduled drops, auto-relist, auto-counter offers), sourcing (Scout, Prospect, Radar, demand, community).
6. Strong: three clients (web PWA, iOS, Android) with most FlipDesk screens on all three; Android lacks buyer surfaces, mileage, scheduled drops; iOS lacks the paid consumer grade path.
7. Weakest: marketplace breadth. Only eBay and Shopify are live APIs. Depop and Etsy are built but switched off pending partner approval. Whatnot, OfferUp, Vestiaire, Kidizen, Amazon, TikTok Shop: nothing.
8. Weakest: extension automation depth. Poshmark and Mercari list + delist automatically; Grailed and Vinted list only; Facebook is unverified; revise and relist are manual on every extension channel. Vendoo / Crosslist / List Perfectly automate all four verbs on 8-11 channels.
9. CORRECTED 2026-09-08: the extension IS live on the Chrome Web Store and Firefox AMO (src/lib/app-links.ts; linked from the footer, /download and the dashboard), serving 1.0.9 with 1.1.0 pending the operator pass (US-3058). This line originally said it was in no store because US-1757 and US-2718 are still passes:false; that was the backlog talking, not the code.
10. Weak: sold-sync on no-API channels exists only for Poshmark and Mercari, and is passive (seller must open their sales page).
11. Weak: two eBay capabilities are written but dead in prod for lack of scopes: send offers to watchers (sell.negotiation) and shipping labels (sell.logistics).
12. Weak: shipping ops. Labels gated, no ship-by countdown, no EasyPost/Pirate Ship alternative, packing slip just landed. Competitors that bundle labels win here today.
13. Weak: grading category coverage (8 of 20 rubrics; hats and bags misrouted), which limits the moat feature to apparel.
14. Gap: Poshmark sharing exists (with hard caps) but no equivalent engagement for Mercari/Depop; no "follow back"/"bundle offer" beyond what engagement.js does.
15. Gap: no combined shipping / bundles / order discounts (deliberate).
16. Gap: no video on listings, no watermarking, no scheduled social posting for listings.
17. Gap: no seller-to-seller community (forum, chat); community is aggregate insights only.
18. Backlog: 266 open stories, but 61 have commits already; the true unbuilt themes are grading depth (~60), extension store launch + flows (~30), marketplace go-lives (~30), mobile parity (~25), Worth My Time (18, untouched).
19. Pricing is listing-volume anchored ($0/25, $29/250, $59/1,000, $99/unlimited) with AI actions, grades and connector actions as separate meters; the extension channels are free on every paid tier.
20. Before filing any competitor gap: check MARKETPLACE_EXTENSION_FLOWS, the adapter files, and `git log --grep US-xxxx`; the honest-labelling machinery here is more reliable than prd.json's passes flag.

# iOS reseller deep dive: Home, composer, Prospect, Scout (2026-09-03)

Static read of `ios/GradeThread`, `src/pages/flipdesk`, `services/edge-functions/src` and `extension-unified`. No Swift toolchain on this host, so every claim below is about the source, not a running build. File references are `path:line` at the commit this was written on.

## 1. Where things stand

The iOS app already has most of the surfaces this brief asks for. The problem is placement and depth, not absence.

| Asked for | Exists today | Where |
|---|---|---|
| Photo an item, get brand and name | Yes. Claude Vision identify with a tag photo, eBay Browse image search for garment-only (flag off) | `Prospect/ProspectView.swift`, edge `routes/flipdesk-scout.ts:785`, `lib/prospect-vision.ts:70` |
| Comparable listings for that item | Active eBay Browse comps with count, low, median, high, and two sold-search links | `flipdesk-scout.ts:1327-1405` |
| Item analytics (is this a good buy) | Buy / maybe / skip verdict, ROI, breakeven, heuristic sell-through and days-to-sell | `lib/scout-decision.ts:151`, `lib/sell-through.ts:25` |
| Scout deals with parameters | Keyword + brand only, 8 candidates, no price or margin inputs | `Scout/ScoutView.swift`, `flipdesk-scout.ts:109` |
| Buy on eBay with our partner link | No. Plain `itemWebUrl`, no EPN attribution, no eBay app hand-off | `Scout/ScoutCandidateRow.swift:52-55`, `Info.plist` has no `LSApplicationQueriesSchemes` |
| Home that surfaces the daily work | No. Fixed column: checklist, 7-day KPIs, sparkline, two link rows, aging, five stacked buttons | `Dashboard/DashboardView.swift:207-223` |
| Composer at web parity | Close. Four real gaps (policies, cross-push picker, View Item preview, draft quantity) | Section 3 |
| Cross-listing from the phone via the extension | Wired end to end, but a `list` job drains with no listing content | Section 3.3 |

Three of the ideas in the brief are already filed as stories and should be built rather than re-filed:

- **US-3080** iOS Home as a command center (priority 13). Attention strip, period picker, reorderable sections, shortcut tiles, iPad two-column.
- **US-3081** Standing Scout: saved sourcing triggers that sweep eBay every 15 minutes and push a buy-now alert (unprioritized). **US-3084** is the iOS/Android half.
- **US-3082** eBay Partner Network attribution on every outbound eBay link (unprioritized). The note on it records that the EPN campaign already exists (campaign id 5339154788) and the reporting API credentials are already on the Coolify edge. What's left is setting `EBAY_EPN_CAMPAIGN_ID` and confirming the account is approved.

The rest of this document says what to change on each surface, in the order a reseller hits them during a day: sourcing, then listing, then the home screen that ties them together.

## 2. Home screen

### 2.1 What it costs today

Home is the default tab. Taps from launch to the things a reseller needs first:

| Task | Taps | Path |
|---|---|---|
| Camera on a new item | 2 | Add tab, then "Photos first" (`ContentView.swift:1255`, `:731`) |
| Prospect an item | 1 after scrolling past six cards, else 2 via Tools | `DashboardView.swift:386-392`, `ToolsHubView.swift:64-71` |
| Scout deals | same as Prospect | `DashboardView.swift:395-401` |
| Publish an item | 3, and not reachable from Home at all | Inventory, swipe row, Publish (`InventoryListView.swift:447-455`) |
| eBay sync | 2 | Marketplaces tab, Sync now (`MarketplacesView.swift:980-989`) |
| Offers waiting on a reply | not on Home | `NegotiationInbox` only via Marketplaces |
| Returns / cases with a deadline | not on Home | `PostSale` only via Marketplaces |
| Sales list | 1 tab plus a scroll past 13 cards | `MoneyView.swift:212-235, 740` |

The five quick-action buttons are full-width and stacked, so they take a whole screen and sit under the fold. Nothing on Home carries a number that changes the seller's next action: the KPI grid is a fixed 7-day window with no tap targets (`DashboardView.swift:301-335`), and the aging card is the only row that opens an item.

### 2.2 What Home should open on

Build US-3080 as written, with these additions that the story does not cover:

1. **Attention strip first, then a camera row, then numbers.** The story already puts the attention strip on top. Under it, one horizontally scrolling row of pill buttons in this order: Add item (camera), Prospect, Scout, Publish drafts (count), Sync eBay. Publish is new to Home; it deep-links to the Inventory "Drafts" filter, which today is two taps away and invisible from Home.
2. **Port the web's Needs You ranking.** `src/pages/flipdesk/needs-you.ts:65` ranks returns, cases, disputes, inquiries, cancellations and expiring offers by deadline first, then money. iOS has no equivalent (`grep NeedsYou ios/` is empty). The attention-strip chip builder in US-3080 should reuse that rule so both platforms agree on what is urgent.
3. **Sourcing sits on Home, not under Tools.** Today Prospect, Scout and Radar are `ToolModule` sheets opened from a `square.grid.2x2` toolbar button (`ContentView.swift:1716`, `ToolModulePresentation.swift:15-37`). A reseller standing in a thrift store should not need to find a grid icon. The pill row fixes the tap count; the "Recently prospected" section below (item 5) fixes the recall problem.
4. **Home-screen quick actions and a camera widget.** There are no `UIApplicationShortcutItems` in `Info.plist` and no `performActionFor` handler. Add three: Prospect, Add item, Scout. The existing `SnapToValueIntent` and `AddItemIntent` (`Intents/GradeThreadAppIntents.swift:24, 45`) already post the right routes, so the shortcut items only need to hand off to `DeepLinkRoute.captureItem` and a new `.prospect` route. Add a Lock Screen / StandBy accessory widget that opens Prospect directly; the widget kind today only opens Money and Marketplaces (`GradeThreadWidget.swift:148-308`).
5. **"Recently prospected" section.** Prospect results are not persisted on iOS; close the sheet and the verdict is gone. Store the last 20 results locally (SwiftData, same pattern as `Persistence/Models`) and render them as a Home section with the verdict chip, the median and a "Add to inventory" action. This is the sourcing log a reseller keeps in Notes today.
6. **Drop the two link rows.** Analytics (`DashboardView.swift:242-267`) and Certified grades (`:269-292`) are full-width cards that navigate. They belong in the US-3080 shortcut grid, not as fixed sections.
7. **Shared row primitive.** `ToolRow` (`ToolsHubView.swift:286-322`), `AgingRow` (`DashboardView.swift:542`) and `DashboardCard` (`:507`) are three private copies of icon/title/subtitle/chevron. Extract one `NavRow` into `Components/` before adding Home sections so the new ones do not become a fourth.

### 2.3 Tab bar

The five tabs (Home, Inventory, Add, Money, Marketplaces at `ContentView.swift:1184-1295`) are right. Do not add a Sourcing tab; the pill row on Home and the quick actions cover it. Do give Marketplaces a badge for offers and cases with a deadline. The Home tab already carries an unread badge (`:1233`); the count that decides whether a seller loses money is on the wrong tab.

## 3. Composer: mirror the web, then move it to the extension

### 3.1 What iOS already has

`PublishDialog.swift` (2,351 lines) is a full composer: title with hard counter and quality meter, condition and condition description, category search, required and recommended specifics with autosuggest and AI fill, coverage meter, description blocks with AI rewrite, price, best offer with auto-accept and auto-decline, fixed or auction with duration and reserve, variations matrix, scheduled publish with timezone, promoted ad rate, quality score, profit estimate, and comps. The Listing Kit (`Marketplaces/ListingKit/ListingKitView.swift`) reads the same `/platform-fields` route as web and can queue a job for the desktop extension. None of that needs rebuilding.

### 3.2 The four real gaps

| Gap | Web | iOS | What to build |
|---|---|---|---|
| Business policy pickers (shipping, payment, returns) | `composer/policies-card.tsx:32` | Only via an applied template (`Templates/ListingTemplate.swift:19-21`) | A three-picker section fed by `GET /api/flipdesk/ebay/policies`. Without it a seller cannot change shipping per item, which is the most common per-listing edit |
| Push-to picker with per-platform price override | `composer/push-to-card.tsx:41,90` | Absent | A platform chip row on the Listing Kit with a price field per chip. This is the cross-listing builder the brief names |
| eBay View Item preview | `ebay-view-item-preview.tsx` | Description string only (`DescriptionBlocksService.swift:106`) | A sheet that renders the same HTML in a `WKWebView`. The web component already builds the markup; expose it as an edge route returning HTML so both clients share one renderer |
| Draft-time quantity | `price-card.tsx:315` | Live-listing only (`ItemCanvasView.swift:680`) | A stepper next to price in `PublishDialog` |

Also filed already: **US-2964** description block editor parity (deletes the local render path in `ListingDescriptionTemplate.swift`), **US-3014** mileage and receipts, **US-2274** item columns owning their eBay specifics.

Not gaps, because nobody has built them anywhere: subtitle, charity, private listing, lot size, VAT, package weight and dimensions, calculated vs flat shipping as a dedicated field. If the composer is to be the full eBay experience these are the next tier, starting with package weight and dimensions since calculated shipping needs them.

### 3.3 The extension hand-off is broken for new listings

This is the finding that matters most for "move it to the extension."

- Every client enqueues a `list` job with an empty payload: web `listing-kit.tsx:824`, `review.tsx:420`, iOS `ListingKitView.swift:358` via `ExtensionQueueService.swift:104`, Android `ExtensionQueue.kt:127`. The server comment at `flipdesk-extension-queue.ts:311-316` says so in as many words.
- The server enriches only `revise` and `relist` rows (`:265-308`) and stamps a locale (`:328`). A `list` row is stored as `{platform, itemId, listingId, locale}`.
- The extension turns that row into a job with nothing added (`lister/job-store.js:489-509`), then `GT.runFlow` fills title and description from the payload unconditionally (`lister/common.js:516-517`). Nothing is filled, the probe passes, and the flow reports success.

So a cross-post queued from the phone opens the marketplace form empty. The interactive web path works because the page builds the payload itself (`src/lib/lister-extension.ts:296`). Fix it once on the server: when a `list` row is claimed, hydrate it with the same fields `buildListerPayload` sends (title, description, price, brand, color, size, category, condition, tags, ordered photo URLs capped at the platform's `maxPhotos`, from `listings.platform_fields` when the Listing Kit ran and from the item otherwise). Neither the phone nor the extension should build listing content.

Two smaller extension items:

- iOS restricts queue kinds to `list` and `delist` (`ExtensionQueueService.swift:49`) while the server has four. `revise` and `relist` already work from the server side (US-9202, US-9203). Adding them to the iOS enum and to the live-listing sheet gives the phone the full lifecycle.
- **US-2718** (the extension button compiled out of the production web build) and **US-2727** (the writeback INSERT never succeeding) are listed as blockers of the extension epic. The phone path depends on both.

### 3.4 What "the composer in the extension" should mean

Do not port the composer UI into the extension. Keep one composer per client and make the extension a dumb filler of a payload the server owns. That is what the ADR requires anyway (`vault/60-decisions/adr-no-server-side-marketplace-automation.md`): the extension runs the click in the seller's own browser, and the content comes from GradeThread. The hydration fix in 3.3 is the whole of that work.

## 4. Prospect: the sourcing camera

### 4.1 What it does today

`ProspectView.swift` (616 lines): two capture slots (garment and tag), camera or library, optional cost, "Find comps," a result card with grade, median and range, comp count, two sold-search links with the query shown, tap-to-correct re-pull with no AI charge, "Add to inventory," and a link to Radar Nearby. The edge does identify (Claude with a tag, eBay image search without one), category suggest, active comps, shadow grade, sell-through forecast, buy verdict, and a sourcing ceiling.

### 4.2 Gaps, in order of value to a reseller

1. **Camera-first, not form-first.** The screen opens on two empty slots and a button. Open on the viewfinder with the garment slot armed and a "Tag" toggle; a second frame is the exception, not the default. The Capture module already has the live camera and tag-quality checks (`Capture/TagPhotoQuality.swift:40`) that Prospect should reuse.
2. **Decode what the server already sends.** `ProspectResponse` (`ProspectTypes.swift:150-175`) drops `ceiling` and `stats.basis`. The ceiling is the single most useful number for a buyer ("pay at most $X for your target ROI") and the basis line says whether the price came from sold data, own sales or active asking prices. Both are free.
3. **Turn on eBay image search.** `SCOUT_EBAY_IMAGE_SEARCH_ENABLED` defaults off and is not in `.env.example` (`lib/scout-identify.ts:168-176`). With it off, a garment photo with no tag goes to Claude, which costs an AI action and cannot see eBay's catalog. Add the var to `.env.example`, turn it on in prod, and the garment-only path becomes free and faster.
4. **Sold data.** Every price today is an active asking price (`source: "active"`, `flipdesk-scout.ts:1399`). Marketplace Insights is built (`lib/ebay-client.ts:5011`) but needs eBay approval and the `EBAY_MARKETPLACE_INSIGHTS` flag. Apply for it. Until then, show "asking prices" in the label, and blend the seller's own `sales` rows in (the fallback in `lib/sold-comps.ts:174` already does this when there are three or more).
5. **Real sell-through.** `forecastSellThrough` is a heuristic from price position (`lib/sell-through.ts:53-54`). Once Insights is approved, sold count over active count for the same query is a measured rate. Until then say "estimated" on the chip.
6. **Persist and resume.** See 2.2 item 5. Also carry the Prospect result into the inventory row it creates (the identity, category, grade and median are all already in the response), so "Add to inventory" does not throw the work away.
7. **On-device pre-pass for the tag.** `Vision/TagTextRecognizer.swift` runs `VNRecognizeTextRequest` for Capture but not for Prospect. Running it on the tag frame before upload gives an instant brand and size guess, lets the app pick the Claude path only when OCR is unsure, and shows something on screen during the network round trip.
8. **Demand board on the phone.** `GET /api/flipdesk/demand` (`routes/flipdesk-demand.ts:19`) returns what buyers are asking for; the web links each term into Scout. iOS has no caller. A "What buyers want" strip on the Prospect empty state and on Home turns sourcing from reactive to targeted.
9. **Radar map.** iOS Radar is a distance-sorted list (`Prospect/RadarNearbyView.swift:173-183`) and cannot link a source to a venue (`:195, :218`). MapKit is one import away. The venue-link form is a `POST /my-stores/link` call that already exists.
10. **Barcode.** The web Buy decision accepts a barcode (`scout-buy.tsx`); iOS Prospect does not. `AVCaptureMetadataOutput` on the same viewfinder gives a UPC path for shoes and sealed goods where a tag photo is not the right input.

## 5. Scout: from a search box to a deal finder

### 5.1 What it does today

Keyword and brand in, eight candidates out, each shadow-graded and scored for margin against the cached value at grade (`lib/scout-scoring.ts:69`). Sort and "actionable only" exist. iOS auto-resolves the category (`ScoutStore.swift:70-75`), which is better than the web's typed category id. The row has a plain "View on eBay" link.

### 5.2 What the brief asks for and what is missing

| Wanted | State | Where it goes |
|---|---|---|
| Target profit in $ or % | Absent from `POST /scout` (`flipdesk-scout.ts:109`). `decideBuy` already has ROI thresholds and `sourcingCeiling` computes a max price for a target ROI (`lib/scout-decision.ts:97, 151`) | Add `minMarginCents`, `minMarginPct`, `maxTotalCents` to the request; filter server-side; show the ceiling on each row |
| Max price, BIN only, ending soon, condition, free shipping, newly listed | Absent | Browse filters `price`, `buyingOptions`, `conditionIds`, `deliveryOptions`, sort `newlyListed` and `endingSoonest`, all supported by `searchBrowseComps` (`lib/ebay-client.ts:4736`) but not exposed |
| Total price including shipping | Asking price only | US-3081 already specifies `total = asking + cheapest shippingOptions.shippingCost` and null when absent. Use the same rule here so the trigger and the manual scan agree |
| More than 8 results | `MAX_CANDIDATES = 8` (`:96`) because every candidate is shadow-graded | Two-phase: fetch 50 by price filter with no AI, rank by asking-vs-median, then shadow-grade only the top 8 on demand ("Grade this one") |
| Buy on eBay through our partner link | No EPN anywhere. The only `campid` in the repo is a stripper regex (`extension-unified/research/flip-format.js:175`) | US-3082: send `X-EBAY-C-ENDUSERCTX` on Browse calls, map `itemAffiliateWebUrl` into `url`. All three surfaces then get attribution with no per-client link building |
| Open the eBay app on the item | Opens Safari in-app via `Link` | Use `UIApplication.shared.open` on the `ebay.com/itm/...` URL. iOS hands an ebay.com universal link to the eBay app when it is installed; `SFSafariViewController` and `Link` in a sheet do not. No `ebay://` scheme is needed and none should be added. Confirm against the EPN terms that an in-app purchase reached this way is credited; if it is not, fall back to Safari for the affiliate URL and offer "Open in eBay app" as the secondary action |
| Save a search and get alerted | Nothing on either client. The only match-and-notify crons are buyer-side (`jobs-demand-matches.ts`, `jobs-portfolio-alerts.ts`) | US-3081 and US-3084. The APNs pipeline (`lib/apns.ts`, `lib/transactional-push.ts:29`) is built and has no sourcing producer yet |
| Value basis on each row | `ScoutCandidate` omits `valueBasis` (`ScoutTypes.swift:33-53`) | Decode it and show the web's `ValueBasisNote` text |
| Bought it | Web has "Bought it, add to inventory" (`scout-buy.tsx:157-186`); iOS Scout rows do not | Row action that calls `POST /scout/buy` (`flipdesk-scout.ts:1406`) with the asking price as cost |

### 5.3 The Scout screen, reworked

Top: a query bar with brand chips from the seller's own top brands (the data behind the web's "Top brands by profit" widget). Under it, a single "Deal filter" sheet: I want to make at least [$ / %], max total price, condition, buying option, sort. Results as cards with the photo, asking vs median, the margin after fees, the ceiling, the basis line, and two buttons: "Buy on eBay" (affiliate URL, eBay app) and "Bought it." A "Save as alert" button at the top of the results turns the current filter into a Standing Scout trigger once US-3081 lands.

## 6. Other additions that would help a reseller, ranked

1. **Sell-through and days-to-sell from real data.** Marketplace Insights approval unlocks every analytics claim in this document. It is an operator task with no code beyond flipping the flag.
2. **Offer inbox on Home with one-tap counter.** `Marketplaces/Negotiation` exists; offers expire on a clock and are money left on the table. The attention strip in US-3080 surfaces the count; add accept / counter / decline actions in the strip's detail sheet.
3. **Shipping label from the sale row.** `Fulfillment/FulfillmentView` is reachable only from a Money card (`MoneyView.swift:589`). A sold item should offer "Ship it" in its push notification and on the Home attention strip.
4. **Sourcing trip mode.** A session that groups every Prospect result and every "Bought it" between a start and a stop into one `sources` row with a total spend, so the cost basis lands on each item without typing. `Sources` and `acquired_source: "scout"` already exist; the trip is the missing container.
5. **Death pile counter.** Items at `sourced` or `photographed` status older than N days, on Home, with a "Photograph next" that opens the camera on that item. The aging card is close but only covers listed items.
6. **AutoLister from the camera roll on the phone.** `AutoLister/` groups photos with a perceptual hash (`DHash.swift`, `PhotoGrouping.swift`) and generates drafts. It is under Tools. It belongs on the Add tab as "Bulk from photos."
7. **Repricing nudges as push.** `Pricing/RepricingView` exists; stale listings (the web's `flipdesk.stale` widget) could push one nudge a day with a one-tap markdown.
8. **Duplicate check while prospecting.** Before "Add to inventory," search the seller's own inventory by brand and style code to catch a second copy of an item they already hold.
9. **Buyer-side tools stay in Settings.** `Buyer/` (alerts, trust score, portfolio, guarantee) is a different persona and is correctly out of the seller's way. Leave it.

## 7. Suggested slate

Ordered by value over cost. Existing IDs are named; new ones get filed at `prd.json.nextId` when picked up.

| # | Work | Story | Size |
|---|---|---|---|
| 1 | Hydrate `list` queue rows on claim so a phone-queued cross-post fills the form (3.3) | new | S, edge only |
| 2 | Set `EBAY_EPN_CAMPAIGN_ID`, send the affiliate header, map `itemAffiliateWebUrl` (5.2) | US-3082 | S, edge + operator |
| 3 | iOS Scout and Prospect open eBay links with `UIApplication.open`; decode `ceiling`, `basis`, `valueBasis` (4.2, 5.2) | new | S, iOS |
| 4 | Scout deal filters: target $ / %, max total, BIN, condition, sort; two-phase ranking (5.2) | new | M, edge + iOS + web |
| 5 | Home command center with the pill row, Needs You port, drafts shortcut, quick actions, camera widget (2.2) | US-3080 plus additions | L, iOS |
| 6 | Prospect camera-first, on-device tag OCR pre-pass, persisted results, barcode (4.2) | new | M, iOS |
| 7 | Turn on `SCOUT_EBAY_IMAGE_SEARCH_ENABLED`; apply for Marketplace Insights (4.2) | operator | S |
| 8 | Composer: policy pickers, push-to picker with per-platform price, View Item preview, draft quantity (3.2) | new, one story each | M, iOS (+1 edge route for the preview HTML) |
| 9 | Standing Scout and iOS alert handling (5.2) | US-3081, US-3084 | L |
| 10 | Radar map and venue linking on iOS; demand strip on Prospect (4.2) | new | M, iOS |
| 11 | iOS extension queue gains `revise` and `relist` (3.3) | new | S, iOS |

Items 1 through 3 are a week of work and change what a seller can do with the phone today. Item 5 changes whether they open it.

# Cross-listing: where it stands, where the bar is, and the plan to clear it

Date: 2026-09-21
Status: proposal, not yet decided. Three decisions are called out in section 7.
Owner: FlipDesk
Supersedes nothing. Extends `2026-09-11-crosslist-list-everywhere-and-sold-delist-design.md` (landed as US-3367) and the September research in `vault/50-business/competitor-landscape-2026-09.md`.

## 0. The verdict in five lines

1. The machinery under cross-listing is deeper than any competitor's. eBay has a 124-route lifecycle, Depop and Etsy connectors are finished, the extension has list, delist, sold-sync, a queue, a worker tab and a side panel, and every claim the UI makes is pinned by a drift test.
2. The seller does not feel any of that, because the parts that touch a marketplace form have not been verified by a human since August, every "revise" and "relist" is still a manual step, delist works on two of five channels, and the four pickers (category, size, condition, colour) are left blank on every cross-post. Sellers call that a "thin copy", and it is the second most common reason they cancel a crosslister.
3. On iOS the only way to cross-list is a copy-and-paste kit reached by swiping a row in AutoLister drafts. The main item screen has no cross-list button at all. Nothing on the phone can put a listing on Poshmark without a desktop browser later.
4. Two channels a clothing seller expects (Depop, Etsy) are built and switched off waiting on an email and a form. One channel (Facebook) is advertised and disabled. One production variable (`EXTENSION_ALLOWED_ORIGINS`) has been measured empty since August.
5. The plan is therefore mostly finishing and verifying, not building. The one genuinely new build is attended listing on the phone (section 6, phase 3), which is the same mechanism as the WebView delist that already ships.

The rule that holds throughout: `vault/60-decisions/adr-no-server-side-marketplace-automation.md`. Nothing below stores a marketplace credential, runs a headless browser in our cloud, or answers a CAPTCHA. Every improvement is inside that line.

## 1. What we have today, channel by verb

Verified against the tree on 2026-09-21. "Live" means a seller on prod can do it today. "Built" means the code is finished but not reachable in prod. "Verifying" is the repo's own word for a flow whose selectors nobody has confirmed on the live form (`MARKETPLACE_EXTENSION_FLOWS`, `src/lib/constants.ts:1863`).

| Channel | Mechanism | List | Revise | Delist | Relist | Sale detection | Last human check of the form |
|---|---|---|---|---|---|---|---|
| eBay | API | live | live | live | live | webhook + sync, minutes | n/a (API) |
| Shopify | API | live | live | live | none | webhook | n/a |
| Depop | API, `DEPOP_ENABLED=false` | built | built | built | none | built (webhook + orders) | waiting on partner approval |
| Etsy | API, `ETSY_ENABLED=false` | built | built | built | none | built (receipts poll) | waiting on keystring |
| Poshmark | extension | live, text fields only | verifying | live | verifying | passive read + hourly poll, selectors `lastVerified: null` | list 2026-08-20, delist 2026-08-11 |
| Mercari | extension | live, text fields only | verifying | live | verifying | same as Poshmark, `lastVerified: null` | list 2026-08-20, delist 2026-08-11 |
| Grailed | extension | live | verifying | impossible (native confirm dialog) | none | none | list 2026-08-10 |
| Vinted | extension, 22 locales | live | verifying | verifying | verifying | none | list 2026-08-11 |
| Facebook | extension, `enabled: false` | "list manually" | none | none | none | none | never |
| Whatnot | OAuth only, every method 501 | none | none | none | none | none | never |

Sources: `extension-unified/lister/selectors.js` (the `lastVerified` lines), `extension-unified/sync/selectors.js:24,124`, `services/edge-functions/src/lib/marketplace-adapters/index.ts:19-34`, `services/edge-functions/src/lib/cross-listing-sale.ts:38-65`.

Three more facts that shape the plan:

- **Every extension flow is desktop only.** Each platform block carries `mobile: { enabled: false, lastVerified: null }`, so the Firefox-for-Android drain refuses every job by design until a human verifies the mobile DOM.
- **The four pickers are the whole thin-copy complaint.** `selectors.js:129` records the decision: colour, size, category and condition are option lists, so the lister fills every text field and leaves those four to the seller. US-3210 built the proposal and the option-matching logic and the kit now says what to pick; the DOM half that actually selects the option is unbuilt.
- **The queue is the bridge between phone and desktop, and it works.** `extension_work_queue` (migration 00588) with `list | delist | revise | relist`, drained on a 5-minute alarm, on the worker tab every 60 seconds, and on a web nudge. The phone apps enqueue into it. The copy that says "queued is not live" is byte-identical across four clients on purpose.

### 1.1 Web

- **Two places to choose channels.** The composer's Push-to card (`src/components/flipdesk/composer/push-to-card.tsx:32`) offers API channels only; extension channels appear there as a dashed, unselectable strip. The Listing Kit (`src/components/flipdesk/listing-kit.tsx:2098`) offers extension channels only, with the "List everywhere" button from US-3367. A seller who wants eBay plus Poshmark plus Mercari touches two different controls in two different parts of the same page.
- **The Marketplaces page is 2,462 lines and four tabs**, carrying the eBay and Shopify connectors, the extension setup gates, the channel picker, the Vinted locale picker, the queue viewer, the sync review queue and the auto-end toggle. It is complete and it is not a page a new seller can read.
- **Bulk publish is eBay only.** `POST /publish-batch` takes item ids and no platform (`src/hooks/use-autolister.ts`). There is no "list these 40 items everywhere".
- **Status after a push is honest but scattered.** `deriveChannelState` (`src/lib/channel-state.ts`) gives live / queued / delist_queued / prefilled / failed / ended / sold / unconfirmed per row, and the item page renders it (`cross-listings-card.tsx`). The listings table does not show per-channel state on a row, so the answer to "where is this jacket live" is one click away on every item.

### 1.2 iOS

- **Cross-listing is reachable from one place.** `ListingKitView` is instantiated only from `AutoLister/Drafts/DraftsLibraryView.swift:80` (swipe action at `:447`). `PushToSheet`, the only multi-select push UI, opens only from inside that kit. `ItemCanvasView` has no cross-list affordance. An item that did not come through AutoLister cannot be cross-listed from the phone.
- **The kit is copy and paste.** Per-field Copy to `UIPasteboard`, "Copy all", a `ShareLink` of plain text, and "Run on my desktop" which enqueues. The Marketplaces screen tells the seller so: "open a drafted item and tap Listing Kit to copy each platform's tailored fields ... straight into the app" (`MarketplacesView.swift:667`).
- **Attended delist exists and is the right shape.** `Marketplaces/WebDelist/` opens the marketplace in a visible `WKWebView`, the seller signs in as themselves, and the app clicks through the end-listing flow while they watch. Enabled for Poshmark and Mercari (`DelistFlows.generated.swift:48,61`), generated at build time from the extension's selectors, with the App Review wording already written in `vault/10-ops/ios-webview-delist-app-review.md`.
- **Two channel taxonomies disagree.** `CrossListingRegistry.swift:81-88` is the mirror of `constants.ts` and is pinned by a test. `MarketplacesView.swift:257-275` keeps an older `ChannelTier` with `phasedChannels` at `:364-368` naming Poshmark, Mercari, Grailed and Depop as "Copy & paste kit"; Grailed is absent from the registry and Depop is `api_pending` there.
- **Revise and relist have services and no UI.** `ExtensionQueueService` exposes `enqueueRevise` and `enqueueRelist`; nothing on a screen calls them.

### 1.3 Android

A generation behind iOS. Full eBay stack, the queue mirror, pending delists, no `cross-push` call, no push-to sheet, no WebView delist. The platform-fields dialog is read-only. This plan sequences Android after iOS parity and does not detail it.

### 1.4 Production state

- `EXTENSION_ALLOWED_ORIGINS` on the Coolify edge measured empty on 2026-08-22 and again on 2026-09-05 (`vault/10-ops/env-reference.md:160-183`). `/health/ready` reports it under `checks.features.extension_origins`. The two Cloudflare Pages build variables are set, so the buttons render; whether every extension fetch survives without the header has never been tested from a real extension context.
- The stores serve extension 1.0.9. 1.1.0 (redesigned overlay, queue view, worker tab, side panel) is committed and waiting on the operator pass (US-3058).
- The extension writeback INSERT that failed on every environment until migration 00634 has been fixed in prod schema since 2026-08-21 and nobody has retried a Send to extension since (US-2727).
- Depop: the partner email in `vault/60-decisions/adr-depop-partner-application.md` is drafted and unsent. Etsy: the Seller App registration in `adr-etsy-api-application.md` is drafted and unsubmitted.

## 2. Where the bar is

From `vault/50-business/competitors/` (2026-09-08, 30 forum threads, Trustpilot, eBay Community) and a re-check of vendor pages and roundups on 2026-09-21. Nothing moved in two weeks except that Crosslist's iOS app went to 0.4.5 and every roundup now leads with "one form, background posting, auto-delist, mobile app".

What every serious competitor ships (table stakes):

| Capability | Vendoo | Crosslist | List Perfectly | Nifty | FlipDesk today |
|---|---|---|---|---|---|
| One listing form for all channels | partial (a form per channel) | yes | no (tabs) | yes | no (two controls) |
| Category, size, condition set on Poshmark and Mercari | yes, imperfectly | yes | partial by tier | yes | no |
| Auto-delist on sale, all channels | 7 channels, extension | Gold tier and up | $99 tier, qty 1 only | cloud | eBay and Shopify server-side; Poshmark and Mercari via extension; Grailed never; Vinted unverified |
| Revise from the tool reaches every channel | yes | yes | Pro and up | yes | eBay and Shopify only |
| Relist stale listings, bulk | 240 at once | yes | Pro and up | yes | eBay only |
| Import existing closets and link duplicates | yes | yes | Business and up | yes | Poshmark and Mercari via extension, eBay and Shopify via API, no linking across channels |
| Mobile app that can list to no-API channels | yes (iOS and Android) | yes, "except autodelist for some" | none | PWA | copy and paste kit |
| Work runs while the laptop is closed | no | "background" (still extension) | no | yes (cloud, refused by our ADR) | queue drains when the desktop opens |
| AI listing from photos | prompt-driven | yes, add-on | Pro Plus | yes, credits | yes, plus grade, measurements, defects |
| Sharing, offers, follow automation | Pro | limited | Pro | headline | Poshmark engage with caps, included |

What no competitor does, and we already do: grade-backed condition line, measurements from a photo, defect capture, certificate and verify page, Return Shield evidence, eBay post-sale depth, books and taxes, no-password architecture. The forum research is blunt that nobody asked for a grade, and that the same people ask for fewer INAD returns and a way to stop typing measurements. The cross-listing plan below does not change that pitch; it removes the reasons a switcher would leave before they ever see it.

The complaint ranking that matters (`forum-sentiment.md` section 4): auto-delist that does not fire (14 sources), thin copies (7), predatory tiers (8), computer must stay on (3), desktop-only or mobile-only (5). The first two are ours to fix in code. The last two are the ADR's accepted cost, and the honest answer to them is the phone queue plus the worker tab, both of which exist and neither of which is verified on a phone.

## 3. The gaps, ranked by what a seller feels

Rank is (how often sellers raise it) times (how far the tree is from it). Story ids are open in `prd.json` unless marked NEW.

| # | Gap | Evidence | Where the tree is | Closes with |
|---|---|---|---|---|
| 1 | Cross-post leaves the four pickers blank | thin copies, 7 sources; `selectors.js:129` | proposal and option matching built (US-3210 AC2, AC5); DOM selection unbuilt | US-3210 AC3, AC4, AC6 |
| 2 | An edit in FlipDesk does not reach Poshmark or Mercari | every competitor; `MARKETPLACE_EXTENSION_FLOWS` revise = verifying everywhere | revise selectors written, `lastVerified: null`, pending-revise banner and queue kind exist | US-3071 |
| 3 | A sale on Poshmark or Mercari is only noticed if the seller opens their sales page, and only on a desktop | auto-delist, 14 sources | passive read plus hourly poll, consented, `lastVerified: null` on both channels | US-2698, US-2700, then US-2702 |
| 4 | Nothing on the phone can list to Poshmark without a desktop later | mobile, 5 sources; Vendoo and Crosslist both do this | attended WebView delist ships for Poshmark and Mercari; the same runner can fill the create form | NEW-A (section 6, phase 3) |
| 5 | The phone's cross-list entry is hidden behind a swipe on AutoLister drafts | iOS inventory, section 1.2 | `PushToSheet` exists | NEW-B |
| 6 | Two places to pick channels on the web composer | section 1.1 | both controls exist, both honest | NEW-C |
| 7 | Vinted delist and relist unverified, Grailed relist absent | Vinted is the one market with no good tool | selectors written | US-3071 AC3, US-2479 |
| 8 | Depop and Etsy switched off | Vendoo shipped Depop API 2026-07-20 | connectors finished | US-3131, US-2473, US-2474 (operator) |
| 9 | Nothing runs on a phone browser | `mobile.enabled: false` on every platform | worker tab built (US-3061), never run on a phone | US-3061 AC5, AC9 (operator) |
| 10 | No bulk cross-list | Vendoo 240 at once, Crosslist bulk | `crosslist_to` automation and per-item List everywhere exist | NEW-D |
| 11 | The stores serve 1.0.9, the tree is at 1.1.0 | Flyp ships weekly | packaged, waiting | US-3058 (operator) |
| 12 | `EXTENSION_ALLOWED_ORIGINS` empty in prod | measured twice | one variable | US-2718 AC2 (operator) |
| 13 | Import does not link the same garment across channels | switching flow is the acquisition channel | closet import per channel, no cross-channel join | US-3197 |
| 14 | Facebook advertised as extension tier, selectors disabled | 4 sources want Facebook and Vinted that do not break | content script exists, unverified | US-2480 (after 1 to 9) |
| 15 | A marketplace redesign is found by sellers, not CI | US-1875 shipped that way | capture script and spec built, zero fixtures captured | US-3063 AC8 (operator) |
| 16 | Per-channel state is one click away on every item | section 1.1 | `deriveChannelState` exists | NEW-E |

Rows 1 to 3 are the ones that decide whether a switcher from Vendoo stays. Rows 4 and 5 decide whether the phone is a real client. Everything below row 9 is reach, and reach on top of an unreliable core inherits the loudest complaint in the category.

## 4. The experience we are building toward

Written as what the seller does, so each phase can be checked against it.

**On the web.** One "List on" panel at the top of the composer with every channel the seller sells on, API and extension alike, each carrying its live state (live, queued, needs you, ended, sold) and one verb. Tick the channels, press List, and the API channels publish now while the extension channels queue and drain, paced, in the seller's own browser, with category, size, condition and colour already selected on the marketplace form so the seller confirms four picks rather than making them. A price or description change saved in FlipDesk becomes a revise job on every live channel. A stale listing gets one Relist button that ends the old copy only after the new one is confirmed live. When the garment sells anywhere, every other listing is ended within minutes if a browser is open and the seller is told exactly what is still live if not, with a link to each one. The listings table shows the channel strip on every row.

**On the phone.** The item screen has "List on more marketplaces" next to Publish to eBay. Tapping it shows the same channel panel with the same states. API channels publish from the phone now. For Poshmark and Mercari the seller chooses: queue it for the desktop, or list it now in an attended web view where they are signed in as themselves, the app fills the form while they watch, they confirm the pickers, and the listing URL writes back the moment the page lands on it. A sale elsewhere raises a push notification naming what is still live, with End it now (attended) or Queue for desktop. Nothing runs in the background, nothing stores a password, and the consent screen says so in the seller's words.

**Under it.** One channel registry per client, pinned to `constants.ts` by test. Every flow verified against a captured fixture in CI and against the live form by a human on a recorded date. A status page generated from the selector self-check. A per-item delist log that reads "sold on eBay 14:02, ended on Poshmark 14:06, Mercari 14:07".

## 5. What we deliberately do not do

- **No cloud runner, no stored session, no CAPTCHA solving.** The ADR stands. The cost (desktop browser must open for extension work) is answered by the queue, the worker tab and attended listing on the phone, and stated in the UI rather than hidden.
- **No auto-submit on a marketplace form.** The seller presses Post on Poshmark and Mercari. The lister fills, proposes, and stops.
- **No Whatnot work.** The API was modelled without documentation (US-2327). It stays `coming_soon` until Whatnot publishes a write API.
- **No Vinted API work** while Pearson Media has no EU or UK entity (US-3280, ADR section 6.1).
- **No new marketplace before rows 1 to 9 are green.** Facebook and Etsy go-live ride behind reliability.

## 6. The plan

Six phases. Phase 0 is operator work with no code and should happen this week, because three of the top twelve gaps are a variable, a store upload and an email. Phases 1 and 2 are the switcher-retention work. Phase 3 makes the phone a real client. Phases 4 to 6 are reach and scale. Weeks are calendar estimates for one engineer plus the founder on the operator items; phases 1, 2 and 3 can overlap once phase 0 is done.

Every code story below follows the repo's existing rules: tenant scoping with a `tenant-isolation_test.ts` case for any new edge route, the US-1108 migration triple for any schema change, `npm run verify` green, the `closing-a-coverage-gap.md` order for anything that flips a channel's tier or flow.

### Phase 0 (this week): unblock what is already built

All operator. Each item is a story that already exists and is open only on a human step.

| Step | Story | Action | Proof |
|---|---|---|---|
| 0.1 | US-2718 AC2 | Set `EXTENSION_ALLOWED_ORIGINS=chrome-extension://apinefjjagmigmobdlbiilhbjebmjkdh` on the Coolify edge and redeploy | `/health/ready` reports `extension_origins: ok` |
| 0.2 | US-2727 AC7 | On a logged-in Poshmark tab, press Fill Poshmark now on one draft | The listings row gains a `listing_url`; the kit shows "live" |
| 0.3 | US-3058 | Load 1.1.0 unpacked, screenshot the overlay on six sites, package, upload to Chrome and Firefox | Stores serve 1.1.0; SUBMISSION.md updated |
| 0.4 | US-3131 AC4, US-2473 | Send the Depop email as drafted, from a real address | Outcome recorded in `adr-depop-partner-application.md` section 3 |
| 0.5 | US-3131 AC1 | Register the Etsy Seller App with the values in `adr-etsy-api-application.md` section 2 | Keystring recorded in section 4 |
| 0.6 | US-2698, US-2700 | In the popup, run Check selectors on your own Poshmark and Mercari sold pages | `sync/selectors.js` gets a real `lastVerified` and `version` |
| 0.7 | US-3063 AC8 | Capture the eleven selector fixtures with `scripts/capture-selector-fixture.mjs` from a logged-in Chrome | Fixtures committed; the Playwright spec runs in `verify --e2e` |
| 0.8 | US-3061 AC9 | Queue one list and one delist from the phone, open the worker tab on a desktop, confirm both complete with no click | Result recorded in the story notes |

Two small code fixes ride along: CLAUDE.md line 176 says "all 7 platforms are registered" and the registry holds ten; `marketplace-specs.ts:28-31` says Facebook and Whatnot are unspecced and both have specs.

### Phase 1 (weeks 1 to 3): copy everything, edit anywhere

The thin-copy and edit-sync gaps. Poshmark and Mercari first; that is where clothing cross-listing pays.

**1.1 Drive the pickers (US-3210 AC3, AC4, AC6).** The mapper and the option matcher exist. Build the DOM half in `extension-unified/lister/common.js`: for each of category, size, condition and colour, when the proposal is exact or likely, open the picker and select the option whose text matches; when none matches, leave it untouched and report which one. Write every outcome back through `POST /listings/extension-writeback` and show it in the kit as "We set category, size and condition. Confirm colour." The rule that a pre-selected option is never overwritten stays and is tested. Capture the option lists of the live pickers as fixtures (AC6) so the mapper's top-20-categories test runs in CI.

**1.2 Revise reaches Poshmark and Mercari (US-3071 AC1, AC5).** Verify the revise selectors on the live edit forms, set `lastVerified`, flip `enabled`, flip `MARKETPLACE_EXTENSION_FLOWS.{poshmark,mercari}.revise` to `live` in the same commit. The pending-revise banner, the queue kind and the mobile enqueue already exist; nothing new on the web or the phone.

**1.3 Relist on Poshmark and Mercari (US-3071 AC2).** Same shape. The relist route already ends the old row only after the copy is confirmed live (`use-relist-extension.ts`).

**1.4 One "List on" panel in the composer (NEW-C).** Replace the split between the Push-to card (API only) and the kit's checklist (extension only) with one panel above the kit that lists every channel from `CROSS_LISTING_PLATFORMS` filtered by the seller's chosen channels, each row showing `deriveChannelState`, the per-channel price, and the disabled reason for `api_pending` and `verifying`. One button. API channels go through the existing eBay dialog and `cross-push`; extension channels go through the same `cross-push` call that enqueues (US-3367 A1). Delete nothing yet; the per-tab "Fill X now" stays as the attended path. Guard: the existing mechanism and label vocabulary tests, plus a new test that the panel offers exactly the channels the two old controls offered between them.

**1.5 Channel strip on the listings table (NEW-E).** One column rendering the per-channel state dots from the rows already fetched, with the same link and End verb the item card offers. No new endpoint.

Verification for the phase: a seller lists one garment to eBay, Poshmark and Mercari from one panel; the Poshmark form opens with title, description, brand, price, category, size and condition filled and only colour left to confirm; a price change in FlipDesk produces a revise job that completes on both channels; the listings row shows three live dots.

### Phase 2 (weeks 2 to 5): a sale ends everything, and the seller can see it happen

The number one complaint in the category. The engine exists (`autoEndCrossListings`, `endOtherListings`, the delist queue, the wake-on-sale push, the pending-delist banner). What is missing is detection on the extension channels being verified, coverage on Vinted, and the seller being able to see the guarantee working.

**2.1 Sold-sync verified and on by default for consenting sellers (US-2698, US-2700 after 0.6).** With `lastVerified` set, surface the hourly poll consent in the web Marketplaces page and the phone's Marketplaces screen as the first thing under "Selling", not the last. The consent sentences are already pinned by test.

**2.2 Vinted delist verified (US-3071 AC3, US-2479).** Four locales minimum; an uncovered locale still says "end it yourself" with the link.

**2.3 The delist log (NEW-F).** A per-item timeline built from `listing_publications`, `extension_work_queue` completions and `delist_requested_at` stamps: "Sold on eBay 14:02. Poshmark ended 14:06 (your browser). Mercari ended 14:07. Grailed: end it yourself (link)." Rendered on the item page and in the sale's Record Sale confirmation. This is the sentence the marketing page needs and the sentence support needs when a seller says it did not fire.

**2.4 The nudge when nothing is draining (NEW-G).** If a delist row has waited longer than a threshold (30 minutes by default) with no drain heartbeat, send one push and one in-app notice naming the items and the two ways out: open your browser, or End it now on the phone. The queue heartbeat and the wake-on-sale push already exist (US-3143); this is one scheduled check and one message.

**2.5 iOS attended delist for Vinted (after 2.2).** `DelistFlows.generated.swift` is generated from the extension selectors, so this is a regeneration once Vinted's delist block is enabled.

**2.6 Grailed, honestly.** Grailed's delete is behind a native confirm dialog and will never be automated. Every surface already says "end it yourself" with the link. The delist log and the nudge make that the first thing the seller sees rather than something they remember.

Verification: record a Poshmark sale on a garment cross-listed to eBay, Mercari and Vinted; eBay and Vinted end within one drain, Mercari ends within one drain, the log reads correctly; close the browser, record another sale, and the nudge arrives at the threshold.

### Phase 3 (weeks 3 to 6): the phone is a real client

**3.1 "List on more marketplaces" on the item screen (NEW-B).** Next to Publish to eBay on `ItemCanvasView`, reusing `PushToSheet` with the same channel states the web panel shows. Remove the second taxonomy in `MarketplacesView.swift:257-368` and read `CrossListingRegistry` everywhere. Add revise and relist to the per-listing row on the phone, calling the service methods that already exist.

**3.2 Attended listing in a web view (NEW-A). This is the one new build in the plan and it is the phone's unlock.** The WebDelist runner already opens the marketplace in a visible `WKWebView` where the seller is signed in as themselves and clicks through a flow while they watch. Extend it with a `list` flow for Poshmark and Mercari: open the create form, fill the text fields and the pickers from the same selectors the extension uses (generated into the binary at build time, never fetched), stop before Post, hand the seller the screen to confirm and post, and write the listing URL back when the page lands on it. The seven build constraints in `ios-webview-delist-app-review.md` section 3 apply unchanged: seller signs in themselves, nothing leaves the device, one tap per run, web view visible throughout, scripts in the binary, a login wall or human check hands over the screen, no marketplace name in the app's name. The App Review notes in that note gain one paragraph describing the list flow in the same words. Photos: the create form's file input cannot be driven from a web view the way the extension drives it; the first version uploads photos through the marketplace's own picker with the app's photos pre-exported to the camera roll album it already maintains, and says so. Consent screen: the delist one, with "end" replaced by "list".

**3.3 The sale push on the phone.** The wake-on-sale push exists. Make its tap land on the pending-delist row with End it now (attended, where enabled) and Queue for desktop as the two buttons.

**3.4 Firefox for Android drain (US-3061 AC5).** A human verifies the mobile DOM per platform and flips `mobile.enabled`. Until then the phone browser refuses jobs, which is correct.

Verification: with no desktop open, a seller photographs a garment, gets the draft, taps List on more marketplaces, lists to Poshmark in the attended view, and the item shows Poshmark live with a URL; the same garment sold on eBay raises a push whose End it now ends the Poshmark listing.

### Phase 4 (weeks 4 to 8): switching in an afternoon

**4.1 Universal import with duplicate linking (US-3197).** One button pulls every connected channel (API server-side, extension via the queue), joins rows that are the same garment onto one item sharing a `draft_id`, and lands anything below the confidence bar in a review list. Idempotent on re-run.

**4.2 Depop closet import via the extension (US-3154)** while the API is pending, so a Depop seller can start before approval lands.

**4.3 Switch-from kit (US-9209, US-3164).** The Vendoo and List Perfectly presets exist and are unverified; get one real export of each, verify, and publish the two "what transfers" pages. Crosslist and Flyp presets wait for real files, as the story says.

**4.4 Leave any time.** One CSV of everything plus photos, from the Marketplaces page. The fear in every switching thread is being held for ransom; the answer is a button.

### Phase 5 (parallel, operator-gated): reach

- **Depop go-live (US-2473)** the day approval lands: `DEPOP_ENABLED`, tier flip, one end-to-end run.
- **Etsy** (US-2474): own-shop validation on the Seller App, then Commercial Access; `ETSY_ENABLED` stays off in prod until approved.
- **Facebook Marketplace lister (US-2480)** after phases 1 and 2 are green. The form has no accessible names, so this is the most fragile channel and goes last.
- **Grailed sold-sync observer (US-2702)** so a Grailed sale at least raises the instruction.

### Phase 6 (weeks 6 to 10): scale

**6.1 Bulk cross-list (NEW-D).** From the listings grid and the AutoLister drafts library: select N items, choose channels, one button. API channels go through a `listing_publish_batches` job per platform (the batch schema in migration 00156 is eBay-shaped and needs a platform column, one migration); extension channels enqueue N paced `list` jobs, and the queue view already groups them. Vendoo caps this at 240; we cap only by the plan's active-listing limit, which `cross-push` already enforces.

**6.2 Automations on every channel.** `crosslist_to` exists. Add `relist_after_days` and `drop_price_pct` on extension channels through the relist and revise kinds, so the stale-listing automation stops being eBay only.

**6.3 Android parity.** Push-to sheet, item-screen entry, attended WebView list and delist, in that order, each a mirror of the iOS story.

**6.4 Status page.** Generated from the selector self-check the popup already runs, published at `/status`, one row per channel per flow with the last verified date. List Perfectly's Current Issues page is the model; ours is data, not prose.

## 7. Decisions needed

Three, in the order they block work. Recommendation on each.

1. **Attended listing on the phone (phase 3.2).** It is the only item in this plan that adds a mechanism, and it goes through App Review with the wording already written for delist. Recommend yes: it is strictly more conservative than the PrimeLister app Apple has already approved, it reuses the shipped runner, and it is the single change that makes the iOS app a cross-lister rather than a clipboard.
2. **One "List on" panel in the composer (phase 1.4)** replacing the split between the Push-to card and the kit's checklist. Recommend yes; keep the per-tab "Fill X now" as the attended path.
3. **Order: reliability before reach.** Phases 1 to 3 before Facebook and any new channel. Recommend yes; every competitor that added channels on a flaky core owns the loudest one-star review in the category.

## 8. How we will know it worked

Measured per seller and shown on the dashboard where the time-saved meter (US-9207) is planned.

| Measure | Today | Target after phase 3 |
|---|---|---|
| Channels live per cross-listed garment | mostly 1 (eBay) | 3 or more |
| Cross-posts needing a manual field beyond the seller's confirm | 4 fields (all pickers) | 0 to 1 (colour) |
| Sales where every sibling ended within 15 minutes of the sale | unmeasured | 90 percent with a browser open; 100 percent notified within the nudge threshold without |
| Revise jobs completing on extension channels | 0 (manual) | equal to eBay's completion rate |
| Garments cross-listed from a phone with no desktop | 0 | any |
| Days since a human verified each enabled flow | 32 to never | under 30, enforced by the status page |

## 9. Story map

Existing ids to carry the plan, in phase order: US-2718, US-2727, US-3058, US-3131, US-2473, US-2474, US-2698, US-2700, US-3063, US-3061, US-3210, US-3071, US-2479, US-2702, US-3197, US-3154, US-9209, US-3164, US-2480. New stories to file, each with the ACs sketched above: NEW-A attended listing on iOS, NEW-B item-screen entry and one registry on iOS, NEW-C one List on panel on the web, NEW-D bulk cross-list, NEW-E channel strip on the listings table, NEW-F delist log, NEW-G no-drain nudge. File them in `prd-crosslisting.json` (the reserved US-92xx block) so the Ralph loop does not collide with them, then renumber into `prd.json` when the phase starts, per that file's own description.

Stale stories to close or rewrite while filing: US-1757 (its core AC shipped at 1.0.9), and the CLAUDE.md line about seven platforms.

## Related

- `vault/60-decisions/adr-no-server-side-marketplace-automation.md` (the constraint)
- `vault/30-platform/closing-a-coverage-gap.md` (the order for flipping a channel)
- `vault/30-platform/sale-delist-contract.md` (what a sale ends)
- `vault/20-domain/sync-source-of-truth.md` (who owns a field once a listing exists twice)
- `vault/10-ops/ios-webview-delist-app-review.md` (the phone's attended mechanism and its wording)
- `vault/50-business/competitor-landscape-2026-09.md` and `vault/50-business/competitors/` (the evidence)
- `docs/superpowers/specs/2026-09-11-crosslist-list-everywhere-and-sold-delist-design.md` (the landed predecessor)

# Store submission kit — GradeThread unified extension v1.1.0

Copy-paste source for the Chrome Web Store + Firefox AMO listings. Artifacts:
`dist-ext/gradethread-v1.1.0-chrome.zip` · `dist-ext/gradethread-v1.1.0-firefox.zip`.

> **Version record.** The stores serve 1.0.9 (US-9210, 2026-09-01: the manifest
> was corrected from 0.10.0 to match). 1.1.0 is the popup/overlay redesign of
> 2026-09-02, not yet uploaded; both stores refuse a version they already hold,
> so the next upload after this one must be higher again. The commit that
> produced the shipped 1.0.9 build is not recorded here; tag it when known.

## Shared fields

- **Name / Title:** `GradeThread: Grade & List`  (≤30 chars for AMO)
- **Summary (125 chars):** `Get an AI-powered condition read on a pre-owned clothing listing before you buy — plus one-click cross-listing for FlipDesk sellers.`
  - ⚠️ Do NOT enumerate marketplace brand names (eBay, Poshmark, Grailed, Mercari, Depop, Vinted) in the summary or description. Chrome rejected the 0.3.5 submission for "excessive keywords" (ref: Yellow Argon, 2026‑07‑16) citing exactly that list. Describe the extension functionally; the supported sites are declared by the `content_scripts` match patterns, not by keyword lists in the copy.
- **Homepage:** `https://gradethread.com`
- **Support email:** `support@gradethread.com`
- **Support site:** `https://gradethread.com`
- **Privacy policy:** `https://gradethread.com/privacy`
- **Category:** Shopping
- **Language:** English (US)
- **Mature content:** No
- **Store icon:** `extension-unified/icons/icon128.png` (128×128)

## Description (paste into both; first 250 chars carry the pitch)

```
GradeThread gives you an independent, AI-powered condition read on a pre-owned clothing listing before you buy — and, for resellers, one-click cross-listing to your other marketplaces.

FOR SHOPPERS — free, no account needed
Open a clothing listing on a supported resale site and click "Get condition read." GradeThread's AI reads the photos already on the page and returns:
• A 1–10 condition score with a confidence level
• A heads-up when the seller's stated condition may be optimistic
• A sense of whether the asking price fits the condition
• Which extra photos to request before you buy

ON SEARCH PAGES
Browsing a search or category page, GradeThread adds a small tag to each result showing the condition the seller claims and whether the asking price is high or low for that claim. Nothing is graded there — no photos are read until you open a listing and ask for a condition read. You can switch this off in the popup.

FOR FLIPDESK SELLERS
Sourcing? On any supported listing, "Should I flip this?" prices the item against comparable sales at the condition its photos actually show, and tells you the resale range, your margin after fees, what you can afford to pay, and how long it should take to sell. It runs only when you ask.
Send a draft from FlipDesk and the extension opens the destination site's new-listing form in your own logged-in tab, already filled in. You review the details and click List — GradeThread never signs in to the marketplace for you.

YOUR SESSIONS STAY YOURS
This extension does not request a "cookies" permission and cannot read your marketplace accounts. Condition reads send only the public listing photos already visible on the page to GradeThread's grading service; results are not kept on our servers, and your recent reads stay on your device. Cross-listing runs entirely in your browser.

Buyer research is free. Seller cross-listing unlocks with an active FlipDesk plan at gradethread.com.
```

## Chrome Web Store — extras

**Single purpose:**
```
Give shoppers an independent AI condition read on second-hand clothing listings, and let signed-in resellers cross-post their listings to other marketplaces.
```

**Permission justifications** (Privacy practices tab):
- `storage` — Store the user's settings (auto-run, per-site toggles), local "recent reads" history, and the signed sign-in token, on the device.
- `activeTab` — Read the active tab's host so the popup can show a per-site enable/disable toggle for the marketplace the user is on.
- `alarms` — Two local, no-network uses, both for the seller cross-listing (Lister) feature:
  1. **A one-shot timeout per cross-listing job.** If the marketplace's new-listing page never finishes loading, an alarm fires at that job's deadline so the user sees a clear "timed out — list manually" message instead of a spinner that never resolves. Chrome suspends the background service worker after ~30s of inactivity, which cancels ordinary `setTimeout` timers; an alarm is the only timer that survives the suspension to report the failure.
  2. **One periodic sweep (every 5 minutes), running entirely on the device.** It drops finished cross-listing jobs once their result grace-window has passed and expires abandoned tab "watches" (US-1877) so a forgotten tab can't capture whatever the seller browses to later. It makes no network requests, polls no server, and collects nothing — it is purely local state cleanup. The single periodic alarm costs one alarm total rather than one per job.
- Host `https://gradethread.com/*` and `https://*.gradethread.com/*` — Two uses, and the second is the one that needs stating plainly:
  1. Call GradeThread's own API (`functions.gradethread.com`) to grade a listing the user asked us to read, and to fetch that account's entitlements.
  2. **Inject a content script into gradethread.com pages** (`gt-bridge.js`). It is a message relay: the GradeThread web app posts a cross-listing request, the script forwards it to the extension's background, and posts the reply back. It exists because Firefox has no `externally_connectable`, so this is the only cross-browser way for our own site to talk to our own extension. It reads nothing from the page — no page content, no credentials, no cookies — and forwards only our own message envelope.
  3. **Inject a content script into the seller's OWN Poshmark sold-order and closet pages** (`sync/content.js`, matched to `/order/sales*` and `/closet/*` only, never a listing page). It reads the seller's own sold rows so GradeThread can end their duplicate listings on other sites before the same garment sells twice. It runs only on pages the seller opened themselves — there is no scheduled read and it never opens or navigates a tab — and it extracts exactly six fields per row: listing address, title, price, sale date, order reference and thumbnail id. **It does not read, and cannot transmit, the buyer's name, handle or shipping address, all of which are printed on that page.** The extracted field set is fixed in code and enforced by a test.
  4. **Inject a content script into the seller's OWN Poshmark closet and listing pages and Mercari listing-list and listing pages** (`closet-import/content.js`, matched to `poshmark.com/closet/*`, `poshmark.com/listing/*`, `mercari.com/mypage/listings*` and `mercari.com/item/*` only). It reads NOTHING on its own: it answers only when the seller presses "Import my closet" on gradethread.com, and only in a tab the seller already has open, so a seller switching from another tool can bring their existing listings into GradeThread without retyping them. It refuses a closet or listing that does not show the owner-only controls, so it cannot read another seller's closet. Per listing it extracts exactly ten fields: listing address, marketplace id, title, description, price, size, brand, the seller's own condition wording, photo addresses and whether the read came from the listing page. It never opens or navigates a tab and never runs on a schedule. **It does not read, and cannot transmit, a buyer's name, handle or shipping address**: the field set is fixed in code and enforced by a test, and the server rejects those keys outright.
- Host `https://*.poshmark.com/*`, `https://*.mercari.com/*`, `https://*.grailed.com/*`, `https://*.facebook.com/*` and the Vinted country domains (`vinted.com`, `vinted.co.uk`, `vinted.fr`, `vinted.de`, `vinted.es`, `vinted.it`, `vinted.nl`, `vinted.pl`, `vinted.be`, `vinted.at`, `vinted.cz`, `vinted.sk`, `vinted.lt`, `vinted.pt`, `vinted.se`, `vinted.ro`, `vinted.hu`, `vinted.lu`, `vinted.hr`, `vinted.gr`, `vinted.dk`, `vinted.fi`) — Prefill the seller's own new-listing form during cross-listing, in the tab they are already signed into, and end one of the seller's own listings when the item sells on another site. The list is long only because these sites run one app across many country domains; each is the same single use. The extension does not read the account, has no `cookies` permission, and sends nothing from these pages to GradeThread.
- `sidePanel` — Opens GradeThread's own panel beside the marketplace tab, from the toolbar button, on the marketplace sites already listed in host permissions. It shows the seller their queued cross-listing jobs and the item they are listing, so the work stays visible while they fill the marketplace's form; a popup closes on the first click on the page, which is why a panel is needed at all. The permission grants nothing beyond opening that panel: the panel renders our own page, reads no page content, makes no network request of its own (every call goes through the background script that already holds the sign-in token), and is enabled only on tabs whose host is one we already match.
- `contextMenus` — Adds TWO right-click items on images ("Grade this image with GradeThread" and "Read this label with GradeThread"). It is how a shopper grades the specific photo they spotted when the site's gallery layout hid it from us. It reads nothing on its own: the click hands the image's public URL to the extension, which grades it exactly like the on-page button does. The second reads a care tag: the click hands that one image to our tag-reader and shows what is printed on it. No menu appears anywhere else.

- `scripting` — Used for ONE thing: showing the care-label result on the page you right-clicked in. When you choose "Read this label with GradeThread", the extension injects a small result card into that tab and nothing else. It runs only from your own right-click, only in the tab you used, and only after you asked — a click on our menu item is what grants the temporary access, through the `activeTab` permission we already request. We deliberately chose this over a content script that runs on every website, because this feature does not need to watch the pages you visit; it needs to answer once, where you asked. The card removes itself when you press Escape, click its close button, or after 60 seconds.
- **Remote code:** No — all executable code ships inside the package.

**Data usage disclosures** (certify):
- Stored ON THE DEVICE ONLY, never transmitted: the seller's public username from
  listings you have read, kept with your local read history so the extension can
  show you your own pattern with that seller. It is never sent to GradeThread and
  never leaves the browser.
- Collected: **Website content**, in three distinct flows — state all three:
  1. **On user action** — the listing's photos and text, sent for grading when the
     user clicks "Get condition read". Not stored on our servers.
  2. **Automatically, on supported search pages** (scan mode, ON by default, per-install
     toggle in the popup) — for up to 24 visible result cards, the **text already
     printed on the card**: title, price, and the seller's stated condition. **No
     photos, no page address, no account.** It is used to check the asking price
     against comparable sales and is not stored on our servers.
  3. **On user action, signed in only, and RETAINED** — "check this against my
     alerts". The user presses it on one listing they opened; the extension sends
     that listing's address, title, brand, stated condition, price and photo URLs
     with their account token, and GradeThread **stores** the listing plus its
     grade against that account so the user's own saved-search alerts can match
     it. Private to that account, user-deletable, and **auto-deleted after 90
     days**. One listing per press — there is no batch form, no automatic
     trigger, and the listing page's HTML is never fetched. This is the only
     flow that both identifies the user and persists anything server-side, so do
     not fold it into flow 1 on a store form.
  4. **On the seller's own account pages, signed in only, and RETAINED** — sold-sync.
     On the seller's own Poshmark sold-order page and closet, the extension reads
     their own sold rows and sends, per row, the listing address, title, price,
     sale date and order reference with their account token. GradeThread
     **stores** these so that when a garment sells on one marketplace it can end
     that seller's duplicate listings on the others. **It never sends the buyer's
     name, handle or shipping address**, which are printed on that same page; the
     extracted field set is fixed in code, the server rejects those keys outright,
     and no database column exists that could hold them. Private to that account.
     Passive only: it reads pages the seller opened themselves, on no schedule.
     This is a SELLER flow on the seller's own data — do not fold it into the
     shopper flows above.
  5. **On the seller's own closet and listing pages, on request only, and RETAINED** — closet import.
     When the seller presses "Import my closet" on gradethread.com, the extension
     reads their own Poshmark closet or Mercari listing list in a tab they already
     have open and sends, per listing, the listing address, marketplace id, title,
     description, price, size, brand, condition wording and photo addresses with
     their account token. GradeThread **stores** these as the seller's inventory
     (and copies the photos into its own storage) so a seller moving from another
     tool does not retype their listings. Private to that account and reversible in
     one step from the same page. **It never sends a buyer's name, handle or
     shipping address**; the field set is fixed in code and the server rejects
     those keys outright. Nothing is read until the seller presses the button, and
     nothing is read on a schedule. A SELLER flow on the seller's own data.

- Collected **only if the user opts in** — TWO separate, independent toggles, both
  off by default, both in the popup, both revocable. State them separately; they
  are not one setting:
  1. **Layout diagnostics.** A ping when a marketplace's layout defeats the reader
     — the marketplace name, which selector group came up empty, and the
     config/extension version.
  2. **Usage counts.** Two running totals kept on the device — how many condition
     reads the user asked for, and how many times they clicked a link back to
     gradethread.com (with which surface the link was on: popup, overlay, flip
     panel or onboarding). Every few hours the **totals** are sent with the
     extension version. **No client timestamp and no ordering**, so there is no
     event stream to reconstruct; turning the toggle off also deletes any totals
     still waiting on the device.

  Neither carries **a page address, a listing, an account, or any device or install
  identifier**, so neither can be tied to a person or a browsing history. Both are
  declared to AMO as OPTIONAL `technicalAndInteraction`.
- NOT collected: health, financial, authentication, location, personal communications.
- **Web history / PII — read the qualification, don't shorten it.** We collect no
  browsing history: nothing observes, logs or transmits the pages a user visits.
  The extension stores nothing about a page unless the user presses a button on
  it. The one place a page ADDRESS reaches us is flow 3 above — a single listing
  URL the user explicitly pressed "check against my alerts" on, kept against
  their own account for 90 days so their alerts can match it. Declare that under
  **Website content**, on user action; it is not a history feed, and describing
  it as "no web history, full stop" would be the inaccurate summary.
- Certify: not sold to third parties · not used/transferred for anything beyond the single purpose · not used for creditworthiness/lending. (All true.)

**Assets still needed (you must supply):**
- Screenshots — at least 1 (1280×800 or 640×400, PNG/JPEG, no alpha). Suggested: (1) condition-read overlay on an eBay listing, (2) the popup, (3) onboarding page, (4) a cross-listing prefill.
- Optional promo tiles: small 440×280, marquee 1400×560.

## Firefox AMO — extras

- **License:** All Rights Reserved (proprietary — Pearson Media LLC).
- **This add-on is experimental:** No
- **Requires payment / non-free services:** Yes — seller cross-listing requires a paid FlipDesk plan (buyer research is free). Explain in reviewer notes.
- **Categories (≤3):** Shopping
- **Privacy Policy:** Yes → `https://gradethread.com/privacy` (paste the summary below if a text field is required).

**Privacy policy summary (if AMO wants text):**
```
GradeThread Condition Check & Lister does not read your marketplace accounts and has no "cookies" permission. When you request a condition read, the extension sends the public listing's image URLs and basic details (title, brand, price) to GradeThread's grading service to produce a score; results are not stored on our servers. If you are signed in and press "check this against my alerts", that one listing is different: its address, title, brand, stated condition, price and photo links are sent with your account token and stored privately against your GradeThread account, together with our grade, so your own saved-search alerts can match it — one listing per press, deletable by you, and automatically deleted after 90 days. On a supported marketplace's search page the extension also sends the text already printed on the visible result cards — title, price and the seller's stated condition, for up to 24 cards — so it can tell you whether each asking price is high or low for the condition the seller claims. No photos are read and nothing is graded on a search page, none of it is stored on our servers, and you can turn this off in the extension's popup. Your recent reads and settings are stored only on your device — including the seller's public username from listings you read, which the extension uses to show you your own pattern with that seller and never sends to us. If you turn on the optional "report when a site's layout breaks the read" setting (off by default), the extension sends us the marketplace's name and which part of the read failed, so we can fix it — never the listing, the page address, or any identifier for you or your installation. A second, separate optional setting, "share anonymous usage counts" (also off by default), keeps two running totals on your device — how many condition reads you asked for and how many times you clicked a link back to gradethread.com — and sends only those totals every few hours, with no timestamps, no ordering, no listing, no account and no install identifier; turning it off deletes any totals still waiting on your device. If you sign in, a short-lived access token is stored locally to apply your account's quota and unlock seller tools. Cross-listing runs entirely in your browser; your marketplace passwords and cookies are never sent to GradeThread. On gradethread.com itself the extension runs a small message relay so our website can hand cross-listing requests to the extension (Firefox provides no other way for a site to reach its own extension); it reads no page content and forwards only our own messages. Full policy: https://gradethread.com/privacy
```

## Microsoft Edge Add-ons — extras (US-1881 AC5)

**Upload the CHROME zip.** Edge is Chromium, reads the same MV3 manifest, and
supports `externally_connectable`, so there is no third artifact and no third
manifest transform — `dist-ext/gradethread-v<version>-chrome.zip` is the Edge
package. If a build ever needs an Edge-specific manifest, that is a packager
change (`firefoxManifest()`'s neighbour), never a hand-edited zip.

**One thing that is genuinely different: the extension ID.** Edge assigns its own
id at publish, unrelated to the Chrome Web Store one. Two places read it, and
both are silent when it is wrong:

| where | var | what to add |
|---|---|---|
| edge service (Coolify) | `EXTENSION_ALLOWED_ORIGINS` | append `chrome-extension://<the Edge id>` — the CORS allow-list is comma-separated, so this is an ADD, never a replace |
| frontend (Pages) | `VITE_LISTER_EXTENSION_ID` | only if the Edge build is the one a given deploy targets; one value, so it cannot hold both stores |

Skipping row 1 does not break the overlay (buyer research is anonymous and
same-origin-free) — it breaks sign-in and every seller call, as a CORS failure in
the console and nothing at all in the UI.

**Partner Center listing fields.** Everything in *Shared fields* above applies
verbatim. Edge-only entries:

- **Store listing language:** English (United States) — must be added explicitly.
- **Category:** Shopping.
- **Privacy policy URL:** `https://gradethread.com/privacy` (required, not optional as on Chrome).
- **Does your extension collect personal data?** Yes — same disclosure as the
  Chrome data-safety block above; Edge asks it as prose, so paste the AMO privacy
  summary.
- **Search terms (≤7):** do NOT list marketplace brand names. Same rule and the
  same rejection risk as Chrome (see the ⚠️ under *Summary*).
- **Notes for certification:** paste the *Notes to Reviewer* block below,
  unchanged — the anonymous path needs no account there either.
- **Screenshots:** 1280×800, at least one. The Chrome set is reusable as-is.

**Before you upload, the smoke that has to pass** — the checklist is
`TESTING.md` §5b. Edge is Chromium, but "Chromium-compatible" is a claim about
the manifest, not evidence about the build, and the store artifact is not
recallable once submitted.

## Notes to Reviewer (AMO) / Testing instructions

> **The reviewer password never goes in this file.** This repository is public
> (`github.com/dj-pearson/GradeThread`), so a password committed here is a
> published password, and the pre-commit gitleaks hook is not a safety net for a
> value it has no pattern for.
>
> Both stores have a private field for it, and that is the only place it goes:
>
> - **Chrome Web Store** — Developer Dashboard, the item's *Privacy practices*
>   tab, the test-credentials / instructions-for-reviewers box. Visible to
>   reviewers only.
> - **Firefox AMO** — the *Notes for Reviewers* box on the version submission.
>   Visible to reviewers only.
>
> Paste the block below into that box and type the password straight into the
> form. The credential itself lives in the password manager alongside the other
> Pearson Media signing secrets; name that location in
> `vault/10-ops/key-rotation.md` if it is not already there, and never the value.
> Use a dedicated comped review account, and rotate its password after each
> review round.


```
PRIMARY FEATURE NEEDS NO ACCOUNT:
1. Install and open any eBay item page, e.g. https://www.ebay.com/itm/  (any live listing).
2. A "GradeThread — condition check" pill appears bottom-right. Click "Get condition read."
3. An AI condition score renders from the listing photos. This is the core feature and needs no login. It also works on Poshmark /listing/, Grailed /listings/, Mercari /item/, Depop /products/, and Vinted /items/ pages.

SELLER FEATURE (requires a paid account):
Cross-listing is gated to an active paid FlipDesk plan. To test it, sign in from the
popup ("Sign in to unlock" → gradethread.com/connect-extension), then use FlipDesk's
Listing Kit "Send to extension".
  Test account:  appledemouser@gradethread.com
  Password:      (paste it here when you fill in the store form, not into this file)
(This account is on a comped paid FlipDesk plan so seller tools are enabled.)

BUILD / SOURCE:
No build step. All files are plain, unminified JavaScript/HTML/CSS exactly as they run
— the submitted package IS the source. Firefox specifics: the background runs as an
event page (background.scripts); page↔extension messaging uses the gradethread.com
content script gt-bridge.js (postMessage) in place of externally_connectable.
```

## Version / release notes (v1.1.0)

```
A new look, and a queue you can actually work.

New: the popup is redesigned. Wider, with a proper tab bar, switches instead
of checkboxes, a grade ring on every saved read, and a site card that says
where you are and what the button will do there. It follows your system's
light or dark theme.

New: three numbers over your read history: how many reads you have saved, the
average grade, and how far the photos have run from what sellers claimed.
Computed on your device; nothing is sent.

New: the cross-listing queue is grouped into what needs you, what is running,
and what is waiting. Failed and expired jobs carry a Retry, and a stale queue
can be retried, cleared or cancelled in one click.

New: the on-page condition card matches. The score is a ring, the seller and
price signals read as one family, and the seller's flip panel lays its numbers
out as a column you can read down.

New: a first-run page that shows the three steps rather than describing them.

Fixed: every button now meets the 4.5:1 contrast bar under white text.
```

<!-- The 0.9.0 notes, kept because the store shows the previous release
     alongside the new one and reviewers read both. -->

```
New: the popup is now three tabs — Reads, Selling and Settings — instead of one long
page holding all three at once. It opens on the one that fits your account, and
sellers get a count on the Selling tab of listings that still need ending.

New: one more cross-listing channel for FlipDesk sellers, and the channel list now
says plainly which ones can end a listing for you and which ones you have to end
yourself. A channel that can only post is labelled as such before you use it.

Fixed: some options and prompts stayed on screen after the extension had switched
them off. Fixed: in dark mode the selected tab was harder to see than the unselected
one.
```

<!-- The 0.8.0 notes, kept because the store shows the previous release alongside
     the new one and reviewers read both. -->

```
New: shortcuts, a settings page, and deeper reads. Alt+G reads the listing you are
on; right-click any photo to grade just that one; a Settings page collects every
option, lists the sites you have switched off with a way to turn them back on, and
lets you clear anything the extension has stored. Paid plans now read up to eight
listing photos instead of four.

New: Compare. Pin any listing you have read and line it up against the others you
are weighing — condition, confidence, price and photo count side by side, sortable.
Pinning costs nothing: it saves the read you already have, and the whole table lives
in your browser.

New: By seller. When you have read two or more listings from the same seller, the
extension tells you how their stated conditions have compared with what the photos
actually showed. Worked out entirely on your own device from your own reads —
nothing about a seller is ever sent to GradeThread.

New: flip checks for FlipDesk sellers. On any supported listing, ask "Should I flip
this?" and get the resale range at the condition shown, margin after fees, a
break-even buy price and an expected time to sell. It only runs when you tap it.

New: search-page tags. On a supported marketplace's search or category page, each
result now carries the condition the seller claims and whether the price is high or
low for that claim. Nothing is graded there — no photos are read until you open a
listing and ask for a condition read — and it can be switched off in the popup.
The extension does both jobs behind one role-aware popup:
• Condition Check (all users, free): an AI condition read on a supported resale listing — score, over-grading flag, price fairness, and photo-request hints.
• Lister (FlipDesk sellers): one-click cross-posting of drafts into a supported marketplace's new-listing form, prefilled in your own logged-in tab.
• Seller engagement (FlipDesk sellers, opt-in): repeats a seller's own share, follow and offer actions in their own logged-in tab, behind a separate consent, a daily limit the seller cannot raise, and randomized pacing. It stops and hands the tab back whenever the site asks for a human check — it never answers one.
Versioned consent for both seller features, and full Firefox support.
```

> Firefox floor is 140.0 (desktop) / 142.0 (Android): the versions that support
> `browser_specific_settings.gecko.data_collection_permissions`. The Firefox add-on
> id is `unified@gradethread.com` (must match the AMO listing). Chrome ignores
> `browser_specific_settings` entirely, so these change only the Firefox build.

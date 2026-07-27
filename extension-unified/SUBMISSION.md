# Store submission kit — GradeThread unified extension v0.3.7

Copy-paste source for the Chrome Web Store + Firefox AMO listings. Artifacts:
`dist-ext/gradethread-v0.3.7-chrome.zip` · `dist-ext/gradethread-v0.3.7-firefox.zip`.

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

FOR FLIPDESK SELLERS
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
- Host `https://*.poshmark.com/*`, `https://*.mercari.com/*`, `https://*.grailed.com/*` — Prefill the seller's own new-listing form during cross-listing, in the tab they are already signed into.
- **Remote code:** No — all executable code ships inside the package.

**Data usage disclosures** (certify):
- Collected: **Website content** (the listing's photos/text, sent for grading on user action).
- Collected **only if the user opts in** (off by default, per-install toggle in the
  popup): a diagnostic ping when a marketplace's layout defeats the reader —
  the marketplace name, which selector group came up empty, and the config/extension
  version. **No page address, no listing, no account, and no device or install
  identifier**, so it cannot be tied to a person or a browsing history. Declared to
  AMO as OPTIONAL `technicalAndInteraction`.
- NOT collected: PII, health, financial, authentication, location, personal communications, web history.
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
GradeThread Condition Check & Lister does not read your marketplace accounts and has no "cookies" permission. When you request a condition read, the extension sends the public listing's image URLs and basic details (title, brand, price) to GradeThread's grading service to produce a score; results are not stored on our servers. Your recent reads and settings are stored only on your device. If you turn on the optional "report when a site's layout breaks the read" setting (off by default), the extension sends us the marketplace's name and which part of the read failed, so we can fix it — never the listing, the page address, or any identifier for you or your installation. If you sign in, a short-lived access token is stored locally to apply your account's quota and unlock seller tools. Cross-listing runs entirely in your browser; your marketplace passwords and cookies are never sent to GradeThread. On gradethread.com itself the extension runs a small message relay so our website can hand cross-listing requests to the extension (Firefox provides no other way for a site to reach its own extension); it reads no page content and forwards only our own messages. Full policy: https://gradethread.com/privacy
```

## Notes to Reviewer (AMO) / Testing instructions

```
PRIMARY FEATURE NEEDS NO ACCOUNT:
1. Install and open any eBay item page, e.g. https://www.ebay.com/itm/  (any live listing).
2. A "GradeThread — condition check" pill appears bottom-right. Click "Get condition read."
3. An AI condition score renders from the listing photos. This is the core feature and needs no login. It also works on Poshmark /listing/, Grailed /listings/, Mercari /item/, Depop /products/, and Vinted /items/ pages.

SELLER FEATURE (requires a paid account):
Cross-listing is gated to an active paid FlipDesk plan. To test it, sign in from the
popup ("Sign in to unlock" → gradethread.com/connect-extension), then use FlipDesk's
Listing Kit "Send to extension".
  Test account:  <<ADD A TEST EMAIL>>
  Password:      <<ADD A TEST PASSWORD>>
(This account is on a comped paid FlipDesk plan so seller tools are enabled.)

BUILD / SOURCE:
No build step. All files are plain, unminified JavaScript/HTML/CSS exactly as they run
— the submitted package IS the source. Firefox specifics: the background runs as an
event page (background.scripts); page↔extension messaging uses the gradethread.com
content script gt-bridge.js (postMessage) in place of externally_connectable.
```

## Version / release notes (v0.3.7)

```
Listing and in-product copy clarified — no functional changes.
Firefox: raised the minimum to Firefox 140 (Android 142) so the browser's built-in
data-collection consent screen is shown, resolving the AMO validation warnings about
data_collection_permissions on older versions.
The extension does both jobs behind one role-aware popup:
• Condition Check (all users, free): an AI condition read on a supported resale listing — score, over-grading flag, price fairness, and photo-request hints.
• Lister (FlipDesk sellers): one-click cross-posting of drafts into a supported marketplace's new-listing form, prefilled in your own logged-in tab.
Versioned Lister consent and full Firefox support.
```

> Firefox floor is 140.0 (desktop) / 142.0 (Android): the versions that support
> `browser_specific_settings.gecko.data_collection_permissions`. The Firefox add-on
> id is `unified@gradethread.com` (must match the AMO listing). Chrome ignores
> `browser_specific_settings` entirely, so these change only the Firefox build.

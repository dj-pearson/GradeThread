# Store submission kit — GradeThread unified extension v0.3.0

Copy-paste source for the Chrome Web Store + Firefox AMO listings. Artifacts:
`dist-ext/gradethread-v0.3.0-chrome.zip` · `dist-ext/gradethread-v0.3.0-firefox.zip`.

## Shared fields

- **Name / Title:** `GradeThread: Grade & List`  (≤30 chars for AMO)
- **Summary (125 chars):** `AI condition reads while you shop eBay, Poshmark, Grailed, Mercari, Depop & Vinted — plus cross-listing for FlipDesk sellers.`
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
GradeThread gives you an independent, AI-powered condition read on any pre-owned clothing listing — before you buy — and, for resellers, one-click cross-listing to your other marketplaces.

SHOP SMARTER — free, no account needed
Open a listing on eBay, Poshmark, Grailed, Mercari, Depop, or Vinted and click "Get condition read." GradeThread's AI reads the listing photos and gives you:
• A 1–10 condition score with a confidence level
• A flag when the seller may be over-grading the item
• Condition-adjusted price fairness
• Which photos to ask the seller for before you buy

SELL FASTER — for FlipDesk sellers
Cross-post your FlipDesk drafts to Poshmark, Mercari, and Grailed. The new-listing form is prefilled in your OWN logged-in browser tab — you just review and click List.

YOUR SESSIONS STAY YOURS
No "cookies" permission and no access to your marketplace accounts. Condition Check sends only the public listing photos already on the page to GradeThread's grading service; nothing is stored on our servers, and your recent reads stay on your device. Cross-listing runs entirely in your browser — GradeThread never sees your marketplace password or cookies.

Buyer research is free for everyone. Seller cross-listing unlocks with an active FlipDesk plan at gradethread.com.
```

## Chrome Web Store — extras

**Single purpose:**
```
Give shoppers an independent AI condition read on second-hand clothing listings, and let signed-in resellers cross-post their listings to other marketplaces.
```

**Permission justifications** (Privacy practices tab):
- `storage` — Store the user's settings (auto-run, per-site toggles), local "recent reads" history, and the signed sign-in token, on the device.
- `activeTab` — Read the active tab's host so the popup can show a per-site enable/disable toggle for the marketplace the user is on.
- Host `*://*.gradethread.com/*` — Call GradeThread's grading API and receive the signed sign-in token / account entitlements.
- Host `*://*.poshmark.com/*`, `*://*.mercari.com/*`, `*://*.grailed.com/*` — Prefill the seller's own new-listing form during cross-listing.
- **Remote code:** No — all executable code ships inside the package.

**Data usage disclosures** (certify):
- Collected: **Website content** (the listing's photos/text, sent for grading on user action).
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
GradeThread Condition Check & Lister does not read your marketplace accounts and has no "cookies" permission. When you request a condition read, the extension sends the public listing's image URLs and basic details (title, brand, price) to GradeThread's grading service to produce a score; results are not stored on our servers. Your recent reads and settings are stored only on your device. If you sign in, a short-lived access token is stored locally to apply your account's quota and unlock seller tools. Cross-listing runs entirely in your browser; your marketplace passwords and cookies are never sent to GradeThread. Full policy: https://gradethread.com/privacy
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

## Version / release notes (v0.3.0)

```
First unified release. One add-on now does both jobs:
• Condition Check (all users, free): AI condition read on eBay, Poshmark, Grailed, Mercari, Depop & Vinted listings — score, over-grading flag, price fairness, and photo-request hints.
• Lister (FlipDesk sellers): one-click cross-posting of drafts to Poshmark, Mercari & Grailed, prefilled in your own logged-in tab.
Role-aware popup, versioned Lister consent, and full Firefox support.
```

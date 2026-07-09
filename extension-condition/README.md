# GradeThread Condition Check (browser extension) — US-1755

A Chrome / Firefox (Manifest V3) **buyer-side** extension that gives an
independent GradeThread AI condition read on an eBay listing while you shop, so
you buy pre-owned clothing with confidence.

> This is a **different** extension from the [GradeThread **Lister**](../extension/)
> (US-716), which is a *seller-side* cross-listing tool. Keep the two folders
> separate: different product, permissions, and store listing.

## What it does (US-1755)

1. On an eBay item page (`/itm/…`), a small non-intrusive pill appears
   bottom-right: **“Get condition read.”**
2. Clicking it extracts the listing's gallery image URLs (upgraded to full
   resolution), the title, and the brand, and asks the GradeThread public
   endpoint `POST /api/grading/public/grade-from-url` (US-1754) to grade them.
3. The overlay shows the **score (1–10) + tier + confidence** and a link to
   grade it properly on gradethread.com. Loading / error / rate-limited states
   are all handled; a low-confidence read is flagged.
4. The popup shows your **recent reads**, an **auto-run** toggle, a **per-site
   enable/disable** toggle, and a **sign-in / connect** link.

### Why click-to-grade, not auto-on-load

Each read spends a Vision call, and the public endpoint is quota-capped
(20/IP/hr, plus a per-install cap keyed by `X-GT-Extension-Id`). Auto-firing on
every listing an active shopper opens would exhaust the quota in minutes and
cost real money for pages the buyer never cared about. So the default is
click-to-grade; power users can opt into **auto-run** in the popup.

## Privacy

- **No `cookies` permission** and no eBay-account access — the extension only
  reads the public image URLs already rendered on the page.
- The grade call goes to GradeThread's **public** endpoint, which **persists
  nothing** server-side. Your reads are stored **locally** (`chrome.storage.local`).
- Host permissions are limited to `gradethread.com` (the endpoint + the hosted
  selector config). eBay is reached only via the content script on item pages.

## Resilience — selectors are remotely updatable

eBay ships DOM changes without notice. Selectors live in [`selectors.js`](selectors.js)
(bundled default) **and** in a hosted file the extension fetches and prefers:
[`public/extension/ebay-selectors.json`](../public/extension/ebay-selectors.json),
served at `https://gradethread.com/extension/ebay-selectors.json`. When eBay
breaks a selector, fix the **hosted** file and deploy the frontend — no Chrome
Web Store / AMO resubmission needed. If no gallery images resolve, the overlay
says so plainly; it never grades an empty set or guesses.

To update: fix selectors in **both** `selectors.js` (bundled fallback) and
`public/extension/ebay-selectors.json` (live override), bump `version` +
`lastVerified` in each.

## Server config (one-time)

The endpoint's CORS allowlist must trust this extension's origin. After loading
it, set on the edge service:

```
EXTENSION_ALLOWED_ORIGINS=chrome-extension://<your-id>,moz-extension://<your-id>
```

(CORS is not the security boundary here — the per-IP / per-instance quotas and
the AI daily ceiling are — but the browser still enforces it, so the origin must
be listed. See `services/edge-functions/src/main.ts`.)

## Install (unpacked, for now)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension-condition/` folder.
3. Copy the extension's ID → add its `chrome-extension://<id>` origin to
   `EXTENSION_ALLOWED_ORIGINS` on the edge and redeploy.
4. Open an eBay clothing listing → click **Get condition read**.

Store distribution + the install/click funnel is US-1757; multi-marketplace
adapters (Poshmark / Grailed / Mercari) are US-1756.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (minimal perms; host-permitted only on gradethread.com) |
| `background.js` | Service worker: instance-id + quota key, the grade fetch (extension-origin CORS), remote-config cache, settings, recent-reads history |
| `selectors.js` | Bundled default eBay selector config (`GT_CC_SELECTORS`) |
| `content/ebay-image.cjs` | Pure, testable image-URL helpers (dual-use node/browser) |
| `content/ebay.js` | eBay content script: detect → extract → overlay → states |
| `overlay.css` | Injected overlay styles (reset-hardened, brand-colored) |
| `popup.{html,css,js}` | Recent reads + settings + sign-in |
| `test/ebay-image.test.cjs` | `node extension-condition/test/ebay-image.test.cjs` |

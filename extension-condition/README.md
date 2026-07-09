# GradeThread Condition Check (browser extension) — US-1755, US-1756

A Chrome / Firefox (Manifest V3) **buyer-side** extension that gives an
independent GradeThread AI condition read on a resale listing while you shop, so
you buy pre-owned clothing with confidence. Works across **eBay, Poshmark,
Grailed, Mercari, Depop, and Vinted**.

> This is a **different** extension from the [GradeThread **Lister**](../extension/)
> (US-716), which is a *seller-side* cross-listing tool. Keep the two folders
> separate: different product, permissions, and store listing.

## What it does

1. On a supported listing page, a small non-intrusive pill appears bottom-right:
   **“Get condition read.”**
2. Clicking it extracts the listing's gallery image URLs (upgraded to full
   resolution where the CDN allows), the title, and the brand, and asks the
   GradeThread public endpoint `POST /api/grading/public/grade-from-url`
   (US-1754) to grade them.
3. The overlay shows the **score (1–10) + tier + confidence** and a link to
   grade it properly on gradethread.com. Loading / error / rate-limited states
   are handled; a low-confidence read is flagged.
4. The popup shows your **recent reads** (with the marketplace), an **auto-run**
   toggle, a **per-site enable/disable** toggle, and a **sign-in / connect** link.

### Why click-to-grade, not auto-on-load

Each read spends a Vision call, and the public endpoint is quota-capped
(20/IP/hr, plus a per-install cap keyed by `X-GT-Extension-Id`). Auto-firing on
every listing an active shopper opens would exhaust the quota in minutes. So the
default is click-to-grade; power users can opt into **auto-run** in the popup.

## Adapter architecture (US-1756)

Every marketplace is a **config-driven adapter** — pure data, no per-site code:
host list, detail-page detection, gallery/title/brand selectors, and a
CDN-specific image-URL upgrade rule. The single generic content script
(`content/marketplace.js`) resolves the adapter matching the current host and
runs the same extract → overlay → grade path everywhere.

- **Config is remotely updatable** (US-1756 AC2): selectors live in
  [`selectors.js`](selectors.js) (bundled default) **and** in
  [`public/extension/marketplace-selectors.json`](../public/extension/marketplace-selectors.json),
  served at `https://gradethread.com/extension/marketplace-selectors.json`,
  which the extension fetches and prefers. When a marketplace breaks a selector,
  fix the **hosted** file and deploy the frontend — no store resubmission.
- **Graceful fallback** (US-1756 AC3): an unknown/disabled host is a no-op; a
  recognized page whose selectors resolve no images shows a plain "couldn't read
  the photos" message — it never grades an empty set or shows a wrong read.
- `verified: true` marks adapters checked against the live site (eBay, US-1755).
  The others are best-effort starting points, corrected from telemetry via the
  remote config. Update: fix selectors in **both** `selectors.js` and
  `public/extension/marketplace-selectors.json`; bump `version` + `lastVerified`.

## Privacy

- **No `cookies` permission** and no marketplace-account access — the extension
  only reads the public image URLs already rendered on the page.
- The grade call goes to GradeThread's **public** endpoint, which **persists
  nothing** server-side. Your reads are stored **locally**
  (`chrome.storage.local`).
- Host permissions are limited to `gradethread.com` (the endpoint + the hosted
  config). Marketplaces are reached only via the content script on listing pages.

## Server config (one-time)

The endpoint's CORS allowlist must trust this extension's origin. After loading
it, set on the edge service:

```
EXTENSION_ALLOWED_ORIGINS=chrome-extension://<your-id>,moz-extension://<your-id>
```

(CORS is not the security boundary — the per-IP / per-instance quotas and the AI
daily ceiling are — but the browser still enforces it. See
`services/edge-functions/src/main.ts`.)

## Install (unpacked, for now)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension-condition/` folder.
3. Copy the extension's ID → add its `chrome-extension://<id>` origin to
   `EXTENSION_ALLOWED_ORIGINS` on the edge and redeploy.
4. Open a supported clothing listing → click **Get condition read**.

Store distribution + the install/click funnel is US-1757.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (minimal perms; host-permitted only on gradethread.com) |
| `background.js` | Service worker: instance-id + quota key, the grade fetch (extension-origin CORS), remote-config cache, settings, recent-reads history |
| `selectors.js` | Bundled default adapter config (`GT_CC_CONFIG`) for all six marketplaces |
| `content/image-utils.cjs` | Pure, testable helpers: URL upgrade, adapter resolution, detail-page detection (dual-use node/browser) |
| `content/marketplace.js` | Generic content script: resolve adapter → detect → extract → overlay → states |
| `overlay.css` | Injected overlay styles (reset-hardened, brand-colored) |
| `popup.{html,css,js}` | Recent reads + settings + sign-in |
| `test/image-utils.test.cjs` | `node extension-condition/test/image-utils.test.cjs` |

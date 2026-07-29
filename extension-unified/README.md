# GradeThread — unified browser extension (US-1872 / US-1873)

**One install, role- and subscription-aware.** This folder merges the two legacy
extensions into a single MV3 extension:

- **Condition Check (buyer research)** — from `extension-condition/` (US-1755/1756).
  An independent AI condition read on eBay / Poshmark / Grailed / Mercari / Depop /
  Vinted listing pages. **Always on** — anonymous-capable, quota-capped.
- **Flip mode (US-2238)** — the SELLER's question about the same listing. On a
  detail page, a FlipDesk account gets "Should I flip this?": the listing's own
  photos are shadow-graded, priced against condition-matched eBay comps, and
  turned into resale range / margin after fees / break-even / days-to-sell /
  buy-or-pass (`POST /api/flipdesk/scout/appraise-url`, the URL-fed twin of
  ScoutAI's `/appraise`). **Click-to-run, never automatic** — it spends a metered
  AI action, unlike the buyer read's free tier. The shadow grade is private to
  the tenant and is never written to `grade_reports` (US-620).
- **Scan mode (US-2237)** — the same six marketplaces' **search / category grids**.
  Badges each result with the seller's *claimed* condition and whether the asking
  price is high or low for that claim. **It does not grade**: no photo is fetched
  and no Vision call is made, which is why it can run automatically (default ON)
  where the detail-page read stays click-to-run.
- **Lister (seller cross-post)** — from `extension/` (US-716). Cross-post + delist
  FlipDesk drafts into Poshmark / Mercari / Grailed from the seller's own logged-in
  tab. **Unlocks only for an active paid FlipDesk account.**

Founder decision 2026-07-09: sellers doing sourcing/comping ARE buyers in the same
session — two installs and two store listings is friction. See
[[unified-extension-decision]] (agent memory) and prd.json US-1872..US-1885.

## Layout (module boundaries kept for a clean store-review narrative)

```
manifest.json        one MV3 manifest — both permission sets + all content scripts
background.js        one service worker — routes GT_CC_* + GT_LISTER_* + entitlements
registry.js          feature registry — resolves capabilities from entitlements+settings
popup.html/js/css    role-aware popup (US-1885)
onboarding.html      first-run page opened on install (US-1885 AC4)
research/            buyer overlay  (selectors.js, image-utils.js, condition-format.js,
                     scan-format.js, flip-format.js, marketplace.js, overlay.css)
lister/              seller Lister  (selectors.js, lister-guard.js, common.js, poshmark/mercari/grailed.js)
icons/               shared icon set
test/                zero-dep node guards (run in verify:web via scripts/test-extensions.mjs)
```

## The gate (US-1873)

`registry.js` is the single source of truth for "what may this install do?":

| capability | granted when |
|---|---|
| `research` | **always** (anonymous allowed, quota-capped server-side) |
| `autoRun`  | buyer setting (default **off** — it spends a Vision call per listing) |
| scan mode  | buyer setting (default **on** — it spends none; `scanMode !== false`) |
| `lister` / `delist` | `sellerEnabled` — an **active paid FlipDesk** plan |
| flip mode  | `sellerEnabled`, gated in BOTH the content script (render) and the background (request); the server gates again via `requireFlipdesk` |

`background.js` fetches `GET https://functions.gradethread.com/api/grading/public/entitlements`
with the signed extension token (US-1838), normalizes it through the registry, and
**refuses** `GT_LISTER_LIST` / `GT_LISTER_DELIST` when `lister` is false. **Fail-safe:**
any lookup gap or malformed response resolves to anonymous (buyer-only) — a hiccup
never unlocks seller tools. The cache is short (5 min) and a token set/clear
invalidates it, so a sign-in / upgrade / lapse takes effect without a tab reload.

## Auth / token flow

1. The buyer app mints a token: `POST /api/buyer/extension-token` (US-1838).
2. The connect page posts it to the extension via `externally_connectable`:
   `chrome.runtime.sendMessage(extId, { type: "GT_SET_TOKEN", token })`.
3. `background.js` stores it as `gtBuyerToken`, invalidates the entitlement cache,
   and re-resolves capabilities. `GT_CLEAR_TOKEN` signs out.

The popup's **Sign in** button opens `gradethread.com/connect-extension?ext=<id>`
to launch this flow. *(The `/connect-extension` frontend page is the remaining
half — it mints the token and posts `GT_SET_TOKEN` back. The extension side is
complete.)*

## Privacy posture (rewritten for the merged permission set — US-1872 AC4)

The old Lister claim "not host-permitted on gradethread.com" no longer holds once
merged. The posture is now:

> **No `cookies` permission and no access to your marketplace accounts.** Condition
> Check sends only the public listing photos already on the page to GradeThread's
> public endpoint (nothing is persisted server-side). Lister automation runs
> entirely on your device — GradeThread never receives your marketplace password or
> cookies, and records a cross-listing only from your own GradeThread session.

**Scan mode adds one flow, and it is the only one that runs without a click** —
so it is stated separately in `SUBMISSION.md` rather than folded into the above.
On a supported search page it sends the text *already printed on* up to 24 visible
result cards (title, price, stated condition) to `/api/grading/public/scan`. No
photos, no page address, no account identifier; nothing is persisted; the popup
toggle switches it off.

## Wiring for the single extension id (US-1873 AC5)

Once published, the unified extension has ONE id. Update:

- **`VITE_LISTER_EXTENSION_ID`** → the unified id (the frontend bridge
  `src/lib/lister-extension.ts` sends `GT_LISTER_LIST`/`GT_LISTER_DELIST` to it
  unchanged).
- **`EXTENSION_ALLOWED_ORIGINS`** (edge, `main.ts`) → add `chrome-extension://<id>`
  so the grade + entitlements endpoints accept its CORS origin.
- **`externally_connectable`** already trusts `*.gradethread.com`.

## Cross-browser (US-1881 / US-1882)

Chrome, Edge, **and Firefox**. The packager emits both a Chrome zip
(`-chrome.zip`) and a Firefox zip (`-firefox.zip`, gecko id
`unified@gradethread.com`). Three things make Firefox work from one codebase:

1. **API namespace** — Firefox's `chrome.*` is callback-only; only `browser.*`
   returns promises. Every script aliases `const chrome = globalThis.browser ||
   globalThis.chrome` so `await chrome.storage…` resolves in both browsers
   (callback-style `sendMessage` in the Lister content scripts was converted to
   promise form for the same reason).
2. **Background** — Chrome runs `background.js` as a service worker (via
   `importScripts`); Firefox runs it as a non-persistent **event page**. The
   `importScripts` call is guarded (`typeof importScripts === "function"`), and the
   Firefox manifest lists the deps in `background.scripts` (in load order) — the
   packager does this transform.
3. **`externally_connectable` → postMessage bridge** — Firefox doesn't support
   page→extension messaging by id. `gt-bridge.js` (a content script on
   gradethread.com) relays `window.postMessage` envelopes to the background and
   back, and drops a `data-gt-ext-bridge` DOM marker the SaaS uses to detect the
   install. The background re-checks the sender origin + entitlement on the bridge
   path exactly as it does for `externally_connectable`. The frontend
   (`src/lib/lister-extension.ts`) picks the transport automatically: Chromium uses
   `externally_connectable`, Firefox uses the bridge. The packager strips
   `externally_connectable` from the Firefox manifest (AMO flags the unsupported
   key).

## Status vs the two legacy folders

`extension/` and `extension-condition/` remain until this reaches store parity
(US-1872 AC5), then they're removed and US-1757 store distribution targets this
folder only. The reliability/coverage fixes (US-1874..1884) land **here**.

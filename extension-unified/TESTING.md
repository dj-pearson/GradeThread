# Testing the unified extension locally

## 1a. Load it unpacked (Chrome / Edge)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `extension-unified/`.
3. Note the **ID** Chrome assigns (stable as long as the folder path doesn't move).
   Pin the extension so the popup is one click away.

On first install a **welcome tab** (`onboarding.html`) opens automatically.

## 1b. Load it temporarily (Firefox)

Firefox runs the SAME `extension-unified/` folder (the browser-specific bits —
event-page background, `browser.*` promises, and the postMessage bridge — are all
handled in-code; only the manifest transforms differ, which the packaged zip
applies). To test the exact store artifact, load the built zip:

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
2. Select `dist-ext/gradethread-v0.3.0-firefox.zip` (or its `manifest.json` after
   unzipping). The gecko id is `unified@gradethread.com`.
3. Inspect the background **event page** from that same page if you need the console.

Buyer research works immediately (§2). Sign-in / seller tools go through the
gradethread.com **postMessage bridge** instead of `externally_connectable` — the
frontend picks the transport automatically, so §3 is identical once the env values
are set (the bridge needs no extension id).

## 2. Zero-config: buyer research (anonymous)

No account or env changes needed — the overlay calls the public prod endpoint.

- Open a listing on any supported site (eBay `/itm/`, Poshmark `/listing/`, Grailed
  `/listings/`, Mercari `/item/`, Depop `/products/`, Vinted `/items/`).
- The **GradeThread** pill appears → click **Get condition read** → a score renders.
- Popup: the read shows under **Recent reads**; toggle **Auto-run** and the per-site
  switch.
- Popup **Account** section shows *Not signed in*; **Seller tools** are hidden.

This is the full anonymous path (US-1873 AC3) and needs nothing below.

## 3. Sign-in + seller gate (needs three env values)

The token flow (popup **Sign in** → `/connect-extension` → `GT_SET_TOKEN`) only works
when the page's origin is in the extension's `externally_connectable` (`gradethread.com`)
**and** the edge trusts this install's origin. So test this against the **deployed
site**, with the edge configured:

| where | var | value |
|---|---|---|
| edge (Coolify) | `EXTENSION_ALLOWED_ORIGINS` | add `chrome-extension://<the id from step 1>` |
| edge (Coolify) | `EXTENSION_TOKEN_SECRET` | any strong secret (already set in prod) |
| frontend (Pages) | `VITE_LISTER_EXTENSION_ID` | `<the id from step 1>` (enables the FlipDesk "Send to extension" button) |
| frontend (Pages) | `VITE_LISTER_EXTENSION` | `true` |

Then:

1. Popup → **Sign in to unlock** → opens `gradethread.com/connect-extension?ext=<id>`.
2. Sign in if prompted; the page mints a token and hands it over → **“Extension
   connected”** with your buyer/seller plan summary.
3. Reopen the popup: **Account** shows *Connected* with plan badges. If the account
   is on an **active paid FlipDesk plan**, the **Seller tools** section appears with
   live platform status (selector version + lastVerified) and the Lister consent
   clickwrap. Otherwise you get the honest *“unlocks with a FlipDesk plan”* teaser.
4. In FlipDesk (Listing Kit) → **Send to extension** for a Poshmark draft → the
   background opens Poshmark's new-listing tab, a banner explains the prefill, and
   the form fills. A non-seller account is refused with an upgrade message (the gate).

### Verifying the gate without a paid account

`GET https://functions.gradethread.com/api/grading/public/entitlements`
- no `Authorization` → `{ authenticated:false, sellerEnabled:false, ... }`
- `Authorization: Bearer <token from a paid FlipDesk account>` → `sellerEnabled:true`

The background refuses `GT_LISTER_LIST`/`GT_LISTER_DELIST` whenever `sellerEnabled`
is false (fail-safe), so the seller flow is gated server-authoritatively.

## 4. Automated guards (CI)

```
node scripts/test-extensions.mjs      # adapter helpers, config sync, host drift, registry gating (both folders)
node scripts/package-extensions.mjs   # builds the store zips + validates the manifest
```

Both run in `npm run verify` (verify:web). The packaged Chrome zip lands in
`dist-ext/gradethread-v<version>-chrome.zip`. Firefox is skipped until the
postMessage bridge (US-1882).

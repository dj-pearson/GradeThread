# Testing the unified extension locally

## 1a. Load it unpacked (Chrome / Edge)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select `extension-unified/`.
3. Note the **ID** Chrome assigns (stable as long as the folder path doesn't move).
   Pin the extension so the popup is one click away.

On first install a **welcome tab** (`onboarding.html`) opens automatically.

> **Chrome shows one warning on THIS folder:**
> `'background.scripts' requires manifest version of 2 or lower.`
>
> **To load without it, use `npm run ext:dev` and §1c below.**
>
> The warning is real and harmless. This folder is ONE manifest serving two
> browsers: Chrome runs the background as a service worker and reads
> `background.service_worker`; Firefox has no extension service workers and
> reads `background.scripts`. Both keys must be present in the source, and
> `test/background-deps.test.cjs` enforces that pair as the single source of
> truth for what the background loads.
>
> **Nothing ships with it.** `scripts/package-extensions.mjs` deletes
> `background.scripts` from the Chrome build and `background.service_worker`
> from the Firefox build, by deletion rather than by restating either — so
> neither carries the other browser's key.
>
> Do not "fix" it by removing the key from `manifest.json`: that breaks the
> Firefox event page, which loads its dependencies from that list.

## 1c. Load it unpacked with no warning (Chrome / Edge)

```
npm run ext:dev
```

Writes the same transformed trees the store zips are built from:

| Folder | Load it with |
|---|---|
| `dist-ext/gradethread-chrome/` | `chrome://extensions` → **Load unpacked** |
| `dist-ext/gradethread-firefox/` | `about:debugging` → **Load Temporary Add-on** → its `manifest.json` |

Chrome is silent on this folder because it is the same bytes the Web Store
gets. The trade is that it is a **copy**: edit a file and re-run `npm run
ext:dev`, then hit reload in `chrome://extensions`. For a tight edit loop keep
loading `extension-unified/` per §1a and ignore the one warning.

## 1b. Load it temporarily (Firefox)

Firefox runs the SAME `extension-unified/` folder (the browser-specific bits —
event-page background, `browser.*` promises, and the postMessage bridge — are all
handled in-code; only the manifest transforms differ, which the packaged zip
applies). To test the exact store artifact, load the built zip:

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…**
2. Select `dist-ext/gradethread-v<version>-firefox.zip` (or its `manifest.json`
   after unzipping) — `<version>` is whatever `manifest.json` says, so run
   `node scripts/package-extensions.mjs` first and take the name it prints. The
   gecko id is `unified@gradethread.com`.
3. Inspect the background **event page** from that same page if you need the console.

> **Firefox will not have granted the sites yet.** Firefox's MV3 makes
> `host_permissions` opt-in, so a healthy install starts with no site access and
> the overlay simply never appears. That is expected on first load, not a bug —
> §5a step 2 is where you grant it.

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

Both run in `npm run verify` (verify:web). The packager emits BOTH store
artifacts — `dist-ext/gradethread-v<version>-chrome.zip` (Chrome **and Edge**;
see §5b) and `dist-ext/gradethread-v<version>-firefox.zip`, whose manifest is
DERIVED from the Chrome one (`firefoxManifest()`), never re-declared. The
Firefox build is no longer skipped: the postMessage bridge landed in US-1882.

What CI cannot check, and why §5 exists: every automated guard here runs the
Chrome path. Chrome grants `host_permissions` at install, so the ungranted state
Firefox ships with is unreachable from a test — the two browsers diverge exactly
where nothing is watching. §5a and §5b are the human half, and they are the
evidence US-1881 AC3 and AC5 are asking for.

## 4b. Accessibility scan (US-3053)

```
node scripts/extension-a11y.mjs          # exits 1 on any serious/critical axe violation
node scripts/extension-a11y.mjs --all    # also prints moderate/minor findings
```

Renders `popup.html` headlessly with the `chrome.*` API stubbed
(`scripts/lib/extension-stub.mjs`) in three states — anonymous, signed-in buyer,
seller with work in every queue — opens each of the three tabs and runs
axe-core on each. No network and no account. The stub THROWS on a popup message
it does not know, so a new message renders as a failed run rather than as an
empty block that scans clean. If Playwright's own Chromium is missing, it
falls back to `GT_CHROMIUM` or `/opt/pw-browsers/chromium`.

Keyboard, by hand: Tab to the tab strip, then Left/Right/Home/End move between
Reads, Selling and Settings; Tab again lands on the panel. The Recent reads /
By seller switch works the same way. After Retry, Cancel, Dismiss or a bulk
action, focus stays in the queue card.

## 4c. Screenshots and the visual baseline (US-3054)

```
node scripts/extension-screenshots.mjs            # 48 PNGs into dist-ext/screenshots/ (3 states x System light/dark, forced light, forced dark)
node scripts/extension-screenshots.mjs --check    # compare against test/fixtures/screenshot-baseline.json
node scripts/extension-screenshots.mjs --update   # rewrite the baseline after an intended change
```

Renders the popup (Reads, Selling, Settings), onboarding, options and compare
in light and dark for three fixture states (anonymous, signed-in buyer, seller
with work in every queue) over the same `chrome.*` stub the a11y scan uses,
with a frozen clock so relative times do not move the pixels. Run `--check`
**before a store upload** and after any popup CSS change; a `DRIFT` line names
the render to look at in `dist-ext/screenshots/`. The baseline is tied to the
Chromium build it was made with (recorded in the file): on a different build
`--check` exits 2 and says so rather than reporting every pixel as drift, and
`--update` on the build you want to track fixes that. The PNGs themselves are
the store-listing screenshots for the next version.

## 5a. Firefox end-to-end (US-1881 AC3) — the sign-off checklist

Do this on the built `-firefox.zip`, against the **deployed site**, on a real
listing. Tick every line; a skipped line is a claim nobody made.

| # | Step | Pass looks like |
|---|---|---|
| 1 | Load the zip per §1b. Open `about:debugging` → **Inspect** the event page. | Console shows the background booted with no `ReferenceError`. A missing `GT_LISTER_*` global here means a `background.scripts` dep drifted (guarded by `test/background-deps.test.cjs`, but confirm). |
| 2 | Open a live eBay `/itm/` listing. Click the toolbar icon. | The popup shows the amber **"has not given GradeThread access to …"** block with an **Allow on `www.ebay.com`** button. It must NOT show a working site toggle instead — that would mean the probe answered wrong. |
| 3 | Click **Allow on …** and accept Firefox's prompt. | The tab reloads by itself and the **GradeThread** pill appears bottom-right. (Firefox injects a newly-permitted content script on the next navigation only, which is why the reload is part of the flow.) |
| 4 | Click **Get condition read**. | A 1–10 score renders from the listing photos. This is the config fetch **and** the grade call: a CORS failure here means the install's `moz-extension://<uuid>` origin is not in `EXTENSION_ALLOWED_ORIGINS` — see the table in §3 and the example in `services/edge-functions/.env.example`. Note that Firefox's uuid is **per-install**, so a dev profile's origin is not the store build's. |
| 5 | Reopen the popup. | The read is listed under **Recent reads** with its score; **Auto-run** and the per-site toggle are present and persist across a popup close/reopen (storage). |
| 6 | Repeat step 2 on one non-eBay site (Poshmark `/listing/`, Vinted `/items/`, …). | Same ask, same grant, same read. Confirms the flow is per-host and not eBay-shaped. |
| 7 | Popup → **Sign in to unlock**. | Before the click, the popup shows the **"Firefox will ask you to allow GradeThread on gradethread.com"** hint; the click asks for that permission and then opens `/connect-extension`. Signing in returns you to a popup reading **Connected** with plan badges. Without the grant the token has no way home (no `externally_connectable` on Firefox) and the popup would sit on *Not signed in* with no error — that is the failure this step is looking for. |
| 8 | Seller tools, on a paid FlipDesk account. | The **Seller tools** section appears with live platform status, and FlipDesk → **Send to extension** fills a Poshmark draft. On a free account, the honest *"unlocks with a FlipDesk plan"* teaser instead. Seller gating is capability-based (entitlements), not browser-based — there is no Firefox gate to look for. |

**Record the outcome** in the story's progress note: Firefox version, OS, which
marketplace, and any step that needed a retry.

## 5b. Edge smoke (US-1881 AC5)

Edge loads the **Chrome** zip unchanged — same manifest, same
`externally_connectable`, host permissions granted at install (so §5a's steps 2,
3 and 7 have no permission prompt; the amber block must stay hidden).

1. `edge://extensions` → **Developer mode** → **Load unpacked** → `extension-unified/`
   (or drag in `dist-ext/gradethread-v<version>-chrome.zip`).
2. Note the ID Edge assigns. It is **not** the Chrome Web Store id — add
   `chrome-extension://<that id>` to `EXTENSION_ALLOWED_ORIGINS` before testing
   anything past step 4 below.
3. Open a live eBay `/itm/` listing → the pill appears with no prompt → **Get
   condition read** returns a score.
4. Popup: recent read listed, auto-run toggle persists, per-site toggle works.
5. Popup → **Sign in to unlock** → `/connect-extension` → popup reads
   **Connected**. (Edge supports `externally_connectable`, so this is the Chrome
   path, not the bridge.)
6. Keyboard shortcut `Alt+G` on a listing runs a read — Edge manages its own
   shortcut list at `edge://extensions/shortcuts`, so a conflict is possible and
   is worth confirming.

Then the store checklist in `SUBMISSION.md` → *Microsoft Edge Add-ons — extras*.

## 5c. Transport sign-off (US-1882 AC4) — run it in BOTH browsers

§5a step 8 asks whether the seller flow works. This asks the question underneath
it: **which transport carried the job**. Chromium must keep using
`externally_connectable`; Firefox must use the gradethread.com postMessage
bridge (`gt-bridge.js`), because Firefox has no `externally_connectable` at all.
A page that quietly used both would list the item twice and still look healthy.

The code half is automated — `src/test/lister-transport-selection.test.ts` fails
the build if the preference inverts, if Chromium also posts a bridge envelope, or
if the correlation-id / durable-push semantics stop holding over the bridge. What
no test can reach is a real extension in a real browser talking to a real
marketplace. That is this checklist, and it is measured rather than eyeballed:

```
npm run transport:verify snippet            # prints it
npm run transport:verify snippet --out /tmp/gt-transport.js
```

The snippet wraps `window.postMessage` and `chrome.runtime.sendMessage` and then
watches. It sends nothing itself, so what it reports is what the shipped
`src/lib/lister-extension.ts` actually did.

| # | Step | Pass looks like |
|---|---|---|
| 1 | Sign in on the deployed site, open the FlipDesk **Listing Kit** for a Poshmark-ready item, open DevTools → Console, paste the snippet. | It prints `transport check armed` with the marker and `externally_connectable` readings. On Firefox the marker must read *present* — *ABSENT* means gradethread.com was never granted (§5a step 7) and the flow will HANG, not fail. |
| 2 | Leave that tab open. Click **Send to extension** for the Poshmark draft and let the marketplace tab fill. | The Poshmark new-listing form prefills as in §5a step 8. |
| 3 | Back on the GradeThread tab, run `__gtTransportCheck.report()`. | A table, then `VERDICT: PASS`. `transport used` must read `bridge` on Firefox and `externally_connectable` on Chromium/Edge — the tool derives the expectation from what the browser actually exposed, so the same snippet checks the rule each browser is subject to. |
| 4 | Submit the Poshmark form while the GradeThread tab is still open, then run `report()` again. | `live listing captured (US-1877)` shows the real listing URL. A WARN here only means you closed the tab first. |
| 5 | Repeat 1–3 in Chrome (or Edge). | Same `PASS`, with `transport used = externally_connectable`. This is the AC4 no-regression half, measured on the same build. |

**Record the outcome** by pasting the tool's own one-line result into the story
note — it carries browser, transport, expectation, date and verdict:

```
US-1882 AC4 | firefox | transport=bridge | expected=bridge | 2026-08-07 | PASS
```

A `FAIL` on `transport used` with `REGRESSION` in the detail means Chromium fell
back to the bridge: either `VITE_LISTER_EXTENSION_ID` is unset in that deployment
or the preference in `sendExtensionMessage` inverted.

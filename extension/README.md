# GradeThread Lister (browser extension companion) — US-716

A Chrome (Manifest V3) extension that lists your FlipDesk drafts to
**Poshmark, Mercari, and Grailed** from **your own logged-in browser session**.

None of those three marketplaces has a developer *write* API, and server-side
automation (driving them from GradeThread's servers with stored cookies) is a
ban + legal risk (ToS, CFAA/DMCA — see `docs/bizdev/poshmark-rithum-decision.md`
and US-715). The user-side extension is the model Vendoo / List Perfectly use
and is the only realistic path for these channels.

## Privacy guarantee (and how it's enforced)

**GradeThread servers never receive or store your marketplace passwords or
session cookies.** The automation runs entirely on your device. This isn't just
a promise — the manifest is built so the extension *can't* do otherwise:

- **No `cookies` permission** — the extension cannot read any site's cookies.
- **Not host-permitted on `gradethread.com`** — it can only *receive* a listing
  payload from a GradeThread tab via `externally_connectable`; it can't read
  GradeThread's auth or page state.
- **`host_permissions` are limited to the three marketplaces**, and the content
  scripts only fill the listing form in the tab you're already logged into.
- The only outbound network request is the optional download of your **public,
  EXIF-stripped** item photos (the `item-photos` bucket, US-276) so they can be
  pre-attached to the form.
- The listing URL is reported back to the GradeThread tab, which records the
  cross-listing using **your existing GradeThread session** — the extension
  itself never talks to GradeThread's API.

## Your responsibility (clickwrap)

The Lister fills forms **in your browser, in your session**. Before it will run,
you must accept — in the extension popup — that **you are responsible for
complying with each marketplace's Terms of Service** for every listing you
create (the same clickwrap pattern as US-377). Acceptance is stored locally
(`chrome.storage.local`) and checked by the background worker on every job.

## Phased rollout

Listing flows ship one marketplace at a time (`enabled` flag in `selectors.js`):

| Phase | Marketplace | Status |
|-------|-------------|--------|
| 1 | Poshmark | **Enabled** |
| 2 | Mercari  | Coming soon (selectors flagged off) |
| 3 | Grailed  | Coming soon (selectors flagged off) |

A disabled target reports a clear "list manually for now" message instead of
guessing at the form. When a flow succeeds, GradeThread writes one `listings`
row (`platform=…`, `listing_url`) so the item shows as cross-listed.

## Selectors break — by design we fail loudly

Marketplaces change their listing forms without notice (Mercari especially —
**assume monthly breakage**). Every flow `probe()`s its required selectors
*before* touching the form. If any required selector is missing, the flow
**aborts and tells you to list manually**, naming the selector version that
broke — it never half-fills a form. Selector configs in `selectors.js` are
versioned (`version` + `lastVerified`) and the version is surfaced in the popup
and reported back to GradeThread.

### Updating a broken flow

1. Open the marketplace's sell page, inspect the changed field(s).
2. Fix the selector(s) in `selectors.js` and bump that platform's `version`,
   set `lastVerified` to today.
3. To enable a new platform, flip its `enabled` to `true`.

## Install (unpacked, for now)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Copy the extension's ID and set it on the GradeThread frontend:
   - `VITE_LISTER_EXTENSION=true`
   - `VITE_LISTER_EXTENSION_ID=<the id from chrome://extensions>`
4. Open the extension popup and accept the terms.
5. In FlipDesk → a draft's cross-list kit, click **Send to extension** on a
   supported platform tab.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (minimal permissions; `externally_connectable` = gradethread.com only) |
| `background.js` | Service worker: receives the SaaS payload, opens the tab, relays the result |
| `selectors.js` | **Versioned** per-platform selectors + flows (the thing that breaks) |
| `content/common.js` | Shared fill / probe / photo-attach helpers (React-safe value setter) |
| `content/{poshmark,mercari,grailed}.js` | Per-platform content scripts |
| `popup.{html,css,js}` | Status + clickwrap consent |

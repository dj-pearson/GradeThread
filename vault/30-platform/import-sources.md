---
title: Import sources: every way inventory and photos get into FlipDesk
aliases: [import sources, where inventory comes from, closet import, cloud photo import, phone as camera]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/remote-photo-import.ts
  - services/edge-functions/src/lib/photo-staging-storage.ts
  - services/edge-functions/src/lib/cloud-folder-providers.ts
  - services/edge-functions/src/lib/closet-import.ts
  - services/edge-functions/src/lib/closet-import-run.ts
  - services/edge-functions/src/tests/import-sources-note_test.ts
reviewed: 2026-09-11
tags: [flipdesk, import, photos, oauth, storage, contract]
summary: Every shipped import source with its route, its auth model, what it can and cannot carry and which bucket it writes to; which paths converge on the shared photo core and which deliberately do not; and what blocks Depop, Etsy and Google Drive.
---

# Import sources

Eleven ways a seller's inventory or photos get in, four auth models between
them, one storage bucket. This note is the list, and it carries two rules:

1. **A new import source lands a row in the table below in the same commit.**
   The epic that added four sources (US-3163) made that an acceptance criterion
   and seven member stories closed without it, which is why the table is now
   held to the tree by `services/edge-functions/src/tests/import-sources-note_test.ts`
   rather than by intent.
2. **A new photo source joins the shared core in
   `lib/remote-photo-import.ts`. It does not write a fourth copy of the
   download, validate, strip, upload sequence.** The steps are security steps
   (US-276); a copy is how one of them quietly loses the EXIF strip.

## The table

Keys are the values the code itself uses: an `origin` on `flipdesk_import_runs`,
or a `CloudProviderId`. Routes are relative to `https://functions.gradethread.com`.

<!-- import-sources:table:start -->

| key | source | route | auth model | carries | bucket |
|---|---|---|---|---|---|
| `csv` | spreadsheet file upload | `POST /api/flipdesk/import/runs` | seller session | item rows, cost basis, list and sale prices, dates, SKU, status, link | none (no photos) |
| `sheet` | Google Sheet share link | `POST /api/flipdesk/sheets/fetch-csv` then `POST /api/flipdesk/import/runs` | seller session for the call; the sheet itself needs no grant, it must be readable by anyone with the link | same as `csv` | none (no photos) |
| `paste` | rows pasted into the page | `POST /api/flipdesk/import/runs` | seller session | same as `csv` | none (no photos) |
| `poshmark` | closet read by the browser extension | `POST /api/flipdesk/closet-import/runs` | extension token, minted on the seller's own machine, plus the seller's own logged-in marketplace tab | title, description, brand, size, listed condition text, price, listing URL, up to 8 photos per listing; no cost basis | `item-photos` |
| `mercari` | closet read by the browser extension | `POST /api/flipdesk/closet-import/runs` | extension token plus the seller's own logged-in tab | same as `poshmark` | `item-photos` |
| `grailed` | closet read by the browser extension | `POST /api/flipdesk/closet-import/runs` | extension token plus the seller's own logged-in tab | same as `poshmark` | `item-photos` |
| `sheet-sync` | the seller's own mapped spreadsheet, pulled | `POST /api/flipdesk/google/sync/now` | Google OAuth grant we hold, scopes `drive.file` and `spreadsheets`, refresh token AES-GCM encrypted in `google_connections` | whatever the seller's column map names; see [[google-sheets-sync]] | none (no photos) |
| `google-photos` | Google Photos picker | `GET /api/flipdesk/google/photos/oauth/start`, `POST /api/flipdesk/google/photos/import` | Google OAuth grant we hold (`photospicker.mediaitems.readonly`) plus a 30-minute picker session the seller drives in a Google-hosted page | photos and capture time, nothing else | `item-photos` staging |
| `dropbox` | a Dropbox folder | `GET /api/flipdesk/cloud/dropbox/oauth/start`, `POST /api/flipdesk/cloud/dropbox/import` | Dropbox OAuth grant we hold (`files.metadata.read`, `files.content.read`), encrypted in `cloud_storage_connections` | photos and capture time, nothing else | `item-photos` staging |
| `onedrive` | a OneDrive folder | `GET /api/flipdesk/cloud/onedrive/oauth/start`, `POST /api/flipdesk/cloud/onedrive/import` | Microsoft Graph OAuth grant we hold (`Files.Read`), encrypted in `cloud_storage_connections` | photos and capture time, nothing else | `item-photos` staging |
| `phone` | phone as camera, scan a code and shoot | `POST /api/flipdesk/capture/sessions` (authed), `POST /api/flipdesk/capture/s/:token/photos` (public) | the scanned token IS the credential: no login, no cookie, looked up by hash, one session, caps enforced server-side | photos only, up to 40 per session | `item-photos` staging |

<!-- import-sources:table:end -->

## The four auth models, which are the part worth knowing

Deciding how to add source twelve is a question about this column, not about
the list.

- **A grant we hold.** Google Photos, Dropbox, OneDrive, Sheets sync. The
  seller consents once, we keep an encrypted refresh token in a per-provider
  table and mint access tokens server-side. Costs a connection table, a
  callback route and a disconnect route. Every one of these is a personal
  grant keyed on `userId`, not on the workspace, so a colleague never inherits
  a teammate's Dropbox.
- **A token the browser holds.** Nothing uses this today, and Google Drive is
  blocked on whether we adopt it (below). It is the Picker shape: the page gets
  a narrow access token and the server never sees the folder.
- **An extension session on the seller's own machine.** Poshmark, Mercari,
  Grailed. We hold no marketplace credential at all. The extension reads a page
  the seller already has open and posts with its own signed token, so the mount
  takes `extensionOrUserAuthMiddleware` rather than the ordinary session
  middleware. The refusal that matters here is the owner-only check: an
  adapter reads a shop page only when it can prove the page is the seller's
  own.
- **No third-party auth.** CSV, paste, and the phone capture token. The
  spreadsheet ones carry nothing to steal. The capture token is the whole
  credential on a public route, so it is 32 random bytes, stored hashed, bound
  to one session, and every limit lives on the server.

The Google Sheet share link sits between the last two: the call is authed, the
sheet is not, because the seller has made it readable by anyone with the link.
That is why it can never see a private sheet, and why the 403 sentence tells
the seller to change the sharing rather than to reconnect.

## What converges, and what deliberately does not

`lib/remote-photo-import.ts` is the shared core (US-3157): download, magic-byte
validate, EXIF strip, upload, one file's failure recorded against its own id
while the rest of the chunk continues. Google Photos, Dropbox and OneDrive all
run through it. A provider owns only the host allowlist, the folder listing and
the direct-link resolution. **A fourth cloud source joins here.**

Two paths do not, and both are correct:

- **`lib/closet-import-run.ts` has its own download, validate, strip, upload
  loop** (`copyClosetPhotos`). It fetches through `safeFetch` with no
  credential attached, restricted to the marketplace's own image hosts, and it
  writes the FINAL `item_photos` row at `{ownerId}/{itemId}/...` rather than
  staging a descriptor for the AutoLister to adopt. The shared core stages and
  returns; this one lands. **Correction worth recording:** the US-3163 epic's
  AC3 says "a grep finds exactly one download-validate-strip-upload sequence in
  `services/edge-functions/src/lib`". That has never been true since the closet
  import shipped. There are two, and the second is the one above. The AC is
  wrong about the count; the code is right about the shape.
- **`routes/flipdesk-phone-capture.ts` validates and strips inline** because
  there is no download step at all. The phone POSTs the bytes. It uses the same
  `itemPhotoStaging()` adapter as the cloud sources, so the storage half is
  still shared.

## What each source cannot carry

Stated because the gap is usually invisible until a seller asks where a number
went.

- **A CSV, a pasted block and a Google Sheet carry no photos.** The importer
  writes item rows; `Photos`, `Image URLs` and `IMAGE1` are mapped to `skip` on
  purpose in every preset. See [[import-presets]].
- **A closet import carries photos but no cost basis.** `itemFieldsForRow`
  fills description, brand, size and a condition note built from the listed
  condition text, and nothing else. A marketplace page does not know what the
  seller paid, so the item arrives with `acquired_price` null and the money
  views stay honest about it.
- **A cloud folder or a phone carries photos and a capture timestamp.**
  No title, no price, no brand. They are photo sources, not listing sources.
- **A closet re-run refreshes price and URL and fills a blank title or
  description, never an edited one.** A title the seller rewrote in FlipDesk is
  theirs.

## Storage, which is the rule most easily lost

Every import source that writes bytes writes to **`item-photos`, the one public
bucket**, and gets there through `validateImageUpload` then
`stripImageMetadata` then `storage.upload` (US-276). No exceptions, and there is
no flag that would make one.

- Cloud and phone sources stage at `{ownerId}/_staging/<key>/<uuid>.<ext>`.
  The AutoLister adopts from that prefix and checks it, so a staged path outside
  the caller's own folder is refused.
- The closet import writes straight to `{ownerId}/{itemId}/import_<platform>_<i>_<ts>.<ext>`
  and inserts the `item_photos` row in the same step.
- **No import source can write to `submission-images`.** That private bucket
  holds grading photos and the sensitive item types (`tag`, `tag_2`,
  `certificate`, per `bucketForItemPhoto`), and no import path assigns one of
  those types. The consequence is worth knowing rather than discovering: a
  photo imported as `front` or `detail` and later re-tagged as `tag` on the
  desktop keeps its public blob, because the type moved and the bytes did not.
  That is the same behaviour every web upload has had since US-979, not a new
  hole, but a private-bucket import source would need its own staging adapter
  rather than a flag on `itemPhotoStaging()`.
- A marketplace CDN URL is never stored as `photo_url`. The bytes are copied.

## Three sources that are not shipped, and what blocks each

Do not read these as unfinished work waiting for an idle hour. Each is blocked
on something no code change reaches.

| would-be source | blocker |
|---|---|
| Depop closet import (US-3154) | Two. The `flipdesk_import_runs_origin_check` constraint permits six values and `depop` is not one, so a run would fail at the insert with 23514 and the build blocks it first; widening it is a migration with the US-1108 triple. And the owner-only tell for a seller's own Depop shop page is still unknown, and it must be read off a live signed-in account, never guessed, or the adapter reads a stranger's shop into the seller's catalogue. The verified tile and JSON-LD selectors are already recorded on the story. |
| Etsy listing import (US-3156) | External approval. `ETSY_KEYSTRING` is unset, `isEtsyEnabled()` returns false, and `MARKETPLACE_TIER.etsy` reads `api_pending`. It also needs the same origin widening, and the listing-image field name cannot be written honestly from this repo: nothing here ever reads a listing resource back. The unblocked substitute is the `etsy` CSV preset, which needs no approval. |
| Google Drive folder import (US-3158) | An owner decision. `drive.readonly` is a Google RESTRICTED scope, so the non-restricted path is the browser-side Picker, and that costs a new `google_drive_connections` table, three CSP widenings in `public/_headers` and a Picker API key. Dropbox and OneDrive went first precisely because neither has this problem. |

**The rule the first two share, and it is the cheapest line in this note: widen
the `origin` CHECK FIRST on any new import origin, not last.** Grailed shipped
against a five-value constraint and every Grailed import failed at the insert
for months (US-3261), with the seller reading "Could not start the import."

## Two things that create inventory and are not import sources

Named so nobody goes looking for them in the table.

- **Marketplace sync** updates listings that already exist and never creates an
  item from a marketplace. eBay has no "pull my existing listings" path; a
  switching eBay seller uses the `ebay-file-exchange` CSV preset. The
  provenance model is [[sync-source-of-truth]].
- **Scout** writes an `inventory_items` row with `acquired_source: "scout"`
  when a seller saves a sourcing candidate. That is sourcing, not importing a
  catalogue the seller already has.

## Related

- [[import-presets]]: the column mapping behind `csv`, `sheet` and `paste`
- [[google-sheets-sync]]: the merge behind `sheet-sync`
- [[closing-a-coverage-gap]]: what it takes to make a marketplace real
- [[marketplace-connector-contract]]: the shape every OAuth connector copies
- [[sync-source-of-truth]]: who owns a field once two systems hold it

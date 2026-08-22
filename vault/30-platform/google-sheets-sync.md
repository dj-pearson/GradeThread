---
title: Google Sheets sync — one merge, and the rules that protect a seller's own sheet
aliases: [runMerge, sheet map, bring your own sheet]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/sheet-sync.ts
  - services/edge-functions/src/lib/sheet-map.ts
  - services/edge-functions/src/routes/flipdesk-google-sync.ts
reviewed: 2026-08-22
tags: [flipdesk, sync, google, contract]
summary: One bidirectional 3-way merge where GradeThread wins conflicts, plus a mapped mode that writes into a seller's own spreadsheet and therefore carries hard safety rules.
---

# Google Sheets sync

## One pass, not two

`runMerge` (`routes/flipdesk-google-sync.ts`) is a **single bidirectional pass**
over a pure merge in `lib/sheet-sync.ts`. `decideField(base, sheet, db)` resolves
each field three ways:

| Situation | Outcome |
|---|---|
| both changed since the snapshot | **conflict → GradeThread wins**, sheet rewritten from the DB |
| only the sheet changed | pull |
| first sync, no snapshot, or ambiguous | push (DB wins) |

So GradeThread already has strictly higher priority: the sheet only writes back a
field GradeThread has not touched since the last sync, and **no GradeThread edit
is ever lost**. That is the intended policy, confirmed with the owner — not a
default to be "improved".

The snapshot base lives in `google_sheet_sync_state` keyed
`(user_id, tab, flipdesk_id)`. Rows are keyed by a **hidden `flipdesk_id` UUID in
column A — not by SKU** (classic mode).

## Which tabs are writable

Inventory is two-way. **Listings, Sales and Sources are a read-only mirror.**

> The recurring support confusion: a seller looks at their *own* tab and expects
> edits to sync, or edits a value on the Listings mirror and watches it revert.
> Item **Status on Inventory is two-way**; listing status, price and the eBay URL
> are one-way DB → sheet.

**Title is one-way, DB → sheet, on both tabs (US-2593).** The Inventory tab's
Title column reads `inventory_items.title` and the Listings tab's reads
`listings.listing_title`; the two used to drift because only the listing copy
ever moved. The item column now follows the listing title on every composer save
and on every eBay revise, and the sheet cell became a read-only mirror (gray
fill, rewritten from the DB on the next sync). In mapped mode the same rule is
expressed as **create-only**: `buildCreateFromSheet` still names a new item from
the sheet and a genuinely blank title is still filled, but once an item has a
title, an edit to that cell is pushed back over rather than pulled. The seller
edits the title in the composer, which is also what goes to eBay.

eBay-owned fields on eBay-originated listings are **locked** and reported back as
skipped rather than silently reverted — see [[sync-source-of-truth]] for that
carve-out.

## Mapped mode writes into a sheet you did not create

"Bring your own sheet" syncs a seller's own tab and layout through a stored
column map (`google_connections.sheet_map`, migration `00433`; `NULL` = classic
generated-tabs mode). It is keyed by **SKU**, not the hidden UUID, and can create
items from unknown SKUs.

That means the code is writing into a spreadsheet holding a seller's history,
formulas and side tables. Three rules follow, and none is optional:

1. **Targeted per-cell updates, never full-row rewrites.** Unmapped columns —
   comps, dashboards, their own notes — must be left untouched.
2. **First sync is ADOPT.** Fill the empty DB fields from the sheet, take the
   sheet as the baseline, and **write nothing back on first contact**, so an
   existing sheet cannot be blanked by a DB that has not caught up yet.
   GradeThread wins conflicts from run 2 onward.
3. **Read-only mirror columns are fill-only.** Never blank a historical value
   because the DB has nothing for it.

The pure engine (`lib/sheet-map.ts`: `parseMappedValue`/`formatMappedValue`,
`suggestFieldForHeader`, `resolveMappedColumns`, `mergeMappedRow`,
`buildCreateFromSheet`, `validateSheetMap`, `WRITABLE_INVENTORY_FIELDS`) is unit
tested. **The orchestration is not** — `runMappedMerge` and `loadMappedRecords`
need live Sheets plus Supabase.

> [!warning] Validate mapped mode against a **copy** of the real sheet, with a
> backup. There is no integration test standing between a mistake here and a
> seller's own spreadsheet.

## Two failure shapes already fixed, worth not reintroducing

- **A dropdown that looked editable but was not writable** silently reverted the
  seller's edits. Tab setup now gates the category dropdown on `writable`.
- **A dropdown built from a stale enum copy.** `ITEM_CATEGORY_VALUES` in
  `sheet-sync.ts` does double duty: it rejects an out-of-list cell *and* becomes
  the Sheets data-validation list, so a value missing from it is one the seller
  cannot pick and cannot type. It sat two enum widenings behind the database —
  missing `jewelry`/`bags`/`accessories` (00230) and `headwear` (00570) — until
  US-2797. `src/test/garment-taxonomy-copies.test.ts` now holds it to
  `ITEM_CATEGORIES`.
- **Snapshot non-atomicity.** Pure-pull rows commit their snapshot *before* the
  Sheets cell-writes (`earlySnapshotUpserts`), closing the false-conflict window
  when the Sheets API fails mid-run. Pushed rows still snapshot after.

SKU is the merge identity in mapped mode, so it is guarded like title in
`parsePulledValue` — a blanked SKU cannot come back from the sheet. (The title
half of that guard is now belt-and-braces: classic Title does not pull at all.)

## Related

- [[sync-source-of-truth]] — precedence, provenance, and the eBay lock
- [[cross-listing]] — the other integrations this sits beside
- [[INDEX]]

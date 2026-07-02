# Sync Source-of-Truth Contract

> Canonical reference for how listing/inventory data is reconciled across **eBay**, **GradeThread/FlipDesk**, and **linking sources** (CSV import, Google Sheets).
> Authored 2026-06-16. Epic: US-1076…US-1086 (US-1086 = iOS parity).

## TL;DR

Authority is **per-listing, decided by provenance** — not global. Each listing has exactly **one** editing surface; the other side is a read-only mirror or is re-asserted.

| | **GradeThread-originated** (published from FlipDesk) | **eBay-originated** (imported from eBay) |
|---|---|---|
| **Source of truth** | GradeThread | eBay |
| **Edit here** | GradeThread → push up to eBay | eBay → pushes back into GradeThread |
| **Inbound eBay sync** | Ignores editable fields; pulls **only read-only signals** (views, watchers, sold/ended status, orders, fees). GradeThread re-asserts its values on the next push. | **Overwrites** eBay-owned fields — full mirror. |
| **eBay-owned fields in the GT editor** | Editable | **Locked (read-only)** |
| **UI badge** | "Edit in GradeThread" (warn: don't edit on eBay) | "Edit on eBay" (deep-link to the listing) |

## Field ownership (applies to both classes)

> **Registry:** `services/edge-functions/src/lib/sync-precedence.ts` (US-1076) is the **canonical code registry** for field ownership. The prose below summarises it; if they ever diverge, the code wins.

| Registry export | Fields | Rule |
|---|---|---|
| `EBAY_OWNED_LISTING_FIELDS` | `listing_title`, `listing_price`, `listing_description`, `listing_status`, `is_active`, `quantity`, `listed_at`, `platform_category_id`, `platform_listing_id`, `platform_offer_id`, `listing_url` | For `listing_origin='ebay'` these are overwritten on every inbound pull (full mirror). For `listing_origin='gradethread'` these are **locked** — inbound pull must not write them; GradeThread re-asserts on the next push. |
| `LISTING_READONLY_SIGNALS` | `is_active`, `listing_status` | Subset of `EBAY_OWNED_LISTING_FIELDS`. These flow in regardless of `listing_origin`: GradeThread must know when eBay ends or marks a listing sold. |
| `GRADETHREAD_OWNED_ITEM_FIELDS` | `grade_value`, `condition_notes`, `acquired_price`, `acquired_date`, `sku`, `source_id` | Always owned by GradeThread — no eBay pull (for any `listing_origin`) and no CSV import may write these. |

The server (`buildListingPullPatch`, `validateEbayOriginEdit`) enforces these boundaries; no client-side precedence logic exists.

## Linking sources (lowest authority)

- **CSV import — fill-only.** Populates a field **only when it is blank**; never overwrites a populated field. "Blank" = `null` or empty string (a `0`, empty array, or placeholder counts as *set*). Matched on **SKU**. (Today's importer is INSERT-only and skips existing SKUs entirely — US-1082 upgrades it to fill blanks on existing rows.)
- **Google Sheets — bidirectional, EXEMPT (with one carve-out).** The existing 3-way snapshot merge (`sheet-sync.ts` / `routes/flipdesk-google-sync.ts`) is kept as-is by deliberate decision: the sheet remains an editable surface that can overwrite populated DB fields, conflicts resolve DB-wins. The fill-only rule does **not** apply to Sheets — **except** for **eBay-owned fields on eBay-originated (locked) listings**, which Sheets must **not** overwrite. eBay stays the source of truth there, so a sheet edit to such a cell is **not applied** (the cell is rewritten from the DB) and is reported back to the user as a **skipped item** ("locked — edit on eBay"): per-cell detail on the **Conflicts tab** (status `Skipped — edit on eBay`), a count in the **Sync Log**, and the `skippedItems` array on the `/sync/now` response (surfaced in the "Sync now" toast). The skip is **field-scoped** — GradeThread-owned and unowned fields on the same locked listing still sync normally. See **US-1083**.
  - **Implementation:** the carve-out is enforced by `isSheetEditLockedByEbay()` + `deriveListingOrigin()` in `sync-precedence.ts`. The Sheets merge does **not** read the deprecated `listings.source_of_truth` pin (retired by US-1078) — provenance drives it. Until US-1077 persists the `listing_origin` column, origin is **derived** from the same signals US-1077 backfills from (`batch_id` / `synced_to_ebay_at` ⇒ GradeThread; an eBay `platform_listing_id` we never published ⇒ eBay; ambiguous ⇒ GradeThread, i.e. fully bidirectional), so behavior is forward-compatible: once the column exists and is selected, the stored marker wins outright.

## Shared fields: item columns ↔ eBay item specifics (single-entry rule)

`brand`, `size`, `color`, `material`, `style` exist twice by construction: as structured
`inventory_items` columns AND as eBay aspects (`listings.item_specifics_override` /
`inventory_items.ebay_aspects`, e.g. `Brand`, `US Shoe Size`, `Colour`). The contract is
**one entry feeds both** — the seller never types the same value in two places:

- **Columns are the write-authority.** At publish/revise the edge force-projects the current
  column values onto their aspects (`forceColumnAspects` → `applyColumnAspects`), and the item
  page projects them on every save (web `projectColumnAspects`). A blanked column clears its
  aspect only on the item-page save (an explicit clear); the publish path is overwrite-only.
- **Specifics edits flow back by provenance** (`reverseColumnAspects` on the edge — run in
  `assemblePublishContext` and the revise path *before* the column re-assert — and
  `reverseProjectAspectColumns` on web, run in the composer + bulk-edit saves):
  - `manual` — the seller typed it in a specifics editor: fills an empty backing field and
    **overwrites** a differing one (newest human intent wins; the next projection is then a
    no-op instead of a clobber).
  - `ai_extracted` — **fill-if-blank only**, same rule as the inbound eBay/CSV merges.
  - `inventory_derived` / unattributed — never written back (it either came *from* the field,
    possibly normalized e.g. "M" → "Medium", or can't be attributed).
  - An absent/blank aspect never clears a field — a category spec without the aspect is
    indistinguishable from an intentional clear.
- **US-821 canonical attributes** (`department`, `pattern`, `fit`, …) get the same reverse
  treatment on web saves, keyed by `inventory_items.attributes`.
- The field↔aspect-name mapping lives ONLY in the shared registry
  (`services/edge-functions/src/lib/aspect-registry.ts`, vendored to web as
  `src/lib/ebay-aspect-registry.json`, CI drift-guarded).

This composes with the ownership table above: on inbound pull `brand/size/color/style/material`
remain fill-if-blank (`EBAY_OWNED_ITEM_SPECIFIC_FIELDS`); the reverse write-back only runs on
GradeThread editing surfaces and the GT-side publish path.

## What this model deliberately removes

- **No push-before-pull, no per-field dirty-tracking, no outbound retry queue for live-listing edits.** Earlier drafts needed these to protect local edits from an authoritative eBay pull. Provenance makes them unnecessary: GT-originated listings are never overwritten on editable fields, and eBay-originated listings are read-only mirrors with no local edits to protect.
- **The eBay per-field `source_of_truth` pin (US-148) is retired** for the eBay↔FlipDesk axis — provenance supersedes it. (See US-1078 notes on safe removal; the Google Sheets merge does not depend on it.)

## Surface parity (web + iOS)

These rules are surface-agnostic. **iOS enforces the identical model** (US-1086): eBay-originated listings are read-only mirrors with an "Edit on eBay" deep-link; GradeThread-originated listings are editable in-app and push up via the same edge endpoints. There is **no client-side precedence logic** on either web or iOS — the edge service is the single enforcement point (server rejects writes to locked eBay-owned fields regardless of client). CSV/Sheets reconciliation stays entirely server-side.

## Provenance marker

A `listing_origin` value (`gradethread` | `ebay`) on `listings` drives both the sync direction and the UI badge. Backfilled from existing signals: GT-originated = created via the FlipDesk publish path (`batch_id` / our `synced_to_ebay_at`); eBay-originated = imported via `flipdesk_ebay_listings`. New listings stamp origin at creation. See US-1077.

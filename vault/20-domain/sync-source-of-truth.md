---
title: Sync source-of-truth contract
aliases: [SYNC_SOURCE_OF_TRUTH, provenance]
type: contract
status: current
source_of_truth: code
code_refs:
  - services/edge-functions/src/lib/sync-precedence.ts
  - services/edge-functions/src/routes/flipdesk-google-sync.ts
  - services/edge-functions/src/lib/sheet-map.ts
reviewed: 2026-07-18
tags: [flipdesk, sync, contract]
summary: Provenance model, field ownership and linking-source rules for bidirectional marketplace and sheet sync.
---

> **Migrated, not re-verified (US-2052).** This note moved into the vault
> unchanged. Its `reviewed` date is when the document was last EDITED, not
> when anyone last checked it against `code_refs` — stamping the migration
> date would have asserted a verification that did not happen. Expect the
> drift guard to flag it; that flag is correct.
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
| `EBAY_OWNED_LISTING_FIELDS` | `listing_title`, `listing_price`, `listing_description`, `listing_status`, `is_active`, `quantity`, `listed_at`, `platform_category_id`, `platform_listing_id`, `platform_offer_id`, `listing_url` | For `listing_origin='ebay'` these are overwritten on every inbound pull (full mirror). For `listing_origin='gradethread'` the **editable** ones are locked — `listing_title`, `listing_price`, `listing_description`, `quantity`, `platform_category_id` — and GradeThread re-asserts them on the next push. The state signals and the eBay-**assigned** identity fields still flow in; see the two rows below. |
| `LISTING_READONLY_SIGNALS` | `is_active`, `listing_status` | Subset of `EBAY_OWNED_LISTING_FIELDS`. These flow in regardless of `listing_origin`: GradeThread must know when eBay ends or marks a listing sold. |
| `LISTING_IDENTITY_FIELDS` | `listed_at`, `platform_listing_id`, `platform_offer_id`, `listing_url` | **eBay ASSIGNS these**, so GradeThread cannot own them even on a listing it originated and published — there is no local value for a pull to overwrite. They flow in for BOTH origins. |
| `LISTING_PULL_ALLOWED_ON_GT_ORIGIN` | the two rows above, combined | What an inbound pull may write on a `gradethread`-origin listing. Everything else in `EBAY_OWNED_LISTING_FIELDS` is locked. |
| `GRADETHREAD_OWNED_ITEM_FIELDS` | `grade_value`, `condition_notes`, `acquired_price`, `acquired_date`, `sku`, `source_id` | Always owned by GradeThread — no eBay pull (for any `listing_origin`) and no CSV import may write these. |

The server (`buildListingPullPatch`, `validateEbayOriginEdit`) enforces these boundaries; no client-side precedence logic exists.


> **US-1994 (2026-07-18) — the identity-field carve-out.** This table used to say
> a `gradethread`-origin pull locks *all* `EBAY_OWNED_LISTING_FIELDS`. The
> production pull path (`applyProvenanceMerge` in `flipdesk-ebay.ts`) never did
> that: it deletes only the five editable fields and has always let `listed_at`,
> `platform_listing_id`, `platform_offer_id` and `listing_url` through.
>
> The divergence was resolved **in production's favour**, because production was
> right — eBay mints those four at publish time, so blocking them would only
> starve our own row of the ids and URL needed to act on the listing later. The
> doc and `sync-precedence.ts` were the overbroad copies and both moved.
>
> Note which way this went: the *tested* module encoded the stricter rule, so its
> green tests read as proof of a contract nothing enforced. `buildListingPullPatch`
> still has no production callers, but it now AGREES with the route, and
> `sync-precedence_test.ts` pins the equivalence — so DRYing the route onto it is
> safe, which it explicitly was not before.

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

## Measurements ↔ eBay measurement aspects (live mirror)

Flat garment measurements (`inventory_items.measurements` jsonb) and matching eBay free-text
item specifics (Inseam, Chest Size, Length, …) are a **live last-write-wins mirror** on the
composer — both editors are visible together, so typing in either updates the other
immediately (including clears). This is separate from the column↔aspect save-time contract
above.

- **Name map:** `MEASUREMENT_SPECS` in `src/lib/measurements.ts` (mirrored on the edge) —
  canonical keys (`inseam`, `chest`, …) → ordered eBay aspect-name candidates.
- **Free-text only:** never write a numeric measurement into a `SELECTION_ONLY` aspect
  (e.g. a “Sleeve Length” style dropdown). Skip reverse parse for those too.
- **Value-shape ownership (the free-text-only rule is not enough):** an aspect NAME can be a
  measurement in one category and a categorical field in the next — a men's hoodie exposes
  “Sleeve Length” as **FREE_TEXT holding “Long Sleeve”**, while a shirt's holds “34 in”.
  Measurements therefore own an aspect only while it is **empty or already holds a value that
  parses as a measurement** (`parseMeasurementAspectValue`). A value that does not parse is
  real listing data — from an item field, AI, or typed by hand — and is neither overwritten
  nor cleared. Without this, a seller with no sleeve measurement lost their “Long Sleeve”
  specific on every composer load.
- **Forward (Measurements → aspects):** `forceMeasurementAspects` overwrites matching
  free-text aspects it owns; provenance → `inventory_derived`. Blanking a measurement clears
  the aspect only when it was `inventory_derived` (manual/AI specifics are left alone).
- **Reverse (aspects → Measurements):** a manual edit in the specifics editor parses
  `"32"`, `"32 in"`, `"81 cm"`, etc. back into the stored number (lengths → inches) and
  updates the Measurements section. Loop-guarded so a forward projection does not echo.
- **Units:** stored lengths remain inches; aspect strings honor the seller’s in/cm preference
  via `formatMeasurementValue` (US-648).
- **Publish / category remap:** still uses fill-only `resolveMeasurementAspects` for empty
  aspects (never clobbers an already-set specific). Live sync is the composer UX; the
  fill-only path remains the safe gap-fill for remap and publish.

## What this model deliberately removes

- **No push-before-pull, no per-field dirty-tracking, no outbound retry queue for live-listing edits.** Earlier drafts needed these to protect local edits from an authoritative eBay pull. Provenance makes them unnecessary: GT-originated listings are never overwritten on editable fields, and eBay-originated listings are read-only mirrors with no local edits to protect.
- **The eBay per-field `source_of_truth` pin (US-148) is retired** for the eBay↔FlipDesk axis — provenance supersedes it. (See US-1078 notes on safe removal; the Google Sheets merge does not depend on it.)

## Surface parity (web + iOS + Android)

These rules are surface-agnostic. **iOS enforces the identical model** (US-1086), and **Android joined it with US-1351**: eBay-originated listings are read-only mirrors with an "edit it on eBay" affordance; GradeThread-originated listings are editable in-app and push up via the same edge endpoints. There is **no client-side precedence logic** on any of the three — the edge service is the single enforcement point (server rejects writes to locked eBay-owned fields regardless of client). What a client's local merge does with provenance is a CACHE decision only: it picks which copy the device shows until the next pull, never what the server accepts. CSV/Sheets reconciliation stays entirely server-side.

## Provenance marker

A `listing_origin` value (`gradethread` | `ebay`) on `listings` drives both the sync direction and the UI badge. Backfilled from existing signals: GT-originated = created via the FlipDesk publish path (`batch_id` / our `synced_to_ebay_at`); eBay-originated = imported via `flipdesk_ebay_listings`. New listings stamp origin at creation. See US-1077.

## Related

- [[ebay-aspect-value-limit]] — a publish-time constraint on synced field values
- [[grading-scale-and-weights]] — grade fields this contract governs the ownership of
- [[measurement-accuracy]] — measurements are one of the synced field families
- [[INDEX]]

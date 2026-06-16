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

- **eBay-owned listing fields:** title, listing price, quantity, listing description, listing status, item specifics/aspects, condition, business policies — anything that lives on the eBay offer/listing.
- **Always GradeThread-owned (eBay never touches):** grade, condition report, measurements, cost/source (acquired price/date/source), SKU. These are GradeThread-owned regardless of listing provenance.

## Linking sources (lowest authority)

- **CSV import — fill-only.** Populates a field **only when it is blank**; never overwrites a populated field. "Blank" = `null` or empty string (a `0`, empty array, or placeholder counts as *set*). Matched on **SKU**. (Today's importer is INSERT-only and skips existing SKUs entirely — US-1082 upgrades it to fill blanks on existing rows.)
- **Google Sheets — bidirectional, EXEMPT (with one carve-out).** The existing 3-way snapshot merge (`sheet-sync.ts`) is kept as-is by deliberate decision: the sheet remains an editable surface that can overwrite populated DB fields, conflicts resolve DB-wins. The fill-only rule does **not** apply to Sheets — **except** for **eBay-owned fields on eBay-originated (locked) listings**, which Sheets must **not** overwrite. eBay stays the source of truth there, so a sheet edit to such a cell is **not applied** and is reported back to the user as a **skipped item** ("locked — edit on eBay"), reusing the existing skip-reporting surface. The skip is **field-scoped** — GradeThread-owned and unowned fields on the same locked listing still sync normally. See US-1083.

## What this model deliberately removes

- **No push-before-pull, no per-field dirty-tracking, no outbound retry queue for live-listing edits.** Earlier drafts needed these to protect local edits from an authoritative eBay pull. Provenance makes them unnecessary: GT-originated listings are never overwritten on editable fields, and eBay-originated listings are read-only mirrors with no local edits to protect.
- **The eBay per-field `source_of_truth` pin (US-148) is retired** for the eBay↔FlipDesk axis — provenance supersedes it. (See US-1078 notes on safe removal; the Google Sheets merge does not depend on it.)

## Surface parity (web + iOS)

These rules are surface-agnostic. **iOS enforces the identical model** (US-1086): eBay-originated listings are read-only mirrors with an "Edit on eBay" deep-link; GradeThread-originated listings are editable in-app and push up via the same edge endpoints. There is **no client-side precedence logic** on either web or iOS — the edge service is the single enforcement point (server rejects writes to locked eBay-owned fields regardless of client). CSV/Sheets reconciliation stays entirely server-side.

## Provenance marker

A `listing_origin` value (`gradethread` | `ebay`) on `listings` drives both the sync direction and the UI badge. Backfilled from existing signals: GT-originated = created via the FlipDesk publish path (`batch_id` / our `synced_to_ebay_at`); eBay-originated = imported via `flipdesk_ebay_listings`. New listings stamp origin at creation. See US-1077.

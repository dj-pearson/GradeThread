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
reviewed: 2026-09-02
tags: [flipdesk, sync, contract]
summary: Provenance model, field ownership and linking-source rules for bidirectional marketplace and sheet sync.
---

> **Checked against the registry on 2026-08-15, and it had drifted.** This note
> spent from US-2052 until now carrying the migration caveat below, which is now
> discharged for the part that matters: every list in the field-ownership table
> was compared against `sync-precedence.ts` line by line. Ten of eleven
> `EBAY_OWNED_LISTING_FIELDS`, both read-only signals and all four identity
> fields matched. `GRADETHREAD_OWNED_ITEM_FIELDS` did not — the code has
> **seven** entries and this table listed six, missing `measurements`. Corrected
> in place. That is the whole value of the drift guard: the note was wrong about
> a field nobody may pull or import, which is the sort of omission that reads as
> permission.
>
> Still NOT re-verified: the prose about the 3-way sheet merge in
> `flipdesk-google-sync.ts`. `sheet-map.ts` and `sync-precedence.ts` were read;
> that route was not.
# Sync Source-of-Truth Contract

> **Re-reviewed 2026-09-02, and the provenance model gained a case.** `015bd5c48`
> stops the Google Sheet re-creating items deleted in FlipDesk: `sheet-map.ts`
> now splits every unmatched SKU into `create` (never synced, a genuinely new
> sheet row) and `deleted` (synced before, item gone), and only the first is
> created. That is this note's rule applied to absence -- a row missing on one
> side is not automatically new -- and it is the same reasoning the closet import
> uses when a listing disappears from a seller's closet.


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
| `GRADETHREAD_OWNED_ITEM_FIELDS` | `grade_value`, `condition_notes`, `measurements`, `acquired_price`, `acquired_date`, `sku`, `source_id` | Always owned by GradeThread — no eBay pull (for any `listing_origin`) and no CSV import may write these. |

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

- **CSV import — fill-only.** Populates a field **only when it is blank**; never overwrites a populated field. "Blank" = `null` or empty string (a `0`, empty array, or placeholder counts as *set*). Matched on **SKU**. Shipped by US-1082, and since **US-2518** the rule lives server-side in `services/edge-functions/src/lib/inventory-import.ts` (`FILL_ITEM_FIELDS` + `fillPatch()`) rather than in the browser — the import is a durable server run, so the list of columns a CSV may write is enforced where the write happens. That run also records one `flipdesk_import_effects` row per change, including the pre-import values of any column it filled, which is what makes an import **reversible**: an undo deletes the items the run created and restores the values it wrote. An item since published to a marketplace (`listings.platform_listing_id` set) is left alone.
- **Google Sheets — bidirectional, EXEMPT (with one carve-out).** The existing 3-way snapshot merge (`sheet-sync.ts` / `routes/flipdesk-google-sync.ts`) is kept as-is by deliberate decision: the sheet remains an editable surface that can overwrite populated DB fields, conflicts resolve DB-wins. The fill-only rule does **not** apply to Sheets — **except** for **eBay-owned fields on eBay-originated (locked) listings**, which Sheets must **not** overwrite. eBay stays the source of truth there, so a sheet edit to such a cell is **not applied** (the cell is rewritten from the DB) and is reported back to the user as a **skipped item** ("locked — edit on eBay"): per-cell detail on the **Conflicts tab** (status `Skipped — edit on eBay`), a count in the **Sync Log**, and the `skippedItems` array on the `/sync/now` response (surfaced in the "Sync now" toast). The skip is **field-scoped** — GradeThread-owned and unowned fields on the same locked listing still sync normally. See **US-1083**.
  - **Implementation:** the carve-out is enforced by `isSheetEditLockedByEbay()` + `deriveListingOrigin()` in `sync-precedence.ts`. The Sheets merge does **not** read the deprecated `listings.source_of_truth` pin (retired by US-1078) — provenance drives it. Until US-1077 persists the `listing_origin` column, origin is **derived** from the same signals US-1077 backfills from (`batch_id` / `synced_to_ebay_at` ⇒ GradeThread; an eBay `platform_listing_id` we never published ⇒ eBay; ambiguous ⇒ GradeThread, i.e. fully bidirectional), so behavior is forward-compatible: once the column exists and is selected, the stored marker wins outright.

## The two titles: `inventory_items.title` follows `listings.listing_title`

A garment carries a title twice — the item's own name and the listing's. Until
US-2593 only the listing copy ever moved: the composer wrote `listing_title`,
the eBay revise wrote `listing_title`, and `inventory_items.title` kept whatever
the item was named at creation. The Inventory tab of a synced Google Sheet reads
the item column, so a corrected size sat on eBay and in the Listings mirror
while the seller's own sheet showed the original wording indefinitely.

**The item title now follows the listing title.** Enforced in two places, both
deliberate:

- **The web composer**, in `itemTitlePatch` — folded into the item patch that
  both `saveDraft` and `saveLiveListing` already write. It carries the
  *substituted* title when the US-1995 write-back made one, so the item never
  keeps words the listing has already dropped. Which is why `titleSyncPatchFor`
  is computed **before** the item write on both paths; the item row is written
  first (see the save-order rule below) and the patch has to exist by then.
- **The edge revise route** (`flipdesk-ebay.ts`), so a revise from iOS or
  Android carries the same rule with no client release behind it.

**Not** in a `listings` trigger, and not in the cross-listing push. Cross-listing
titles are truncated per-platform (`cross-listing-fields.ts` honours each
marketplace's `titleMaxLength`), so anything that let every platform write the
item column would make it flap with whichever push ran last. The eBay path owns
it because eBay is where the seller's own words go.

For Sheets this is settled policy rather than a merge outcome: **the GradeThread
title is the truth**, and the Title cell is a mirror on both tabs. See
[[google-sheets-sync]].

The enforcement is in `sheet-map.ts`, and its shape is worth knowing because it
is not a plain refusal: a mapped Title column is **create-only**. Naming a new
item from the sheet still works, and a blank title still gets filled — but once
a title exists, an edit to that cell is added to the push set and rewritten from
the database rather than pulled. So the seller's edit is not lost silently; it
is visibly reverted on the next sync, which is the honest form of "this cell is
a mirror". The place to change a title is the composer, where the same value is
what goes to eBay.

## Shared fields: item columns ↔ eBay item specifics (single-entry rule)

`brand`, `size`, `color`, `material`, `style` exist twice by construction: as structured
`inventory_items` columns AND as eBay aspects (`listings.item_specifics_override` /
`inventory_items.ebay_aspects`, e.g. `Brand`, `US Shoe Size`, `Colour`). The contract is
**one entry feeds both** — the seller never types the same value in two places:

- **Columns are the write-authority.** At publish/revise the edge force-projects the current
  column values onto their aspects (`forceColumnAspects` → `applyColumnAspects`).
- **A blank column may only clear its aspect on a surface that OWNS the column inputs.**
  Anywhere else, a blank column cannot be told apart from a never-populated one — and the
  second case is the common one: iOS-created items, AI-filled specifics, and anything the
  seller typed into a specifics editor all routinely carry a value whose column is empty.
  - **May clear** (the seller emptied a field they can see, in the same save): AutoLister bulk
    edit's set-or-drop pass (`saveRow` in `src/pages/flipdesk/autolister-bulk-edit.tsx`),
    Android `AspectSync.projectColumnAspects`, and iOS via the server's `columnCleared` list
    (`InventoryAspectSync` → `applyColumnAuthority`). All three run off an item form.
  - **Must not clear** (overwrite-only): the edge publish/revise path
    (`applyColumnAspects`, no `clearEmpty`) and the web composer's
    `projectColumnAspectsForSpec`. Neither has a column input on screen.
  - **Why the composer's projection stopped clearing (2026-08-02).** `projectColumnAspectsForSpec`
    did clear, on the reasoning that the reverse pass runs first, so a still-blank column must
    mean a deliberate clear. That holds only while the write-back LANDS. The composer saves the
    listing row and the item row as two statements with no transaction, so an item write that
    fails alone — a duplicate-SKU 409 — left the listing holding the value stamped
    `inventory_derived` over a column that was never written. Derived values are never written
    back, so the rescue stopped firing and the projection deleted the specific on every
    subsequent save. Reported symptom: Brand plainly visible in the specifics editor, publish
    refusing with "Fill required eBay specifics in the composer: Brand". Pinned by
    `src/lib/__tests__/ebay-prefill.test.ts`.
  - **The CLEAR itself moved to the reverse pass (2026-08-05), where the evidence is.** Keeping
    the projection overwrite-only was right, but it left column-backed specifics impossible to
    empty at all: the reverse pass ignored empty aspects, so the column kept its value and the
    projection re-asserted it on the same save. Brand, Size, Color, Material and Type all
    snapped back, and on the next revise the edge re-derived them too. The missing evidence was
    a **baseline** — the last-saved aspect map. `reverseProjectAspectColumns(item, aspects,
    sources, baseline, spec)` writes `null` to the column (and `null` → key deleted for a
    US-821 attribute) only when the aspect is **present in this category's spec** and **held a
    value in the baseline**. A category that simply lacks the aspect never matches, so
    re-categorising still cannot wipe a column, and the partial-save case above still cannot
    either (the projection is untouched, and the item row is written first). The composer
    passes `savedAspects` as the baseline; every other caller omits it and keeps the old
    fill-and-overwrite-only behaviour.
  - **Save order is part of the contract: item row FIRST, listing row second.** The listing row
    records the aspects as column-derived, which is a claim about the item row — so it must not
    be written until the write that fills the columns has succeeded. Both composer save paths
    (`saveDraft`, `saveLiveListing`) do it in that order.
  - **On web the forward projection is SPEC-AWARE** (`projectColumnAspectsForSpec`, US-2381).
    It resolves each column's aspect name from the **loaded category spec** rather than
    assuming the registry's first name exists, because the two differ per category — `Colour`,
    `US Shoe Size`, `Fabric Type`. Using a spec-less projection where a spec IS loaded would
    write a second key beside the picker's for the same field — a duplicate specific, not a
    sync.
  - **ONE field owns ONE aspect per category** (`ownedAspectName`, both sides, 2026-08-05).
    A category can expose several of an entry's candidate names AT ONCE: Women's Tops (53159)
    has `Style` **and** `Type` (both style-column candidates) and `Material` **and**
    `Fabric Type` (both material). The registry's `aspects` array is a **priority list**, so
    the first candidate the category exposes is bound and every other name is left free for
    the seller, the AI, or an inbound sync. Both older rules were wrong in opposite
    directions: the edge's `columnAspectProjection` forced the column onto *every* match, and
    the web's projection picked whichever matched first in **spec order** (which on Tops bound
    the style column to `Type`, not `Style`). Either way the unowned twin rendered as an
    editable row that silently reverted on save — reported as "Type and Fabric Type won't
    change". The same rule governs the gap-fill (`resolveItemAspects` /
    `deriveAspectsFromItem`, which now iterate ENTRIES rather than the spec), the reverse pass
    when it is given a spec, and `columnBackedAspectNames` — so a client no longer hides a
    free row as column-backed.
  - **The spec-less web projection is gone** (`projectColumnAspects` /
    `projectAttributeAspects`, deleted 2026-08-01). iOS `InventoryAspectSync.swift` and Android
    `AspectSync.kt` still carry that shape and are **correct to**, because their item forms have
    no category spec loaded. That is a UI difference, not drift.
    > **Future, if mobile ever gains a spec-aware item form:** port the rule above rather than
    > the deleted code. It needs the category's aspect list at save time, which those clients do
    > not currently fetch — so it is a rollout with a client release behind it, not a refactor.
    > `src/test/aspect-projection-callers.test.ts` is the guard that makes the next orphan loud.
    A column the category does not expose is **skipped**, and a value a SELECTION_ONLY aspect
    cannot express **leaves the existing value alone** rather than clearing it.
  - **Order is load-bearing, and no type can enforce it.** The reverse pass runs FIRST on the
    PRE-projection aspect map, and the projection is fed the columns as they will be saved
    (item columns overlaid with the write-back). Reversed, a Brand the seller just typed is
    overwritten by the stale column and stamped `inventory_derived`, so the reverse pass then
    declines to rescue it and the edit is silently lost. Pinned by a behavioural test in
    `src/lib/__tests__/ebay-prefill.test.ts` that asserts both orders.
- **Specifics edits flow back by provenance** (`reverseColumnAspects` on the edge — run in
  `assemblePublishContext` and the revise path *before* the column re-assert — and
  `reverseProjectAspectColumns` on web, run in the composer + bulk-edit saves):
  - `manual` — the seller typed it in a specifics editor: fills an empty backing field and
    **overwrites** a differing one (newest human intent wins; the next projection is then a
    no-op instead of a clobber).
  - `ai_extracted` — **fill-if-blank only**, same rule as the inbound eBay/CSV merges.
  - `inventory_derived` / unattributed — never written back (it either came *from* the field,
    possibly normalized e.g. "M" → "Medium", or can't be attributed).
  - **Which aspect it reads back from.** Given a spec, only the ONE name the field owns
    (`ownedAspectName`) — so an edit to a free neighbour like `Type` is not mistaken for a
    rename of the `style` column. Without a spec, it scans the entry's candidates and prefers
    whichever the SELLER touched (`manual`, then `ai_extracted`); taking the first candidate
    that merely held a value picked the stale twin, failed the provenance test, and dropped
    the edit on the floor.
  - A blank aspect clears its field only under the baseline rule above; with no baseline, an
    absent/blank aspect never clears anything — a category spec without the aspect is
    indistinguishable from an intentional clear.
- **US-821 canonical attributes** (`department`, `pattern`, `fit`, …) get the same reverse
  treatment on web saves, keyed by `inventory_items.attributes`.
- The field↔aspect-name mapping lives ONLY in the shared registry
  (`services/edge-functions/src/lib/aspect-registry.ts`, vendored to web as
  `src/lib/ebay-aspect-registry.json`, CI drift-guarded).
- **A client projection is category-spec-less, and that is safe by construction.** The
  client has no eBay category spec at save time, so it treats every value as FREE_TEXT and
  writes to each registry entry's *first* aspect name (Brand/Size/Color/Material/Style) —
  matching the edge's `COLUMN_ASPECT_FALLBACK`. Publish then re-normalizes against the real
  spec (SELECTION_ONLY matching, e.g. "M" → "Medium"), so a raw column value that eBay would
  not accept is corrected before it is sent. Do not add spec-fetching to a save path to
  "fix" this; the correction already happens where the spec actually exists.

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

---
title: The draft snapshot shadows the item — and one editor is why that is safe
aliases: [publish reads the listing first, stale draft, one item editor]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/composer-save.ts
  - src/pages/flipdesk/composer.tsx
  - src/pages/flipdesk/grid.tsx
  - src/pages/flipdesk/grid-columns.ts
  - src/pages/flipdesk/use-grid-listings.ts
  - src/lib/title-sync-patch.ts
  - services/edge-functions/src/routes/flipdesk-ebay-publish.ts
  - services/edge-functions/src/routes/flipdesk-ebay-sync.ts
reviewed: 2026-09-25
tags: [flipdesk, listings, publishing, contract]
summary: Publish prefers the listings-row snapshot over the item, so any surface writing the item's title, description or price must reach the draft row too.
---

> [!note] Re-reviewed 2026-09-23, no change in behaviour. `flipdesk-ebay.ts`
> was split into one route file per concern as a pure move (marketplaces
> module plan, action 5); it now only mounts them. The code this note
> describes is in `flipdesk-ebay-publish.ts`, `flipdesk-ebay-sync.ts`, so `code_refs` point there.
> `flipdesk-ebay.ts:NNNN` line numbers quoted below are from before the split.


> [!note] Re-reviewed 2026-09-20. Two drifts, both from the US-2855 eBay policy
> work, and neither touches what this note asserts.
> `flipdesk-ebay.ts` gained one response field, `replaced_defaults`.
> `composer.tsx` gained a seed so a NEW draft opens on the seller's eBay
> account policy defaults, plus a wait for that query.
>
> Checked against this note's subject: which record is authoritative, and the
> single-editor rule that makes the snapshot safe. Neither moved. **This note
> is SILENT on how a new draft's three policy controls are seeded** -- it
> describes policy EDITS ("policy changes use the existing bulk-edit route only
> for active listings") and says nothing about their initial value. Saying so
> here so a future reader knows the silence is deliberate rather than reading
> the note as covering it.

The grid was expanded on 2026-09-14. The current writer list is below;
the dated reviews record the older nine-column grid.

> **Re-reviewed 2026-09-15.** `grid-columns.ts` and `use-grid-listings.ts`
> changed in `4dd48a240`. Neither moves the precedence. `aspectColumn` now
> labels a specific `Specific: <name>` instead of the bare name, which only
> changes a header and the text of the changed-elsewhere error. The real change
> is `sameGridValue`, which the stale-row check in `useSaveGridListing` now uses
> in place of `!==`: it trims, re-joins a semicolon list, and compares numerics
> by value, so a retry after eBay refused a write no longer reads its own
> re-formatted value as somebody else's edit. Both operands still come from the
> LISTINGS row via `col.get`, and every write below `cellLock` still lands on
> that row, so the rule this note states is unchanged.

> **Re-reviewed 2026-09-13.** flipdesk-ebay.ts changed for US-3111 (`5a3156dc0`).
> The whole diff is a chunker: `chunkIdsForInFilter` / `IN_FILTER_CHAR_BUDGET`
> replace a fixed 400-row slice, and the two catalog stamps
> (`ebay_offer_checked_at`, `ebay_specifics_checked_at`) now fan out by character
> budget instead of row count. Both write a timestamp column on
> `inventory_items` and nothing else, so they touch none of the three fields this
> note is about. Re-verified the rule at HEAD rather than taking the diff's word:
> `listing.listing_title ?? item.title` at `flipdesk-ebay.ts:14252` and `:14396`,
> `resolvePublishPrice` at `:13281`, `COLS` in `src/pages/flipdesk/grid.tsx:59`
> still exactly nine keys (sku, title, brand, style, size, cost, target,
> sourced_by, notes) and `TITLE_SYNC_COLS` still the three
> brand/style/size at `grid.tsx:454`. Still accurate.

> **Re-reviewed 2026-09-11.** flipdesk-ebay.ts changed for US-3265, which added an opt-in read-back and a
> post-create confirmation to the BUSINESS POLICIES handler. Nothing on the draft
> snapshot path moved. Re-read against the diff: still accurate.

# The draft snapshot shadows the item

> **Re-reviewed 2026-09-22.** Drift flagged `composer.tsx` on 3b252aa1
> (US-3450): the Push to card became the List on panel, one tick per channel
> including the extension ones, and the publish toast reads the fan-out's
> per-channel result. It changes where a channel is chosen, not what a save
> writes or which snapshot wins. The precedence below is unchanged.

> **Re-reviewed 2026-09-06, no change to the rule.** Drift flagged `grid.tsx`
> for US-3123's sourcer sort. Checked against this note's actual claim - that any
> surface WRITING the item's title, description or price must reach the draft row
> too - and the diff writes none of those three.
>
> ⚠ CORRECTED 2026-09-10: that review said the diff "only extends a SELECT
> column list", and that is wrong. `dc1f1f65e` added a full editable `sourced_by`
> column to `COLS`, so the grid gained a ninth writable field on the same day.
> The conclusion held for the right reason anyway - `sourced_by` is neither
> title, description nor price, and it is not a title-syncable field - but "a
> read is not a write" was the wrong evidence for it, and a reader trusting that
> sentence would have the grid's writer list short by one.
# The draft snapshot shadows the item

> **Re-reviewed 2026-09-05, no change.** Drift flagged `flipdesk-ebay.ts`
> for US-3068, which moved `planEvidence` out to `lib/evidence-plan.ts`
> unchanged so a second surface could call the one planner. It reads the
> grade report and the publication snapshot; it writes no draft and touches
> no title, description or price, so nothing this note says about who must
> reach the listings row moved.

> **Re-reviewed 2026-09-02, and a new writer joined the list.** US-9205 makes
> the graded price the DRAFT price rather than a suggestion: the composer and
> the review screen write `target_price` on the item AND the price plus
> `price_set_by`, `graded_price_cents` and `graded_price_why` on the newest eBay
> draft row. That is this note's rule being followed, not broken -- a surface
> that wrote only the item would have shipped the old price, which is exactly
> the failure documented below.
>
> The new part worth carrying: `price_set_by` records WHO set the price
> ('graded', 'comp_median', 'seller', 'rule'), so a repricing rule can tell a
> seller's deliberate override from a stale default without comparing numbers,
> and `graded_price_cents` survives the override so the offer stays legible
> after it is refused. Precedence itself is unchanged: publish still prefers the
> snapshot.


> **Re-reviewed 2026-08-28.** Drift flagged `flipdesk-ebay.ts` and
> `composer.tsx`. Two changes, neither of which moves the precedence.
>
> US-2974 adds an optional `item_id` to the comps search and stamps the comp
> stage for rewards after a successful lookup. It writes no title, description
> or price, so the rule below does not reach it.
>
> US-2967 is closer and still does not change this note: the template's
> boilerplate became a description BLOCK handed to `generateListing`, so it
> lands in the same upsert as everything else rendered from those blocks,
> instead of being appended by a follow-up UPDATE that the composer's first save
> then overwrote. That is an INSTANCE of the rule here rather than an exception
> to it - a second write left the row holding a `listing_description` its
> `description_blocks` did not produce, which is exactly the shadowing this note
> exists to describe. `listing.listing_description ?? item.description` is
> unchanged.

> **Re-reviewed 2026-08-17.** Drift flagged `composer.tsx` and `flipdesk-ebay.ts`
> for `0ea04f6f` (a duplicate item that could be neither deleted nor ended) and
> `b25e7650` (relist reported success while eBay was never touched). Both are
> about the DELETE and RELIST verbs; neither writes a title, description or
> price on either side. The precedence rule — publish prefers the listings-row
> snapshot over the item — is untouched.
>
> **Re-reviewed 2026-08-18.** Drift flagged the same two files for US-2684
> (a cancelled eBay order left the listing live at quantity zero). That change
> adds a QUANTITY to the revise patch and an out-of-stock banner; it touches
> neither buildListingFields nor the publish-time resolution order. The
> precedence rule still holds.
>
> **Re-reviewed 2026-08-21.** Drift flagged `flipdesk-ebay.ts` for the US-2704 /
> US-2706 / US-2707 evidence work (`b7c59c1da`, `ffc009926`, `6f749fdaa`,
> `ba017426a`, `2d1f046ae`). The rule holds, and the direction of the dependency
> is worth writing down: this work **reads** the resolved publish payload, it
> never writes one.
>
> US-2704 is the only one that touches the publish path at all. It adds a
> `recordPublication` call after persist in `publishItemForOwner`, writing
> `ctx.summary.description / aspects / priceValue` into the NEW
> `listing_publications` table. That is a record of what was published — it
> mutates neither the item nor the listings draft row, and it does not reorder
> `assemblePublishContext`. The evidence builder then reads back through
> `latestPublication()` rather than the table directly.
>
> Which makes `listing_publications` a downstream CONSUMER of the precedence
> rule: what it stores is whatever the resolution above chose. So a bug in the
> precedence order no longer just publishes the wrong text — it now also files
> the wrong text as evidence in a dispute, asserted under our signature. Same
> rule, higher cost of getting it wrong.

## The precedence

At publish, `assemblePublishContext` resolves each field **listing first**:

```
listing.listing_title       ?? item.title
listing.listing_description ?? item.description
resolvePublishPrice(listing.listing_price, …, item.target_price)
```

So once a listings row holds a value, **the item's copy stops mattering**. That
is correct — an eBay-optimised title should not be undone by an inventory
edit — but it makes a whole class of bug possible: edit the item, publish, and
get the old text with no error anywhere.

One narrowing, US-2593 (2026-08-14): a composer save now writes the effective
listing title back onto `inventory_items.title`, so the two stop diverging on
the surface that owns both. The precedence above is unchanged — publish still
reads the listing first — but the item's copy is no longer left at whatever it
was named on the day it was created. Which fields flow which way is
[[sync-source-of-truth]]'s to state, not this note's.

## The composer and the bulk grid

`FlipdeskComposerPage` (`src/pages/flipdesk/composer.tsx`) is the only **full**
item/listing editor, at every status. `/dashboard/flipdesk/items/:id`,
`/items/:id/draft` and the item detail dialog all embed it, and every
listings-table row navigates to it.

It writes `listing_title`, `listing_description` and `listing_price` **straight
to the listings row** through `buildListingFields` (`src/lib/composer-save.ts`),
which both save paths share precisely so a column cannot be wired into one and
forgotten in the other.

The Inventory grid now has 22 base columns in `grid-columns.ts`, plus eight
common item specifics and any additional specifics stored on the page's listings.
Thirteen columns write inventory fields: SKU, inventory title, brand, style, size,
color, material, cost, target price, floor price, storage bin, sourced by and
private notes. The separate **Listing title** and **Listing price** columns write
the listing snapshot directly. The review dialog labels inventory title and
target price as inventory-only; sellers must use the listing columns to change
what gets published. The older inventory-title/target-price mirroring gap is
not silently treated as fixed.

`use-grid-listings.ts` resolves each page row's exact `listing_id`, rechecks the
listing before saving, and rejects conflicting edits and imported eBay-origin
listings. Draft edits write the listing snapshot without invoking a publishing
endpoint. Active listing edits use the existing eBay revision route; policy
changes use the existing bulk-edit route only for active listings. A local save
followed by an eBay refusal remains a failed row with its edits retained for retry.
Item specifics merge into the existing override map and record manual sources.

Inventory brand/style/size/color edits still use `syncListingTitle`, now against
the row's exact listing id. An explicit listing-title edit takes precedence over
the automatic substitution. An inventory save and a failed automatic title sync
remain separate outcomes, with a warning for the latter.

**And since US-1995 a composer save is no longer a pure copy of the form.**
`titleSyncPatchFor()` builds a `TitleSyncPatch` from the specifics write-back and
it is spread **after** `buildListingFields`' payload, so `listing_title` can leave
a save different from what the seller typed, and `title_variants` / `needs_review`
reach the row without passing through the shared builder. `adoptSyncedTitle()`
pushes the substituted value back into React state so the next save does not
revert it. The shared-builder guarantee therefore no longer covers every listings
column the composer writes; it held here only because both call sites were
patched by hand.

**US-2442 added a third AI producer and it does NOT widen that hole** (2026-08-12).
`/api/flipdesk/ai/listing-copy` now has a composer button, joining `/extract` and
`/rewrite`, and all three land in one `AiFillPanel`. `applyAiCopy` only calls
`setTitle` / `setDescription` — React state — and its toast says "Save the draft
to keep it", so persistence still goes through `buildListingFields` like any
typed edit. **The set of listings columns bypassing the shared builder is
unchanged: still just the `titleSyncPatchFor()` ones.** Stated because this note
exists to track who writes the row, and a new AI write path is exactly what a
reader should check — the answer here is that it writes the form, not the row.
The copy panel now passes `applicableFields={["title", "description"]}`
(2026-09-25), so it only offers and logs those two fields, which is exactly what
`applyAiCopy` writes. Still form state, still no new listings-row writer.

> [!note] This obsoleted a fix rather than losing it (2026-08-01)
> A "smart merge" once lived in `item-canvas.tsx`, propagating canvas edits into
> a draft row only when the seller had not customised that field in the composer.
> It existed because **two** editors wrote different tables. Deleting ItemCanvas
> removed the second writer, so the merge is obsolete by architecture — not an
> orphan.
>
> Worth stating explicitly, because the same deletion *did* orphan two other
> mechanisms (US-2381). Same commit, two different outcomes, and telling them
> apart takes reading the code rather than the commit message. See
> [[shipped-but-unwired]].

## The rule this leaves behind

**A new surface that writes `inventory_items.title`, `description` or
`target_price` must also update the draft's listings row.** Publish will
otherwise serve the snapshot and the seller's change silently will not ship.

That is not hypothetical: bulk edit needed its own title sync for exactly this
reason, having been shipped for the canvas and never for there. The composer is
safe because it writes the listing row directly; nothing else gets that for free,
and the grid keeps separate inventory and listing columns. Its inventory-title
and target-price edits still do not author the listing snapshot; the dedicated
listing columns do.

There is now a **second** way to diverge, added by the backwards title sync:
editing `brand`, `size`, `color` or `style` on the item makes
`listings.listing_title` stale even though nobody wrote `inventory_items.title`.
The rule above only names title/description/price, so it does not catch that
case; a surface writing any syncable field needs the title patch too.

> [!warning] The sync marks its own work as a hand edit
> `ai_generated_snapshot` is written only at generation and is never re-stamped.
> So the FIRST sync leaves `listing_title != ai_generated_snapshot.title`
> permanently, and every later sync on that listing reads `handEdited === true`
> and sets `needs_review`. A machine substitution is thereafter indistinguishable
> from a seller's own edit. Harmless for publish, which never reads
> `needs_review`, but it makes the review queue noisier than the code comment
> implies.

The reverse direction — a specifics edit reaching the item's columns — is a
different contract; see [[sync-source-of-truth]].

## Related

- [[sync-source-of-truth]] — field ownership and the provenance rules
- [[listings-column-inventory]] — what the rest of the listings row is for
- [[listing-photos]] — the photo half of the same publish path
- [[INDEX]]

## 2026-09-04: one more surface that writes the item

Two code_refs moved. `services/edge-functions/src/routes/flipdesk-ebay.ts`
changed on 2026-09-03 for the eBay sync-efficiency work (US-3110/US-3111):
sync-scope resolution, a GetItem specifics recheck stamp and the per-SKU
offer stagger. Read: none of it touches which copy publish prefers.

`src/pages/flipdesk/composer.tsx` changed in 1d565ca6f and does concern
this note. `commitDerivedField` is a new write path: a seller clicks a
line in the rendered description preview, and it writes the underlying
`inventory_items` column or measurement directly, then writes the paired
eBay specific through `syncedAspectNameFor`, then re-renders the preview.

The precedence rule is unchanged and now covers one more surface. The
column half lands on the ITEM immediately; the draft row's stored
description is still reconciled by the composer's save, exactly as it is
for every other item write. So between a derived-field edit and a save,
the item and the snapshot disagree -- which is this note's whole subject,
not a new exception to it. The aspect half is routed through the normal
dirty/save machinery (`sellerEditedAspects`, `handleAspectsChange`), so it
reaches the draft the way a specifics edit always has.

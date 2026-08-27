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
  - src/lib/title-sync-patch.ts
  - services/edge-functions/src/routes/flipdesk-ebay.ts
reviewed: 2026-08-27
tags: [flipdesk, listings, publishing, contract]
summary: Publish prefers the listings-row snapshot over the item, so any surface writing the item's title, description or price must reach the draft row too.
---

# The draft snapshot shadows the item

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

## Why this is mostly safe: one full editor, and one grid that half-syncs

`FlipdeskComposerPage` (`src/pages/flipdesk/composer.tsx`) is the only **full**
item/listing editor, at every status. `/dashboard/flipdesk/items/:id`,
`/items/:id/draft` and the item detail dialog all embed it, and every
listings-table row navigates to it.

It writes `listing_title`, `listing_description` and `listing_price` **straight
to the listings row** through `buildListingFields` (`src/lib/composer-save.ts`),
which both save paths share precisely so a column cannot be wired into one and
forgotten in the other.

**It is not the only writer.** `src/pages/flipdesk/grid.tsx` edits `title`,
`target_price`, `brand`, `style`, `size` and `condition_notes` inline, against
`inventory_items` only. Since US-1995 it syncs **brand/style/size** into
`listings.listing_title` (`TITLE_SYNC_COLS`, `grid.tsx:378`) — but a grid edit to
**Title** or **Target price** still never reaches the listings row, and will not
publish. That is the open case of the rule below, stated here rather than left to
be rediscovered.

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
and the grid is the standing proof — it got the sync for three columns and still
lacks it for two.

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

---
title: The draft snapshot shadows the item — and one editor is why that is safe
aliases: [publish reads the listing first, stale draft, one item editor]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/composer-save.ts
  - src/pages/flipdesk/composer.tsx
  - services/edge-functions/src/routes/flipdesk-ebay.ts
reviewed: 2026-08-02
tags: [flipdesk, listings, publishing, contract]
summary: Publish prefers the listings-row snapshot over the item, so any surface writing the item's title, description or price must reach the draft row too.
---

# The draft snapshot shadows the item

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

## Why this is currently safe: there is exactly one editor

`FlipdeskComposerPage` (`src/pages/flipdesk/composer.tsx`) is the only
item/listing editor, at **every** status. `/dashboard/flipdesk/items/:id`,
`/items/:id/draft` and the item detail dialog all embed it, and every
listings-table row navigates to it.

It writes `listing_title`, `listing_description` and `listing_price` **straight
to the listings row** through `buildListingFields` (`src/lib/composer-save.ts`),
which both save paths share precisely so a column cannot be wired into one and
forgotten in the other. The seller's edit and the snapshot publish reads are the
same write.

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
safe because it writes the listing row directly; nothing else gets that for free.

The reverse direction — a specifics edit reaching the item's columns — is a
different contract; see [[sync-source-of-truth]].

## Related

- [[sync-source-of-truth]] — field ownership and the provenance rules
- [[listings-column-inventory]] — what the rest of the listings row is for
- [[listing-photos]] — the photo half of the same publish path
- [[INDEX]]

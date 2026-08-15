---
slug: google-sheets-sync
title: Google Sheets sync
category: marketplaces
visibility: members
audience: seller
sort_order: 70
pillar_path: /flipdesk/inventory-management
summary: What syncs to a spreadsheet, which direction each field flows, and why one side has to own each column.
faq:
  - q: Can I edit the sheet and have it come back?
    a: Only for the fields marked as sheet-owned. Everything else is exported for reading, and an edit to a read-only column is overwritten on the next sync rather than applied.
  - q: What happens if I delete a row?
    a: Nothing happens to the item. The sheet is a view, and deleting a row in a view does not delete the thing it was showing.
---

The sheet sync puts your inventory in a spreadsheet. It is useful for bulk
editing, for sharing numbers with somebody who does not have an account, and for
the sort of ad-hoc analysis a spreadsheet is genuinely better at.

It is also the feature where being clear about direction matters most.

## One side owns each column

Every synced field has an owner, and the owner is the side allowed to change it.

**FlipDesk owns** anything the system derives or receives: the grade, the
certificate, listing URLs, statuses, sale prices, payout figures. These export to
the sheet for reading. Editing them in the sheet does nothing except get
overwritten on the next sync.

**The sheet can own** a small set of fields you would sensibly bulk-edit: price,
title, notes. Changing those in the sheet brings them back.

That split is the whole design. Two systems that both believe they own a field
will eventually disagree, and the losing side's edit vanishes with no error, no
log, and no way for a person to tell which change survived. Naming the owner per
field is what prevents that.

## Setting it up

Connect Google from the integrations area and pick or create a sheet. FlipDesk
writes a header row and populates it.

Give the sheet to whoever needs it with normal Google sharing. FlipDesk's access
is to that one sheet.

<!-- SCREENSHOT: the sheet connection with the column ownership legend (as of 2026-08-15) -->

## What syncs

The item's identity: SKU, brand, category, size, colour, cost, source.

Its state: status, and the grade with its tier once it has one.

Its listings: URL and price per channel.

Its outcome: sale price, fees, net, and the dates.

Not the photos, and not the description body. Both are the wrong shape for a
spreadsheet cell, and putting a wall of HTML into a column makes the sheet
unusable for the things it is good at.

## Bulk editing safely

The sheet is a good way to reprice fifty things at once, and there are two
habits worth having.

**Edit the owned columns only.** The header marks which. Typing into a read-only
column is not blocked, because Google Sheets has no mechanism to block it, and
it is discarded.

**Do not reorder or rename the header row.** The sync matches by column name.
Renaming a header means that column stops being recognised, which reads as
"my edits stopped coming back" rather than as an obvious error.

## Deleting rows

Deleting a row does not delete the item. The sheet is a view over your
inventory, and removing something from a view does not remove the thing.

The row reappears on the next sync, which is occasionally annoying and is much
better than the alternative, where a stray delete in a spreadsheet destroys
inventory.

## When it is the wrong tool

If you find yourself doing structured work in the sheet that FlipDesk has a
screen for, use the screen. Bulk pricing, bulk status changes and the prep view
all exist and all keep the ownership question from arising at all.

The sheet earns its place for the things a spreadsheet is uniquely good at:
pivot tables, ad-hoc sums, and handing a file to an accountant.

## Give it to your accountant, not your workflow

The sheet is at its best as an output: a file somebody outside the app can read,
sort and total.

It is at its worst as a place to run your day, because every hour spent editing
there is an hour spent on the wrong side of the ownership split. FlipDesk has
screens for bulk pricing and bulk status changes, and those do not raise the
question of which side wins.

Export for reading, edit in the app.

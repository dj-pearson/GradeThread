---
title: CSV import presets for Vendoo and List Perfectly exports
aliases: [import presets, switch-from mapping, vendoo csv, list perfectly csv]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/import-presets.ts
  - src/lib/__tests__/import-presets.test.ts
  - src/pages/flipdesk/import.tsx
reviewed: 2026-09-01
tags: [flipdesk, import, crosslisting, contract]
summary: The header-to-field mapping FlipDesk applies to a Vendoo or List Perfectly CSV export, which real export each was verified against (none yet), and the rule that a format change is one line here and one in import-presets.ts in the same commit.
---

# CSV import presets for Vendoo and List Perfectly exports

`src/lib/import-presets.ts` maps a competitor export's column headers onto
FlipDesk import fields so a switching seller drops the file in and confirms
(US-9209). The tables below are the same mapping; `import-presets.test.ts`
parses them and fails when the code and this note disagree in either
direction. A format change on their side is one line in each, same commit.

Headers are matched after normalising to lowercase letters and digits, so
`Sold Price`, `sold_price` and `SoldPrice` are one key. A header a preset does
not name falls back to the generic guess in `import-mapping.ts`. Detection
needs two of a preset's signature headers (the ones only that tool uses), so a
plain spreadsheet with a Title column never reads as a Vendoo file.

## vendoo

**Verification: not yet verified against a real export.** The headers below are
the column names Vendoo's inventory export is documented to carry as of
2026-09-01; nobody on the team has opened a real file yet. When one is checked,
set `verified` in the code and replace this line with the date and the
export's row count. Signature headers: `Date Added`, `Marketplaces`,
`Sold On`, `Cost of Goods`.

| export header | FlipDesk field |
|---|---|
| `Title` | `title` |
| `Description` | `description` |
| `Brand` | `brand` |
| `Size` | `size` |
| `Category` | `item_category` |
| `SKU` | `sku` |
| `Price` | `list_price` |
| `Cost` | `purchase_price` |
| `Cost of Goods` | `purchase_price` |
| `Condition` | `condition_notes` |
| `Notes` | `condition_notes` |
| `Date Added` | `purchase_date` |
| `Date Created` | `purchase_date` |
| `Date Listed` | `list_date` |
| `Date Sold` | `sale_date` |
| `Sold Price` | `sale_price` |
| `Sales Price` | `sale_price` |
| `Sold On` | `skip` |
| `Marketplaces` | `skip` |
| `Status` | `status` |
| `Listing URL` | `link` |
| `Photos` | `skip` |
| `Image URLs` | `skip` |
| `Quantity` | `skip` |
| `Color` | `skip` |
| `Tags` | `skip` |
| `Item Number` | `sku` |

## list-perfectly

**Verification: not yet verified against a real export.** Same status as
above: documented column names as of 2026-09-01, no real file opened yet.
Signature headers: `COGS`, `Sold Platform`, `Keywords`, `Created Date`,
`Image URLs`.

| export header | FlipDesk field |
|---|---|
| `Title` | `title` |
| `Item Title` | `title` |
| `Description` | `description` |
| `Brand` | `brand` |
| `Size` | `size` |
| `Category` | `item_category` |
| `SKU` | `sku` |
| `Price` | `list_price` |
| `COGS` | `purchase_price` |
| `Cost` | `purchase_price` |
| `Cost of Goods` | `purchase_price` |
| `Condition` | `condition_notes` |
| `Notes` | `condition_notes` |
| `Date Created` | `purchase_date` |
| `Created Date` | `purchase_date` |
| `Date Listed` | `list_date` |
| `Date Sold` | `sale_date` |
| `Sold Price` | `sale_price` |
| `Sold On` | `skip` |
| `Sold Platform` | `skip` |
| `Status` | `status` |
| `Listing URL` | `link` |
| `Photos` | `skip` |
| `Image URLs` | `skip` |
| `Images` | `skip` |
| `Quantity` | `skip` |
| `Color` | `skip` |
| `Keywords` | `skip` |
| `Tags` | `skip` |

## What a preset does not do

Photos, colour, tags and quantity are skipped: the importer writes item rows,
not photos, and the public switch-from pages say so. Live listings on the
extension channels do not transfer through a CSV at all; the closet import
(US-9201) claims those from the seller's own browser.

## Related

- [[closing-a-coverage-gap]] for the extension side of a switch.

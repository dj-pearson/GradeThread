---
title: CSV import presets for competitor and marketplace exports
aliases: [import presets, switch-from mapping, vendoo csv, list perfectly csv, shopify products csv, ebay listings report, etsy listings csv]
type: contract
status: current
source_of_truth: code
code_refs:
  - src/lib/import-presets.ts
  - src/lib/__tests__/import-presets.test.ts
  - src/pages/flipdesk/import.tsx
reviewed: 2026-09-08
tags: [flipdesk, import, crosslisting, contract]
summary: The header-to-field mapping FlipDesk applies to a Vendoo, List Perfectly, Shopify, eBay or Etsy CSV export, which real export each was verified against (none yet), why three other tools have no preset, and the rule that a format change is one line here and one in import-presets.ts in the same commit.
---

# CSV import presets for competitor and marketplace exports

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

## shopify

**Verification: not yet verified against a real export.** Unlike the two
presets above, this one is read off a published format rather than inferred:
Shopify documents the products CSV column set and it has been stable for years.
Nobody here has run a real shop export through it, so `verified` stays null
until someone does. Signature headers: `Body (HTML)`, `Variant SKU`,
`Variant Price`, `Cost per item`, `Image Src`.

`Option1 Value` is `skip` on purpose. It is Size on most apparel shops and
Colour on the rest, and the file never says which; writing Colour into the size
column is worse than leaving it for step 2.

| export header | FlipDesk field |
|---|---|
| `Handle` | `skip` |
| `Title` | `title` |
| `Body (HTML)` | `description` |
| `Vendor` | `brand` |
| `Product Category` | `item_category` |
| `Type` | `skip` |
| `Tags` | `skip` |
| `Published` | `skip` |
| `Option1 Name` | `skip` |
| `Option1 Value` | `skip` |
| `Option2 Name` | `skip` |
| `Option2 Value` | `skip` |
| `Option3 Name` | `skip` |
| `Option3 Value` | `skip` |
| `Variant SKU` | `sku` |
| `Variant Grams` | `skip` |
| `Variant Inventory Tracker` | `skip` |
| `Variant Inventory Qty` | `skip` |
| `Variant Inventory Policy` | `skip` |
| `Variant Fulfillment Service` | `skip` |
| `Variant Price` | `list_price` |
| `Variant Compare At Price` | `skip` |
| `Variant Requires Shipping` | `skip` |
| `Variant Taxable` | `skip` |
| `Variant Barcode` | `skip` |
| `Variant Image` | `skip` |
| `Variant Weight Unit` | `skip` |
| `Variant Tax Code` | `skip` |
| `Image Src` | `skip` |
| `Image Position` | `skip` |
| `Image Alt Text` | `skip` |
| `Gift Card` | `skip` |
| `SEO Title` | `skip` |
| `SEO Description` | `skip` |
| `Cost per item` | `purchase_price` |
| `Status` | `status` |

## ebay-file-exchange

**Verification: not yet verified against a real export.** One preset covers two
eBay files, because a seller has two ways to get their listings out and neither
is more official than the other: the Seller Hub active-listings report
(`Available quantity`, `eBay category 1 name`, `Watchers`) and a File Exchange
template (`PicURL`, `ConditionID`, `StoreCategory`, `CustomLabel`). The headers
normalise to different keys, so both spellings live in one mapping rather than
two presets that would tie with each other and detect as nothing. Signature
headers: `Available quantity`, `eBay category 1 name`, `Watchers`,
`Buy It Now price`, `PicURL`, `ConditionID`, `StoreCategory`.

This preset is for a seller who has not connected eBay. A connected seller
should use the eBay sync, which carries the live listing and its photos rather
than a snapshot of some columns.

| export header | FlipDesk field |
|---|---|
| `Item number` | `skip` |
| `ItemID` | `skip` |
| `Title` | `title` |
| `Subtitle` | `skip` |
| `Description` | `description` |
| `CustomLabel` | `sku` |
| `Custom label (SKU)` | `sku` |
| `SKU` | `sku` |
| `Available quantity` | `skip` |
| `Quantity` | `skip` |
| `Sold quantity` | `skip` |
| `Format` | `skip` |
| `Currency` | `skip` |
| `StartPrice` | `list_price` |
| `Current price` | `list_price` |
| `Buy It Now price` | `skip` |
| `Reserve price` | `skip` |
| `Watchers` | `skip` |
| `Bids` | `skip` |
| `Start date` | `list_date` |
| `End date` | `skip` |
| `Category` | `item_category` |
| `eBay category 1 name` | `item_category` |
| `eBay category 1 number` | `skip` |
| `eBay category 2 name` | `skip` |
| `eBay category 2 number` | `skip` |
| `StoreCategory` | `skip` |
| `Condition` | `condition_notes` |
| `ConditionID` | `skip` |
| `Brand` | `brand` |
| `C:Brand` | `brand` |
| `Size` | `size` |
| `C:Size` | `size` |
| `PicURL` | `skip` |
| `PhotoURL` | `skip` |
| `ViewItemURL` | `link` |
| `Listing site URL` | `link` |
| `Item URL` | `link` |
| `Location` | `skip` |
| `Duration` | `skip` |
| `PayPalAccepted` | `skip` |
| `ShippingServiceCost` | `shipping_cost` |

## etsy

**Verification: not yet verified against a real export.** This is the
`Currently for sale listings` CSV any shop can download from Shop Manager, and
it needs no app approval, no keystring and no partner status — which is the
whole reason it exists as a preset while the Etsy API import (US-3156) waits on
approval. Signature headers: `CURRENCY_CODE`, `MATERIALS`, `VARIATION 1 TYPE`,
`VARIATION 1 NAME`, `VARIATION 1 VALUES`.

`IMAGE2` through `IMAGE10` are not in the table; they fall to the generic guess,
which skips them, exactly as `IMAGE1` does. `VARIATION 1 VALUES` is `skip` for
the same reason Shopify's `Option1 Value` is.

| export header | FlipDesk field |
|---|---|
| `TITLE` | `title` |
| `DESCRIPTION` | `description` |
| `PRICE` | `list_price` |
| `CURRENCY_CODE` | `skip` |
| `QUANTITY` | `skip` |
| `TAGS` | `skip` |
| `MATERIALS` | `skip` |
| `IMAGE1` | `skip` |
| `SKU` | `sku` |
| `VARIATION 1 TYPE` | `skip` |
| `VARIATION 1 NAME` | `skip` |
| `VARIATION 1 VALUES` | `skip` |
| `VARIATION 2 TYPE` | `skip` |
| `VARIATION 2 NAME` | `skip` |
| `VARIATION 2 VALUES` | `skip` |

## Three tools that have no preset, and why

Flyp, Crosslist and SellerAider were asked for in US-3153 and are deliberately
absent. None of the three publishes its export column list, and a preset built
from guessed headers is not merely useless here — it is actively harmful.
Detection picks the preset with the most signature hits and returns null on a
tie, so a guessed signature that happens to overlap Vendoo's turns a detection
that works today into no detection at all. Absent is the safe state.

The fix is a real file, not more thinking. One export from any of the three,
dropped in front of whoever picks this up, turns each into about twenty minutes
of work.

## What a preset does not do

Photos, colour, tags and quantity are skipped: the importer writes item rows,
not photos, and the public switch-from pages say so. Live listings on the
extension channels do not transfer through a CSV at all; the closet import
(US-9201) claims those from the seller's own browser.

## Related

- [[closing-a-coverage-gap]] for the extension side of a switch.

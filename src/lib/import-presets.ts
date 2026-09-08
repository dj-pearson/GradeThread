// US-9209: column-mapping presets for the CSV exports of the tools resellers
// switch from. The importer takes mapped rows; a preset is the mapping, so a
// seller leaving Vendoo or List Perfectly drops the file in and confirms.
//
// EVERY HEADER LIST IS A CONTRACT with vault/30-platform/import-presets.md:
// the note carries the same headers and says which real export each was
// verified against. A format change is a one-line edit in both, in the same
// commit. `verified` is null until a real export has been checked; a preset
// still applies, it just says so on the page.

import { guessField, type ImportField } from "@/lib/import-mapping";

export interface ImportPreset {
  id:
    | "vendoo"
    | "list-perfectly"
    | "shopify"
    | "ebay-file-exchange"
    | "etsy";
  name: string;
  /**
   * Export-file header -> FlipDesk field, keyed by the normalized header
   * (lowercase, letters and digits only) so casing and spacing never matter.
   */
  headers: Record<string, ImportField>;
  /**
   * Headers that only this tool's export uses. Detection needs two of them so
   * a plain spreadsheet with a Title column never reads as a Vendoo file.
   */
  signature: string[];
  /** The export the mapping was checked against, or null when nobody has yet. */
  verified: { date: string; note: string } | null;
}

export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const IMPORT_PRESETS: readonly ImportPreset[] = [
  {
    id: "vendoo",
    name: "Vendoo export",
    headers: {
      title: "title",
      description: "description",
      brand: "brand",
      size: "size",
      category: "item_category",
      sku: "sku",
      price: "list_price",
      cost: "purchase_price",
      costofgoods: "purchase_price",
      condition: "condition_notes",
      notes: "condition_notes",
      dateadded: "purchase_date",
      datecreated: "purchase_date",
      datelisted: "list_date",
      datesold: "sale_date",
      soldprice: "sale_price",
      salesprice: "sale_price",
      soldon: "skip",
      marketplaces: "skip",
      status: "status",
      listingurl: "link",
      photos: "skip",
      imageurls: "skip",
      quantity: "skip",
      color: "skip",
      tags: "skip",
      itemnumber: "sku",
    },
    signature: ["dateadded", "marketplaces", "soldon", "costofgoods"],
    verified: null,
  },
  {
    id: "list-perfectly",
    name: "List Perfectly export",
    headers: {
      title: "title",
      itemtitle: "title",
      description: "description",
      brand: "brand",
      size: "size",
      category: "item_category",
      sku: "sku",
      price: "list_price",
      cogs: "purchase_price",
      cost: "purchase_price",
      costofgoods: "purchase_price",
      condition: "condition_notes",
      notes: "condition_notes",
      datecreated: "purchase_date",
      createddate: "purchase_date",
      datelisted: "list_date",
      datesold: "sale_date",
      soldprice: "sale_price",
      soldon: "skip",
      soldplatform: "skip",
      status: "status",
      listingurl: "link",
      photos: "skip",
      imageurls: "skip",
      images: "skip",
      quantity: "skip",
      color: "skip",
      keywords: "skip",
      tags: "skip",
    },
    signature: ["cogs", "soldplatform", "keywords", "createddate", "imageurls"],
    verified: null,
  },
  // US-3153: the three MARKETPLACE exports below are a different kind of preset
  // from the two above. Vendoo and List Perfectly are competitor tools whose
  // column names are documented by the tool and nothing else; Shopify, eBay and
  // Etsy publish their export formats, so these mappings are read off a spec
  // rather than inferred, and their signature headers are names no other file
  // carries. That is why these three shipped and Flyp, Crosslist and SellerAider
  // did not: a guessed signature either never fires or ties with Vendoo's and
  // turns a detection that works today into null. See the story note on US-3153.
  //
  // The two variant columns are deliberately `skip` in both Shopify and Etsy.
  // Shopify's `Option1 Value` and Etsy's `VARIATION 1 VALUES` are Size on most
  // apparel shops and Colour on the rest, and the file does not say which; a
  // wrong guess writes Colour into the size column, where nobody looks twice.
  // Step 2 of the importer is one click away for a seller who knows.
  {
    id: "shopify",
    name: "Shopify products export",
    headers: {
      handle: "skip",
      title: "title",
      bodyhtml: "description",
      vendor: "brand",
      productcategory: "item_category",
      type: "skip",
      tags: "skip",
      published: "skip",
      option1name: "skip",
      option1value: "skip",
      option2name: "skip",
      option2value: "skip",
      option3name: "skip",
      option3value: "skip",
      variantsku: "sku",
      variantgrams: "skip",
      variantinventorytracker: "skip",
      variantinventoryqty: "skip",
      variantinventorypolicy: "skip",
      variantfulfillmentservice: "skip",
      variantprice: "list_price",
      variantcompareatprice: "skip",
      variantrequiresshipping: "skip",
      varianttaxable: "skip",
      variantbarcode: "skip",
      variantimage: "skip",
      variantweightunit: "skip",
      varianttaxcode: "skip",
      imagesrc: "skip",
      imageposition: "skip",
      imagealttext: "skip",
      giftcard: "skip",
      seotitle: "skip",
      seodescription: "skip",
      costperitem: "purchase_price",
      status: "status",
    },
    signature: ["bodyhtml", "variantsku", "variantprice", "costperitem", "imagesrc"],
    verified: null,
  },
  {
    id: "ebay-file-exchange",
    name: "eBay listings report or File Exchange",
    headers: {
      itemnumber: "skip",
      itemid: "skip",
      title: "title",
      subtitle: "skip",
      description: "description",
      customlabel: "sku",
      customlabelsku: "sku",
      sku: "sku",
      availablequantity: "skip",
      quantity: "skip",
      soldquantity: "skip",
      format: "skip",
      currency: "skip",
      startprice: "list_price",
      currentprice: "list_price",
      buyitnowprice: "skip",
      reserveprice: "skip",
      watchers: "skip",
      bids: "skip",
      startdate: "list_date",
      enddate: "skip",
      category: "item_category",
      ebaycategory1name: "item_category",
      ebaycategory1number: "skip",
      ebaycategory2name: "skip",
      ebaycategory2number: "skip",
      storecategory: "skip",
      condition: "condition_notes",
      conditionid: "skip",
      brand: "brand",
      cbrand: "brand",
      size: "size",
      csize: "size",
      picurl: "skip",
      photourl: "skip",
      viewitemurl: "link",
      listingsiteurl: "link",
      itemurl: "link",
      location: "skip",
      duration: "skip",
      paypalaccepted: "skip",
      shippingservicecost: "shipping_cost",
    },
    signature: [
      "availablequantity",
      "ebaycategory1name",
      "watchers",
      "buyitnowprice",
      "picurl",
      "conditionid",
      "storecategory",
    ],
    verified: null,
  },
  {
    id: "etsy",
    name: "Etsy currently-for-sale listings",
    headers: {
      title: "title",
      description: "description",
      price: "list_price",
      currencycode: "skip",
      quantity: "skip",
      tags: "skip",
      materials: "skip",
      image1: "skip",
      sku: "sku",
      variation1type: "skip",
      variation1name: "skip",
      variation1values: "skip",
      variation2type: "skip",
      variation2name: "skip",
      variation2values: "skip",
    },
    signature: ["currencycode", "materials", "variation1type", "variation1name", "variation1values"],
    verified: null,
  },
];

/** Enough of a tool's own headers to call the file its export. */
export const PRESET_SIGNATURE_MIN = 2;

export function getImportPreset(id: string): ImportPreset | undefined {
  return IMPORT_PRESETS.find((p) => p.id === id);
}

/**
 * Which preset, if any, the headers look like. The best match wins; a tie or
 * a file with fewer than PRESET_SIGNATURE_MIN signature headers is null and the
 * seller maps by hand, exactly as before this existed.
 */
export function detectImportPreset(headers: readonly string[]): ImportPreset | null {
  const norm = new Set(headers.map(normalizeHeader));
  let best: { preset: ImportPreset; hits: number } | null = null;
  let tie = false;
  for (const preset of IMPORT_PRESETS) {
    const hits = preset.signature.filter((h) => norm.has(h)).length;
    if (hits < PRESET_SIGNATURE_MIN) continue;
    if (!best || hits > best.hits) {
      best = { preset, hits };
      tie = false;
    } else if (hits === best.hits) {
      tie = true;
    }
  }
  return best && !tie ? best.preset : null;
}

/** The mapping a preset gives these headers; anything it does not name falls back to the generic guess. */
export function applyImportPreset(headers: readonly string[], preset: ImportPreset): ImportField[] {
  return headers.map((h) => preset.headers[normalizeHeader(h)] ?? guessField(h));
}

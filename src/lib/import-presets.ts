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
  id: "vendoo" | "list-perfectly";
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

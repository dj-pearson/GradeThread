// Parser for the eBay "Active Listings" CSV report (Seller Hub → Listings →
// Active → Download report). eBay's export is messy: it can carry a few
// banner/footer rows around the real table and column names drift between
// account types, so we locate the header row by content and match columns
// by a normalized key rather than exact string.

import { parseDelimited, detectDelimiter } from "@/lib/csv";
import { parseDate as parseFlexibleDate } from "@/lib/import-mapping";

export interface EbayListingParsed {
  ebayItemId: string;
  customLabel: string | null;
  title: string;
  price: number | null;
  quantity: number | null;
  startDate: string | null; // yyyy-mm-dd or null
  url: string | null;
  format: string | null;
  raw: Record<string, string>;
}

export interface EbayCsvResult {
  headerFound: boolean;
  listings: EbayListingParsed[];
  /** Rows after the header that had no usable item id. */
  skipped: number;
}

// Normalize a header cell to a comparable key: lowercase, alphanumeric only.
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Header aliases by normalized key. First match wins.
const COLUMN_ALIASES: Record<keyof Omit<EbayListingParsed, "raw">, string[]> = {
  ebayItemId: ["itemnumber", "ebayitemnumber", "itemid", "ebayitemid"],
  customLabel: ["customlabel", "customlabelsku", "sku", "customsku"],
  title: ["title", "listingtitle", "itemtitle"],
  price: [
    "currentprice",
    "startprice",
    "price",
    "buyitnowprice",
    "fixedprice",
  ],
  quantity: ["availablequantity", "quantityavailable", "quantity"],
  startDate: ["startdate", "listingstartdate", "datelisted"],
  url: ["viewitemurl", "ebayitemurl", "url", "listingurl", "itemurl"],
  format: ["format", "listingformat", "buyingformat"],
};

function parseMoney(v: string | undefined): number | null {
  if (!v) return null;
  const cleaned = v.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseInteger(v: string | undefined): number | null {
  if (!v) return null;
  const cleaned = v.replace(/[^0-9-]/g, "");
  if (!cleaned) return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

// Delegates to the shared flexible parser so a year-less "M/D" start date in
// an eBay export can't be silently resolved to year 2001 (the V8 `new Date`
// quirk). See parseDate in import-mapping.ts.
function parseDate(v: string | undefined): string | null {
  return v == null ? null : parseFlexibleDate(v);
}

export function parseEbayListingsCsv(input: string): EbayCsvResult {
  const delimiter = detectDelimiter(input);
  const rows = parseDelimited(input, delimiter);

  // Find the header row: the first row whose normalized cells contain an
  // item-number column and a title column.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const keys = (rows[i] ?? []).map(norm);
    const hasItem = keys.some((k) => COLUMN_ALIASES.ebayItemId.includes(k));
    const hasTitle = keys.some((k) => COLUMN_ALIASES.title.includes(k));
    if (hasItem && hasTitle) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    return { headerFound: false, listings: [], skipped: 0 };
  }

  const header = (rows[headerIdx] ?? []).map(norm);
  const rawHeader = rows[headerIdx] ?? [];

  // Resolve each logical field to a column index.
  const colIndex = {} as Record<keyof Omit<EbayListingParsed, "raw">, number>;
  (Object.keys(COLUMN_ALIASES) as Array<keyof typeof COLUMN_ALIASES>).forEach(
    (field) => {
      colIndex[field] = header.findIndex((k) =>
        COLUMN_ALIASES[field].includes(k),
      );
    },
  );

  const listings: EbayListingParsed[] = [];
  let skipped = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    // Skip blank rows and eBay footer banners (single non-empty cell).
    const nonEmpty = cells.filter((c) => c.trim() !== "");
    if (nonEmpty.length <= 1) continue;

    const at = (idx: number): string | undefined =>
      idx >= 0 ? cells[idx]?.trim() : undefined;

    const ebayItemId = at(colIndex.ebayItemId) ?? "";
    if (!ebayItemId) {
      skipped++;
      continue;
    }

    const raw: Record<string, string> = {};
    rawHeader.forEach((h, idx) => {
      const key = h.trim();
      if (key) raw[key] = (cells[idx] ?? "").trim();
    });

    const customLabel = at(colIndex.customLabel) ?? "";

    listings.push({
      ebayItemId,
      customLabel: customLabel || null,
      title: at(colIndex.title) ?? "",
      price: parseMoney(at(colIndex.price)),
      quantity: parseInteger(at(colIndex.quantity)),
      startDate: parseDate(at(colIndex.startDate)),
      url: at(colIndex.url) || null,
      format: at(colIndex.format) || null,
      raw,
    });
  }

  return { headerFound: true, listings, skipped };
}

// Normalize a SKU/custom-label for comparison: trimmed, lowercased.
// Returns "" for blank values so callers can treat them as "no SKU".
export function normalizeSku(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

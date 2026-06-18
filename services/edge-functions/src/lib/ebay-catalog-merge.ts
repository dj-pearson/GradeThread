// Catalog merge for the eBay → FlipDesk sync (eBay as source of truth).
//
// When a pulled eBay listing matches a FlipDesk inventory_item by SKU, we let
// eBay drive the catalog fields:
//   • title              → OVERWRITE whenever eBay's differs (and is non-empty)
//   • brand/size/color/style/material → FILL ONLY WHEN the local cell is blank
//     (never clobber a value the seller set by hand)
//
// brand/size/color/style/material come from eBay "item specifics" (aspects),
// whose names vary by category ("Colour", "Fabric Type", "Women's Size", …) —
// pickAspect maps our field to the right specific case-insensitively.
//
// Pure module (no supabase/network import) so it unit-tests without env.

import {
  EBAY_OWNED_ITEM_SPECIFIC_FIELDS,
  isBlank,
} from "./sync-precedence.ts";

// The inventory_items catalog fields this sync may write. `title` is handled
// separately (overwrite); the rest are fill-if-blank. Sourced from the shared
// precedence registry (sync-precedence.ts) — no duplicate field list here.
export const FILL_IF_BLANK_FIELDS = EBAY_OWNED_ITEM_SPECIFIC_FIELDS;

export type FillField = (typeof FILL_IF_BLANK_FIELDS)[number];

export interface LocalCatalog {
  title: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  style: string | null;
  material: string | null;
}

export type CatalogPatch = Partial<{
  title: string;
  brand: string;
  size: string;
  color: string;
  style: string;
  material: string;
}>;

export interface EbayCatalog {
  title: string | null;
  // eBay item specifics, already flattened to one value per name.
  specifics: Record<string, string>;
}

// eBay's getInventoryItem `product.aspects` is Record<name, string[]>. Take the
// first non-empty value per name so it matches the GetItem (Trading) shape.
export function flattenAspects(
  aspects: Record<string, string[]> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!aspects) return out;
  for (const [name, values] of Object.entries(aspects)) {
    const first = (values ?? []).find((v) => typeof v === "string" && v.trim());
    if (first) out[name] = first.trim();
  }
  return out;
}

// Per-field aspect-name resolution. `primary` matches the exact eBay specific
// name (case-insensitive); `contains`/`excludes` are fuzzy fallbacks for the
// many category-specific variants ("Women's Size", "Outer Shell Material", …).
const ASPECT_MATCHERS: Record<
  FillField,
  { primary: string[]; contains: string[]; excludes: string[] }
> = {
  brand: { primary: ["brand"], contains: [], excludes: [] },
  // Exclude "Size Type" (Regular/Plus/Petite) — that's not the numeric size.
  size: { primary: ["size"], contains: ["size"], excludes: ["size type"] },
  color: { primary: ["color", "colour"], contains: ["color", "colour"], excludes: [] },
  style: { primary: ["style"], contains: [], excludes: [] },
  material: {
    primary: ["material"],
    contains: ["material", "fabric"],
    excludes: [],
  },
};

// Resolve the eBay specific value for one of our fields, or null if absent.
export function pickAspect(
  specifics: Record<string, string>,
  field: FillField,
): string | null {
  const m = ASPECT_MATCHERS[field];
  const entries = Object.entries(specifics).map(([k, v]) => ({
    key: k,
    lower: k.toLowerCase().trim(),
    value: typeof v === "string" ? v.trim() : "",
  }));
  // 1) exact (case-insensitive) name match.
  for (const want of m.primary) {
    const hit = entries.find((e) => e.lower === want && e.value);
    if (hit) return hit.value;
  }
  // 2) fuzzy contains-match, respecting excludes.
  for (const e of entries) {
    if (!e.value) continue;
    if (m.excludes.some((x) => e.lower.includes(x))) continue;
    if (m.contains.some((c) => e.lower.includes(c))) return e.value;
  }
  return null;
}

// Build the inventory_items patch for one matched listing. Returns {} when
// nothing should change so the caller can skip the DB write.
export function buildCatalogPatch(
  local: LocalCatalog,
  ebay: EbayCatalog,
): CatalogPatch {
  const patch: CatalogPatch = {};

  // Title: eBay is source of truth — overwrite when it differs and is non-empty.
  const ebayTitle = ebay.title?.trim();
  if (ebayTitle && ebayTitle !== (local.title ?? "").trim()) {
    patch.title = ebayTitle;
  }

  // The rest: fill only when the local cell is blank.
  for (const field of FILL_IF_BLANK_FIELDS) {
    if (!isBlank(local[field])) continue;
    const val = pickAspect(ebay.specifics, field);
    if (val) patch[field] = val;
  }

  return patch;
}

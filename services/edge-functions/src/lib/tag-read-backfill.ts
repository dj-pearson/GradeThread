// 2026-09-02: the pure half of scripts/backfill-tag-reads.ts.
//
// 1001 items on prod were generated before the Style Code aspect could land
// (aspect-registry mpn entry, 293008ffb) and before the listing path decoded
// codes at all. 150 of them already have a tag-typed photo. This plans the
// ONLY writes the backfill may make: attributes.mpn / .model / .rn /
// .rn_registrant and the Style Code (or MPN) and Model aspects when the
// item's leaf exposes them. Title, description, size, brand and every
// listings row are out of scope; a live eBay listing changes only when the
// seller republishes. Fill-only throughout.

import type { EbayAspectSpec } from "./ai-extract.ts";
import { deriveInventoryAspects } from "./ai-listing.ts";
import type { RegistryItem } from "./aspect-registry.ts";

export interface BackfillItem {
  id: string;
  user_id: string;
  brand: string | null;
  style: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  title: string | null;
  item_category: string | null;
  garment_type: string | null;
  garment_category: string | null;
  ebay_category_id: string | null;
  ebay_aspects: Record<string, string[]> | null;
  ebay_aspect_sources: Record<string, string> | null;
  attributes: Record<string, unknown> | null;
}

export interface BackfillPatch {
  /** Full merged attribute map, or null when there is nothing to write. */
  attributes: Record<string, unknown> | null;
  /** Full merged aspect map, or null when no aspect was added. */
  ebay_aspects: Record<string, string[]> | null;
  ebay_aspect_sources: Record<string, string> | null;
  addedAttributes: string[];
  addedAspects: string[];
}

/** The keys the backfill may add. Anything else in tagAttributes is dropped. */
export const BACKFILL_ATTRIBUTE_KEYS = [
  "mpn",
  "model",
  "rn",
  "rn_registrant",
] as const;

/** The aspect names the backfill may add: the mpn and model registry entries. */
export const BACKFILL_ASPECT_NAMES: ReadonlySet<string> = new Set([
  "MPN",
  "Manufacturer Part Number",
  "Style Code",
  "Style Number",
  "Model Number",
  "Model",
  "Model Name",
]);

/** Same literal the generation path writes for registry-derived aspects. */
export const INVENTORY_DERIVED = "inventory_derived";

function filled(v: unknown): boolean {
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return v != null;
}

export function backfillEligible(item: BackfillItem): boolean {
  return !filled(item.attributes?.mpn) && !filled(item.attributes?.rn);
}

export function planBackfillPatch(args: {
  item: BackfillItem;
  tagAttributes: Record<string, string>;
  aspectSpecs: EbayAspectSpec[];
}): BackfillPatch {
  const existing = args.item.attributes ?? {};
  const addedAttributes: string[] = [];
  const attributes: Record<string, unknown> = { ...existing };
  for (const key of BACKFILL_ATTRIBUTE_KEYS) {
    const v = args.tagAttributes[key];
    if (!v || v.trim() === "" || filled(existing[key])) continue;
    attributes[key] = v.trim();
    addedAttributes.push(key);
  }
  if (addedAttributes.length === 0) {
    return {
      attributes: null,
      ebay_aspects: null,
      ebay_aspect_sources: null,
      addedAttributes,
      addedAspects: [],
    };
  }

  let ebay_aspects: Record<string, string[]> | null = null;
  let ebay_aspect_sources: Record<string, string> | null = null;
  const addedAspects: string[] = [];
  if (args.aspectSpecs.length > 0) {
    const registryItem: RegistryItem = {
      item_category: args.item.item_category,
      brand: args.item.brand,
      size: args.item.size,
      color: args.item.color,
      material: args.item.material,
      style: args.item.style,
      title: args.item.title,
      attributes: attributes as Record<string, string | string[]>,
    };
    const current = args.item.ebay_aspects ?? {};
    const derived = deriveInventoryAspects(registryItem, args.aspectSpecs, current);
    for (const [name, values] of Object.entries(derived)) {
      if (!BACKFILL_ASPECT_NAMES.has(name)) continue;
      if (filled(current[name])) continue;
      ebay_aspects ??= { ...current };
      ebay_aspects[name] = values;
      ebay_aspect_sources ??= { ...(args.item.ebay_aspect_sources ?? {}) };
      ebay_aspect_sources[name] = INVENTORY_DERIVED;
      addedAspects.push(name);
    }
  }
  return { attributes, ebay_aspects, ebay_aspect_sources, addedAttributes, addedAspects };
}

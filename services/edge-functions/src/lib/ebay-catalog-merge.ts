// Catalog merge for the eBay → FlipDesk sync (eBay as source of truth).
//
// When a pulled eBay listing matches a FlipDesk inventory_item by SKU, we let
// eBay drive the catalog fields:
//   • title              → OVERWRITE whenever eBay's differs (and is non-empty)
//   • brand/size/color/style/material → FILL ONLY WHEN the local cell is blank
//     (never clobber a value the seller set by hand)
//   • ebay_aspects       → FILL per aspect NAME: every specific eBay holds that
//     the item does not yet carry is added; a name the item already has keeps
//     its local value. ebay_category_id fills only when blank.
//
// The last line is what makes an imported listing crosslistable. Until US-3468
// the pull read the WHOLE specifics map (modern offers carry product.aspects,
// legacy listings answer GetItem) and then kept only the five clothing columns
// above. A baseball card's Sport, Player, Season, Set, Card Number and Graded
// specifics, or a shoe's US Shoe Size, were fetched and dropped on the floor,
// so the item page showed a title and photos and nothing else, and no other
// marketplace draft could be built from it. ebay_aspects is the map the
// composer, publish and every crosslist adapter read
// (listing.item_specifics_override ?? item.ebay_aspects), so the pull now
// writes the full map there.
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
  /**
   * US-3468: the item's full eBay specifics map and leaf category. Optional so
   * a caller that only has the five columns (older tests, the sync-scope
   * fixtures) still type-checks; absent reads as "nothing stored", which is
   * the fill-everything case.
   */
  ebay_aspects?: Record<string, string[]> | null;
  ebay_category_id?: string | null;
}

export type CatalogPatch = Partial<{
  title: string;
  brand: string;
  size: string;
  color: string;
  style: string;
  material: string;
  ebay_aspects: Record<string, string[]>;
  ebay_category_id: string;
}>;

export interface EbayCatalog {
  title: string | null;
  // eBay item specifics, already flattened to one value per name.
  specifics: Record<string, string>;
  /**
   * US-3468: the same specifics with EVERY value per name (eBay's own shape,
   * Record<name, string[]>), for the ebay_aspects mirror. Optional so the
   * flattened-only callers keep working; when absent, `specifics` is widened
   * to one-value arrays so the mirror is never skipped just because a caller
   * had only the flat form.
   */
  aspects?: Record<string, string[]> | null;
  /** eBay's leaf category id for the listing, when the pull has it. */
  categoryId?: string | null;
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

// Resolve the eBay specific (its name AND value) for one of our fields, or
// null if absent. The name is what US-3468's mirror needs: the one aspect a
// filled column already answers for, so the mirror can leave it out.
export function pickAspectEntry(
  specifics: Record<string, string>,
  field: FillField,
): { key: string; value: string } | null {
  const m = ASPECT_MATCHERS[field];
  const entries = Object.entries(specifics).map(([k, v]) => ({
    key: k,
    lower: k.toLowerCase().trim(),
    value: typeof v === "string" ? v.trim() : "",
  }));
  // 1) exact (case-insensitive) name match.
  for (const want of m.primary) {
    const hit = entries.find((e) => e.lower === want && e.value);
    if (hit) return { key: hit.key, value: hit.value };
  }
  // 2) fuzzy contains-match, respecting excludes.
  for (const e of entries) {
    if (!e.value) continue;
    if (m.excludes.some((x) => e.lower.includes(x))) continue;
    if (m.contains.some((c) => e.lower.includes(c))) {
      return { key: e.key, value: e.value };
    }
  }
  return null;
}

// Resolve the eBay specific value for one of our fields, or null if absent.
export function pickAspect(
  specifics: Record<string, string>,
  field: FillField,
): string | null {
  return pickAspectEntry(specifics, field)?.value ?? null;
}

/**
 * US-3468: sanitize an eBay aspect map to the shape ebay_aspects stores —
 * trimmed names, trimmed non-empty string values, no empty names or lists.
 */
export function sanitizePulledAspects(
  aspects: Record<string, unknown> | null | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!aspects || typeof aspects !== "object") return out;
  for (const [rawName, rawValues] of Object.entries(aspects)) {
    const name = rawName.trim();
    if (!name) continue;
    const list = Array.isArray(rawValues) ? rawValues : [rawValues];
    const values: string[] = [];
    for (const v of list) {
      if (typeof v !== "string") continue;
      const t = v.trim();
      if (t && !values.includes(t)) values.push(t);
    }
    if (values.length > 0) out[name] = values;
  }
  return out;
}

/**
 * US-3468: merge eBay's specifics into the item's stored map, fill-if-blank
 * PER NAME. Names are compared case-insensitively so "Colour" from eBay does
 * not sit beside a locally stored "colour"; the local spelling wins. Returns
 * null when the merge would change nothing, so the caller skips the write.
 *
 * Fill-if-blank rather than overwrite for the same reason the five columns
 * are: the specifics editor and the AI pass both write ebay_aspects, and a
 * value the seller set here must not be clobbered by a pull. A NEW name from
 * eBay is not a conflict, it is the thing that was missing.
 */
export function mergeEbayAspects(
  local: Record<string, string[]> | null | undefined,
  pulled: Record<string, string[]> | null | undefined,
): Record<string, string[]> | null {
  const incoming = sanitizePulledAspects(pulled);
  if (Object.keys(incoming).length === 0) return null;
  const base = sanitizePulledAspects(local);
  const haveLower = new Set(Object.keys(base).map((k) => k.toLowerCase()));
  let added = 0;
  const merged: Record<string, string[]> = { ...base };
  for (const [name, values] of Object.entries(incoming)) {
    if (haveLower.has(name.toLowerCase())) continue;
    merged[name] = values;
    haveLower.add(name.toLowerCase());
    added += 1;
  }
  return added > 0 ? merged : null;
}

// Build the inventory_items patch for one matched listing. Returns {} when
// nothing should change so the caller can skip the DB write.
export function buildCatalogPatch(
  local: LocalCatalog,
  ebay: EbayCatalog,
): CatalogPatch {
  const patch: CatalogPatch = {};

  // US-3468: the full specifics map, fill-if-blank per name. Runs off the
  // multi-valued form when the caller has it; otherwise off the flat one so a
  // legacy caller still mirrors what it read.
  const pulledAspects: Record<string, string[]> = {
    ...(ebay.aspects && Object.keys(ebay.aspects).length > 0
      ? ebay.aspects
      : Object.fromEntries(
        Object.entries(ebay.specifics ?? {}).map(([k, v]) => [k, [v]]),
      )),
  };
  // A column the seller already filled is the write-authority for its ONE
  // aspect (SYNC_SOURCE_OF_TRUTH "single-entry rule"), and publish projects
  // the column onto it regardless. So when eBay's value for that aspect
  // DISAGREES with a filled column, the mirror leaves that name out rather
  // than store a value the item page contradicts. An agreeing value, or a
  // blank column the pull is about to fill, mirrors as normal.
  for (const field of FILL_IF_BLANK_FIELDS) {
    if (isBlank(local[field])) continue;
    const hit = pickAspectEntry(ebay.specifics ?? {}, field);
    if (!hit) continue;
    const localValue = (local[field] ?? "").trim().toLowerCase();
    if (hit.value.trim().toLowerCase() !== localValue) {
      delete pulledAspects[hit.key];
    }
  }
  const mergedAspects = mergeEbayAspects(local.ebay_aspects, pulledAspects);
  if (mergedAspects) patch.ebay_aspects = mergedAspects;

  // Leaf category: fill only when blank. The composer loads the aspect spec
  // (which names are required, which are selection-only) from this id, so an
  // item with specifics but no category shows them with no editor around them.
  const categoryId = (ebay.categoryId ?? "").trim();
  if (categoryId && isBlank(local.ebay_category_id ?? null)) {
    patch.ebay_category_id = categoryId;
  }

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

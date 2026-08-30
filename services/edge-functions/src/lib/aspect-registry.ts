// US-822: the SINGLE source of truth for how an item's canonical fields map to
// eBay item-specific (aspect) names.
//
// Before this module the mapping was hand-duplicated in THREE places — the edge
// publish path (flipdesk-ebay.ts deriveAspectsFromItem), the web composer
// (src/lib/ebay-prefill.ts), and iOS prefill behavior — each covering only
// brand/size/color/material/style/department/size-type. That drifts silently.
//
// Now there is exactly one definition: the data-driven ASPECT_REGISTRY below
// plus resolveItemAspects(). The edge consumes it directly. The web vendors a
// generated JSON copy (src/lib/ebay-aspect-registry.json) and a CI drift guard
// (services/edge-functions/src/tests/aspect-registry-drift_test.ts) fails the
// build if the copy diverges. iOS prefill is server-driven (it has no local
// mapping table — it consumes the values the server derives via this registry),
// so it benefits transitively with no Swift table to drift.
//
// The registry covers every canonical field: the legacy structured columns
// (brand, size, color, material, style) AND every canonical attribute the
// capture pass can fill — the original US-821 sixteen plus the US-2421
// widening to 40 (apparel cut, fabric, product identity, use case, shoes, bags).
//
// The ONE canonical key with no entry here is `observations` (US-2421's
// catch-all). That is deliberate: it holds facts that by definition have no
// named home, so there is no aspect to map it to. It is stored so a future
// canonical key can be backfilled from it — at which point THAT key gets an
// entry, and this one still won't.

import { normalizeAspectValue } from "./aspect-normalize.ts";

// ─── Registry data shape ───────────────────────────────────────────

export interface AspectMappingEntry {
  /** Canonical key (a legacy item column or a US-821 attribute key). */
  key: string;
  /** Where the value comes from. */
  source: "column" | "attribute";
  /** Item column name (source === "column"). */
  column?: string;
  /** inventory_items.attributes key (source === "attribute"). */
  attribute?: string;
  /** Multi-valued (only fills an eBay MULTI-cardinality aspect with >1 value). */
  multi: boolean;
  /**
   * Ordered eBay aspect-name candidates incl. synonyms (e.g. Color/Colour,
   * Material/Fabric Type/Outer Shell Material). Matched case-insensitively
   * against the category's real aspect list.
   */
  aspects: string[];
  /**
   * Per-item_category EXTRA aspect-name candidates, tried ahead of the defaults
   * for that vertical (e.g. shoes → "US Shoe Size"). Extends, never replaces.
   */
  byCategory?: Record<string, string[]>;
  /** Inference fallback applied when no value is present. Only "department". */
  infer?: "department";
  /** Constant default applied only when item_category === "clothing". */
  clothingDefault?: string;
}

export interface AspectRegistry {
  version: number;
  entries: AspectMappingEntry[];
}

// Bump `version` whenever entries change so a served/cached copy is versioned.
export const ASPECT_REGISTRY: AspectRegistry = {
  version: 4,
  entries: [
    // ── Legacy structured columns ──
    { key: "brand", source: "column", column: "brand", multi: false, aspects: ["Brand"] },
    {
      key: "size",
      source: "column",
      column: "size",
      multi: false,
      aspects: ["Size"],
      // US-2812: `headwear` had no entry anywhere in this registry, so a hat
      // listing could only ever fill the generic "Size". Adding a candidate is
      // SAFE rather than a guess — ownedAspectName resolves against the real
      // aspect list eBay returns for the chosen category, so a name that
      // category does not have is never matched. A name is a proposal; only
      // eBay's own vocabulary is ever used.
      //
      // ONLY "Hat Size", deliberately. "Size Type" was the other obvious
      // candidate and is left out: on eBay's apparel categories it means
      // Regular/Petite/Plus, and if a hat leaf carries it as FREE TEXT then
      // "7 3/8" would fill it and publish a size where a fit class belongs.
      // A candidate is only safe when its meaning cannot be mistaken.
      byCategory: {
        shoes: ["US Shoe Size", "Shoe Size"],
        headwear: ["Hat Size"],
      },
    },
    { key: "color", source: "column", column: "color", multi: false, aspects: ["Color", "Colour"] },
    {
      key: "material",
      source: "column",
      column: "material",
      multi: false,
      aspects: ["Material", "Fabric Type", "Outer Shell Material"],
      byCategory: { shoes: ["Upper Material"] },
    },
    { key: "style", source: "column", column: "style", multi: false, aspects: ["Style", "Type"] },
    // ── US-821 canonical attributes ──
    // Placed after the style COLUMN entry deliberately. In a category exposing
    // both "Style" and "Type", the style column owns Style and this owns Type,
    // which is the split the aspect list is asking for. In the few categories
    // exposing Type but no Style, the style column still owns Type and
    // columnAspectProjection re-asserts it authoritatively — unchanged
    // behaviour, and the out[name] guard in resolveItemAspects means this
    // entry stands down there rather than fighting it.
    {
      key: "product_type",
      source: "attribute",
      attribute: "product_type",
      multi: false,
      aspects: ["Type"],
    },
    {
      key: "department",
      source: "attribute",
      attribute: "department",
      infer: "department",
      multi: false,
      aspects: ["Department"],
    },
    {
      key: "size_type",
      source: "attribute",
      attribute: "size_type",
      clothingDefault: "Regular",
      multi: false,
      aspects: ["Size Type"],
    },
    { key: "sleeve_length", source: "attribute", attribute: "sleeve_length", multi: false, aspects: ["Sleeve Length"] },
    { key: "neckline", source: "attribute", attribute: "neckline", multi: false, aspects: ["Neckline"] },
    { key: "pattern", source: "attribute", attribute: "pattern", multi: false, aspects: ["Pattern"] },
    { key: "fit", source: "attribute", attribute: "fit", multi: false, aspects: ["Fit", "Garment Fit"] },
    {
      key: "closure",
      source: "attribute",
      attribute: "closure",
      multi: false,
      aspects: ["Closure", "Closure Type", "Fastening"],
    },
    { key: "features", source: "attribute", attribute: "features", multi: true, aspects: ["Features"] },
    {
      key: "garment_care",
      source: "attribute",
      attribute: "garment_care",
      multi: false,
      aspects: ["Garment Care", "Care Instructions"],
    },
    {
      key: "country_of_manufacture",
      source: "attribute",
      attribute: "country_of_manufacture",
      multi: false,
      aspects: ["Country/Region of Manufacture", "Country of Manufacture"],
    },
    { key: "vintage", source: "attribute", attribute: "vintage", multi: false, aspects: ["Vintage"] },
    {
      key: "theme",
      source: "attribute",
      attribute: "theme",
      multi: false,
      aspects: ["Theme", "Character", "Character Family"],
    },
    { key: "mpn", source: "attribute", attribute: "mpn", multi: false, aspects: ["MPN", "Manufacturer Part Number"] },

    // ── US-2421/US-2422: the wide capture's aspects ──
    //
    // ORDER MATTERS. resolveItemAspects walks entries top-down and each entry
    // takes only the FIRST candidate name the category actually exposes
    // (ownedAspectName), skipping any name an earlier entry already filled. So
    // an entry that shares a name with an earlier one — fabric_type vs the
    // `material` column ("Fabric Type"), character vs `theme` ("Character") —
    // is placed AFTER it on purpose: the older, more authoritative field keeps
    // first claim, and the new key picks up the second name when the leaf has
    // both. On a leaf with only one of them, the new key fills it only when the
    // older field had nothing to give.

    // Apparel cut + construction.
    {
      key: "accents",
      source: "attribute",
      attribute: "accents",
      multi: true,
      aspects: ["Accents", "Embellishment", "Embellishments"],
    },
    {
      key: "sleeve_style",
      source: "attribute",
      attribute: "sleeve_style",
      multi: false,
      aspects: ["Sleeve Style", "Sleeve Type"],
    },
    { key: "rise", source: "attribute", attribute: "rise", multi: false, aspects: ["Rise"] },
    {
      key: "leg_style",
      source: "attribute",
      attribute: "leg_style",
      multi: false,
      aspects: ["Leg Style", "Leg Type"],
    },
    {
      key: "dress_length",
      source: "attribute",
      attribute: "dress_length",
      multi: false,
      aspects: ["Dress Length", "Skirt Length"],
    },
    {
      key: "garment_length",
      source: "attribute",
      attribute: "garment_length",
      multi: false,
      // Deliberately NOT the bare "Length": on bottoms and bags that aspect is
      // a NUMBER (inches), and pushing "Regular" into it fails the publish.
      aspects: ["Garment Length", "Coat/Jacket Length", "Top Length"],
    },
    {
      key: "lining",
      source: "attribute",
      attribute: "lining",
      multi: false,
      // NOT "Lining Material": that aspect wants a fabric (Sherpa, Faux Fur),
      // while this key answers whether and how the garment is lined at all.
      aspects: ["Lining"],
    },

    // Fabric. `material` (the column) owns the primary name; these carry the
    // qualities eBay asks for beside it.
    {
      key: "fabric_type",
      source: "attribute",
      attribute: "fabric_type",
      multi: false,
      aspects: ["Fabric Type", "Fabric", "Material"],
    },
    {
      key: "fabric_weight",
      source: "attribute",
      attribute: "fabric_weight",
      multi: false,
      aspects: ["Fabric Weight"],
    },

    // Product identity.
    {
      key: "product_line",
      source: "attribute",
      attribute: "product_line",
      multi: false,
      aspects: ["Product Line", "Collection", "Series"],
    },
    { key: "model", source: "attribute", attribute: "model", multi: false, aspects: ["Model"] },
    {
      key: "collaboration",
      source: "attribute",
      attribute: "collaboration",
      multi: false,
      aspects: ["Collaboration"],
    },
    {
      key: "character",
      source: "attribute",
      attribute: "character",
      multi: false,
      aspects: ["Character", "Character Family"],
    },

    // Use case.
    { key: "occasion", source: "attribute", attribute: "occasion", multi: false, aspects: ["Occasion"] },
    {
      key: "activity",
      source: "attribute",
      attribute: "activity",
      multi: false,
      aspects: ["Activity", "Sport", "Sport/Activity"],
    },
    { key: "season", source: "attribute", attribute: "season", multi: false, aspects: ["Season"] },
    { key: "era", source: "attribute", attribute: "era", multi: false, aspects: ["Era", "Decade"] },

    // Footwear. The default names are the generic ones; the shoes vertical adds
    // the leaf-specific spellings ahead of them.
    {
      key: "heel_type",
      source: "attribute",
      attribute: "heel_type",
      multi: false,
      aspects: ["Heel Type"],
      byCategory: { shoes: ["Heel Style"] },
    },
    {
      key: "heel_height",
      source: "attribute",
      attribute: "heel_height",
      multi: false,
      aspects: ["Heel Height"],
    },
    {
      key: "toe_shape",
      source: "attribute",
      attribute: "toe_shape",
      multi: false,
      aspects: ["Toe Shape"],
      byCategory: { shoes: ["Toe Type", "Toe Style"] },
    },
    {
      key: "shoe_width",
      source: "attribute",
      attribute: "shoe_width",
      multi: false,
      // "Width" alone is a bag/furniture dimension elsewhere, so it is offered
      // only inside the shoes vertical.
      aspects: ["Shoe Width", "US Shoe Width"],
      byCategory: { shoes: ["Shoe Width", "US Shoe Width", "Width"] },
    },
    {
      key: "shoe_shaft_height",
      source: "attribute",
      attribute: "shoe_shaft_height",
      multi: false,
      aspects: ["Shaft Height"],
      byCategory: { shoes: ["Shaft Height", "Boot Height"] },
    },

    // Bags + accessories.
    {
      key: "strap_type",
      source: "attribute",
      attribute: "strap_type",
      multi: false,
      aspects: ["Strap Type"],
      byCategory: {
        bags: ["Handle/Strap Type", "Handle Type", "Strap Type"],
        accessories: ["Strap Type", "Band Type"],
      },
    },
    {
      key: "hardware_color",
      source: "attribute",
      attribute: "hardware_color",
      multi: false,
      // NOT "Hardware Material": that aspect wants brass/steel/resin, and a
      // tone like "Gold-Tone" is not a material — eBay would reject it, or
      // worse, accept it and mislead the buyer.
      aspects: ["Hardware Color"],
      byCategory: {
        bags: ["Hardware Color", "Metal Color"],
        accessories: ["Metal Color", "Hardware Color"],
      },
    },
  ],
};

/**
 * Canonical, stable JSON serialization of the registry. The vendored web copy
 * (src/lib/ebay-aspect-registry.json) MUST byte-match this; the drift guard
 * asserts it. Two-space indent + trailing newline matches `scripts/
 * sync-aspect-registry.mjs`.
 */
export function serializeRegistry(): string {
  return `${JSON.stringify(ASPECT_REGISTRY, null, 2)}\n`;
}

// ─── Resolver inputs (normalized, platform-agnostic) ───────────────

/** A category aspect spec, normalized from eBay's per-client wire shape. */
export interface RegistryAspect {
  name: string;
  /** "SELECTION_ONLY" | "FREE_TEXT" | "SUGGESTED" (anything else → free text). */
  mode?: string;
  /** itemToAspectCardinality === "MULTI" — required before we send >1 value. */
  multi?: boolean;
  /** eBay's allowed values (only present for SELECTION_ONLY aspects). */
  allowedValues?: string[];
}

/** The item fields the resolver may draw from. */
export interface RegistryItem {
  item_category: string | null;
  brand?: string | null;
  size?: string | null;
  color?: string | null;
  material?: string | null;
  style?: string | null;
  // Free-text fields used only for department inference.
  title?: string | null;
  description?: string | null;
  condition_notes?: string | null;
  /** inventory_items.attributes (US-821): canonical key → string | string[]. */
  attributes?: Record<string, string | string[]> | null;
}

// ─── Department inference ──────────────────────────────────────────

// eBay's "Department" aspect is required + SELECTION_ONLY for most clothing
// categories and we have no column for it — but the gender/age is almost always
// in the title/style/size text ("Men's Nike Hoodie", "Boys 10/12"). Infer the
// canonical eBay value; the SELECTION_ONLY allowed-value check then validates it
// against the category's real list before we fill. Returns null when no signal.
export function inferDepartment(item: RegistryItem): string | null {
  const text = [item.title, item.style, item.description, item.condition_notes, item.size]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
  if (!text) return null;
  const has = (re: RegExp) => re.test(text);
  // Order matters: most specific first. \b avoids "men" matching inside "women".
  if (has(/\bmaternity\b/)) return "Maternity";
  if (has(/\b(baby|infant|newborn|toddler|onesie)\b/)) return "Baby";
  if (has(/\bboys?\b/)) return "Boys";
  if (has(/\bgirls?\b/)) return "Girls";
  if (has(/\b(kids?|youth|juniors?|children'?s?|child)\b/)) return "Unisex Kids";
  if (has(/\bunisex\b/)) return "Unisex Adult";
  if (has(/\b(women'?s?|womens|woman'?s?|womenswear|ladies'?|lady'?s?|female|misses)\b/)) {
    return "Women";
  }
  if (has(/\b(men'?s?|mens|man'?s?|menswear|male)\b/)) return "Men";
  return null;
}

/**
 * The item's department: what it SAYS, falling back to what its text implies.
 *
 * This is the precedence `canonicalValues` already applies to the department
 * entry (a single-valued attribute with `infer: "department"`), lifted out so a
 * caller outside the aspect resolver cannot invent a second one. US-2796's
 * parcel path needs it, and it was reading only the inferred half - so an item
 * whose capture pass had already written department="Women" was re-derived from
 * its title, and a title that never says "women's" lost the answer the row was
 * carrying.
 *
 * A guard in shoe-size-scale_test.ts pins this against what resolveItemAspects
 * actually fills for "Department", so the two cannot drift.
 */
export function resolveDepartment(item: RegistryItem): string | null {
  const raw = item.attributes?.department;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const stated = typeof first === "string" ? first.trim() : "";
  if (stated) return stated;
  return inferDepartment(item);
}

// ─── Resolver ──────────────────────────────────────────────────────

// Effective (lowercased) aspect-name candidates for an entry in a vertical:
// per-category extras first, then the defaults, deduped.
function effectiveCandidates(entry: AspectMappingEntry, category: string | null): string[] {
  const extra = (category && entry.byCategory?.[category]) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...extra, ...entry.aspects]) {
    const l = name.toLowerCase();
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out;
}

// The value(s) an entry contributes for this item, or null when absent.
function canonicalValues(entry: AspectMappingEntry, item: RegistryItem): string[] | null {
  if (entry.source === "column") {
    const v = entry.column
      ? (item as unknown as Record<string, unknown>)[entry.column]
      : undefined;
    const s = typeof v === "string" ? v.trim() : "";
    return s ? [s] : null;
  }
  // source === "attribute"
  const attrs = item.attributes ?? {};
  const raw = entry.attribute ? attrs[entry.attribute] : undefined;
  if (entry.multi) {
    const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const cleaned = arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
    if (cleaned.length > 0) return cleaned;
  } else {
    const s = Array.isArray(raw) ? raw[0] : raw;
    const t = typeof s === "string" ? s.trim() : "";
    if (t) return [t];
  }
  // Fallbacks (single-valued only).
  if (entry.infer === "department") {
    const d = inferDepartment(item);
    if (d) return [d];
  }
  if (entry.clothingDefault && item.item_category === "clothing") {
    return [entry.clothingDefault];
  }
  return null;
}

// Fill a single aspect from candidate value(s), honoring its constraint:
// SELECTION_ONLY only accepts a value that resolves (via normalizeAspectValue —
// exact, plural, curated synonyms, conservative token fallback) to one of its
// allowed values; FREE_TEXT/SUGGESTED take the raw value(s). Multiple values are
// sent only when BOTH the canonical field is multi AND the aspect is MULTI.
function fillAspect(aspect: RegistryAspect, values: string[], entryMulti: boolean): string[] {
  const allowMulti = entryMulti && aspect.multi === true;
  if ((aspect.mode ?? "") === "SELECTION_ONLY") {
    const matched: string[] = [];
    for (const v of values) {
      const hit = normalizeAspectValue(v, {
        name: aspect.name,
        mode: aspect.mode,
        allowedValues: aspect.allowedValues,
      });
      if (hit && !matched.includes(hit)) matched.push(hit);
    }
    if (matched.length === 0) return [];
    return allowMulti ? matched : [matched[0]!];
  }
  return allowMulti ? values : [values[0]!];
}

/**
 * The ONE aspect in this category that a registry entry owns, or null when the
 * category exposes none of its names.
 *
 * An entry lists several names because different leaves name the same field
 * differently — and some leaves expose MORE THAN ONE of them at once. Women's
 * Tops has both "Material" and "Fabric Type" (the material entry) and both
 * "Style" and "Type" (the style entry). Treating every match as backed by the
 * column made those rows unusable: the column overwrote both on each save, so
 * "Type" could not be set to Blouse while "Style" said Sheath, and the second
 * row of each pair looked editable while being incapable of holding an edit.
 *
 * `aspects` in the registry is a PRIORITY list, so the first candidate the
 * category actually has wins and every other name is left alone — free for the
 * seller, the AI, or an inbound sync to fill independently. Byonly ever binding
 * one name, the column stays single-entry without swallowing its neighbours.
 */
export function ownedAspectName(
  entry: { source: string; column?: string; attribute?: string; aspects: string[]; byCategory?: Record<string, string[]> },
  category: string | null,
  aspects: RegistryAspect[],
): string | null {
  const byLower = new Map<string, string>();
  for (const aspect of aspects) {
    const name = (aspect.name ?? "").trim();
    const l = name.toLowerCase();
    if (name && !byLower.has(l)) byLower.set(l, name);
  }
  for (const cand of effectiveCandidates(
    entry as Parameters<typeof effectiveCandidates>[0],
    category,
  )) {
    const hit = byLower.get(cand);
    if (hit) return hit;
  }
  return null;
}

/**
 * Map an item's canonical fields onto a category's aspects via the registry.
 * Returns ONLY aspects not already set in `existing` (user-set values win, per
 * AC4). The single resolve function the edge consumes directly and the web
 * mirrors (driven by the same vendored registry data).
 *
 * Iterates ENTRIES (not the spec) so each canonical field fills exactly the one
 * aspect it owns — see ownedAspectName. Filling every matching name is what let
 * a cleared "Type" come straight back from the style column on the next revise.
 */
export function resolveItemAspects(
  item: RegistryItem,
  aspects: RegistryAspect[],
  existing: Record<string, string[]>,
): Record<string, string[]> {
  const category = item.item_category ?? null;
  const byName = new Map<string, RegistryAspect>();
  for (const aspect of aspects) {
    const name = (aspect.name ?? "").trim();
    if (name && !byName.has(name)) byName.set(name, aspect);
  }
  const out: Record<string, string[]> = {};
  for (const entry of ASPECT_REGISTRY.entries) {
    const name = ownedAspectName(entry, category, aspects);
    if (!name) continue;
    if ((existing[name]?.length ?? 0) > 0) continue; // never overwrite user-set
    if (out[name]) continue;
    const aspect = byName.get(name);
    if (!aspect) continue;
    const values = canonicalValues(entry, item);
    if (!values || values.length === 0) continue;
    const filled = fillAspect(aspect, values, entry.multi);
    if (filled.length > 0) out[name] = filled;
  }
  return out;
}

/**
 * The structured COLUMNS (brand, size, color, material, style) are the source of
 * truth for their eBay aspects. Unlike resolveItemAspects (which fills gaps and
 * NEVER overwrites), this projects the CURRENT column values onto a category's
 * aspects authoritatively:
 *  - `set`   — aspect name → value derived from the column (overwrite any prior).
 *  - `clear` — aspect names whose backing column is now empty (drop the stale
 *              value so an edit that BLANKS a field also clears it on eBay).
 *
 * Only `source: "column"` entries participate. US-821 attribute-derived aspects,
 * AI-filled, and manually-typed aspects are never touched here — those keep
 * their own provenance and are reconciled elsewhere. A column whose value can't
 * be matched to a SELECTION_ONLY aspect's allowed list is left ALONE (neither
 * set nor cleared) so we don't wipe a previously-valid value on a normalization
 * miss; the publish-time value validator handles that case.
 */
export function columnAspectProjection(
  item: RegistryItem,
  aspects: RegistryAspect[],
): { set: Record<string, string[]>; clear: string[] } {
  const category = item.item_category ?? null;
  const byName = new Map<string, RegistryAspect>();
  for (const aspect of aspects) {
    const name = (aspect.name ?? "").trim();
    if (name && !byName.has(name)) byName.set(name, aspect);
  }
  const set: Record<string, string[]> = {};
  const clear: string[] = [];
  // One aspect per column — see ownedAspectName. Forcing the column onto every
  // name it could match is what pinned "Fabric Type" to "Material" and "Type"
  // to "Style" on this seller's Women's Tops listing.
  for (const entry of ASPECT_REGISTRY.entries) {
    if (entry.source !== "column") continue;
    const name = ownedAspectName(entry, category, aspects);
    if (!name || set[name]) continue;
    const aspect = byName.get(name);
    if (!aspect) continue;
    const values = canonicalValues(entry, item);
    if (!values || values.length === 0) {
      clear.push(name); // column blanked → drop the stale aspect
      continue;
    }
    const filled = fillAspect(aspect, values, entry.multi);
    if (filled.length > 0) set[name] = filled;
    // else: SELECTION_ONLY normalization miss — leave the existing value as-is.
  }
  return { set, clear };
}

/**
 * Apply the column projection onto an existing aspect map: column-sourced
 * aspects are forced to the current column values, every other aspect is
 * preserved. Returns a NEW map (input untouched).
 *
 * By default this is OVERWRITE-ONLY: it never removes an aspect just because its
 * backing column is empty, because at publish/revise time we can't tell "the
 * user blanked this field" from "this column was never populated but the aspect
 * was AI- or manually-filled" — clearing the latter would silently destroy good
 * data. Pass `{ clearEmpty: true }` only where the caller KNOWS a blank column
 * means the seller intentionally removed the value.
 */
export function applyColumnAspects(
  existing: Record<string, string[]>,
  item: RegistryItem,
  aspects: RegistryAspect[],
  opts?: { clearEmpty?: boolean },
): Record<string, string[]> {
  const { set, clear } = columnAspectProjection(item, aspects);
  const out: Record<string, string[]> = { ...existing, ...set };
  if (opts?.clearEmpty) {
    for (const name of clear) delete out[name];
  }
  return out;
}

/**
 * The aspect names in THIS category that are backed by a main-page item column
 * (Brand / Size / Color / Material / Style), whatever the item's values are.
 *
 * Used by the clients to avoid rendering the SAME field twice on a single
 * listing page: the item's own Brand input and an "eBay specifics → Brand" row
 * are one value with one write-authority (the column), and showing both is the
 * "why am I typing this in two places" confusion. Purely structural — no item
 * needed — so a client can ask for it as soon as it knows the category.
 *
 * Every VERTICAL is considered, including the per-vertical extras (shoes → "US
 * Shoe Size"), because the caller may not know the item's item_category. But
 * only the ONE name each column owns in this category is returned — the same
 * name columnAspectProjection writes (see ownedAspectName). Returning every
 * candidate told clients to hide "Type" and "Fabric Type" as column-backed when
 * the column actually writes "Style" and "Material"; those rows are ordinary
 * editable specifics and hiding them removed the only way to set them.
 */
export function columnBackedAspectNames(aspects: RegistryAspect[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of ASPECT_REGISTRY.entries) {
    if (entry.source !== "column" || !entry.column) continue;
    // null category = the entry's own list; then each vertical's extras, since
    // the caller may know the category only as an eBay leaf.
    const verticals = [null, ...Object.keys(entry.byCategory ?? {})];
    for (const vertical of verticals) {
      const name = ownedAspectName(entry, vertical, aspects);
      if (!name) continue;
      const l = name.toLowerCase();
      if (seen.has(l)) continue;
      seen.add(l);
      out.push(name);
    }
  }
  return out;
}

/** The item columns that own an eBay aspect (the registry's column entries). */
export type ColumnAspectField = "brand" | "size" | "color" | "material" | "style";

/**
 * The same answer as columnBackedAspectNames, KEYED BY COLUMN -- "which aspect
 * does the item's Style input actually drive in this category".
 *
 * The flat name list tells a client what to hide. It cannot tell a client what
 * to RENDER, because it never says which of "Size" and "US Shoe Size" belongs
 * to the size column. A client that wants to put eBay's allowed values behind
 * the item's own Style/Color/Material inputs (US-2839, the iOS item page) needs
 * the pairing, not the set.
 *
 * `category` is the item's vertical (clothing / shoes / headwear ...) when the
 * caller knows it, so the per-vertical name wins -- a shoe item's size column
 * owns "US Shoe Size", not the generic "Size". Pass null and every vertical is
 * considered in registry order, which is what the flat list does.
 */
export function columnBackedAspectMap(
  aspects: RegistryAspect[],
  category: string | null = null,
): Partial<Record<ColumnAspectField, string>> {
  const out: Partial<Record<ColumnAspectField, string>> = {};
  const taken = new Set<string>();
  for (const entry of ASPECT_REGISTRY.entries) {
    if (entry.source !== "column" || !entry.column) continue;
    const column = entry.column as ColumnAspectField;
    // The caller's own vertical first, then the entry's other verticals, so an
    // unknown category still resolves the way the flat list does.
    const verticals = category
      ? [category, null, ...Object.keys(entry.byCategory ?? {})]
      : [null, ...Object.keys(entry.byCategory ?? {})];
    for (const vertical of verticals) {
      const name = ownedAspectName(entry, vertical, aspects);
      if (!name) continue;
      // Two columns must never claim one aspect. "Type" is the style column's
      // fallback name, and letting a second entry take a name already spoken
      // for would give one input two owners. First entry in registry order
      // wins -- the same rule the flat list uses.
      const l = name.toLowerCase();
      if (taken.has(l)) continue;
      taken.add(l);
      out[column] = name;
      break;
    }
  }
  return out;
}

/**
 * REVERSE projection: fold aspect-map edits back into the structured columns,
 * so Brand/Size/Color/Material/Style stay SINGLE-ENTRY. The columns are the
 * write-authority (columnAspectProjection force-overwrites their aspects), so
 * an aspect edit that never reaches its column is silently clobbered on the
 * next publish/revise — this closes that loop. Provenance decides what flows
 * back:
 *  - "manual"       — the seller typed it in a specifics editor. Newest human
 *                     intent: fills an empty column AND overwrites a differing
 *                     one.
 *  - "ai_extracted" — fills an EMPTY column only (same fill-if-blank rule the
 *                     inbound eBay/CSV merges use); never overwrites.
 *  - "inventory_derived" / unknown — never written back (it either came FROM
 *                     the column, or we can't attribute it — writing it back
 *                     could resurrect stale data).
 * Aspect names match case-insensitively against the entry's candidates (per-
 * category extras first, e.g. shoes "US Shoe Size" → size). Absent/blank
 * aspects never clear a column — a category spec that simply lacks the aspect
 * is indistinguishable from an intentional clear; blanking stays a main-page
 * action. Returns only the columns that actually change.
 */
export function reverseColumnAspects(
  item: RegistryItem,
  aspects: Record<string, string[]>,
  sources: Record<string, string | undefined> | null | undefined,
  // The category spec, when the caller has it. With it, each column reads back
  // from the ONE aspect it owns (ownedAspectName) — the same name the forward
  // projection writes. Without it we fall back to scanning the entry's
  // candidates, which is all a spec-less caller can do.
  spec?: RegistryAspect[] | null,
): Partial<Record<ColumnAspectField, string>> {
  const src = sources ?? {};
  const byLower = new Map<string, string>();
  for (const key of Object.keys(aspects)) {
    const l = key.trim().toLowerCase();
    if (l && !byLower.has(l)) byLower.set(l, key);
  }
  const patch: Partial<Record<ColumnAspectField, string>> = {};
  for (const entry of ASPECT_REGISTRY.entries) {
    if (entry.source !== "column" || !entry.column) continue;
    let matchedKey: string | undefined;
    if (spec && spec.length > 0) {
      const owned = ownedAspectName(entry, item.item_category ?? null, spec);
      const key = owned ? byLower.get(owned.toLowerCase()) : undefined;
      if (key && (aspects[key]?.length ?? 0) > 0) matchedKey = key;
    } else {
      // Spec-less fallback: prefer the aspect the SELLER touched over whichever
      // candidate happens to come first, so an edit to a secondary name isn't
      // discarded because a stale primary still holds a derived value.
      let matchedRank = 3;
      for (const cand of effectiveCandidates(entry, item.item_category ?? null)) {
        const key = byLower.get(cand);
        if (!key || (aspects[key]?.length ?? 0) === 0) continue;
        const p = src[key];
        const rank = p === "manual" ? 0 : p === "ai_extracted" ? 1 : 2;
        if (rank < matchedRank) {
          matchedKey = key;
          matchedRank = rank;
        }
        if (rank === 0) break;
      }
    }
    if (!matchedKey) continue;
    const value = (aspects[matchedKey]![0] ?? "").trim();
    if (!value) continue;
    const provenance = src[matchedKey];
    const raw = (item as unknown as Record<string, unknown>)[entry.column];
    const current = typeof raw === "string" ? raw.trim() : "";
    if (current === "") {
      if (provenance === "manual" || provenance === "ai_extracted") {
        patch[entry.column as ColumnAspectField] = value;
      }
    } else if (provenance === "manual" && value !== current) {
      patch[entry.column as ColumnAspectField] = value;
    }
  }
  return patch;
}

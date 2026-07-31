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
// (brand, size, color, material, style) AND every US-821 canonical attribute
// (department, size_type, sleeve_length, neckline, pattern, fit, closure,
// features, garment_care, country_of_manufacture, vintage, theme, mpn).

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
  version: 1,
  entries: [
    // ── Legacy structured columns ──
    { key: "brand", source: "column", column: "brand", multi: false, aspects: ["Brand"] },
    {
      key: "size",
      source: "column",
      column: "size",
      multi: false,
      aspects: ["Size"],
      byCategory: { shoes: ["US Shoe Size", "Shoe Size"] },
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
 * Map an item's canonical fields onto a category's aspects via the registry.
 * Returns ONLY aspects not already set in `existing` (user-set values win, per
 * AC4). The single resolve function the edge consumes directly and the web
 * mirrors (driven by the same vendored registry data).
 */
export function resolveItemAspects(
  item: RegistryItem,
  aspects: RegistryAspect[],
  existing: Record<string, string[]>,
): Record<string, string[]> {
  const category = item.item_category ?? null;
  const out: Record<string, string[]> = {};
  for (const aspect of aspects) {
    const name = (aspect.name ?? "").trim();
    if (!name) continue;
    if ((existing[name]?.length ?? 0) > 0) continue; // never overwrite user-set
    if (out[name]) continue;
    const lname = name.toLowerCase();
    const entry = ASPECT_REGISTRY.entries.find((e) =>
      effectiveCandidates(e, category).includes(lname),
    );
    if (!entry) continue;
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
  const set: Record<string, string[]> = {};
  const clear: string[] = [];
  for (const aspect of aspects) {
    const name = (aspect.name ?? "").trim();
    if (!name || set[name]) continue;
    const lname = name.toLowerCase();
    const entry = ASPECT_REGISTRY.entries.find(
      (e) =>
        e.source === "column" &&
        effectiveCandidates(e, category).includes(lname),
    );
    if (!entry) continue;
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
 * Every candidate is considered, INCLUDING the per-vertical extras (shoes →
 * "US Shoe Size"). Over-matching is the safe direction here: if a category
 * really exposes "US Shoe Size" then the Size column does own it, whatever the
 * item's item_category happens to say.
 */
export function columnBackedAspectNames(aspects: RegistryAspect[]): string[] {
  const candidates = new Set<string>();
  for (const entry of ASPECT_REGISTRY.entries) {
    if (entry.source !== "column" || !entry.column) continue;
    for (const name of entry.aspects) candidates.add(name.toLowerCase());
    for (const extras of Object.values(entry.byCategory ?? {})) {
      for (const name of extras) candidates.add(name.toLowerCase());
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const aspect of aspects) {
    const name = (aspect.name ?? "").trim();
    const l = name.toLowerCase();
    if (!name || seen.has(l) || !candidates.has(l)) continue;
    seen.add(l);
    out.push(name);
  }
  return out;
}

/** The item columns that own an eBay aspect (the registry's column entries). */
export type ColumnAspectField = "brand" | "size" | "color" | "material" | "style";

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
    for (const cand of effectiveCandidates(entry, item.item_category ?? null)) {
      const key = byLower.get(cand);
      if (key && (aspects[key]?.length ?? 0) > 0) {
        matchedKey = key;
        break;
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

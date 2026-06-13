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
// SELECTION_ONLY only accepts values matching an allowed value (case- and
// trailing-plural-insensitive, matching the legacy behavior); FREE_TEXT/
// SUGGESTED take the raw value(s). Multiple values are sent only when BOTH the
// canonical field is multi AND the aspect is MULTI-cardinality.
function fillAspect(aspect: RegistryAspect, values: string[], entryMulti: boolean): string[] {
  const allowMulti = entryMulti && aspect.multi === true;
  if ((aspect.mode ?? "") === "SELECTION_ONLY") {
    const allowed = (aspect.allowedValues ?? []).filter((v) => v.length > 0);
    const norm = (s: string) => s.toLowerCase().trim().replace(/s$/, "");
    const matched: string[] = [];
    for (const v of values) {
      const cand = norm(v);
      const hit = allowed.find((a) => norm(a) === cand);
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

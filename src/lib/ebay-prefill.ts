// Client-side prefill of a category's eBay aspects from an item's structured
// data — so the composer SHOWS the values the server would fill at publish
// instead of empty dropdowns for data the user already entered.
//
// US-822: the field→aspect MAPPING is no longer hand-duplicated here. It comes
// from the single-source registry vendored as ebay-aspect-registry.json
// (generated from services/edge-functions/src/lib/aspect-registry.ts via
// `npm run sync:aspects`; a CI drift guard fails if this copy diverges). This
// module only holds the thin resolve LOGIC mirrored from the edge resolver,
// driven entirely by that shared data.

import type { EbayAspect } from "@/hooks/use-ebay";
import registry from "@/lib/ebay-aspect-registry.json";
import { normalizeAspectValue } from "@/lib/aspect-normalize";
import { type Measurements, resolveMeasurementAspects } from "@/lib/measurements";

/** A value the composer rewrote to match eBay's allowed list ("M" → "Medium"). */
export interface AspectRewrite {
  from: string;
  to: string;
}

interface AspectMappingEntry {
  key: string;
  source: "column" | "attribute";
  column?: string;
  attribute?: string;
  multi: boolean;
  aspects: string[];
  byCategory?: Record<string, string[]>;
  infer?: "department";
  clothingDefault?: string;
}
const ASPECT_REGISTRY = registry as {
  version: number;
  entries: AspectMappingEntry[];
};

// The structured item data aspect prefill can draw from.
export interface ItemAspectSource {
  title: string | null;
  brand: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  style: string | null;
  description: string | null;
  condition_notes: string | null;
  item_category: string | null;
  // US-821 canonical attributes (inventory_items.attributes jsonb).
  attributes?: Record<string, string | string[]> | null;
  // US-1450: captured garment measurements (stored in inches), folded into the
  // category's free-text measurement aspects fill-only — parity with the
  // AutoLister AI path (US-827) so hand-composed listings don't drop them.
  measurements?: Measurements | null;
}

// Department (Men/Women/Boys/…) inferred from free-text fields — mirrors the
// registry's inferDepartment. Order matters: most specific first; \b avoids
// "men" matching inside "women".
export function inferDepartment(item: ItemAspectSource): string | null {
  const text = [
    item.title,
    item.style,
    item.description,
    item.condition_notes,
    item.size,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
  if (!text) return null;
  const has = (re: RegExp) => re.test(text);
  if (has(/\bmaternity\b/)) return "Maternity";
  if (has(/\b(baby|infant|newborn|toddler|onesie)\b/)) return "Baby";
  if (has(/\bboys?\b/)) return "Boys";
  if (has(/\bgirls?\b/)) return "Girls";
  if (has(/\b(kids?|youth|juniors?|children'?s?|child)\b/)) return "Unisex Kids";
  if (has(/\bunisex\b/)) return "Unisex Adult";
  if (
    has(/\b(women'?s?|womens|woman'?s?|womenswear|ladies'?|lady'?s?|female|misses)\b/)
  ) {
    return "Women";
  }
  if (has(/\b(men'?s?|mens|man'?s?|menswear|male)\b/)) return "Men";
  return null;
}

// Effective (lowercased) aspect-name candidates for an entry in a vertical.
function effectiveCandidates(
  entry: AspectMappingEntry,
  category: string | null,
): string[] {
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
function canonicalValues(
  entry: AspectMappingEntry,
  item: ItemAspectSource,
): string[] | null {
  if (entry.source === "column") {
    const v = entry.column
      ? (item as unknown as Record<string, unknown>)[entry.column]
      : undefined;
    const s = typeof v === "string" ? v.trim() : "";
    return s ? [s] : null;
  }
  const attrs = item.attributes ?? {};
  const raw = entry.attribute ? attrs[entry.attribute] : undefined;
  if (entry.multi) {
    const arr = Array.isArray(raw)
      ? raw
      : typeof raw === "string"
        ? [raw]
        : [];
    const cleaned = arr.map((x) => String(x).trim()).filter((x) => x.length > 0);
    if (cleaned.length > 0) return cleaned;
  } else {
    const s = Array.isArray(raw) ? raw[0] : raw;
    const t = typeof s === "string" ? s.trim() : "";
    if (t) return [t];
  }
  if (entry.infer === "department") {
    const d = inferDepartment(item);
    if (d) return [d];
  }
  if (entry.clothingDefault && item.item_category === "clothing") {
    return [entry.clothingDefault];
  }
  return null;
}

// Fill a single aspect from candidate value(s), honoring its constraint.
// SELECTION_ONLY values resolve through normalizeAspectValue (US-823) — exact,
// plural, curated synonyms, conservative token fallback — and we report any
// substantive rewrite (more than a casing change) so the composer can show it.
function fillAspect(
  aspect: EbayAspect,
  values: string[],
  entryMulti: boolean,
): { values: string[]; rewrites: AspectRewrite[] } {
  const allowMulti =
    entryMulti &&
    aspect.aspectConstraint?.itemToAspectCardinality === "MULTI";
  if (aspect.aspectConstraint?.aspectMode === "SELECTION_ONLY") {
    const allowed = (aspect.aspectValues ?? [])
      .map((v) => v.localizedValue ?? "")
      .filter((v) => v.length > 0);
    const matched: string[] = [];
    const rewrites: AspectRewrite[] = [];
    for (const v of values) {
      const hit = normalizeAspectValue(v, {
        name: aspect.localizedAspectName,
        mode: "SELECTION_ONLY",
        allowedValues: allowed,
      });
      if (hit && !matched.includes(hit)) {
        matched.push(hit);
        if (hit.trim().toLowerCase() !== v.trim().toLowerCase()) {
          rewrites.push({ from: v, to: hit });
        }
      }
    }
    if (matched.length === 0) return { values: [], rewrites: [] };
    const out = allowMulti ? matched : [matched[0]!];
    return { values: out, rewrites: rewrites.filter((r) => out.includes(r.to)) };
  }
  return { values: allowMulti ? values : [values[0]!], rewrites: [] };
}

// Map structured item data onto a category's aspects via the shared registry.
// Returns only aspects NOT already set in `existing` (user-set values win).
// When `rewritesOut` is supplied, it is populated with the (first) value rewrite
// per aspect so the composer can surface "M → will be sent as Medium".
export function deriveAspectsFromItem(
  item: ItemAspectSource,
  aspectList: EbayAspect[],
  existing: Record<string, string[]>,
  rewritesOut?: Record<string, AspectRewrite>,
): Record<string, string[]> {
  const category = item.item_category ?? null;
  const out: Record<string, string[]> = {};
  for (const aspect of aspectList) {
    const name = (aspect.localizedAspectName ?? "").trim();
    if (!name) continue;
    if ((existing[name]?.length ?? 0) > 0) continue;
    if (out[name]) continue;
    const lname = name.toLowerCase();
    const entry = ASPECT_REGISTRY.entries.find((e) =>
      effectiveCandidates(e, category).includes(lname),
    );
    if (!entry) continue;
    const values = canonicalValues(entry, item);
    if (!values || values.length === 0) continue;
    const filled = fillAspect(aspect, values, entry.multi);
    if (filled.values.length > 0) {
      out[name] = filled.values;
      if (rewritesOut && filled.rewrites[0]) {
        rewritesOut[name] = filled.rewrites[0];
      }
    }
  }
  return out;
}

// US-824: classify how a draft's already-set aspect values carry into a NEWLY
// selected category's spec — purely deterministic, NO AI/network call. This is
// the remap that makes a category change non-destructive:
//   • kept    — values whose aspect name still exists in the new spec (carried
//               as-is; cross-category universals like Brand/Color/Material land
//               here whenever they're valid in the new category)
//   • derived — aspects newly filled from the item's columns + US-821 canonical
//               attributes (remapped through the registry + US-823 normalization)
//   • dropped — previously-set values that don't apply to the new category; the
//               composer surfaces these in a confirm-before-discard summary so
//               nothing is silently lost
// `kept` is passed as `existing` to deriveAspectsFromItem so a kept value is
// never overwritten by a derived one (user-set values win).
export interface AspectRemapResult {
  kept: Record<string, string[]>;
  derived: Record<string, string[]>;
  dropped: Record<string, string[]>;
  /** SELECTION_ONLY value rewrites for the derived aspects ("M" → "Medium"). */
  rewrites: Record<string, AspectRewrite>;
}

export function remapAspectsForCategory(
  prev: Record<string, string[]>,
  aspectList: EbayAspect[],
  item: ItemAspectSource | null,
): AspectRemapResult {
  const valid = new Set(
    aspectList
      .map((a) => (a.localizedAspectName ?? "").trim())
      .filter((n) => n.length > 0),
  );
  const kept: Record<string, string[]> = {};
  const dropped: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(prev)) {
    if (!values || values.length === 0) continue;
    if (valid.has(name)) kept[name] = values;
    else dropped[name] = values;
  }
  const rewrites: Record<string, AspectRewrite> = {};
  const derived = item
    ? deriveAspectsFromItem(item, aspectList, kept, rewrites)
    : {};

  // US-1450: fold captured measurements into the category's free-text
  // measurement aspects (Inseam, Chest Size, Sleeve Length, …) — fill-only, never
  // clobbering a kept or already-derived value. Mirrors the AutoLister AI path
  // (US-827): stored values are inches, and resolveMeasurementAspects only fills
  // aspects the category exposes as free-text and that aren't already set.
  if (item?.measurements) {
    const categoryAspects: Record<string, string[]> = {};
    for (const a of aspectList) {
      const name = (a.localizedAspectName ?? "").trim();
      if (!name) continue;
      categoryAspects[name] =
        a.aspectConstraint?.aspectMode === "SELECTION_ONLY"
          ? (a.aspectValues ?? [])
              .map((v) => v.localizedValue ?? "")
              .filter((v) => v.length > 0)
          : [];
    }
    const existing = { ...kept, ...derived };
    const measured = resolveMeasurementAspects(
      item.measurements,
      categoryAspects,
      existing,
    );
    for (const [name, values] of Object.entries(measured)) {
      derived[name] = values;
    }
  }

  return { kept, derived, dropped, rewrites };
}

// Grade → eBay condition mapping — mirrors the server's mapEbayCondition,
// which is what publish falls back to when no condition was chosen. Surfacing
// it in the composer makes the eventual publish value visible and editable.
export function mapEbayCondition(
  grade: number | null,
  label: string | null,
): string {
  const isNwt = (label ?? "").toUpperCase().includes("NWT");
  if (grade != null) {
    if (grade >= 9.75 || isNwt) return "NEW";
    if (grade >= 9.0) return "LIKE_NEW";
    if (grade >= 7.5) return "USED_EXCELLENT";
    if (grade >= 6.0) return "USED_VERY_GOOD";
    if (grade >= 4.5) return "USED_GOOD";
    return "USED_ACCEPTABLE";
  }
  return isNwt ? "NEW" : "USED_EXCELLENT";
}

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
import type { AspectSourceMap } from "@/lib/aspect-provenance";
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

// British→American spelling folds so an aspect NAME matches across spellings
// ("Main Colour" ↔ "Main Color"). Aspect VALUES are folded separately by
// normalizeAspectValue (US-823); this is names only.
const NAME_SPELLING: Array<[RegExp, string]> = [
  [/colour/g, "color"],
  [/greying|grey/g, "gray"],
  [/jewellery/g, "jewelry"],
  [/fibre/g, "fiber"],
];

// Normalize an eBay aspect NAME for equivalence matching: lowercase, fold
// British spellings, strip all non-alphanumerics ("Sleeve Length" → "sleevelength").
function normalizeAspectName(name: string): string {
  let s = name.trim().toLowerCase();
  for (const [re, to] of NAME_SPELLING) s = s.replace(re, to);
  return s.replace(/[^a-z0-9]/g, "");
}

// Curated groups of aspect NAMES that denote the same concept across categories
// (already name-normalized). Re-homing a value between members is ALWAYS gated
// by fillAspect (SELECTION_ONLY validation), so a value the target category
// can't accept is parked/dropped rather than mis-filed — this only rescues
// values that genuinely fit. Conservative on purpose (no semantic guesses).
const ASPECT_NAME_SYNONYMS: string[][] = [
  ["color", "maincolor", "primarycolor", "colorfamily", "mancolor"],
  ["material", "fabrictype", "fabric", "outermaterial", "outershellmaterial"],
  ["size", "clothingsize", "apparelsize"],
];

function synonymGroupFor(norm: string): string[] | null {
  return ASPECT_NAME_SYNONYMS.find((g) => g.includes(norm)) ?? null;
}

// US-824+: find an aspect in the NEW category's spec equivalent to a
// would-be-dropped `sourceName`, so its value can carry instead of vanish.
// Exact name-normalized match wins (pure spelling/format difference); a curated
// synonym-group match is the fallback. Skips aspects already filled (`taken`).
function findEquivalentAspect(
  sourceName: string,
  aspectList: EbayAspect[],
  taken: Set<string>,
): EbayAspect | null {
  const srcNorm = normalizeAspectName(sourceName);
  const group = synonymGroupFor(srcNorm);
  let synonymHit: EbayAspect | null = null;
  for (const a of aspectList) {
    const an = (a.localizedAspectName ?? "").trim();
    if (!an) continue;
    const norm = normalizeAspectName(an);
    if (taken.has(norm)) continue;
    if (norm === srcNorm) return a; // exact-normalized: pure format diff, best
    if (!synonymHit && group && group.includes(norm)) synonymHit = a;
  }
  return synonymHit;
}

// US-824: classify how a draft's already-set aspect values carry into a NEWLY
// selected category's spec — purely deterministic, NO AI/network call. This is
// the remap that makes a category change non-destructive:
//   • kept     — values whose aspect name still exists verbatim in the new spec
//                (cross-category universals like Brand/Color/Material land here)
//   • remapped — values whose aspect had a DIFFERENT name in the new category
//                (spelling/format or a curated synonym) and still validate into
//                it — carried under the new name so AI/AutoLister-filled specifics
//                survive a category correction instead of dropping. Keyed by the
//                NEW aspect name; `remappedFrom` maps new→old for provenance/UI.
//   • derived  — aspects newly filled from the item's columns + US-821 canonical
//                attributes (remapped through the registry + US-823 normalization)
//   • dropped  — previously-set values that truly don't apply to the new category
//                (no equivalent aspect, or the value doesn't validate); the
//                composer surfaces/parks these so nothing is silently lost
// kept+remapped are passed as `existing` to deriveAspectsFromItem so they're
// never overwritten by a derived gap-fill (user/AI-set values win).
export interface AspectRemapResult {
  kept: Record<string, string[]>;
  remapped: Record<string, string[]>;
  /** New aspect name → the old name its value came from (for provenance/UI). */
  remappedFrom: Record<string, string>;
  derived: Record<string, string[]>;
  dropped: Record<string, string[]>;
  /** SELECTION_ONLY value rewrites for derived/remapped aspects ("M" → "Medium"). */
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
  const wouldDrop: Array<[string, string[]]> = [];
  for (const [name, values] of Object.entries(prev)) {
    if (!values || values.length === 0) continue;
    if (valid.has(name)) kept[name] = values;
    else wouldDrop.push([name, values]);
  }

  // Try to re-home each would-be-dropped value into an equivalent aspect in the
  // new category. fillAspect validates it (SELECTION_ONLY → must match an allowed
  // value), so a value that doesn't fit is left to drop, not mis-filed.
  const rewrites: Record<string, AspectRewrite> = {};
  const remapped: Record<string, string[]> = {};
  const remappedFrom: Record<string, string> = {};
  const dropped: Record<string, string[]> = {};
  const taken = new Set(Object.keys(kept).map(normalizeAspectName));
  for (const [name, values] of wouldDrop) {
    const target = findEquivalentAspect(name, aspectList, taken);
    if (target) {
      const filled = fillAspect(target, values, values.length > 1);
      if (filled.values.length > 0) {
        const tn = (target.localizedAspectName ?? "").trim();
        remapped[tn] = filled.values;
        remappedFrom[tn] = name;
        taken.add(normalizeAspectName(tn));
        if (filled.rewrites[0]) rewrites[tn] = filled.rewrites[0];
        continue;
      }
    }
    dropped[name] = values;
  }

  const derived = item
    ? deriveAspectsFromItem(item, aspectList, { ...kept, ...remapped }, rewrites)
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
    const existing = { ...kept, ...remapped, ...derived };
    const measured = resolveMeasurementAspects(
      item.measurements,
      categoryAspects,
      existing,
    );
    for (const [name, values] of Object.entries(measured)) {
      derived[name] = values;
    }
  }

  return { kept, remapped, remappedFrom, derived, dropped, rewrites };
}

// The structured COLUMNS (brand, size, color, material, style) OWN their eBay
// item specifics. This projects the CURRENT column values authoritatively onto
// an existing aspect map + provenance map — the client mirror of the edge
// forceColumnAspects + the COLUMN_ASPECT_FALLBACK it uses when no category spec
// is loaded (services/edge-functions/src/routes/flipdesk-ebay.ts):
//   • a non-empty column OVERWRITES its aspect (provenance → inventory_derived)
//   • a blanked column CLEARS its aspect (drop the stale value + source)
// Only source:"column" entries participate; every AI-, attribute- and
// manually-typed aspect is left untouched.
//
// Runs on an explicit main-listing save, where a blank field IS an intentional
// clear (unlike the server's overwrite-only publish path, which can't tell a
// blanked field from a never-populated one). This keeps the main listing page
// the single source of truth for these fields, so editing Brand there also
// updates the eBay specifics — no second, duplicate entry in the specifics
// editor. Returns NEW maps (inputs untouched).
export function projectColumnAspects(
  item: Pick<ItemAspectSource, "brand" | "size" | "color" | "material" | "style">,
  existingAspects: Record<string, string[]>,
  existingSources: AspectSourceMap,
): { aspects: Record<string, string[]>; sources: AspectSourceMap } {
  const aspects: Record<string, string[]> = { ...existingAspects };
  const sources: AspectSourceMap = { ...existingSources };
  for (const entry of ASPECT_REGISTRY.entries) {
    if (entry.source !== "column" || !entry.column) continue;
    const name = entry.aspects[0];
    if (!name) continue;
    const raw = (item as unknown as Record<string, unknown>)[entry.column];
    const val = typeof raw === "string" ? raw.trim() : "";
    if (val) {
      aspects[name] = [val];
      sources[name] = "inventory_derived";
    } else {
      delete aspects[name];
      delete sources[name];
    }
  }
  return { aspects, sources };
}

// The item FIELD an aspect name is two-way synced with — a structured column
// (brand/size/color/material/style) or a US-821 canonical attribute key
// (department, pattern, …) — or null for AI-/free-typed aspects. Drives the
// editor's "synced with item field" hint so sellers know one entry feeds both.
export function syncedItemFieldFor(
  aspectName: string,
  category: string | null,
): string | null {
  const lname = aspectName.trim().toLowerCase();
  if (!lname) return null;
  for (const entry of ASPECT_REGISTRY.entries) {
    const field =
      entry.source === "column" ? entry.column : entry.attribute;
    if (!field) continue;
    if (effectiveCandidates(entry, category).includes(lname)) {
      return field;
    }
  }
  return null;
}

// Item-page projection for the US-821 canonical attributes — the attribute
// counterpart of projectColumnAspects. `changed` holds ONLY the attribute keys
// the seller edited this session (new value, or null for an explicit clear);
// untouched attributes never move their aspects, so an AI-/manually-set aspect
// with no backing attribute isn't clobbered by a mere resave. A changed value
// OVERWRITES its aspect (provenance → inventory_derived); a cleared one drops
// it. Returns NEW maps (inputs untouched).
export function projectAttributeAspects(
  changed: Record<string, string | string[] | null>,
  existingAspects: Record<string, string[]>,
  existingSources: AspectSourceMap,
): { aspects: Record<string, string[]>; sources: AspectSourceMap } {
  const aspects: Record<string, string[]> = { ...existingAspects };
  const sources: AspectSourceMap = { ...existingSources };
  for (const [key, raw] of Object.entries(changed)) {
    const entry = ASPECT_REGISTRY.entries.find(
      (e) => e.source === "attribute" && e.attribute === key,
    );
    if (!entry) continue;
    const name = entry.aspects[0];
    if (!name) continue;
    const values = (Array.isArray(raw) ? raw : raw != null ? [raw] : [])
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (values.length > 0) {
      aspects[name] = entry.multi ? values : [values[0]!];
      sources[name] = "inventory_derived";
    } else {
      delete aspects[name];
      delete sources[name];
    }
  }
  return { aspects, sources };
}

// The write-back a specifics-editor save owes the item: column patches +
// changed canonical-attribute keys (caller merges the latter over the item's
// existing `attributes` jsonb before persisting).
export interface AspectWriteBack {
  columns: Partial<
    Record<"brand" | "size" | "color" | "material" | "style", string>
  >;
  attributes: Record<string, string | string[]>;
}

// REVERSE projection — the other half of projectColumnAspects, so shared
// values are SINGLE-ENTRY in both directions. The item's structured fields own
// their eBay specifics (the edge force-projects columns at publish/revise), so
// an aspect edit that never reaches its backing field is clobbered by the stale
// field on the next save/publish. This folds specifics-editor edits back:
//   • provenance "manual"        → the seller typed it: fills an EMPTY backing
//     field and overwrites a DIFFERING one (newest human intent wins; the edge
//     applies the same rule at publish via reverseColumnAspects).
//   • provenance "ai_extracted"  → fill-if-blank only (same rule as the inbound
//     eBay/CSV merges) — AI never overwrites something a human entered.
//   • "inventory_derived"/absent → never written back; it either came FROM the
//     field (possibly normalized, e.g. "M" → "Medium" — writing that back would
//     churn the column) or can't be attributed.
// Covers BOTH registry sources: column entries (brand/size/color/material/
// style) and US-821 attribute entries (Department, Pattern, Fit, …), so a
// manually-picked Department finally persists to attributes.department and
// survives category changes / relists. Absent or blank aspects never clear a
// field — a category spec without the aspect is indistinguishable from an
// intentional clear; blanking stays a main-listing-page action.
export function reverseProjectAspectColumns(
  item: ItemAspectSource,
  aspects: Record<string, string[]>,
  // Loosely typed: DB-loaded provenance maps arrive as Record<string, string>.
  sources: Record<string, string | undefined>,
): AspectWriteBack {
  const byLower = new Map<string, string>();
  for (const key of Object.keys(aspects)) {
    const l = key.trim().toLowerCase();
    if (l && !byLower.has(l)) byLower.set(l, key);
  }
  const columns: AspectWriteBack["columns"] = {};
  const attributes: AspectWriteBack["attributes"] = {};
  const category = item.item_category ?? null;
  for (const entry of ASPECT_REGISTRY.entries) {
    let matchedKey: string | undefined;
    for (const cand of effectiveCandidates(entry, category)) {
      const key = byLower.get(cand);
      if (key && (aspects[key]?.length ?? 0) > 0) {
        matchedKey = key;
        break;
      }
    }
    if (!matchedKey) continue;
    const values = aspects[matchedKey]!
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    if (values.length === 0) continue;
    const provenance = sources[matchedKey];
    if (provenance !== "manual" && provenance !== "ai_extracted") continue;

    if (entry.source === "column" && entry.column) {
      const raw = (item as unknown as Record<string, unknown>)[entry.column];
      const current = typeof raw === "string" ? raw.trim() : "";
      const next = values[0]!;
      if (current === "" || (provenance === "manual" && next !== current)) {
        columns[entry.column as keyof AspectWriteBack["columns"]] = next;
      }
    } else if (entry.source === "attribute" && entry.attribute) {
      const raw = item.attributes?.[entry.attribute];
      const currentArr = (Array.isArray(raw) ? raw : raw != null ? [raw] : [])
        .map((v) => String(v).trim())
        .filter((v) => v.length > 0);
      const next = entry.multi ? values : [values[0]!];
      const differs = next.join(" ") !== currentArr.join(" ");
      const blank = currentArr.length === 0;
      if ((blank || provenance === "manual") && differs) {
        attributes[entry.attribute] = entry.multi ? next : next[0]!;
      }
    }
  }
  return { columns, attributes };
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

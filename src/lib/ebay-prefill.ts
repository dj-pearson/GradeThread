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
import { isClosedAspect, normalizeAspectValue } from "@/lib/aspect-normalize";
import type { AspectSourceMap } from "@/lib/aspect-provenance";
import { type Measurements, resolveMeasurementAspects } from "@/lib/measurements";
import { statedShoeSizeScale } from "@/lib/shoe-size-scale";

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

// The ONE aspect in this category that a registry entry owns, or null when the
// category exposes none of its names. Mirrors the edge's ownedAspectName.
//
// An entry lists several names because leaves name the same field differently —
// and some leaves expose more than one AT ONCE. Women's Tops has "Material" AND
// "Fabric Type" (material entry) and "Type" AND "Style" (style entry). Binding
// the column to every match made the extra rows dead: the column re-asserted
// both on every save, so "Type" could not be set independently of "Style".
// `aspects` is a PRIORITY list, so the first name the category has wins and the
// rest stay free for the seller / AI / an inbound sync to fill.
function ownedAspectName(
  entry: AspectMappingEntry,
  category: string | null,
  aspectList: EbayAspect[],
): string | null {
  const byLower = new Map<string, string>();
  for (const a of aspectList) {
    const name = (a.localizedAspectName ?? "").trim();
    const l = name.toLowerCase();
    if (name && !byLower.has(l)) byLower.set(l, name);
  }
  for (const cand of effectiveCandidates(entry, category)) {
    const hit = byLower.get(cand);
    if (hit) return hit;
  }
  return null;
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
  const allowedForMode = (aspect.aspectValues ?? [])
    .map((v) => v.localizedValue ?? "")
    .filter((v) => v.length > 0);
  // eBay standardized sizes (2026-09): Size / Size Type are closed lists
  // whenever eBay ships values, whatever the cached mode says.
  if (
    isClosedAspect(aspect.localizedAspectName, aspect.aspectConstraint?.aspectMode, allowedForMode.length)
  ) {
    const allowed = allowedForMode;
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
  const byName = new Map<string, EbayAspect>();
  for (const aspect of aspectList) {
    const name = (aspect.localizedAspectName ?? "").trim();
    if (name && !byName.has(name)) byName.set(name, aspect);
  }
  const out: Record<string, string[]> = {};
  // Iterate ENTRIES, so each field fills only the aspect it owns. Filling every
  // matching name is how a cleared "Type" came straight back from the style
  // column on the next remap.
  for (const entry of ASPECT_REGISTRY.entries) {
    const name = ownedAspectName(entry, category, aspectList);
    if (!name) continue;
    if ((existing[name]?.length ?? 0) > 0) continue;
    if (out[name]) continue;
    const aspect = byName.get(name);
    if (!aspect) continue;
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
      "in",
      // US-2796 AC3: a UK/EU/JP number must not land in "US Shoe Size". This
      // matters MORE here than on the edge: the edge only fills BLANK aspects,
      // so whatever this prefills arrives at publish as an existing value and is
      // never corrected. Stated scale only — the brand-chart inference lives on
      // the edge and is deliberately not mirrored (see lib/shoe-size-scale.ts).
      statedShoeSizeScale(
        (item as { attributes?: Record<string, string | string[]> | null })
          .attributes,
      ),
    );
    for (const [name, values] of Object.entries(measured)) {
      derived[name] = values;
    }
  }

  return { kept, remapped, remappedFrom, derived, dropped, rewrites };
}

// US-2381: the forward projection — the structured COLUMNS (brand, size, color,
// material, style) own their eBay item specifics, and this asserts them onto an
// existing aspect map + provenance map. It is the client mirror of the edge's
// `forceColumnAspects` (services/edge-functions/src/routes/flipdesk-ebay.ts),
// which does the same re-assert at publish/revise against the same spec — so a
// draft saved here and the listing eBay eventually receives agree.
//
// It is SPEC-AWARE, and that is the whole design. A spec-LESS version used to
// live here (`projectColumnAspects`, deleted 2026-08-01 with its only caller
// long gone): it wrote each registry entry's FIRST aspect name, which is correct
// only on a surface with no category spec loaded. Every web surface that
// projects now has the spec, and the spec's real names differ per category —
// "Colour", "US Shoe Size", "Fabric Type". Writing the registry's first guess
// there would add a SECOND key beside the picker's row for the same field: a
// duplicate specific, not a sync.
//
// iOS (`InventoryAspectSync.swift`) and Android (`AspectSync.kt`) still carry
// the spec-less shape, because their item forms have no spec loaded. That is a
// UI difference, not drift — see vault/20-domain/sync-source-of-truth.md.
//
// Rules, in the order they matter:
//   • The aspect name comes from the LOADED SPEC via the registry's candidates.
//     No match in this category ⇒ skip entirely. The category does not expose
//     the field, and inventing the name would create a specific the picker
//     cannot show and eBay will not use.
//   • A non-empty column OVERWRITES its aspect (provenance → inventory_derived),
//     validated through fillAspect so a SELECTION_ONLY value is normalized the
//     same way publish would ("M" → "Medium").
//   • A SELECTION_ONLY value that cannot be matched at all LEAVES the existing
//     aspect alone. The column simply is not expressible here; clearing would
//     destroy a good value on the strength of a bad one.
//   • A blank column LEAVES its aspect alone. This projection is OVERWRITE-ONLY,
//     for the same reason the edge's publish-time `applyColumnAspects` is: from
//     a blank column it cannot tell "the seller cleared this field" from "this
//     field was never populated and the specific came from AI, iOS or the
//     seller's own typing", and clearing the second case destroys good data.
//
// WHY OVERWRITE-ONLY, given this used to clear. Clearing looks safe because the
// reverse pass runs first and rescues a typed value into its column — so a blank
// column "must" mean an intentional clear. It only means that when the write-back
// actually LANDED. The composer saves the listing row and the item row as two
// separate statements, so an item write that fails (a duplicate-SKU 409, say)
// leaves the listing holding the value stamped `inventory_derived` while the
// column stays empty. The reverse pass then declines to rescue it (derived values
// are never written back) and this projection deleted it on the next save: the
// specifics editor still showed Brand, the saved map had none, and publish
// blocked on "Fill required eBay specifics: Brand" — a message that contradicted
// the screen. Overwrite-only makes that state stable and recoverable instead.
//
// Blanking a column still clears its specific on the surface that OWNS the
// column: AutoLister bulk edit rebuilds the map with its own set-or-drop pass
// (`saveRow`), where an empty inline field is unambiguously an explicit clear.
// The composer has no column inputs at all, so it can never observe one.
//
// CALLER CONTRACT: run this AFTER reverseProjectAspectColumns and feed it the
// columns as they will be SAVED (item columns overlaid with the write-back). A
// manual "Nike" typed in the specifics editor writes back to the column first;
// projecting from the pre-edit column would overwrite it with the stale value
// and stamp it inventory_derived, so the reverse pass would then refuse to
// rescue it — the seller's edit would vanish on save.
export function projectColumnAspectsForSpec(
  item: Pick<
    ItemAspectSource,
    "brand" | "size" | "color" | "material" | "style" | "item_category"
  >,
  aspectList: EbayAspect[],
  existingAspects: Record<string, string[]>,
  // Loosely typed for the same reason reverseProjectAspectColumns is: a
  // DB-loaded provenance map arrives as Record<string, string>.
  existingSources: Record<string, string | undefined>,
): { aspects: Record<string, string[]>; sources: AspectSourceMap } {
  const aspects: Record<string, string[]> = { ...existingAspects };
  const sources: AspectSourceMap = {
    ...(existingSources as AspectSourceMap),
  };
  const category = item.item_category ?? null;
  for (const entry of ASPECT_REGISTRY.entries) {
    if (entry.source !== "column" || !entry.column) continue;
    // The ONE aspect this column owns here — the registry's priority order, not
    // whatever the spec happens to list first. `aspectList.find` picked by SPEC
    // order, which on Women's Tops bound the style column to "Type" (listed
    // ahead of "Style"): every edit to Type was overwritten by Style's value,
    // and Style itself looked free while being the thing doing the overwriting.
    const name = ownedAspectName(entry, category, aspectList);
    if (!name) continue; // this category has no such specific
    const aspect = aspectList.find(
      (a) => (a.localizedAspectName ?? "").trim() === name,
    );
    if (!aspect) continue;
    const raw = (item as unknown as Record<string, unknown>)[entry.column];
    const val = typeof raw === "string" ? raw.trim() : "";
    if (!val) continue; // blank column — overwrite-only, see the header
    const filled = fillAspect(aspect, [val], false);
    if (filled.values.length === 0) continue; // not expressible — keep what's there
    aspects[name] = filled.values;
    sources[name] = "inventory_derived";
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

// The write-back a specifics-editor save owes the item: column patches +
// changed canonical-attribute keys (caller merges the latter over the item's
// existing `attributes` jsonb before persisting).
// `null` = an explicit CLEAR (the seller emptied a specific that was filled).
// The caller writes null to the column and DELETES the attribute key.
export interface AspectWriteBack {
  columns: Partial<
    Record<"brand" | "size" | "color" | "material" | "style", string | null>
  >;
  attributes: Record<string, string | string[] | null>;
}

// REVERSE projection — the other half of projectColumnAspectsForSpec, so shared
// values are SINGLE-ENTRY in both directions. Run this FIRST: the forward pass
// stamps what it writes `inventory_derived`, and this one only writes back
// `manual`/`ai_extracted`, so the other order silently drops a seller's edit. The item's structured fields own
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
// survives category changes / relists.
//
// CLEARING (only when `baseline` is supplied). Emptying a column-backed specific
// used to be impossible: the reverse pass ignored empty aspects, so the column
// kept its value, and projectColumnAspectsForSpec re-asserted it on the very
// same save. Brand, Size, Color, Material and Type all snapped straight back.
// The reason for ignoring them was real — a category spec that simply lacks the
// aspect is indistinguishable from a seller who cleared it, and clearing the
// first case destroys good data. `baseline` (the last-saved map) is the missing
// evidence: a clear is written back only when the aspect is PRESENT in this
// category's map and HELD a value in the baseline. A category the field doesn't
// exist in never matches, so re-categorising still can't wipe a column.
export function reverseProjectAspectColumns(
  item: ItemAspectSource,
  aspects: Record<string, string[]>,
  // Loosely typed: DB-loaded provenance maps arrive as Record<string, string>.
  sources: Record<string, string | undefined>,
  // The LAST-SAVED aspect map. Supplying it turns "this specific used to have a
  // value and is now empty" into an explicit clear of the backing field; without
  // it the function behaves exactly as before (fills and overwrites only).
  baseline?: Record<string, string[]> | null,
  // The category spec, when the caller has it. With it, each field reads back
  // from the ONE aspect it owns (ownedAspectName) — the same name the forward
  // projection writes — instead of scanning every candidate.
  aspectList?: EbayAspect[] | null,
): AspectWriteBack {
  const byLower = new Map<string, string>();
  for (const key of Object.keys(aspects)) {
    const l = key.trim().toLowerCase();
    if (l && !byLower.has(l)) byLower.set(l, key);
  }
  const baselineByLower = new Map<string, string[]>();
  for (const [key, values] of Object.entries(baseline ?? {})) {
    const l = key.trim().toLowerCase();
    if (l && (values?.length ?? 0) > 0) baselineByLower.set(l, values);
  }
  const columns: AspectWriteBack["columns"] = {};
  const attributes: AspectWriteBack["attributes"] = {};
  const category = item.item_category ?? null;
  for (const entry of ASPECT_REGISTRY.entries) {
    // With a spec, only the owned name counts, so an edit to a free neighbour
    // ("Type" next to "Style") never rewrites someone else's column. Without
    // one, fall back to preferring whichever candidate the SELLER touched — a
    // spec-less caller can't do better, and taking the first candidate that
    // merely HAS a value picked the stale twin and dropped the edit.
    const owned = aspectList?.length
      ? ownedAspectName(entry, category, aspectList)
      : null;
    const candidates = owned
      ? [owned.toLowerCase()]
      : effectiveCandidates(entry, category);
    let matchedKey: string | undefined;
    let matchedRank = 3;
    for (const cand of candidates) {
      const key = byLower.get(cand);
      if (!key || (aspects[key]?.length ?? 0) === 0) continue;
      const p = sources[key];
      const rank = p === "manual" ? 0 : p === "ai_extracted" ? 1 : 2;
      if (rank < matchedRank) {
        matchedKey = key;
        matchedRank = rank;
      }
      if (rank === 0) break;
    }

    // Nothing holds a value. That is an intentional CLEAR only when the field
    // held one in the baseline — otherwise it is the ordinary "this category
    // never exposed the field" case, which must not touch anything.
    if (!matchedKey) {
      if (!baseline) continue;
      // With a spec, `owned` being null already means the category has no such
      // specific, so there is nothing to have cleared.
      if (aspectList?.length && !owned) continue;
      const wasFilled = candidates.some((c) => baselineByLower.has(c));
      const present = candidates.some((c) => byLower.has(c));
      if (!wasFilled || !present) continue;
      if (entry.source === "column" && entry.column) {
        const raw = (item as unknown as Record<string, unknown>)[entry.column];
        if (typeof raw === "string" && raw.trim() !== "") {
          columns[entry.column as keyof AspectWriteBack["columns"]] = null;
        }
      } else if (entry.source === "attribute" && entry.attribute) {
        if (item.attributes?.[entry.attribute] != null) {
          attributes[entry.attribute] = null;
        }
      }
      continue;
    }

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
      const differs = next.join("\u0000") !== currentArr.join("\u0000");
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

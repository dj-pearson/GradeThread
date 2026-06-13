// US-823: aspect VALUE normalization for SELECTION_ONLY eBay aspects.
//
// The registry (US-822) decides WHICH aspect a canonical field maps to. This
// module decides what VALUE to send once we know the aspect is SELECTION_ONLY —
// i.e. eBay will only accept a value from its `allowedValues` list. Before this,
// matching was case-insensitive + a trailing-"s" plural strip only, so a stored
// size "M" never matched the allowed value "Medium", "Poly" never matched
// "Polyester", "Men's" never matched "Men" — the aspect silently fell back to
// manual entry or became a publish blocker.
//
// normalizeAspectValue() adds curated synonym tables (sizes, materials, colors,
// departments, size types) plus a conservative token/affix fallback that ONLY
// fires when exactly one allowed value is an unambiguous candidate. Design rule
// from the PRD: a wrong auto-mapped aspect is worse than an empty one, so when
// no confident match exists we return null (leave it for manual entry) and we
// NEVER touch FREE_TEXT aspects (the original value passes straight through).
//
// This file is MIRRORED verbatim at src/lib/aspect-normalize.ts (the web
// composer copy) so the edge publish path, the web prefill preview, and iOS
// (server-driven) all normalize identically. Keep the two in sync.

/** The minimal, platform-agnostic shape of an aspect spec we normalize against. */
export interface AspectValueSpec {
  /** eBay aspect display name (e.g. "Size", "Department") — drives table choice. */
  name?: string;
  /** "SELECTION_ONLY" | "FREE_TEXT" | "SUGGESTED" — only SELECTION_ONLY is normalized. */
  mode?: string;
  /** eBay's allowed values for a SELECTION_ONLY aspect. */
  allowedValues?: string[];
}

type SynonymKind = "size" | "size_type" | "material" | "color" | "department";

// ─── Curated equivalence groups ────────────────────────────────────
// Each group is a set of interchangeable spellings. Expansion returns every
// member of the group a value belongs to, which is then matched against the
// category's real allowedValues. Conservative by design — only well-established
// equivalences, never semantic guesses (e.g. Beige ≠ Tan, 1X ≠ XL).

const SIZE_GROUPS: string[][] = [
  ["XXS", "XX-Small", "2XS", "Double Extra Small"],
  ["XS", "X-Small", "Extra Small"],
  ["S", "Small"],
  ["M", "Medium", "Med"],
  ["L", "Large"],
  ["XL", "X-Large", "Extra Large"],
  ["XXL", "XX-Large", "2X-Large"],
  ["XXXL", "XXX-Large", "3X-Large"],
  ["One Size", "One Size Fits All", "OS", "OSFA", "One-Size"],
];

const MATERIAL_GROUPS: string[][] = [
  ["Polyester", "Poly"],
  ["Spandex", "Elastane", "Lycra"],
  ["Nylon", "Polyamide"],
  ["Viscose", "Rayon"],
  ["Faux Leather", "Vegan Leather", "Synthetic Leather", "Pleather"],
];

const COLOR_GROUPS: string[][] = [
  ["Gray", "Grey"],
  ["Multicolor", "Multi-Color", "Multicolour", "Multi-Colour"],
  ["Navy", "Navy Blue"],
  ["Off-White", "Off White"],
];

const DEPARTMENT_GROUPS: string[][] = [
  ["Men", "Men's", "Mens", "Man", "Male", "Menswear"],
  ["Women", "Women's", "Womens", "Woman", "Female", "Ladies", "Womenswear"],
  ["Unisex Adult", "Unisex Adults", "Unisex"],
  ["Boys", "Boy", "Boy's"],
  ["Girls", "Girl", "Girl's"],
  ["Unisex Kids", "Unisex Kid", "Unisex Children", "Kids", "Children"],
  ["Baby", "Babies", "Infant", "Newborn"],
];

const SIZE_TYPE_GROUPS: string[][] = [
  ["Regular", "Standard"],
  ["Plus", "Plus Size"],
  ["Petite", "Petites"],
  ["Big & Tall", "Big and Tall", "Big &amp; Tall"],
  ["Juniors", "Junior", "Jr"],
];

const GROUPS_BY_KIND: Record<SynonymKind, string[][]> = {
  size: SIZE_GROUPS,
  size_type: SIZE_TYPE_GROUPS,
  material: MATERIAL_GROUPS,
  color: COLOR_GROUPS,
  department: DEPARTMENT_GROUPS,
};

// Loose key used for synonym-group membership and exact comparison: lowercased,
// punctuation/whitespace stripped. "Men's" → "mens", "X-Large" → "xlarge".
function loose(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Comparison key for the legacy exact + plural-tolerant match: lowercased,
// trimmed, single trailing "s" removed.
function plural(s: string): string {
  return s.toLowerCase().trim().replace(/s$/, "");
}

// Which curated table (if any) applies to an aspect, by its display name.
function aspectKind(name: string | undefined): SynonymKind | null {
  const n = (name ?? "").toLowerCase();
  if (!n) return null;
  if (n.includes("size type")) return "size_type";
  if (n.includes("size")) return "size"; // incl. "US Shoe Size" (no alpha table hits → harmless)
  if (n.includes("material") || n.includes("fabric")) return "material";
  if (n.includes("color") || n.includes("colour")) return "color";
  if (n.includes("department")) return "department";
  return null;
}

// All interchangeable spellings of `value` for `kind`, including the value
// itself. Returns just [value] when it belongs to no curated group.
function expandSynonyms(value: string, kind: SynonymKind): string[] {
  const key = loose(value);
  for (const group of GROUPS_BY_KIND[kind]) {
    if (group.some((m) => loose(m) === key)) {
      return group;
    }
  }
  return [value];
}

/**
 * Resolve a canonical stored value to one of an aspect's allowed values, or
 * null when no confident match exists. FREE_TEXT (and any non-SELECTION_ONLY)
 * aspects pass the original value straight through unchanged.
 *
 * Cascade (first hit wins, all case-insensitive):
 *  1. exact match
 *  2. plural-tolerant match (legacy behavior — "Unisex Adult" ↔ "Unisex Adults")
 *  3. curated synonym expansion ("M" → "Medium", "Poly" → "Polyester", "Men's" → "Men")
 *  4. parenthetical abbreviation ("M" → "M (Medium)", "Medium" → "M (Medium)")
 *  5. single unambiguous whole-word containment ("Crew" → "Crew Neck")
 * Steps 4–5 fire ONLY when exactly one allowed value is a candidate.
 */
export function normalizeAspectValue(
  value: string,
  spec: AspectValueSpec,
): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  // FREE_TEXT / SUGGESTED / anything that isn't a closed list: never normalize.
  if ((spec.mode ?? "") !== "SELECTION_ONLY") return raw;

  const allowed = (spec.allowedValues ?? []).filter((v) => v && v.trim().length > 0);
  if (allowed.length === 0) return null;

  // 1. exact (case-insensitive, trimmed)
  const lc = raw.toLowerCase();
  const exact = allowed.find((a) => a.toLowerCase().trim() === lc);
  if (exact) return exact;

  // 2. plural-tolerant (legacy)
  const pv = plural(raw);
  const pluralHit = allowed.find((a) => plural(a) === pv);
  if (pluralHit) return pluralHit;

  // 3. curated synonyms
  const kind = aspectKind(spec.name);
  if (kind) {
    for (const cand of expandSynonyms(raw, kind)) {
      const clc = cand.toLowerCase().trim();
      const cp = plural(cand);
      const hit = allowed.find((a) => a.toLowerCase().trim() === clc || plural(a) === cp);
      if (hit) return hit;
    }
  }

  // 4. parenthetical abbreviation: "Label (ABBR)" — match either part.
  const parenHits = allowed.filter((a) => {
    const m = a.match(/^(.+?)\s*\(([^)]+)\)$/);
    if (!m) return false;
    const label = m[1]!.toLowerCase().trim();
    const abbr = m[2]!.toLowerCase().trim();
    return label === lc || abbr === lc;
  });
  if (parenHits.length === 1) return parenHits[0]!;

  // 5. whole-word containment, only for a multi-word allowed value and a
  // sufficiently specific (≥3 char) single-token value, and only when exactly
  // one allowed value contains it as a standalone word.
  if (raw.length >= 3 && !/\s/.test(raw)) {
    const wordRe = new RegExp(`\\b${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const wordHits = allowed.filter((a) => /\s/.test(a) && wordRe.test(a));
    if (wordHits.length === 1) return wordHits[0]!;
  }

  return null;
}

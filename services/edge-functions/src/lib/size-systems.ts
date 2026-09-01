// US-2215: size systems and extended size classes as structured data.
//
// THE SHAPE GAP: SizingChart had `department` (Women/Men/Unisex/Kids) and a
// free-text `garment` scope, and nowhere to say WHICH NATIONAL SYSTEM a size
// label is written in. So the corpus encoded it the only way it could — inside
// the size label itself. 115 of 292 charts do this: "UK 10 (US 6)", "IT 48
// (US 38)", "FR 36 (US 4)", "JP L (≈US M)". Every one of those parentheses is a
// workaround for a missing field.
//
// ── THE CONVERSION TABLE IS DERIVED FROM THE CORPUS, NOT FROM MEMORY ───────
//
// The decoder-bar discipline (vault/20-domain/brands/brand-kb-decoder-bar.md)
// applied to sizing: a wrong conversion is worse than none, because it produces
// a confident, plausible, wrong size on a public certificate.
//
// So the four offsets below were EXTRACTED from the charts that state both
// sides, not recalled. Across every "FOREIGN n (US m)" label in the corpus:
//
//     FR | Women   6 data points, one offset (+32), zero contradictions
//     IT | Men     6 data points, one offset (+10), zero contradictions
//     IT | Women   6 data points, one offset (+36), zero contradictions
//     UK | Women   6 data points, one offset (+4),  zero contradictions
//
// A test re-derives these from SIZING_CHARTS and fails if the corpus ever
// contradicts one, so the table cannot rot away from its own evidence.
//
// ── WHAT IS REFUSED, AND WHY THAT IS THE FEATURE ───────────────────────────
//
//   EU  — NO paired data anywhere in the corpus. EU womenswear numbering
//         differs by country (a German 38 and an Italian 38 are not the same
//         garment) and "EU" on a tag does not say which. Refused.
//   JP  — the corpus's only JP mapping is BAPE's, and 00456 records it as
//         BRAND-SPECIFIC: BAPE runs small, so "JP L ≈ US M" is a fact about
//         BAPE, not about Japan. Generalising it would mis-size every other
//         Japanese label. Refused.
//   AU  — no data. Refused.
//   alpha→alpha — S/M/L is not a numbering system; Essentials' "M drapes like
//         US L" is a DESIGN fact (00456), not a conversion. Refused.
//   Men's UK/FR — no paired data; UK men's tailoring often equals US, but
//         "often" is not a rule and the corpus does not vouch for it. Refused.
//
// A refusal returns null. Null means "we do not know", and the caller must show
// the original label rather than a guess.
//
// Pure — no network, no DB, no model.

import type { SizingChart } from "./sizing-charts.ts";

/** The national systems a size label can be written in. */
export type SizeSystem = "US" | "UK" | "EU" | "IT" | "FR" | "JP" | "AU" | "alpha";

export const SIZE_SYSTEMS: readonly SizeSystem[] = [
  "US", "UK", "EU", "IT", "FR", "JP", "AU", "alpha",
];

/**
 * Extended size classes. `standard` is the default and is what almost every
 * seeded chart is; the others exist so extended sizing can be REPRESENTED
 * rather than folded into a standard chart (see `detectSizeClass`).
 */
export type SizeClass =
  | "standard"
  | "plus"
  | "petite"
  | "tall"
  | "big_and_tall"
  | "maternity";

export const SIZE_CLASSES: readonly SizeClass[] = [
  "standard", "plus", "petite", "tall", "big_and_tall", "maternity",
];

// ── Detection ───────────────────────────────────────────────────────────────

// A leading system token on a size label: "UK 10", "IT 48 (US 38)", "JP L".
const LEADING_SYSTEM = /^\s*(UK|EU|IT|FR|JP|AU|DE|US)\b/i;

/**
 * Read the system a chart's labels are WRITTEN IN. This is a READ, not a guess:
 * it returns a system only when the labels say so themselves, and null when
 * they do not. A chart of bare "S/M/L" is `alpha`; a chart of bare numbers is
 * NULL, because a bare "6" could be US or UK and nothing in the row says which.
 *
 * DE is folded to EU: the corpus writes German sizing as a European label, and
 * the distinction only matters for conversion — which EU refuses anyway.
 */
export function detectSizeSystem(chart: SizingChart): SizeSystem | null {
  const systems = new Set<string>();
  let alphaOnly = true;
  for (const row of chart.rows) {
    const m = row.size.match(LEADING_SYSTEM);
    if (m) {
      const tok = m[1].toUpperCase();
      systems.add(tok === "DE" ? "EU" : tok);
      alphaOnly = false;
      continue;
    }
    // A pure alpha label (XS/S/M/L/XL/XXL, with optional punctuation).
    if (!/^\s*X{0,3}[SML](\/[A-Z]+)?\s*$/i.test(row.size)) alphaOnly = false;
  }
  if (systems.size === 1) return [...systems][0] as SizeSystem;
  // Mixed systems across one chart (e.g. some rows UK, some US) is not a
  // single system and must not be reduced to one.
  if (systems.size > 1) return null;
  return alphaOnly && chart.rows.length > 0 ? "alpha" : null;
}

// Extended classes, matched only where the chart SAYS SO in its garment scope.
// Deliberately NOT matched from `note` prose: a note reading "tall inseams run
// 34-36" is a remark about a standard chart, not a tall chart, and treating it
// as one would mislabel dozens of ordinary charts.
const CLASS_PATTERNS: Array<[SizeClass, RegExp]> = [
  ["big_and_tall", /\bbig\s*(?:&|and)\s*tall\b/i],
  ["maternity", /\bmaternity\b/i],
  ["plus", /\bplus\b|\bcurvy\b/i],
  ["petite", /\bpetite\b/i],
  ["tall", /\btall\b/i],
];

/**
 * Read the extended class a chart declares in its garment scope. Returns
 * "standard" when it declares none, and null when the scope names MORE THAN ONE
 * class — the Talbots case, whose scope reads "Misses (US numeric 2-18) /
 * Petite (0P-16P) / Plus (14W-26W)". That single chart is exactly the folding
 * this dimension exists to end, and collapsing it to one class would assert
 * something false about two thirds of its rows.
 */
export function detectSizeClass(chart: SizingChart): SizeClass | null {
  const hits = CLASS_PATTERNS.filter(([, re]) => re.test(chart.garment));
  // big_and_tall also matches /tall/, so a single logical hit can match twice.
  const distinct = new Set(hits.map(([c]) => c));
  if (distinct.has("big_and_tall")) distinct.delete("tall");
  if (distinct.size === 0) return "standard";
  if (distinct.size === 1) return [...distinct][0];
  return null;
}

// ── Conversion ──────────────────────────────────────────────────────────────

export interface SizeConversion {
  system: SizeSystem;
  department: string;
  /** foreign = US + offset. */
  offset: number;
  /** Why we believe it — the corpus rows this was derived from. */
  evidence: string;
}

/**
 * The ONLY conversions we perform. Every entry is corpus-derived (see header);
 * adding one means adding paired data first, not adding a row here.
 */
export const SIZE_CONVERSIONS: readonly SizeConversion[] = [
  { system: "FR", department: "Women", offset: 32, evidence: "Chanel FR 34/36/38 = US 2/4/6" },
  { system: "IT", department: "Men", offset: 10, evidence: "Burberry/Prada IT 46/48/50 = US 36/38/40" },
  { system: "IT", department: "Women", offset: 36, evidence: "Prada IT 38/40/42 = US 2/4/6" },
  { system: "UK", department: "Women", offset: 4, evidence: "Burberry/Sweaty Betty UK 6/8/10 = US 2/4/6" },
];

/**
 * Convert a numeric foreign size to its US equivalent, or null to REFUSE.
 *
 * Refuses when: the system/department pair has no corpus-backed offset, the
 * value is not numeric (alpha sizes are not convertible arithmetic), or the
 * result would be non-positive (which means the offset does not apply to that
 * end of the range and we would be inventing a size).
 */
export function toUsSize(
  system: SizeSystem | null,
  department: string,
  value: number,
): number | null {
  if (!system || system === "US" || system === "alpha") return null;
  if (!Number.isFinite(value)) return null;
  const rule = SIZE_CONVERSIONS.find(
    (c) => c.system === system && c.department === department,
  );
  if (!rule) return null;
  const us = value - rule.offset;
  return us > 0 ? us : null;
}

/** Parse the leading numeric off a label like "IT 48 (US 38)" → 48. */
export function labelNumber(size: string): number | null {
  const m = size.match(/^\s*(?:[A-Z]{2}\s*)?(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * The US equivalent of a chart row, when one can be derived. Returns null for
 * every refused case — the caller shows the original label, never a guess.
 */
export function usEquivalentForRow(
  chart: SizingChart,
  size: string,
  system: SizeSystem | null = detectSizeSystem(chart),
): number | null {
  const n = labelNumber(size);
  if (n === null) return null;
  return toUsSize(system, chart.department, n);
}

// ── Reading half (US-2215) ──────────────────────────────────────────────────
//
// Everything above converts a CHART ROW, whose system is known because the chart
// declares it. The certificate does not have a chart — it has one size STRING
// that a tag pass transcribed ("IT 48") or a measurement pass produced. These
// three functions are what let that string reach a US-reading buyer, and every
// one of them is written to refuse rather than to guess.
//
// Until this, nothing in production imported this module at all: the dimension
// and the conversions shipped and no surface called them. The story's own note
// said seeding charts before wiring the reading half would be "shipped-but-
// unwired with a sourcing bill attached", so this is the reading half.

/** The chart departments a conversion rule can key on. Everything else refuses. */
export function normalizeDepartment(gender: string | null | undefined): string | null {
  const g = (gender ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (g === "women" || g === "womens" || g === "female" || g === "w") return "Women";
  if (g === "men" || g === "mens" || g === "male" || g === "m") return "Men";
  // Unisex, Kids, Baby and anything unrecognised: no corpus-backed offset
  // exists, and inventing one is the failure this whole module is shaped
  // against. `M` is deliberately read as Men here and NOT as a size — this
  // function only ever receives a department, never a size label.
  return null;
}

/**
 * The size system a LABEL announces, or null when it announces none.
 *
 * Only an explicit two-letter prefix counts. A bare "48" is not an IT 48: it is
 * a number whose system nobody recorded, and guessing one would turn an
 * unlabelled size into a confident wrong one. "W30 L32" is refused for the same
 * reason from the other direction — W is a waist measurement in inches, not a
 * place in a national size sequence, and that exact case is why labelNumber's
 * test pins a refusal.
 */
export function systemFromLabel(label: string): SizeSystem | null {
  const m = label.trim().match(/^([A-Z]{2})\s*\d/i);
  if (!m) return null;
  const token = m[1]!.toUpperCase();
  return (SIZE_SYSTEMS as readonly string[]).includes(token) ? (token as SizeSystem) : null;
}

/**
 * The US equivalent of a size LABEL, or null to refuse.
 *
 * Refuses when the label announces no system, when it is already US, when the
 * department has no corpus-backed offset, and — the case worth naming — when the
 * label ALREADY states a US equivalent. The corpus is full of those: US-2215
 * exists partly because 00456 wrote "JP L (approx US M)" inside the size label
 * for want of a structured field. Appending "(US 38)" to a label that already
 * says so is noise, and noise on a certificate is indistinguishable from a bug.
 */
export function usEquivalentForLabel(
  label: string,
  gender: string | null | undefined,
): number | null {
  if (/\bUS\b/i.test(label.replace(/^\s*[A-Z]{2}/i, ""))) return null;
  const system = systemFromLabel(label);
  if (!system) return null;
  const department = normalizeDepartment(gender);
  if (!department) return null;
  const n = labelNumber(label);
  if (n === null) return null;
  return toUsSize(system, department, n);
}

// ── normalizeSizeLabel (US-3033) ────────────────────────────────────────────
//
// The join key for the Fit & Measurement Index. Every observation in one cohort
// has to land on one label, because the cohort is what the sample floor counts.
// If "W34 L32", "34x32" and "34X32" stay three labels, one style in one size
// splits into three cohorts of two garments each, none of them clears the floor,
// and the page that should exist never does. The failure is silent: coverage
// just looks lower than it is.
//
// So this function MERGES aggressively where two labels mean one garment, and
// refuses to merge anywhere they might not. Two cases are worth stating because
// merging them looks tidy and would be wrong:
//
//   A NATIONAL SYSTEM IS NOT A DECORATION. "UK 10" and "10" are different
//   garments. Only a "US" prefix is dropped, because a bare label is US here by
//   convention. Every other system in SIZE_SYSTEMS is kept.
//
//   PETITE AND TALL ARE NOT DECORATIONS EITHER. "10P" is a different cut from
//   "10", with different measurements, which is the entire point of the index.
//   Only "R" (regular, the default) is dropped.
//
// Anything unrecognised is returned cleaned but otherwise verbatim, and so can
// only ever merge with something spelled the same way. An unknown label makes a
// small cohort; a wrongly merged one makes a wrong number.
//
// Pure — no network, no DB, no model.

/** Alpha size words to their letter form, longest first so MEDIUM beats MED. */
const ALPHA_WORDS: readonly (readonly [RegExp, string])[] = [
  [/EXTRA/g, "X"],
  [/XSMALL/g, "XS"],
  [/XLARGE/g, "XL"],
  [/SMALL/g, "S"],
  [/MEDIUM/g, "M"],
  [/MED/g, "M"],
  [/LARGE/g, "L"],
  [/LG/g, "L"],
  [/SM/g, "S"],
];

/**
 * Canonical alpha token, or null when the input is not an alpha size.
 *
 * Collapses the two ways every size past XL is written: XXL and 2XL are one
 * size, and so are XXXL, 3X and 3XL. The numeric form wins because it extends
 * without ambiguity — nobody can count the Xs in XXXXXL reliably, including us.
 */
function canonicalAlpha(token: string): string | null {
  let t = token.replace(/[\s._-]/g, "");
  for (const [pattern, replacement] of ALPHA_WORDS) t = t.replace(pattern, replacement);

  if (t === "S" || t === "M" || t === "L") return t;
  if (t === "XS") return "XS";
  if (t === "XL") return "XL";

  // X-runs: XXS -> 2XS, XXL -> 2XL, XXXL -> 3XL.
  const run = t.match(/^(X{2,})(S|L)$/);
  if (run) return `${run[1]!.length}X${run[2]!}`;

  // Numeric forms: 2X, 2XL, 3XS. A bare "2X" means 2XL, which is the only way
  // that token is ever printed on a garment.
  const numeric = t.match(/^(\d)X(S|L)?$/);
  if (numeric) {
    const n = Number(numeric[1]);
    const end = numeric[2] ?? "L";
    // "1X" and "1XL" are XL written the other way, and there is no "2X"-style
    // spelling below that, so a leading 0 is not a size.
    if (n === 1) return `X${end}`;
    if (n < 2 || n > 9) return null;
    return `${n}X${end}`;
  }

  return null;
}

/**
 * The canonical form of a size label, used as the cohort join key.
 *
 * `group` is accepted because waist-by-inseam only means what it looks like on
 * a bottom, and is deliberately NOT used for anything else: a function whose
 * output depends on the caller's category in ways the caller cannot predict is
 * worse than one that ignores the hint.
 *
 * Returns "" for empty input. Never throws.
 */
export function normalizeSizeLabel(
  raw: string | null | undefined,
  group?: string | null,
): string {
  if (!raw) return "";

  let s = raw.toUpperCase().replace(/\s+/g, " ").trim();
  // A trailing restatement, as the chart corpus writes it: "UK 10 (US 6)".
  s = s.replace(/\s*\([^)]*\)\s*$/, "").trim();
  // Leading/trailing punctuation, but not the separators the forms below need.
  s = s.replace(/^[^A-Z0-9]+/, "").replace(/[^A-Z0-9]+$/, "").trim();
  if (!s) return "";

  s = s.replace(/^SIZE\s*[:#]?\s*/, "").trim();
  if (!s) return "";

  // One size, however it is spelled.
  if (/^(ONE\s?SIZE|OS|OSFA|ONE\s?SIZE\s?FITS\s?ALL|FREE\s?SIZE)$/.test(s)) return "OS";

  // A national system prefix is part of the identity, except US, which is the
  // bare form here. Recurse on the remainder so "UK 10" gets the same cleanup.
  const systemMatch = s.match(/^([A-Z]{2})\s*(.+)$/);
  if (systemMatch) {
    const token = systemMatch[1]!;
    const rest = systemMatch[2]!;
    if (token === "US") return normalizeSizeLabel(rest, group);
    if ((SIZE_SYSTEMS as readonly string[]).includes(token)) {
      const inner = normalizeSizeLabel(rest, group);
      return inner ? `${token} ${inner}` : token;
    }
  }

  // Waist by inseam: "W34 L32", "34x32", "34 X 32", "34/32", "34-32".
  const wxl = s.match(/^W?\s*(\d{1,2})(?:\s*(?:X|\/|-)\s*|\s*L\s*)(\d{1,2})$/);
  if (wxl) return `${wxl[1]}X${wxl[2]}`;

  // Waist only: "W34" is the same garment as "34".
  const waistOnly = s.match(/^W\s*(\d{1,2})$/);
  if (waistOnly) return waistOnly[1]!;

  // Numeric, with a length class that changes the cut. R is the default and is
  // dropped; P (petite) and T (tall) are kept because they are different cuts.
  const numeric = s.match(/^(\d{1,3})(?:\s*(R|P|T|L))?$/);
  if (numeric) {
    const suffix = numeric[2];
    if (!suffix || suffix === "R") return numeric[1]!;
    return `${numeric[1]}${suffix}`;
  }

  const alpha = canonicalAlpha(s);
  if (alpha) return alpha;

  // Unrecognised. Cleaned, never merged, and that is the safe outcome.
  return s;
}

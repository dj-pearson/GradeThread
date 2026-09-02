// US-3044: how often the specifics that used to come back blank are filled.
//
// The 2026-09-02 AutoLister change (tag OCR reading care / country / product
// line, RECOMMENDED aspects named in the refine schema, the evidence rules in
// the refine prompt) was argued from the code. This is the measurement: per
// draft, is each tracked aspect filled, and was it even exposed by the leaf?
//
// EXPOSURE IS INFERRED, NOT LOOKED UP. A stored draft carries its filled
// specifics (item_specifics_override) and, from US-2425, the names of the
// REQUIRED and RECOMMENDED aspects it left empty (aspect_coverage.*.missing).
// So an aspect is known to be exposed when it is filled OR listed as missing.
// An OPTIONAL-tier aspect that was left empty is invisible here - the leaf may
// or may not offer it - which is why every stat carries both denominators:
// `exposed` (the honest rate) and `drafts` (the floor). Reading each leaf's
// spec back from ebay_category_aspects would close that gap; it is not done
// here because the operator report has to run against prod read-only with no
// eBay call, and the two numbers bracket the answer well enough to act on.
//
// Pure. The script (scripts/aspect-fill-report.ts) does the reads.

import type { StoredCoverage } from "../routes/admin-listing-coverage.ts";

/**
 * The aspects the change was meant to move, each with the spellings eBay's
 * leaves use for it (aspect-registry.ts candidates, same order).
 */
export const TRACKED_ASPECTS: ReadonlyArray<
  { label: string; names: string[] }
> = [
  { label: "Theme", names: ["Theme"] },
  { label: "Fabric Type", names: ["Fabric Type", "Fabric"] },
  { label: "Garment Care", names: ["Garment Care", "Care Instructions"] },
  {
    label: "Country of Origin",
    names: [
      "Country of Origin",
      "Country/Region of Origin",
      "Country/Region of Manufacture",
      "Country of Manufacture",
    ],
  },
  {
    label: "MPN / Style Code",
    names: [
      "MPN",
      "Manufacturer Part Number",
      "Style Code",
      "Style Number",
      "Model Number",
    ],
  },
  { label: "Product Line", names: ["Product Line", "Collection", "Series"] },
  { label: "Model", names: ["Model"] },
  { label: "Character", names: ["Character", "Character Family"] },
  { label: "Department", names: ["Department"] },
  { label: "Features", names: ["Features"] },
  { label: "Occasion", names: ["Occasion"] },
];

export interface FillDraftRow {
  platform_category_id: string | null;
  item_specifics_override: Record<string, string[]> | null;
  aspect_coverage: StoredCoverage | null;
}

export interface AspectFillStat {
  aspect: string;
  /** Drafts with a non-empty value under any of the aspect's spellings. */
  filled: number;
  /** Drafts where the aspect is known to exist on the leaf: filled, or reported missing. */
  exposed: number;
  /** Drafts in the set. */
  drafts: number;
}

function loose(name: string): string {
  return name.trim().toLowerCase();
}

function isFilled(
  specifics: Record<string, string[]> | null,
  names: readonly string[],
): boolean {
  if (!specifics) return false;
  const wanted = new Set(names.map(loose));
  for (const [key, values] of Object.entries(specifics)) {
    if (!wanted.has(loose(key))) continue;
    if ((values ?? []).some((v) => typeof v === "string" && v.trim() !== "")) {
      return true;
    }
  }
  return false;
}

function isReportedMissing(
  coverage: StoredCoverage | null,
  names: readonly string[],
): boolean {
  if (!coverage) return false;
  const wanted = new Set(names.map(loose));
  const missing = [
    ...(coverage.required?.missing ?? []),
    ...(coverage.recommended?.missing ?? []),
  ];
  return missing.some((m) => typeof m === "string" && wanted.has(loose(m)));
}

/** Fill / exposure counts for every tracked aspect over a set of drafts. Pure. */
export function aspectFillStats(
  rows: readonly FillDraftRow[],
): AspectFillStat[] {
  return TRACKED_ASPECTS.map(({ label, names }) => {
    let filled = 0;
    let exposed = 0;
    for (const row of rows) {
      const f = isFilled(row.item_specifics_override, names);
      if (f) {
        filled++;
        exposed++;
      } else if (isReportedMissing(row.aspect_coverage, names)) {
        exposed++;
      }
    }
    return { aspect: label, filled, exposed, drafts: rows.length };
  });
}

/** The same stats, one table per category, categories with fewer than `min` drafts folded away. */
export function aspectFillStatsByCategory(
  rows: readonly FillDraftRow[],
  min = 3,
): Array<{ categoryId: string; drafts: number; stats: AspectFillStat[] }> {
  const buckets = new Map<string, FillDraftRow[]>();
  for (const row of rows) {
    const id = row.platform_category_id ?? "(none)";
    const list = buckets.get(id) ?? [];
    list.push(row);
    buckets.set(id, list);
  }
  return [...buckets.entries()]
    .filter(([, list]) => list.length >= min)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([categoryId, list]) => ({
      categoryId,
      drafts: list.length,
      stats: aspectFillStats(list),
    }));
}

function pct(n: number, d: number): string {
  return d === 0 ? "-" : `${Math.round((n / d) * 100)}%`;
}

/** A markdown table the operator can paste into the story note. Pure. */
export function renderFillTable(stats: readonly AspectFillStat[]): string {
  const lines = [
    "| Aspect | Filled | Of exposed | Of all drafts |",
    "|---|---|---|---|",
  ];
  for (const s of stats) {
    lines.push(
      `| ${s.aspect} | ${s.filled}/${s.exposed} | ${
        pct(s.filled, s.exposed)
      } | ${pct(s.filled, s.drafts)} |`,
    );
  }
  return lines.join("\n");
}

/** Which tracked aspect moved least between two sets, by rate of exposed. Pure. */
export function leastMoved(
  before: readonly AspectFillStat[],
  after: readonly AspectFillStat[],
): { aspect: string; before: number; after: number } | null {
  let best:
    | { aspect: string; before: number; after: number; delta: number }
    | null = null;
  for (const b of before) {
    const a = after.find((x) => x.aspect === b.aspect);
    if (!a || b.exposed === 0 || a.exposed === 0) continue;
    const rb = b.filled / b.exposed;
    const ra = a.filled / a.exposed;
    const delta = Math.abs(ra - rb);
    if (!best || delta < best.delta) {
      best = { aspect: b.aspect, before: rb, after: ra, delta };
    }
  }
  return best
    ? { aspect: best.aspect, before: best.before, after: best.after }
    : null;
}

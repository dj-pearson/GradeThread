// US-1088 (knowledge layer): curated garment sizing charts that ground the Size
// AI vision pass. The model reads measurements off the photos; injecting the
// relevant brand/category chart as an authoritative reference makes the
// measurement→size mapping far more reliable than the model's memory alone
// (Lululemon's numeric 0–14 women's sizing is the motivating case).
//
// This is a SEED, designed to grow. To add a brand: append a SizingChart with
// `brandMatch` (lowercased substrings that identify the brand) + size rows.
// Values are approximate body/garment measurements in INCHES and are clearly
// presented to the model as reference, not gospel — it still reasons from the
// actual photos and returns a calibrated confidence.
//
// Pure data + pure helpers (no network) so they're unit-testable.

export interface SizingRow {
  /** The brand's own size label, e.g. "M", "8", "W32 L34". */
  size: string;
  /** Measurement name → value/range string in inches, e.g. waist: "28-29". */
  measurements: Record<string, string>;
}

export interface SizingChart {
  brand: string;
  /** Lowercased substrings; any match (in brand text) selects this chart. */
  brandMatch: string[];
  /** "Women" | "Men" | "Unisex" | "Kids". */
  department: string;
  /** Free-text garment scope, e.g. "Bottoms (leggings/pants)". */
  garment: string;
  /** Category keywords (lowercased) used to pick the right chart for a brand. */
  categoryMatch: string[];
  rows: SizingRow[];
  note?: string;
}

// ── Seed charts ─────────────────────────────────────────────────────────────
// Approximations from widely published size guides; refine as we learn.
export const SIZING_CHARTS: SizingChart[] = [
  {
    brand: "Lululemon",
    brandMatch: ["lululemon", "lulu"],
    department: "Women",
    garment: "Bottoms (leggings / pants)",
    categoryMatch: ["bottom", "legging", "pant", "short", "jogger", "tight"],
    note:
      "Lululemon women's bottoms run numeric 0–14. Waist is the primary signal; " +
      "hip secondary. Align/Wunder-style waistbands lie flat — measure flat and " +
      "double the waistband width.",
    rows: [
      { size: "0", measurements: { waist: "24-24.5", hip: "33-34" } },
      { size: "2", measurements: { waist: "25-25.5", hip: "34-35" } },
      { size: "4", measurements: { waist: "26.5-27", hip: "35.5-36.5" } },
      { size: "6", measurements: { waist: "28-28.5", hip: "37-38" } },
      { size: "8", measurements: { waist: "29.5-30", hip: "38.5-39.5" } },
      { size: "10", measurements: { waist: "31-31.5", hip: "40-41" } },
      { size: "12", measurements: { waist: "32.5-33", hip: "41.5-42.5" } },
      { size: "14", measurements: { waist: "34-34.5", hip: "43-44" } },
    ],
  },
  {
    brand: "Lululemon",
    brandMatch: ["lululemon", "lulu"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "tank", "tee", "shirt", "bra", "hoodie", "jacket", "long sleeve"],
    note: "Lululemon women's tops run numeric 0–14. Bust is the primary signal.",
    rows: [
      { size: "0", measurements: { bust: "30-31" } },
      { size: "2", measurements: { bust: "31.5-32.5" } },
      { size: "4", measurements: { bust: "33-34" } },
      { size: "6", measurements: { bust: "34.5-35.5" } },
      { size: "8", measurements: { bust: "36-37" } },
      { size: "10", measurements: { bust: "38-39" } },
      { size: "12", measurements: { bust: "40-41" } },
      { size: "14", measurements: { bust: "42-43" } },
    ],
  },
  {
    brand: "Generic women's alpha",
    brandMatch: [], // fallback only (selected when no brand chart matches)
    department: "Women",
    garment: "Tops & dresses (alpha)",
    categoryMatch: ["top", "tank", "tee", "shirt", "dress", "blouse", "sweater", "hoodie"],
    note: "Generic US women's alpha sizing — use when no brand-specific chart applies.",
    rows: [
      { size: "XS", measurements: { bust: "31-32", waist: "24-25" } },
      { size: "S", measurements: { bust: "33-35", waist: "26-28" } },
      { size: "M", measurements: { bust: "36-38", waist: "29-31" } },
      { size: "L", measurements: { bust: "39-41", waist: "32-34" } },
      { size: "XL", measurements: { bust: "42-45", waist: "35-38" } },
    ],
  },
  {
    brand: "Generic men's alpha",
    brandMatch: [],
    department: "Men",
    garment: "Tops (alpha)",
    categoryMatch: ["top", "tee", "shirt", "polo", "sweater", "hoodie", "jacket"],
    note: "Generic US men's alpha sizing (chest) — use when no brand-specific chart applies.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "41-43" } },
      { size: "XL", measurements: { chest: "44-46" } },
      { size: "XXL", measurements: { chest: "47-49" } },
    ],
  },
  {
    brand: "Generic men's pants",
    brandMatch: [],
    department: "Men",
    garment: "Pants (waist x inseam)",
    categoryMatch: ["pant", "jean", "chino", "trouser", "short", "bottom"],
    note:
      "Men's pants are labeled W (waist) x L (inseam). Read the flat waistband " +
      "(double it) for W and the inside-leg seam for L. Common inseams: 30/32/34.",
    rows: [
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
    ],
  },
];

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

/**
 * Select the most relevant charts for a brand + category. Prefers brand-specific
 * charts; falls back to generic charts (brandMatch empty) when no brand chart
 * exists. Within the selected group, narrows by category keyword when possible.
 * Pure — unit-testable.
 */
export function findSizingCharts(
  brand: string | null | undefined,
  category: string | null | undefined,
): SizingChart[] {
  const b = norm(brand);
  const cat = norm(category);

  const brandCharts = b
    ? SIZING_CHARTS.filter(
        (c) => c.brandMatch.length > 0 && c.brandMatch.some((m) => b.includes(m)),
      )
    : [];

  const pool = brandCharts.length > 0
    ? brandCharts
    : SIZING_CHARTS.filter((c) => c.brandMatch.length === 0);

  if (!cat) return pool;
  const byCategory = pool.filter((c) =>
    c.categoryMatch.some((m) => cat.includes(m)),
  );
  // If category narrows to something, use it; else return the whole pool so the
  // model still gets a reference table to reason from.
  return byCategory.length > 0 ? byCategory : pool;
}

/**
 * Render charts as a compact markdown reference for the vision prompt. Returns
 * "" when there's nothing to inject (caller then relies on the model's own
 * knowledge). Pure — unit-testable.
 */
export function formatSizingChartsForPrompt(charts: SizingChart[]): string {
  if (charts.length === 0) return "";
  const blocks = charts.slice(0, 3).map((c) => {
    const measureKeys = Array.from(
      new Set(c.rows.flatMap((r) => Object.keys(r.measurements))),
    );
    const header = ["size", ...measureKeys].join(" | ");
    const sep = ["---", ...measureKeys.map(() => "---")].join(" | ");
    const lines = c.rows.map((r) =>
      [r.size, ...measureKeys.map((k) => r.measurements[k] ?? "")].join(" | "),
    );
    const head = `${c.brand} — ${c.department} ${c.garment} (measurements in inches)`;
    return [
      head,
      c.note ? `(${c.note})` : "",
      header,
      sep,
      ...lines,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return blocks.join("\n\n");
}

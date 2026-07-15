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
  // US-1731: Alo Yoga (women's from the published Alo size guide; men's is the
  // standard activewear-alpha approximation). Mirrors migration 00447's
  // brand_size_charts seed.
  {
    brand: "Alo Yoga",
    brandMatch: ["alo yoga", "aloyoga", "alo"],
    department: "Women",
    garment: "Bottoms (leggings / pants)",
    categoryMatch: ["bottom", "legging", "pant", "short", "tight", "jogger", "sweatpant"],
    note:
      "Alo women's bottoms run alpha; waist is the primary signal, hip secondary. " +
      "XS–L per the published guide; XXS/XL extend ~1.5–2in each way. High-rise " +
      "waistbands lie flat — measure flat and double the waistband.",
    rows: [
      { size: "XS", measurements: { waist: "25-26.5", hip: "34.5-36" } },
      { size: "S", measurements: { waist: "27-28.5", hip: "36.5-38" } },
      { size: "M", measurements: { waist: "29-30.5", hip: "38.5-40" } },
      { size: "L", measurements: { waist: "31-33", hip: "40.5-42" } },
    ],
  },
  {
    brand: "Alo Yoga",
    brandMatch: ["alo yoga", "aloyoga", "alo"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "tank", "tee", "shirt", "bra", "hoodie", "jacket", "long sleeve"],
    note: "Alo women's tops run alpha (XS–L published; XXS/XL extend ~2in); bust is the primary signal.",
    rows: [
      { size: "XS", measurements: { bust: "32-34" } },
      { size: "S", measurements: { bust: "34-36" } },
      { size: "M", measurements: { bust: "36-38" } },
      { size: "L", measurements: { bust: "38-40" } },
    ],
  },
  {
    brand: "Alo Yoga",
    brandMatch: ["alo yoga", "aloyoga", "alo"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "polo", "hoodie", "jacket", "long sleeve"],
    note:
      "Alo men's tops run alpha; chest is the primary signal. Standard US activewear-alpha " +
      "approximation (lower confidence) — refine with Alo-specific men's data.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "41-43" } },
      { size: "XL", measurements: { chest: "44-46" } },
      { size: "XXL", measurements: { chest: "47-49" } },
    ],
  },
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
    brand: "Lululemon",
    brandMatch: ["lululemon", "lulu"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "polo", "hoodie", "jacket", "long sleeve"],
    note: "Lululemon men's tops run alpha XS–XXL; chest is the primary signal.",
    rows: [
      { size: "XS", measurements: { chest: "33-35" } },
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "41-43" } },
      { size: "XL", measurements: { chest: "44-46" } },
      { size: "XXL", measurements: { chest: "47-49" } },
    ],
  },
  {
    brand: "Lululemon",
    brandMatch: ["lululemon", "lulu"],
    department: "Men",
    garment: "Bottoms (ABC / pants / shorts)",
    categoryMatch: ["bottom", "pant", "short", "jogger", "trouser"],
    note: "Lululemon men's bottoms are labeled by waist in inches (28–40).",
    rows: [
      { size: "28", measurements: { waist: "28" } },
      { size: "30", measurements: { waist: "30" } },
      { size: "32", measurements: { waist: "32" } },
      { size: "34", measurements: { waist: "34" } },
      { size: "36", measurements: { waist: "36" } },
      { size: "38", measurements: { waist: "38" } },
      { size: "40", measurements: { waist: "40" } },
    ],
  },
  {
    brand: "Nike",
    brandMatch: ["nike"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "polo", "hoodie", "jacket", "jersey"],
    note: "Nike men's apparel runs alpha; chest is the primary signal.",
    rows: [
      { size: "S", measurements: { chest: "35-37.5" } },
      { size: "M", measurements: { chest: "38-41" } },
      { size: "L", measurements: { chest: "42-44.5" } },
      { size: "XL", measurements: { chest: "45-48.5" } },
      { size: "XXL", measurements: { chest: "49-52.5" } },
    ],
  },
  {
    brand: "Nike",
    brandMatch: ["nike"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "tank", "sports bra", "hoodie", "jacket"],
    note: "Nike women's apparel runs alpha; bust is the primary signal.",
    rows: [
      { size: "XS", measurements: { bust: "30-32" } },
      { size: "S", measurements: { bust: "33-35" } },
      { size: "M", measurements: { bust: "36-38.5" } },
      { size: "L", measurements: { bust: "39-42.5" } },
      { size: "XL", measurements: { bust: "43-46.5" } },
    ],
  },
  {
    brand: "Athleta",
    brandMatch: ["athleta"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "tank", "bra", "hoodie", "jacket"],
    note: "Athleta women's tops run alpha (XXS–XL); bust is the primary signal.",
    rows: [
      { size: "XXS", measurements: { bust: "30-31" } },
      { size: "XS", measurements: { bust: "32-33" } },
      { size: "S", measurements: { bust: "34-35" } },
      { size: "M", measurements: { bust: "36-37.5" } },
      { size: "L", measurements: { bust: "38.5-40" } },
      { size: "XL", measurements: { bust: "41-43" } },
    ],
  },
  {
    brand: "Athleta",
    brandMatch: ["athleta"],
    department: "Women",
    garment: "Bottoms (leggings / pants)",
    categoryMatch: ["bottom", "legging", "pant", "short", "tight", "jogger"],
    note: "Athleta women's bottoms run alpha (XXS–XL); waist is the primary signal.",
    rows: [
      { size: "XXS", measurements: { waist: "24-25", hip: "33-34" } },
      { size: "XS", measurements: { waist: "26-27", hip: "35-36" } },
      { size: "S", measurements: { waist: "28-29", hip: "37-38.5" } },
      { size: "M", measurements: { waist: "30-31.5", hip: "39.5-41" } },
      { size: "L", measurements: { waist: "32.5-34", hip: "42-43.5" } },
      { size: "XL", measurements: { waist: "35-37", hip: "44.5-46.5" } },
    ],
  },
  {
    brand: "Levi's",
    brandMatch: ["levi", "levi's", "levis"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser"],
    note:
      "Levi's men's jeans are labeled W (waist) x L (inseam) in inches; the W " +
      "number is the flat-waistband measurement doubled.",
    rows: [
      { size: "W29", measurements: { waist: "29" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W31", measurements: { waist: "31" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W33", measurements: { waist: "33" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
    ],
  },
  {
    brand: "Levi's",
    brandMatch: ["levi", "levi's", "levis"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom"],
    note:
      "Levi's women's jeans use a numeric waist label (24–34) ≈ natural waist in " +
      "inches; hip rises ~9-10in over the waist.",
    rows: [
      { size: "24", measurements: { waist: "24-24.5", hip: "33-34" } },
      { size: "25", measurements: { waist: "25-25.5", hip: "34-35" } },
      { size: "26", measurements: { waist: "26-26.5", hip: "35-36" } },
      { size: "27", measurements: { waist: "27-27.5", hip: "36-37" } },
      { size: "28", measurements: { waist: "28-28.5", hip: "37-38" } },
      { size: "29", measurements: { waist: "29-29.5", hip: "38-39" } },
      { size: "30", measurements: { waist: "30-31", hip: "39-40.5" } },
      { size: "31", measurements: { waist: "31-32", hip: "40.5-41.5" } },
      { size: "32", measurements: { waist: "32.5-33.5", hip: "42-43" } },
      { size: "34", measurements: { waist: "34.5-35.5", hip: "44-45" } },
    ],
  },
  {
    brand: "Madewell",
    brandMatch: ["madewell"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom"],
    note:
      "Madewell women's denim uses a numeric waist label (23–35) ≈ natural waist " +
      "in inches.",
    rows: [
      { size: "23", measurements: { waist: "23-23.5", hip: "32.5-33.5" } },
      { size: "24", measurements: { waist: "24-24.5", hip: "33.5-34.5" } },
      { size: "25", measurements: { waist: "25-25.5", hip: "34.5-35.5" } },
      { size: "26", measurements: { waist: "26-26.5", hip: "35.5-36.5" } },
      { size: "27", measurements: { waist: "27-27.5", hip: "36.5-37.5" } },
      { size: "28", measurements: { waist: "28-28.5", hip: "37.5-38.5" } },
      { size: "29", measurements: { waist: "29-29.5", hip: "38.5-39.5" } },
      { size: "30", measurements: { waist: "30-31", hip: "39.5-41" } },
      { size: "31", measurements: { waist: "31-32", hip: "41-42" } },
      { size: "32", measurements: { waist: "32.5-33.5", hip: "42.5-43.5" } },
    ],
  },
  {
    brand: "The North Face / Patagonia (outerwear)",
    brandMatch: ["north face", "patagonia", "columbia", "arc'teryx", "arcteryx"],
    department: "Unisex",
    garment: "Outerwear / jackets (alpha)",
    categoryMatch: ["jacket", "coat", "fleece", "vest", "outerwear", "shell", "parka"],
    note:
      "Outdoor outerwear runs alpha; chest is the primary signal. Men's and " +
      "women's overlap — confirm department from the cut/colorway.",
    rows: [
      { size: "XS", measurements: { chest: "33-35" } },
      { size: "S", measurements: { chest: "35-38" } },
      { size: "M", measurements: { chest: "38-41" } },
      { size: "L", measurements: { chest: "42-45" } },
      { size: "XL", measurements: { chest: "46-49" } },
      { size: "XXL", measurements: { chest: "50-53" } },
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

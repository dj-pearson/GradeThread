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
  /**
   * US-2215: the national system the size labels are WRITTEN IN. Optional and
   * usually derived — `size-systems.ts:detectSizeSystem` reads it off the
   * labels when they say so — but settable here when a chart's labels are bare
   * numbers whose system only a human knows. null/absent means "not recorded",
   * never "US".
   */
  sizeSystem?: string;
  /**
   * US-2215: extended size class (plus / petite / tall / big_and_tall /
   * maternity). Absent means `standard`. This exists so extended sizing can be
   * a SEPARATE chart rather than folded into a standard one — see the Talbots
   * row, the corpus's only extended chart, which crams three classes into one.
   */
  sizeClass?: string;
  /**
   * US-2917 provenance. These three carry no value on a SEED chart and are
   * absent here on purpose: the seed's own numbers are approximations from
   * widely published guides, which is exactly what `verified` must not claim.
   * They are populated when a chart is read out of `public.brand_size_charts`,
   * where a human has compared the rows against the brand's own guide.
   */
  /** The brand's OWN published size guide, never a reseller blog. */
  sourceUrl?: string | null;
  /** True only after a human checked these rows against `sourceUrl`. */
  verified?: boolean;
  /**
   * What the numbers MEAN. Every seeded chart is `body` (the wearer), which is
   * why absent reads as `body`. A brand that publishes garment-flat specs is
   * recorded as `flat` so the band builder does not add ease on top of ease.
   */
  measurementBasis?: "body" | "flat";
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
  // US-1733: athleisure & activewear group. Mirrors migration 00452. All BODY
  // measurements (the wearer), never flat-garment — a compression legging
  // measures far smaller flat than its listed hip.
  {
    brand: "Sweaty Betty",
    brandMatch: ["sweaty betty", "sweatybetty"],
    department: "Women",
    garment: "Bottoms (leggings / pants)",
    categoryMatch: ["bottom", "legging", "pant", "short", "jogger", "trouser", "tight"],
    note:
      "BODY measurements, brand-published inches. CRITICAL UK SIZING: the UK→US offset is " +
      "MINUS 4 through UK 14 (UK 12 = US 8), but it BREAKS above that — UK 16-18 → US 12, " +
      "UK 18-20 → US 14. Never subtract 4 blindly at XL/XXL. Mis-listing a UK 12 as a US 12 " +
      "is a two-size overstatement and the costliest error on this brand.",
    rows: [
      { size: "UK 6 / XXS", measurements: { waist: "23", hip: "34", us: "2" } },
      { size: "UK 8 / XS", measurements: { waist: "25", hip: "36", us: "4" } },
      { size: "UK 10 / S", measurements: { waist: "27", hip: "38", us: "6" } },
      { size: "UK 12 / M", measurements: { waist: "29", hip: "40", us: "8" } },
      { size: "UK 14 / L", measurements: { waist: "31", hip: "42", us: "10" } },
      { size: "UK 16-18 / XL", measurements: { waist: "33", hip: "44", us: "12" } },
      { size: "UK 18-20 / XXL", measurements: { waist: "36", hip: "46.5", us: "14" } },
    ],
  },
  {
    brand: "Sweaty Betty",
    brandMatch: ["sweaty betty", "sweatybetty"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "tee", "tank", "vest", "sweatshirt", "hoodie", "jacket", "long sleeve"],
    note:
      "BODY measurements, brand-published inches. Same UK→US caveat as the bottoms chart " +
      "(offset -4 through UK 14, then it compresses). Letter sizes map to UK RANGES at the " +
      "top (XL = UK 16-18, XXL = UK 18-20), so a letter-only tag can't resolve to one UK " +
      "number there. EXCLUDES sports bras (wired styles use UK bra sizing, e.g. 32B).",
    rows: [
      { size: "UK 6 / XXS", measurements: { bust: "30", waist: "23", us: "2" } },
      { size: "UK 8 / XS", measurements: { bust: "32", waist: "25", us: "4" } },
      { size: "UK 10 / S", measurements: { bust: "34", waist: "27", us: "6" } },
      { size: "UK 12 / M", measurements: { bust: "36", waist: "29", us: "8" } },
      { size: "UK 14 / L", measurements: { bust: "38", waist: "31", us: "10" } },
      { size: "UK 16-18 / XL", measurements: { bust: "40", waist: "33", us: "12" } },
      { size: "UK 18-20 / XXL", measurements: { bust: "43", waist: "36", us: "14" } },
    ],
  },
  {
    brand: "Gymshark",
    brandMatch: ["gymshark", "gym shark"],
    department: "Women",
    garment: "Bottoms (leggings / shorts)",
    categoryMatch: ["bottom", "legging", "short", "jogger", "tight"],
    note:
      "BODY measurements. Gymshark publishes cm with inches alongside. Despite the UK " +
      "origin it labels INTERNATIONAL alpha sizes (XXS-XXL), NOT UK numerics — there is no " +
      "UK→US trap here (contrast Sweaty Betty). Inside leg 28.5-32.5in varies by " +
      "Short/Regular/Tall.",
    rows: [
      { size: "XXS", measurements: { waist: "24", hip: "35.5" } },
      { size: "XS", measurements: { waist: "26", hip: "37.5" } },
      { size: "S", measurements: { waist: "28", hip: "39.5" } },
      { size: "M", measurements: { waist: "30", hip: "41.5" } },
      { size: "L", measurements: { waist: "32", hip: "43.5" } },
      { size: "XL", measurements: { waist: "34", hip: "45.5" } },
      { size: "XXL", measurements: { waist: "36", hip: "47.7" } },
    ],
  },
  {
    brand: "Gymshark",
    brandMatch: ["gymshark", "gym shark"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "tee", "tank", "bra", "crop", "hoodie", "jacket", "long sleeve"],
    note:
      "BODY measurement; Gymshark labels this dimension \"chest\" in its own guide. " +
      "International alpha sizing (XXS-XXL), not UK numerics.",
    rows: [
      { size: "XXS", measurements: { bust: "31.5" } },
      { size: "XS", measurements: { bust: "33.5" } },
      { size: "S", measurements: { bust: "35.5" } },
      { size: "M", measurements: { bust: "37.5" } },
      { size: "L", measurements: { bust: "39.5" } },
      { size: "XL", measurements: { bust: "41.5" } },
      { size: "XXL", measurements: { bust: "43.5" } },
    ],
  },
  {
    brand: "Gymshark",
    brandMatch: ["gymshark", "gym shark"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "hoodie", "tank", "long sleeve"],
    note: "BODY measurement (chest ~1in below the underarm). No UK/US mapping is published for Gymshark menswear.",
    rows: [
      { size: "XS", measurements: { chest: "37" } },
      { size: "S", measurements: { chest: "39" } },
      { size: "M", measurements: { chest: "41" } },
      { size: "L", measurements: { chest: "43" } },
      { size: "XL", measurements: { chest: "45" } },
      { size: "XXL", measurements: { chest: "47" } },
      { size: "3XL", measurements: { chest: "49" } },
    ],
  },
  {
    brand: "Under Armour",
    brandMatch: ["under armour", "underarmour", "under armor"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "hoodie", "polo", "compression", "jacket", "long sleeve"],
    note:
      "BODY measurement (under the arms at the fullest part of the chest), from UA's " +
      "official guide. NOTE: widely-syndicated retailer charts show XS 30-32 / MD 38-40, " +
      "which CONTRADICT UA's official values used here — prefer these.",
    rows: [
      { size: "XS", measurements: { chest: "31-34" } },
      { size: "SM", measurements: { chest: "34-37" } },
      { size: "MD", measurements: { chest: "37-41" } },
      { size: "LG", measurements: { chest: "41-44" } },
      { size: "XL", measurements: { chest: "44-48" } },
      { size: "XXL", measurements: { chest: "48-52" } },
      { size: "3XL", measurements: { chest: "52-56" } },
    ],
  },
  {
    brand: "Under Armour",
    brandMatch: ["under armour", "underarmour", "under armor"],
    department: "Men",
    garment: "Bottoms",
    categoryMatch: ["bottom", "pant", "short", "jogger", "legging", "tight"],
    note: "BODY measurement (natural waistline, tape not squeezed). UA official guide.",
    rows: [
      { size: "XS", measurements: { waist: "28" } },
      { size: "SM", measurements: { waist: "30" } },
      { size: "MD", measurements: { waist: "32-33" } },
      { size: "LG", measurements: { waist: "34-36" } },
      { size: "XL", measurements: { waist: "38-40" } },
      { size: "XXL", measurements: { waist: "42-44" } },
      { size: "3XL", measurements: { waist: "46-48" } },
    ],
  },
  {
    brand: "Under Armour",
    brandMatch: ["under armour", "underarmour", "under armor"],
    department: "Women",
    garment: "Bottoms (leggings / pants)",
    categoryMatch: ["bottom", "legging", "pant", "short", "capri", "tight"],
    note:
      "BODY measurement (natural waistline; hips at the fullest). UA official guide. NOTE " +
      "the separate W (plus) run — 1X/2X/3X OVERLAP XL/XXL rather than continuing past " +
      "them, so 1X is not simply \"bigger than XXL\".",
    rows: [
      { size: "XXS", measurements: { waist: "24.5-25.5", hip: "33-34.5", numeric: "00" } },
      { size: "XS", measurements: { waist: "25.5-27", hip: "34.5-36", numeric: "0-2" } },
      { size: "SM", measurements: { waist: "27-29", hip: "36-38", numeric: "4-6" } },
      { size: "MD", measurements: { waist: "29-31", hip: "38-40", numeric: "8-10" } },
      { size: "LG", measurements: { waist: "31-34", hip: "40-43", numeric: "12-14" } },
      { size: "XL", measurements: { waist: "34-37", hip: "43-46", numeric: "16" } },
      { size: "XXL", measurements: { waist: "37-40", hip: "46-49", numeric: "18" } },
      { size: "1X", measurements: { waist: "39-43.5", hip: "47-50.5", numeric: "16W-18W" } },
      { size: "2X", measurements: { waist: "43.5-48.5", hip: "50.5-54.5", numeric: "20W-22W" } },
    ],
  },
  {
    brand: "Beyond Yoga",
    brandMatch: ["beyond yoga", "beyondyoga"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "tank", "tee", "shirt", "bra", "hoodie", "sweatshirt", "dress", "long sleeve"],
    note:
      "BODY measurements from the official guide (XXS-4X). Official rule: when bust and " +
      "waist suggest two sizes, go with the BUST. WARNING — do NOT cross-use this waist " +
      "column with the Bottoms chart: the two charts give different waists for the same " +
      "alpha size and different alpha↔numeric maps. The map is NON-MONOTONIC across the " +
      "standard/extended boundary (XXL=20-22 but 1X=18-20).",
    rows: [
      { size: "XXS", measurements: { bust: "31.5", waist: "25", numeric: "0" } },
      { size: "XS", measurements: { bust: "32-34", waist: "26-27.5", numeric: "0-2" } },
      { size: "S", measurements: { bust: "34.5-36", waist: "28-29.5", numeric: "4-6" } },
      { size: "M", measurements: { bust: "36.5-38", waist: "30-31.5", numeric: "8-10" } },
      { size: "L", measurements: { bust: "38.5-40", waist: "32-33.5", numeric: "12-14" } },
      { size: "XL", measurements: { bust: "40.5-42", waist: "34-35.5", numeric: "16-18" } },
      { size: "XXL", measurements: { bust: "42.5-45", waist: "36-39.5", numeric: "20-22" } },
      { size: "1X", measurements: { bust: "45-47", waist: "41-43", numeric: "18-20" } },
      { size: "2X", measurements: { bust: "48-51", waist: "44-47", numeric: "22-24" } },
      { size: "3X", measurements: { bust: "52-55", waist: "48-51", numeric: "26-28" } },
      { size: "4X", measurements: { bust: "56-60", waist: "52-56", numeric: "30-32" } },
    ],
  },
  {
    brand: "Beyond Yoga",
    brandMatch: ["beyond yoga", "beyondyoga"],
    department: "Women",
    garment: "Bottoms (leggings / joggers)",
    categoryMatch: ["bottom", "legging", "jogger", "pant", "short", "capri", "skirt", "tight"],
    note:
      "BODY measurements. NOTE: XXL and 1X are IDENTICAL (both 39-41 waist / 50-52 hip, " +
      "both US 18-20) — parallel entry points into the standard vs extended blocks, so 1X " +
      "is NOT strictly larger than XXL. BY sells bottoms through 4X but the 4X measurements " +
      "aren't sourceable and are deliberately not extrapolated.",
    rows: [
      { size: "XXS", measurements: { waist: "23-24.5", hip: "32-34", numeric: "0-2" } },
      { size: "XS", measurements: { waist: "25-26.5", hip: "34-37", numeric: "2-4" } },
      { size: "S", measurements: { waist: "27-29", hip: "38-40", numeric: "4-6" } },
      { size: "M", measurements: { waist: "30-32", hip: "41-43", numeric: "6-8" } },
      { size: "L", measurements: { waist: "33-35", hip: "44-46", numeric: "10-12" } },
      { size: "XL", measurements: { waist: "36-38", hip: "47-49", numeric: "14-16" } },
      { size: "XXL", measurements: { waist: "39-41", hip: "50-52", numeric: "18-20" } },
      { size: "1X", measurements: { waist: "39-41", hip: "50-52", numeric: "18-20" } },
      { size: "2X", measurements: { waist: "42-45", hip: "53-56", numeric: "22-24" } },
      { size: "3X", measurements: { waist: "46-49", hip: "57-60", numeric: "26-28" } },
    ],
  },
  {
    brand: "Fabletics",
    brandMatch: ["fabletics"],
    department: "Women",
    garment: "Bottoms (leggings / pants)",
    categoryMatch: ["bottom", "legging", "pant", "short", "jogger", "capri", "tight"],
    note:
      "BODY measurements (the guide instructs the WEARER to measure), XXS-4X. Fabletics " +
      "publishes ONE unified body chart for tops and bottoms. Length variants (7/8, 27in " +
      "inseam) live in the product title, not this chart. The XXL/1X numeric equivalent is " +
      "omitted deliberately: the source renders XL and XXL/1X both as US 16-18, an artifact " +
      "— the measurements are monotonic and trustworthy, that numeric map isn't.",
    rows: [
      { size: "XXS", measurements: { waist: "24-25", hip: "33-35", numeric: "00" } },
      { size: "XS", measurements: { waist: "25.5-26.5", hip: "36-37", numeric: "0-2" } },
      { size: "S", measurements: { waist: "27-28", hip: "37.5-38.5", numeric: "4-6" } },
      { size: "M", measurements: { waist: "29-31", hip: "39-41", numeric: "8-10" } },
      { size: "L", measurements: { waist: "32-34", hip: "42-44", numeric: "12-14" } },
      { size: "XL", measurements: { waist: "35-37", hip: "45-47", numeric: "16-18" } },
      { size: "XXL/1X", measurements: { waist: "38-41", hip: "48-51" } },
      { size: "2X", measurements: { waist: "41-43", hip: "51-53", numeric: "20-22" } },
      { size: "3X", measurements: { waist: "43-45", hip: "53-55", numeric: "24-26" } },
      { size: "4X", measurements: { waist: "45-47", hip: "55-57", numeric: "28-30" } },
    ],
  },
  {
    brand: "Fabletics",
    brandMatch: ["fabletics"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "tee", "tank", "shirt", "bra", "hoodie", "jacket", "dress", "long sleeve"],
    note:
      "BODY measurements, XXS-4X. Sports bras size alpha (XXS-4X), NOT band+cup. Same " +
      "XXL/1X numeric-map caveat as the bottoms chart.",
    rows: [
      { size: "XXS", measurements: { bust: "30-31.5", waist: "24-25", numeric: "00" } },
      { size: "XS", measurements: { bust: "32-33.5", waist: "25.5-26.5", numeric: "0-2" } },
      { size: "S", measurements: { bust: "34.5-35.5", waist: "27-28", numeric: "4-6" } },
      { size: "M", measurements: { bust: "36-38", waist: "29-31", numeric: "8-10" } },
      { size: "L", measurements: { bust: "39-41", waist: "32-34", numeric: "12-14" } },
      { size: "XL", measurements: { bust: "42-44", waist: "35-37", numeric: "16-18" } },
      { size: "XXL/1X", measurements: { bust: "45-48", waist: "38-41" } },
      { size: "2X", measurements: { bust: "48-50", waist: "41-43", numeric: "20-22" } },
      { size: "3X", measurements: { bust: "50-52", waist: "43-45", numeric: "24-26" } },
      { size: "4X", measurements: { bust: "52-54", waist: "45-47", numeric: "28-30" } },
    ],
  },
  {
    brand: "Vuori",
    brandMatch: ["vuori"],
    department: "Men",
    garment: "Bottoms (shorts / joggers)",
    categoryMatch: ["bottom", "short", "pant", "jogger", "kore", "banks", "meta", "ponto"],
    note:
      "BODY measurements. Vuori men's bottoms are ALPHA-sized (XS-XXL), not numeric waist. " +
      "INSEAM is a SEPARATE axis, not a size: Kore 5/7/9in; HardKore 5/7in; Banks Session " +
      "5/7in; Sunday Short 8in; Ponto Jogger 28in/Regular/Long. Capture inseam separately.",
    rows: [
      { size: "XS", measurements: { waist: "27-29", hip: "33-35" } },
      { size: "S", measurements: { waist: "29-32", hip: "35-37" } },
      { size: "M", measurements: { waist: "32-35", hip: "37-41" } },
      { size: "L", measurements: { waist: "35-38", hip: "41-44" } },
      { size: "XL", measurements: { waist: "38-43", hip: "44-47" } },
      { size: "XXL", measurements: { waist: "43-47", hip: "47-50" } },
    ],
  },
  {
    brand: "Vuori",
    brandMatch: ["vuori"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "hoodie", "crew", "jacket", "long sleeve"],
    note:
      "BODY measurement — never compare to a flat-lay pit-to-pit. The retailer rendering " +
      "labels the basis ambiguously (range-style values are characteristic of a body " +
      "chart), so treat as lower confidence.",
    rows: [
      { size: "XS", measurements: { chest: "33-35" } },
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "37-40" } },
      { size: "L", measurements: { chest: "40-43" } },
      { size: "XL", measurements: { chest: "43-47" } },
      { size: "XXL", measurements: { chest: "47-51" } },
    ],
  },
  {
    brand: "Vuori",
    brandMatch: ["vuori"],
    department: "Women",
    garment: "Bottoms (leggings / shorts)",
    categoryMatch: ["bottom", "legging", "short", "jogger", "pant", "clean elevation"],
    note:
      "BODY measurements. Clean Elevation also has a Long (tall) inseam variant. The XXL " +
      "hip renders as both 44-46 and 45-47 across sources — that row is low confidence.",
    rows: [
      { size: "XXS", measurements: { waist: "23-24", hip: "33-34" } },
      { size: "XS", measurements: { waist: "24-26", hip: "34-36" } },
      { size: "S", measurements: { waist: "26-28", hip: "36-38" } },
      { size: "M", measurements: { waist: "28-30", hip: "38-40" } },
      { size: "L", measurements: { waist: "30-32", hip: "40-42" } },
      { size: "XL", measurements: { waist: "32-34", hip: "42-44" } },
      { size: "XXL", measurements: { waist: "35-37", hip: "44-47" } },
    ],
  },
  // US-1730: J.Crew men's chinos (numeric) + shirts (alpha). Mirrors 00450.
  // (Madewell women's denim is already seeded above.)
  {
    brand: "J.Crew",
    brandMatch: ["j.crew", "jcrew", "j crew"],
    department: "Men",
    garment: "Chinos / pants (waist x inseam)",
    categoryMatch: ["chino", "pant", "trouser", "bottom", "short"],
    note:
      "J.Crew men's chinos/pants are labeled W (waist) x L (inseam) in inches; the numbered " +
      "FIT (484/770/1040) sets the leg cut, not the size. Measure the flat waistband and double it.",
    rows: [
      { size: "28", measurements: { waist: "28" } },
      { size: "30", measurements: { waist: "30" } },
      { size: "31", measurements: { waist: "31" } },
      { size: "32", measurements: { waist: "32" } },
      { size: "33", measurements: { waist: "33" } },
      { size: "34", measurements: { waist: "34" } },
      { size: "36", measurements: { waist: "36" } },
      { size: "38", measurements: { waist: "38" } },
    ],
  },
  {
    brand: "J.Crew",
    brandMatch: ["j.crew", "jcrew", "j crew"],
    department: "Men",
    garment: "Shirts (alpha)",
    categoryMatch: ["shirt", "tee", "polo", "oxford", "sweater", "hoodie"],
    note: "J.Crew men's shirts run alpha; chest is the primary signal. Dress shirts also sold neck x sleeve.",
    rows: [
      { size: "XS", measurements: { chest: "32-34" } },
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "41-43" } },
      { size: "XL", measurements: { chest: "44-46" } },
      { size: "XXL", measurements: { chest: "47-49" } },
    ],
  },
  // US-1729: Free People (URBN). Women's tops/dresses (alpha) + denim (numeric).
  // Mirrors migration 00449's brand_size_charts seed.
  {
    brand: "Free People",
    brandMatch: ["free people", "freepeople", "fp"],
    department: "Women",
    garment: "Tops & dresses (alpha)",
    categoryMatch: ["top", "tee", "shirt", "blouse", "dress", "tunic", "sweater", "hoodie", "jacket", "tank", "bodysuit"],
    note:
      "Free People women's tops/dresses run alpha; bust is the primary signal. XS-L per " +
      "the published guide; XL extends ~+2in. FP runs relaxed/oversized — a garment often " +
      "measures larger than the alpha implies.",
    rows: [
      { size: "XS", measurements: { bust: "33", waist: "25" } },
      { size: "S", measurements: { bust: "34", waist: "26" } },
      { size: "M", measurements: { bust: "35", waist: "27" } },
      { size: "L", measurements: { bust: "36", waist: "28" } },
      { size: "XL", measurements: { bust: "38", waist: "30" } },
    ],
  },
  {
    brand: "Free People",
    brandMatch: ["free people", "freepeople", "we the free", "fp"],
    department: "Women",
    garment: "Denim (numeric waist)",
    categoryMatch: ["jean", "denim", "pant", "bottom"],
    note:
      "Free People / We The Free denim uses a numeric waist label (24-31) approx = natural " +
      "waist in inches. Measure the flat waistband and double it.",
    rows: [
      { size: "24", measurements: { waist: "24-24.5" } },
      { size: "25", measurements: { waist: "25-25.5" } },
      { size: "26", measurements: { waist: "26-26.5" } },
      { size: "27", measurements: { waist: "27-27.5" } },
      { size: "28", measurements: { waist: "28-28.5" } },
      { size: "29", measurements: { waist: "29-29.5" } },
      { size: "30", measurements: { waist: "30-31" } },
      { size: "31", measurements: { waist: "31-32" } },
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
    // US-1732: refined to the published Athleta guide + numeric map (mirrors 00448).
    note:
      "Athleta women's tops run alpha (XXS–3X) with a numeric map (XXS≈00, XS≈0-2, " +
      "S≈4-6, M≈8-10, L≈12-14, XL≈16-18); bust is the primary signal. 1X-3X extend ~+2.5in/step.",
    rows: [
      { size: "XXS", measurements: { bust: "32.5" } },
      { size: "XS", measurements: { bust: "32.5-33.5" } },
      { size: "S", measurements: { bust: "34.5-35.5" } },
      { size: "M", measurements: { bust: "36.5-37.5" } },
      { size: "L", measurements: { bust: "38.5-40" } },
      { size: "XL", measurements: { bust: "41.5-43.5" } },
    ],
  },
  {
    brand: "Athleta",
    brandMatch: ["athleta"],
    department: "Women",
    garment: "Bottoms (leggings / pants)",
    categoryMatch: ["bottom", "legging", "pant", "short", "tight", "jogger"],
    // US-1732: refined to the published Athleta guide + numeric map (mirrors 00448).
    note:
      "Athleta women's bottoms run alpha (XXS–3X) with a numeric map (XXS≈00, XS≈0-2, " +
      "S≈4-6, M≈8-10, L≈12-14, XL≈16-18); waist is the primary signal, hip secondary. " +
      "1X-3X extend ~+2.5in waist/step.",
    rows: [
      { size: "XXS", measurements: { waist: "24", hip: "34.5" } },
      { size: "XS", measurements: { waist: "25-26", hip: "35.5-36.5" } },
      { size: "S", measurements: { waist: "27-28", hip: "37.5-38.5" } },
      { size: "M", measurements: { waist: "29-30", hip: "39.5-40.5" } },
      { size: "L", measurements: { waist: "31-32.5", hip: "41.5-43" } },
      { size: "XL", measurements: { waist: "34-36", hip: "44.5-46.5" } },
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
  // US-1735: premium & vintage denim group. Mirrors migration 00454.
  //
  // DENIM IS THE EXCEPTION among these charts. Every other group here is a BODY
  // chart, because its garments are alpha-sized and a letter has to be mapped
  // onto a wearer. Denim labels are MEASUREMENTS: a W32 claims a 32in waist, a
  // numeric 27 claims a 27in waist. So these are NOMINAL WAIST charts — they map
  // the label to the waist it CLAIMS, and the claim is often false in a direction
  // that depends on the tier:
  //   * VINTAGE (Wrangler/Lee) runs SMALL vs the tag (pre-shrunk sizing + decades
  //     of laundering): a vintage W32 commonly measures 30-31.
  //   * PREMIUM (7FAM/TR/AG/Citizens) runs LARGE vs the tag (vanity sizing +
  //     stretch that relaxes permanently with wear): a 27 commonly measures 28+.
  // The two brands' denim JACKET charts are the exception-to-the-exception: those
  // are alpha-sized, so they are genuine BODY charts.
  //
  // NOTE: no bare "ag" in any brandMatch — matching is by SUBSTRING and
  // "patagonia" contains "ag". The canonical brand is "AG Jeans" (see
  // brand-normalize.ts), which is what reaches these rows.
  {
    brand: "Wrangler",
    brandMatch: ["wrangler"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — the label is a claimed measurement, not a body chart. " +
      "Labeled W (waist) x L (inseam) in inches. VINTAGE CAVEAT: a vintage " +
      "Wrangler runs SMALL against its tag (a vintage W32 commonly measures " +
      "30-31), so never list a Blue Bell-era pair on its tag alone. Measure the " +
      "flat waistband, double it, publish that. Vintage inseams are often hemmed.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
      { size: "W40", measurements: { waist: "40" } },
      { size: "W42", measurements: { waist: "42" } },
    ],
  },
  {
    brand: "Wrangler",
    brandMatch: ["wrangler"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches; hip " +
      "rises ~9-10in over the waist. Wrangler also sells women's western jeans on " +
      "a misses/juniors SIZE x INSEAM label (e.g. 5/6 x 34), a different scale — " +
      "do not map a juniors number onto this chart. Measure and double the flat " +
      "waistband.",
    rows: [
      { size: "24", measurements: { waist: "24-24.5", hip: "33-34" } },
      { size: "26", measurements: { waist: "26-26.5", hip: "35-36" } },
      { size: "28", measurements: { waist: "28-28.5", hip: "37-38" } },
      { size: "30", measurements: { waist: "30-31", hip: "39-40.5" } },
      { size: "32", measurements: { waist: "32.5-33.5", hip: "42-43" } },
      { size: "34", measurements: { waist: "34.5-35.5", hip: "44-45" } },
    ],
  },
  {
    brand: "Wrangler",
    brandMatch: ["wrangler"],
    department: "Unisex",
    garment: "Denim jackets (alpha)",
    categoryMatch: ["jacket", "coat", "denim jacket", "western jacket", "outerwear", "vest"],
    note:
      "BODY measurement (chest) — the jackets are alpha-sized rather than " +
      "waist-labeled, so unlike the jeans charts this one IS a body chart. A " +
      "western denim jacket is cut close, so its flat chest sits near the body " +
      "chest rather than above it. Vintage jackets run SMALL against the tag — " +
      "measure the flat chest (armpit to armpit, doubled) and publish it.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "42-44" } },
      { size: "XL", measurements: { chest: "46-48" } },
      { size: "XXL", measurements: { chest: "50-52" } },
    ],
  },
  {
    brand: "Lee",
    brandMatch: ["lee"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — the label is a claimed measurement, not a body chart. " +
      "Labeled W (waist) x L (inseam) in inches. Same VINTAGE CAVEAT as Wrangler, " +
      "hardest on the union-made era: an early Lee runs SMALL against its tag (a " +
      "vintage W32 commonly measures 30-31). Never list a UNION MADE pair on its " +
      "tag alone — measure the flat waistband, double it, publish that.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
      { size: "W40", measurements: { waist: "40" } },
    ],
  },
  {
    brand: "Lee",
    brandMatch: ["lee"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches; hip " +
      "rises ~9-10in over the waist. Lee also sells women's jeans on a misses SIZE " +
      "label (8/10/12), a DIFFERENT scale from this waist-inch one — read which " +
      "scale the tag uses before mapping. Measure and double the flat waistband.",
    rows: [
      { size: "24", measurements: { waist: "24-24.5", hip: "33-34" } },
      { size: "26", measurements: { waist: "26-26.5", hip: "35-36" } },
      { size: "28", measurements: { waist: "28-28.5", hip: "37-38" } },
      { size: "30", measurements: { waist: "30-31", hip: "39-40.5" } },
      { size: "32", measurements: { waist: "32.5-33.5", hip: "42-43" } },
      { size: "34", measurements: { waist: "34.5-35.5", hip: "44-45" } },
    ],
  },
  {
    brand: "Lee",
    brandMatch: ["lee"],
    department: "Unisex",
    garment: "Denim jackets (alpha)",
    categoryMatch: ["jacket", "coat", "denim jacket", "storm rider", "outerwear", "vest"],
    note:
      "BODY measurement (chest) — the jackets are alpha-sized, so unlike the jeans " +
      "charts this one IS a body chart. NOTE the Storm Rider: it is BLANKET-LINED, " +
      "so it is cut with room for the lining and wears smaller inside than its flat " +
      "chest suggests. Measure the flat chest and say the jacket is lined.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "42-44" } },
      { size: "XL", measurements: { chest: "46-48" } },
      { size: "XXL", measurements: { chest: "50-52" } },
    ],
  },
  {
    brand: "7 For All Mankind",
    brandMatch: ["7 for all mankind", "7forallmankind", "seven for all mankind", "7fam"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches. " +
      "PREMIUM-DENIM CAVEAT, running OPPOSITE to the vintage brands in this same " +
      "group: premium denim runs LARGE against its tag. Vanity sizing plus stretch " +
      "that relaxes with wear means a 27 commonly measures 28+, and a used pair has " +
      "permanently given at the waistband. Measure and double the flat waistband.",
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
    brand: "7 For All Mankind",
    brandMatch: ["7 for all mankind", "7forallmankind", "seven for all mankind", "7fam"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. Same PREMIUM " +
      "caveat as the women's chart: stretch denim relaxes, so a worn Slimmy " +
      "measures above its tag. Measure and double the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W33", measurements: { waist: "33" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
    ],
  },
  {
    brand: "True Religion",
    brandMatch: ["true religion", "truereligion"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat " +
      "applies (runs large against the tag). TRUE-RELIGION-SPECIFIC: the INSEAM is " +
      "the number to watch — the flare and bootcut fits were sold long by design " +
      "and are very frequently HEMMED by the owner, so the tag inseam is often " +
      "wrong on a used pair. Measure and double the flat waistband, and measure " +
      "the inside leg too; publish both real figures rather than the tag.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
      { size: "W40", measurements: { waist: "40" } },
    ],
  },
  {
    brand: "True Religion",
    brandMatch: ["true religion", "truereligion"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches. " +
      "PREMIUM caveat applies (runs large against the tag). Same hemming warning " +
      "as the men's chart: the women's flares were sold long and are commonly " +
      "shortened, so measure the inside leg rather than trusting the tag inseam. " +
      "Measure and double the flat waistband too.",
    rows: [
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
    brand: "AG Jeans",
    // NEVER add a bare "ag" — "patagonia" contains it (substring match).
    brandMatch: ["ag jeans", "agjeans", "adriano goldschmied"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat " +
      "applies: AG's men's fits are stretch denim and relax with wear, so a worn " +
      "Graduate measures above its tag. Measure and double the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W33", measurements: { waist: "33" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
    ],
  },
  {
    brand: "AG Jeans",
    brandMatch: ["ag jeans", "agjeans", "adriano goldschmied"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches. " +
      "PREMIUM caveat applies (runs large; stretch gives with wear). AG-SPECIFIC: " +
      "heavy whiskering/fading is the AG-ed WASH, not wear — do not let a " +
      "distressed finish drive a size or condition judgment. Measure and double " +
      "the flat waistband.",
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
    brand: "Citizens of Humanity",
    brandMatch: ["citizens of humanity", "citizensofhumanity"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches. " +
      "PREMIUM caveat applies (runs large against the tag). CITIZENS-SPECIFIC: the " +
      "Rocket is a sculpting STRETCH fit while the Daphne is RIGID denim, and the " +
      "two behave oppositely on a used pair — stretch gives permanently at the " +
      "waistband, rigid does not. Read the fabric off the care tag before trusting " +
      "any size claim, then measure and double the flat waistband.",
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
    brand: "Citizens of Humanity",
    brandMatch: ["citizens of humanity", "citizensofhumanity"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat " +
      "applies. Measure and double the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
    ],
  },
  // US-1984: premium denim tier 2. Mirrors migration 00464. Same NOMINAL WAIST
  // basis as the 00454 block above (the label is a claimed measurement, not a
  // body chart) — but this pack lies in THREE directions rather than two:
  // stretch premium runs LARGE and gives permanently; RAW G-Star SHRINKS on its
  // first wash; and MOTHER's frayed hem makes the tag inseam a fiction. Standard
  // premium-denim grades rather than each brand's published figures — capped
  // confidence in the migration, and each note says so.
  {
    brand: "Diesel",
    brandMatch: ["diesel"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — the label is a claimed measurement, not a body chart. " +
      "Diesel labels W (waist) x L (inseam) in inches for BOTH genders (a " +
      "European convention). PREMIUM caveat applies to the stretch (-X) fits. " +
      "DIESEL-SPECIFIC: heavy shredding, holes and abrasion are usually the " +
      "DESIGNED WASH, not wear — do not let a destroyed finish drive a size or " +
      "condition judgment. Measure and double the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
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
    brand: "Diesel",
    brandMatch: ["diesel"],
    department: "Women",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the waist in inches. NOTE THE " +
      "EUROPEAN CONVENTION: unlike the US premium brands in this pack, Diesel " +
      "labels women's denim W (waist) x L (inseam) exactly as it does men's. " +
      "Diesel non-denim RTW may instead use an EU/IT number, which is a " +
      "DIFFERENT scale — do not map an IT 42 onto this chart. PREMIUM caveat " +
      "applies to the stretch fits. Measure and double the flat waistband.",
    rows: [
      { size: "W24", measurements: { waist: "24" } },
      { size: "W25", measurements: { waist: "25" } },
      { size: "W26", measurements: { waist: "26" } },
      { size: "W27", measurements: { waist: "27" } },
      { size: "W28", measurements: { waist: "28" } },
      { size: "W29", measurements: { waist: "29" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W31", measurements: { waist: "31" } },
      { size: "W32", measurements: { waist: "32" } },
    ],
  },
  {
    brand: "Diesel",
    brandMatch: ["diesel"],
    department: "Unisex",
    garment: "Denim jackets (alpha)",
    categoryMatch: ["jacket", "coat", "denim jacket", "outerwear", "vest"],
    note:
      "BODY measurement (chest) — the jackets are alpha-sized rather than " +
      "waist-labeled, so unlike the jeans charts this one IS a body chart. Same " +
      "DIESEL-SPECIFIC warning: a destroyed or heavily treated finish is usually " +
      "designed, not wear. Measure the flat chest (armpit to armpit, doubled).",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "42-44" } },
      { size: "XL", measurements: { chest: "46-48" } },
      { size: "XXL", measurements: { chest: "50-52" } },
    ],
  },
  {
    brand: "G-Star RAW",
    brandMatch: ["g-star", "gstar", "g star"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — the label is a claimed measurement, not a body chart. " +
      "G-Star labels W (waist) x L (inseam) in inches for both genders. " +
      "G-STAR-SPECIFIC AND IT RUNS OPPOSITE TO THE REST OF THIS PACK: RAW denim " +
      "SHRINKS on its first wash (commonly an inch or two in the waist), where " +
      "the stretch premium brands here GIVE and run large. So an unwashed raw " +
      "pair measures near its tag and a washed one measures under it — the tag " +
      "cannot tell you which. Also do not read raw denim's high-contrast fading " +
      "(whiskers, honeycombs) as wear: it is earned patina buyers pay for. " +
      "Measure and double the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
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
    brand: "G-Star RAW",
    brandMatch: ["g-star", "gstar", "g star"],
    department: "Women",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the waist in inches, carried as " +
      "W (waist) x L (inseam) in the European convention rather than the US " +
      "bare-numeric one. Same G-STAR-SPECIFIC shrink caveat as the men's chart: " +
      "a RAW pair shrinks on first wash rather than giving with wear, which is " +
      "the opposite of the stretch premium brands in this pack. Measure and " +
      "double the flat waistband.",
    rows: [
      { size: "W24", measurements: { waist: "24" } },
      { size: "W25", measurements: { waist: "25" } },
      { size: "W26", measurements: { waist: "26" } },
      { size: "W27", measurements: { waist: "27" } },
      { size: "W28", measurements: { waist: "28" } },
      { size: "W29", measurements: { waist: "29" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W31", measurements: { waist: "31" } },
      { size: "W32", measurements: { waist: "32" } },
    ],
  },
  {
    brand: "G-Star RAW",
    brandMatch: ["g-star", "gstar", "g star"],
    department: "Unisex",
    garment: "Denim jackets (alpha)",
    categoryMatch: ["jacket", "coat", "denim jacket", "outerwear", "vest"],
    note:
      "BODY measurement (chest) — the jackets are alpha-sized rather than " +
      "waist-labeled, so unlike the jeans charts this one IS a body chart. A RAW " +
      "denim jacket shrinks on first wash for the same reason the jeans do, and " +
      "its 3D-constructed sleeves can read as misshapen when they are simply " +
      "built that way. Measure the flat chest (armpit to armpit, doubled).",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "42-44" } },
      { size: "XL", measurements: { chest: "46-48" } },
      { size: "XXL", measurements: { chest: "50-52" } },
    ],
  },
  {
    brand: "PAIGE",
    brandMatch: ["paige"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches; hip " +
      "rises ~9-10in over the waist. PREMIUM caveat applies (runs LARGE against " +
      "the tag). PAIGE-SPECIFIC: the line is built on TRANSCEND, a " +
      "high-recovery stretch fabric, so the give is real and permanent — a used " +
      "Verdugo measures above its tag and will not return. Measure and double " +
      "the flat waistband.",
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
    brand: "PAIGE",
    brandMatch: ["paige"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat " +
      "applies: the men's fits are TRANSCEND stretch and relax with wear, so a " +
      "worn Federal measures above its tag. Measure and double the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W31", measurements: { waist: "31" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W33", measurements: { waist: "33" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
    ],
  },
  // "FRAME" and "MOTHER" are ordinary words, but brandMatch is tested against the
  // CANONICAL BRAND STRING (never free text), so the token is safe HERE. The prose
  // hazard lives in detectBrandInText and is handled by DETECT_EXCLUDED_FROM_TEXT
  // in brand-normalize.ts. Both directions are asserted in
  // premium-denim-content_test.ts.
  {
    brand: "FRAME",
    brandMatch: ["frame"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches; hip " +
      "rises ~9-10in over the waist. PREMIUM caveat applies (runs LARGE against " +
      "the tag; stretch gives with wear and a used pair has permanently given at " +
      "the waistband). Measure and double the flat waistband.",
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
    brand: "FRAME",
    brandMatch: ["frame"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. FRAME's entire " +
      "men's denim line is L'HOMME, so an L'Homme tag on a pair of jeans means " +
      "this chart rather than the women's one — the tag names the department. " +
      "PREMIUM caveat applies (stretch relaxes with wear). Measure and double " +
      "the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
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
  // MOTHER is a WOMEN'S line — no men's chart is seeded rather than inventing one.
  {
    brand: "MOTHER",
    brandMatch: ["mother"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches; hip " +
      "rises ~9-10in over the waist. MOTHER is a WOMEN'S line, so there is no " +
      "men's chart. PREMIUM caveat applies (runs LARGE against the tag). " +
      "MOTHER-SPECIFIC AND IT IS THE POINT OF THIS ROW: the INSEAM cannot be " +
      "read from the tag on a Fray or Chew style, because the hem is " +
      "DELIBERATELY shredded and uneven — there is no single length to report, " +
      "so measure the inside leg to the SHORTEST point and say the hem is a " +
      "factory fray. Do not record the frayed hem as damage: it is the product, " +
      "and a new pair arrives that way. Measure and double the flat waistband too.",
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
    brand: "Rag & Bone",
    brandMatch: ["rag & bone", "rag and bone", "ragbone", "rag bone"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat " +
      "applies (runs large; stretch gives with wear). RAG & BONE-SPECIFIC: the " +
      "men's FIT NUMBER (Fit 1/2/3/4) is a separate axis from the waist size and " +
      "both are on the tag — the number is the cut, not the size, so never map a " +
      "\"Fit 2\" onto this chart as if it were a measurement. Measure and double " +
      "the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
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
    brand: "Rag & Bone",
    brandMatch: ["rag & bone", "rag and bone", "ragbone", "rag bone"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches. " +
      "PREMIUM caveat applies (runs large against the tag). NOTE the line's " +
      "split naming: the women's fits are NAMED (Cate, Dre, Nina) while the " +
      "men's are NUMBERED, so a women's tag carries a name plus this waist " +
      "number and no Fit number. Measure and double the flat waistband.",
    rows: [
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
  // NEVER add a bare "hudson" — the canonical is "Hudson Jeans" (the AG Jeans
  // play), and findSizingCharts is passed that canonical, so "hudson jeans"
  // reaches the chart without putting a loose surname/place token in the table.
  {
    brand: "Hudson Jeans",
    brandMatch: ["hudson jeans", "hudsonjeans"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches; hip " +
      "rises ~9-10in over the waist. PREMIUM caveat applies (runs LARGE against " +
      "the tag; the super-skinny fits are heavy stretch and give permanently at " +
      "the waistband). Measure and double the flat waistband.",
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
    brand: "Hudson Jeans",
    brandMatch: ["hudson jeans", "hudsonjeans"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat " +
      "applies (stretch relaxes with wear, so a worn Blake measures above its " +
      "tag). Measure and double the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
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
    brand: "Joe's Jeans",
    brandMatch: ["joes jeans", "joesjeans", "joe's jeans"],
    department: "Women",
    garment: "Jeans (numeric waist)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "short"],
    note:
      "NOMINAL WAIST — the numeric label claims the natural waist in inches; hip " +
      "rises ~9-10in over the waist. PREMIUM caveat applies (runs LARGE against " +
      "the tag; stretch gives permanently with wear). JOE'S-SPECIFIC: the HONEY " +
      "is a CURVY block cut for a larger hip-to-waist ratio, so its hip runs " +
      "fuller than this chart at the same waist number — do not read a Honey's " +
      "hip off this row. Measure and double the flat waistband, and measure the " +
      "hip separately on a Honey.",
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
    brand: "Joe's Jeans",
    brandMatch: ["joes jeans", "joesjeans", "joe's jeans"],
    department: "Men",
    garment: "Jeans (waist x inseam)",
    categoryMatch: ["jean", "pant", "denim", "bottom", "trouser", "short"],
    note:
      "NOMINAL WAIST — labeled W (waist) x L (inseam) in inches. PREMIUM caveat " +
      "applies (stretch relaxes with wear, so a worn Brixton measures above its " +
      "tag). Measure and double the flat waistband.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W31", measurements: { waist: "31" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W33", measurements: { waist: "33" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
    ],
  },
  // US-1734: outdoor & technical group. Mirrors migration 00453. All BODY
  // measurements (the wearer), never flat-garment — and in THIS category the
  // error runs the opposite way to activewear: an outdoor shell is cut with
  // deliberate layering room, so its flat chest measures well ABOVE the body
  // chest it is sized to. These are the standard outdoor-alpha grade rather than
  // each brand's own published figures (00453 seeds them at capped confidence and
  // says so) — the value here is that the brand resolves a chart at all, plus the
  // per-brand fit caveat in each note.
  {
    brand: "Columbia",
    brandMatch: ["columbia", "columbia sportswear"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "polo", "hoodie", "fleece", "jacket", "coat", "shell", "parka", "vest", "long sleeve"],
    note:
      "BODY measurements — NOT flat-garment. An outdoor shell carries layering " +
      "room, so its flat chest measures well above the body chest listed here; " +
      "never compare this chart to a flat-lay tape. Standard outdoor-alpha " +
      "approximation, not Columbia-fetched figures.",
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
    brand: "Columbia",
    brandMatch: ["columbia", "columbia sportswear"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "tee", "shirt", "tank", "fleece", "hoodie", "jacket", "coat", "shell", "parka", "vest", "long sleeve"],
    note:
      "BODY measurements — NOT flat-garment; outdoor cuts carry layering room. " +
      "Standard outdoor-alpha approximation, not Columbia-fetched figures.",
    rows: [
      { size: "XS", measurements: { bust: "32-33" } },
      { size: "S", measurements: { bust: "34-35" } },
      { size: "M", measurements: { bust: "36-37.5" } },
      { size: "L", measurements: { bust: "38.5-40" } },
      { size: "XL", measurements: { bust: "41-43" } },
      { size: "XXL", measurements: { bust: "44-46" } },
    ],
  },
  {
    brand: "Columbia",
    brandMatch: ["columbia", "columbia sportswear"],
    department: "Men",
    garment: "Bottoms",
    categoryMatch: ["bottom", "pant", "short", "trouser", "hiking pant", "convertible"],
    note:
      "BODY measurements (natural waistline) — NOT flat-garment. Columbia men's " +
      "hiking pants are labeled W (waist) x L (inseam) in inches, so the label IS " +
      "the measurement. Inseam is a separate axis (30/32/34); the Silver Ridge " +
      "convertible zips off to a short — capture that as an attribute, not a size.",
    rows: [
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
      { size: "W40", measurements: { waist: "40" } },
    ],
  },
  {
    brand: "Arc'teryx",
    brandMatch: ["arc'teryx", "arcteryx", "arc teryx"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "jacket", "coat", "shell", "hoodie", "fleece", "vest", "hardshell", "softshell", "long sleeve"],
    note:
      "BODY measurements — NOT flat-garment. The FIT varies by SUFFIX, not by " +
      "size: an Alpha/Beta hardshell is cut for layering while an Atom LT is trim, " +
      "so the same body chest can wear a different letter across the lines. State " +
      "the flat measurements and the suffix. Standard outdoor-alpha approximation.",
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
    brand: "Arc'teryx",
    brandMatch: ["arc'teryx", "arcteryx", "arc teryx"],
    department: "Women",
    garment: "Tops",
    categoryMatch: ["top", "jacket", "coat", "shell", "hoodie", "fleece", "vest", "hardshell", "softshell", "long sleeve"],
    note:
      "BODY measurements — NOT flat-garment. Same suffix-drives-fit caveat as the " +
      "men's chart. Standard outdoor-alpha approximation.",
    rows: [
      { size: "XS", measurements: { bust: "32-33" } },
      { size: "S", measurements: { bust: "34-35" } },
      { size: "M", measurements: { bust: "36-37.5" } },
      { size: "L", measurements: { bust: "38.5-40" } },
      { size: "XL", measurements: { bust: "41-43" } },
    ],
  },
  {
    brand: "Marmot",
    brandMatch: ["marmot"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "jacket", "coat", "shell", "hoodie", "fleece", "vest", "rain jacket", "long sleeve"],
    note:
      "BODY measurements — NOT flat-garment; a rain shell is cut with layering " +
      "room over this. Standard outdoor-alpha approximation, not Marmot-fetched.",
    rows: [
      { size: "S", measurements: { chest: "35-38" } },
      { size: "M", measurements: { chest: "38-41" } },
      { size: "L", measurements: { chest: "42-45" } },
      { size: "XL", measurements: { chest: "46-49" } },
      { size: "XXL", measurements: { chest: "50-53" } },
    ],
  },
  {
    brand: "REI Co-op",
    brandMatch: ["rei co-op", "rei coop", "reicoop", "rei"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "jacket", "coat", "shell", "hoodie", "fleece", "vest", "rain jacket", "shirt", "long sleeve"],
    note:
      "BODY measurements — NOT flat-garment; house-label shells carry layering " +
      "room. Standard outdoor-alpha approximation, not REI-fetched figures.",
    rows: [
      { size: "S", measurements: { chest: "35-38" } },
      { size: "M", measurements: { chest: "38-41" } },
      { size: "L", measurements: { chest: "42-45" } },
      { size: "XL", measurements: { chest: "46-49" } },
      { size: "XXL", measurements: { chest: "50-53" } },
    ],
  },
  {
    brand: "L.L.Bean",
    brandMatch: ["l.l.bean", "llbean", "l.l. bean", "ll bean"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "shirt", "flannel", "tee", "polo", "sweater", "hoodie", "fleece", "jacket", "coat", "vest", "long sleeve"],
    note:
      "BODY measurements — NOT flat-garment. CRITICAL BEAN CAVEAT: the classic " +
      "Bean cut runs GENEROUS/relaxed, so the finished garment is roomier than " +
      "this body chart implies and a Bean Medium wears larger than a Medium from " +
      "a technical brand. This maps body-to-label; it does NOT predict the flat " +
      "measurement. Always measure the garment and publish the flat figures.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "42-44" } },
      { size: "XL", measurements: { chest: "46-48" } },
      { size: "XXL", measurements: { chest: "50-52" } },
    ],
  },
  {
    brand: "L.L.Bean",
    brandMatch: ["l.l.bean", "llbean", "l.l. bean", "ll bean"],
    department: "Men",
    garment: "Bottoms",
    categoryMatch: ["bottom", "pant", "short", "trouser", "chino", "jean"],
    note:
      "BODY measurements (natural waistline) — NOT flat-garment. Bean men's pants " +
      "are labeled W (waist) x L (inseam) in inches, so the label IS the " +
      "measurement. Bean also grades LENGTH as a named axis (Regular/Tall) " +
      "alongside the numeric inseam — capture it separately, not as part of the size.",
    rows: [
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
      { size: "W40", measurements: { waist: "40" } },
    ],
  },
  {
    brand: "Mountain Hardwear",
    brandMatch: ["mountain hardwear", "mountainhardwear", "mhw"],
    department: "Men",
    garment: "Tops",
    categoryMatch: ["top", "jacket", "coat", "shell", "hoodie", "fleece", "vest", "down", "long sleeve"],
    note:
      "BODY measurements — NOT flat-garment. NOTE the intra-brand fit spread: the " +
      "Ghost Whisperer is cut trim as an ultralight layer while the Kor shells " +
      "allow layering room, so the same body chest can wear a different letter " +
      "across the lines. Standard outdoor-alpha approximation.",
    rows: [
      { size: "S", measurements: { chest: "35-38" } },
      { size: "M", measurements: { chest: "38-41" } },
      { size: "L", measurements: { chest: "42-45" } },
      { size: "XL", measurements: { chest: "46-49" } },
      { size: "XXL", measurements: { chest: "50-53" } },
    ],
  },
  {
    brand: "The North Face / Patagonia (outerwear)",
    // US-1734 narrowed this: Columbia + Arc'teryx now have their OWN charts
    // above, and leaving them here made the resolver return BOTH the shared row
    // and the brand row for one brand — two charts with the same numbers,
    // competing for the 3-chart prompt budget. Stays for the two brands that have
    // no own-brand chart. Mirrors the same narrowing in migration 00453.
    brandMatch: ["north face", "patagonia"],
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
  // US-1736: luxury & designer group. Mirrors migration 00455's brand_size_charts
  // seed. The group's whole point is that THREE national sizing systems are in
  // play and the same number means different sizes in each — a "42" is US 10 on a
  // Chanel FR tag but US 6 on a Prada IT tag. So every European chart carries its
  // US equivalent INSIDE the size label, where the model actually reads it, and
  // the three American brands say "US sizing" for the contrast.
  //
  // NOTE the short-token hazard (the US-1735 lesson): brandMatch is a SUBSTRING
  // test, so "mk" and "tory" are deliberately NOT here — they are exact-key
  // BRAND_ALIASES entries only, and these charts are reached via the canonical.
  {
    brand: "Chanel",
    brandMatch: ["chanel"],
    department: "Women",
    garment: "Jackets & tweed (FR sizing)",
    categoryMatch: ["jacket", "blazer", "coat", "tweed", "outerwear"],
    note:
      "Chanel is FRENCH sizing: the tag number is FR, and FR = US + 32 (FR 42 = " +
      "US 10). DO NOT read it as Italian — a 42 on a PRADA tag is IT 42 = US 6, " +
      "two sizes away. These are BODY measurements for the nominal FR grade, not " +
      "Chanel-published garment specs. Chanel RTW runs SMALL against this map: it " +
      "does not use US vanity sizing, so a US 6 body frequently needs FR 40. " +
      "Measure the garment flat and treat the tag as a claim to check.",
    rows: [
      { size: "FR 34 (US 2)", measurements: { bust: "33-34", waist: "25-26" } },
      { size: "FR 36 (US 4)", measurements: { bust: "34-35", waist: "26-27" } },
      { size: "FR 38 (US 6)", measurements: { bust: "35.5-36.5", waist: "27.5-28.5" } },
      { size: "FR 40 (US 8)", measurements: { bust: "37-38", waist: "29-30" } },
      { size: "FR 42 (US 10)", measurements: { bust: "38.5-39.5", waist: "30.5-31.5" } },
      { size: "FR 44 (US 12)", measurements: { bust: "40-41", waist: "32-33" } },
    ],
  },
  {
    brand: "Chanel",
    brandMatch: ["chanel"],
    department: "Women",
    garment: "Dresses & tops (FR sizing)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "shirt", "knit", "sweater"],
    note:
      "Chanel is FRENCH sizing (FR = US + 32; FR 42 = US 10). These are BODY " +
      "measurements for the nominal FR grade, not Chanel-published garment specs. " +
      "Chanel RTW runs SMALL against this map — no US vanity sizing. Measure the " +
      "garment flat and treat the tag as a claim to check.",
    rows: [
      { size: "FR 34 (US 2)", measurements: { bust: "33-34", waist: "25-26", hip: "35.5-36.5" } },
      { size: "FR 36 (US 4)", measurements: { bust: "34-35", waist: "26-27", hip: "36.5-37.5" } },
      { size: "FR 38 (US 6)", measurements: { bust: "35.5-36.5", waist: "27.5-28.5", hip: "38-39" } },
      { size: "FR 40 (US 8)", measurements: { bust: "37-38", waist: "29-30", hip: "39.5-40.5" } },
      { size: "FR 42 (US 10)", measurements: { bust: "38.5-39.5", waist: "30.5-31.5", hip: "41-42" } },
      { size: "FR 44 (US 12)", measurements: { bust: "40-41", waist: "32-33", hip: "42.5-43.5" } },
    ],
  },
  {
    brand: "Burberry",
    // "burberrys" (the pre-1999 label) CONTAINS "burberry", so the substring
    // match covers both spellings without a second token.
    brandMatch: ["burberry"],
    department: "Women",
    garment: "Trench & outerwear (UK sizing)",
    categoryMatch: ["trench", "coat", "jacket", "outerwear", "blazer"],
    note:
      "Burberry womenswear is UK sizing: UK = US + 4 (UK 12 = US 8). A UK 12 " +
      "trench is NOT a US 12 — mislabeling it costs two sizes. These are BODY " +
      "measurements for the nominal UK grade, not Burberry-published garment " +
      "specs, and Burberry runs SMALL against the cross-map. Measure the coat " +
      "flat (chest across the underarm seam, doubled).",
    rows: [
      { size: "UK 6 (US 2)", measurements: { bust: "33-34", waist: "25-26", hip: "35.5-36.5" } },
      { size: "UK 8 (US 4)", measurements: { bust: "34-35", waist: "26-27", hip: "36.5-37.5" } },
      { size: "UK 10 (US 6)", measurements: { bust: "35.5-36.5", waist: "27.5-28.5", hip: "38-39" } },
      { size: "UK 12 (US 8)", measurements: { bust: "37-38", waist: "29-30", hip: "39.5-40.5" } },
      { size: "UK 14 (US 10)", measurements: { bust: "38.5-39.5", waist: "30.5-31.5", hip: "41-42" } },
      { size: "UK 16 (US 12)", measurements: { bust: "40-41", waist: "32-33", hip: "42.5-43.5" } },
    ],
  },
  {
    brand: "Burberry",
    brandMatch: ["burberry"],
    department: "Men",
    garment: "Tailoring & outerwear (IT sizing)",
    categoryMatch: ["trench", "coat", "jacket", "blazer", "suit", "outerwear", "shirt"],
    note:
      "Burberry menswear tailoring is ITALIAN numeric: IT = US + 10 on the chest " +
      "(IT 50 = US 40). Note this is a DIFFERENT system from the same brand's " +
      "womenswear, which is UK. These are BODY chest measurements for the nominal " +
      "IT grade, not Burberry-published garment specs, and it runs SMALL against " +
      "the cross-map. Measure the chest across the underarm seam and double it.",
    rows: [
      { size: "IT 46 (US 36)", measurements: { chest: "36-37" } },
      { size: "IT 48 (US 38)", measurements: { chest: "38-39" } },
      { size: "IT 50 (US 40)", measurements: { chest: "40-41" } },
      { size: "IT 52 (US 42)", measurements: { chest: "42-43" } },
      { size: "IT 54 (US 44)", measurements: { chest: "44-45" } },
      { size: "IT 56 (US 46)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Prada",
    brandMatch: ["prada"],
    department: "Women",
    garment: "Ready-to-wear (IT sizing)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "jacket", "coat", "knit", "shirt", "sweater"],
    note:
      "Prada is ITALIAN sizing: IT = US + 36 on womenswear (IT 42 = US 6). DO NOT " +
      "read it as French — a 42 on a CHANEL tag is FR 42 = US 10, two sizes " +
      "larger. This collision is the most expensive mistake in this brand group. " +
      "These are BODY measurements for the nominal IT grade, not Prada-published " +
      "garment specs. Prada RTW runs SMALL against this map — no US vanity " +
      "sizing. Measure the garment flat and treat the tag as a claim to check.",
    rows: [
      { size: "IT 38 (US 2)", measurements: { bust: "33-34", waist: "25-26", hip: "35.5-36.5" } },
      { size: "IT 40 (US 4)", measurements: { bust: "34-35", waist: "26-27", hip: "36.5-37.5" } },
      { size: "IT 42 (US 6)", measurements: { bust: "35.5-36.5", waist: "27.5-28.5", hip: "38-39" } },
      { size: "IT 44 (US 8)", measurements: { bust: "37-38", waist: "29-30", hip: "39.5-40.5" } },
      { size: "IT 46 (US 10)", measurements: { bust: "38.5-39.5", waist: "30.5-31.5", hip: "41-42" } },
      { size: "IT 48 (US 12)", measurements: { bust: "40-41", waist: "32-33", hip: "42.5-43.5" } },
    ],
  },
  {
    brand: "Prada",
    brandMatch: ["prada"],
    department: "Men",
    garment: "Ready-to-wear (IT sizing)",
    categoryMatch: ["jacket", "coat", "blazer", "suit", "shirt", "knit", "sweater", "top"],
    note:
      "Prada menswear is ITALIAN numeric: IT = US + 10 on the chest (IT 50 = US " +
      "40). Note the menswear offset (+10) is NOT the womenswear offset (+36) — " +
      "they are different grades of the same national system. These are BODY " +
      "chest measurements for the nominal IT grade, not Prada-published garment " +
      "specs, and it runs SMALL against the cross-map. Measure the chest across " +
      "the underarm seam and double it.",
    rows: [
      { size: "IT 46 (US 36)", measurements: { chest: "36-37" } },
      { size: "IT 48 (US 38)", measurements: { chest: "38-39" } },
      { size: "IT 50 (US 40)", measurements: { chest: "40-41" } },
      { size: "IT 52 (US 42)", measurements: { chest: "42-43" } },
      { size: "IT 54 (US 44)", measurements: { chest: "44-45" } },
      { size: "IT 56 (US 46)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Michael Kors",
    brandMatch: ["michael kors", "michaelkors"],
    department: "Women",
    garment: "Tops & dresses (US sizing)",
    categoryMatch: ["top", "dress", "blouse", "shirt", "knit", "sweater", "jacket", "blazer"],
    note:
      "Michael Kors is US sizing — NOT the FR/IT/UK systems the European half of " +
      "this brand group uses, so no cross-map applies. It runs true-to-large, the " +
      "opposite of Chanel/Prada/Burberry. These are BODY measurements for the " +
      "nominal US alpha grade, not MK-published garment specs. Sizing does NOT " +
      "differ between the Collection and MICHAEL lines — the line changes the " +
      "price, not the fit.",
    rows: [
      { size: "XS (US 0-2)", measurements: { bust: "32-34", waist: "24-26" } },
      { size: "S (US 4-6)", measurements: { bust: "34-36.5", waist: "26-28.5" } },
      { size: "M (US 8-10)", measurements: { bust: "37-39.5", waist: "29-31.5" } },
      { size: "L (US 12-14)", measurements: { bust: "40-42.5", waist: "32-34.5" } },
      { size: "XL (US 16)", measurements: { bust: "43-45", waist: "35-37" } },
    ],
  },
  {
    brand: "Michael Kors",
    brandMatch: ["michael kors", "michaelkors"],
    department: "Women",
    garment: "Bottoms (US numeric)",
    categoryMatch: ["bottom", "pant", "jean", "skirt", "short", "trouser", "legging"],
    note:
      "Michael Kors is US sizing — no national cross-map applies, unlike the " +
      "European half of this brand group — and it runs true-to-large. These are " +
      "BODY measurements for the nominal US numeric grade, not MK-published " +
      "garment specs. Measure the flat waistband and double it.",
    rows: [
      { size: "US 0", measurements: { waist: "24-25", hip: "34.5-35.5" } },
      { size: "US 2", measurements: { waist: "25-26", hip: "35.5-36.5" } },
      { size: "US 4", measurements: { waist: "26-27", hip: "36.5-37.5" } },
      { size: "US 6", measurements: { waist: "27.5-28.5", hip: "38-39" } },
      { size: "US 8", measurements: { waist: "29-30", hip: "39.5-40.5" } },
      { size: "US 10", measurements: { waist: "30.5-31.5", hip: "41-42" } },
      { size: "US 12", measurements: { waist: "32-33", hip: "42.5-43.5" } },
    ],
  },
  {
    brand: "Kate Spade",
    brandMatch: ["kate spade", "katespade"],
    department: "Women",
    garment: "Dresses (US numeric)",
    categoryMatch: ["dress", "gown", "jumpsuit"],
    note:
      "Kate Spade is US sizing — no national cross-map applies, unlike the " +
      "European half of this brand group — and it runs true-to-large. These are " +
      "BODY measurements for the nominal US numeric grade, not Kate " +
      "Spade-published garment specs. Mainline, outlet and the discontinued " +
      "Saturday label share the same size grade — the LINE changes the price, not " +
      "the fit.",
    rows: [
      { size: "US 0", measurements: { bust: "32-33", waist: "24-25", hip: "34.5-35.5" } },
      { size: "US 2", measurements: { bust: "33-34", waist: "25-26", hip: "35.5-36.5" } },
      { size: "US 4", measurements: { bust: "34-35", waist: "26-27", hip: "36.5-37.5" } },
      { size: "US 6", measurements: { bust: "35.5-36.5", waist: "27.5-28.5", hip: "38-39" } },
      { size: "US 8", measurements: { bust: "37-38", waist: "29-30", hip: "39.5-40.5" } },
      { size: "US 10", measurements: { bust: "38.5-39.5", waist: "30.5-31.5", hip: "41-42" } },
      { size: "US 12", measurements: { bust: "40-41", waist: "32-33", hip: "42.5-43.5" } },
    ],
  },
  {
    brand: "Kate Spade",
    brandMatch: ["kate spade", "katespade"],
    department: "Women",
    garment: "Tops & knits (US alpha)",
    categoryMatch: ["top", "blouse", "shirt", "knit", "sweater", "cardigan", "jacket"],
    note:
      "Kate Spade is US sizing — no national cross-map applies — and it runs " +
      "true-to-large. These are BODY measurements for the nominal US alpha grade, " +
      "not Kate Spade-published garment specs. Measure the garment flat (bust " +
      "across the underarm seam, doubled).",
    rows: [
      { size: "XS (US 0-2)", measurements: { bust: "32-34", waist: "24-26" } },
      { size: "S (US 4-6)", measurements: { bust: "34-36.5", waist: "26-28.5" } },
      { size: "M (US 8-10)", measurements: { bust: "37-39.5", waist: "29-31.5" } },
      { size: "L (US 12-14)", measurements: { bust: "40-42.5", waist: "32-34.5" } },
      { size: "XL (US 16)", measurements: { bust: "43-45", waist: "35-37" } },
    ],
  },
  {
    brand: "Tory Burch",
    brandMatch: ["tory burch", "toryburch"],
    department: "Women",
    garment: "Tops & dresses (US numeric)",
    categoryMatch: ["top", "dress", "blouse", "shirt", "knit", "sweater", "jacket", "blazer", "tunic"],
    note:
      "Tory Burch is US sizing — no national cross-map applies, unlike the " +
      "European half of this brand group — and it runs true-to-large. These are " +
      "BODY measurements for the nominal US numeric grade, not Tory " +
      "Burch-published garment specs. Measure the garment flat (bust across the " +
      "underarm seam, doubled).",
    rows: [
      { size: "US 0", measurements: { bust: "32-33", waist: "24-25", hip: "34.5-35.5" } },
      { size: "US 2", measurements: { bust: "33-34", waist: "25-26", hip: "35.5-36.5" } },
      { size: "US 4", measurements: { bust: "34-35", waist: "26-27", hip: "36.5-37.5" } },
      { size: "US 6", measurements: { bust: "35.5-36.5", waist: "27.5-28.5", hip: "38-39" } },
      { size: "US 8", measurements: { bust: "37-38", waist: "29-30", hip: "39.5-40.5" } },
      { size: "US 10", measurements: { bust: "38.5-39.5", waist: "30.5-31.5", hip: "41-42" } },
      { size: "US 12", measurements: { bust: "40-41", waist: "32-33", hip: "42.5-43.5" } },
    ],
  },
  {
    brand: "Tory Burch",
    brandMatch: ["tory burch", "toryburch"],
    department: "Women",
    garment: "Bottoms (US numeric)",
    categoryMatch: ["bottom", "pant", "jean", "skirt", "short", "trouser", "legging"],
    note:
      "Tory Burch is US sizing — no national cross-map applies — and it runs " +
      "true-to-large. These are BODY measurements for the nominal US numeric " +
      "grade, not Tory Burch-published garment specs. Measure the flat waistband " +
      "and double it.",
    rows: [
      { size: "US 0", measurements: { waist: "24-25", hip: "34.5-35.5" } },
      { size: "US 2", measurements: { waist: "25-26", hip: "35.5-36.5" } },
      { size: "US 4", measurements: { waist: "26-27", hip: "36.5-37.5" } },
      { size: "US 6", measurements: { waist: "27.5-28.5", hip: "38-39" } },
      { size: "US 8", measurements: { waist: "29-30", hip: "39.5-40.5" } },
      { size: "US 10", measurements: { waist: "30.5-31.5", hip: "41-42" } },
      { size: "US 12", measurements: { waist: "32-33", hip: "42.5-43.5" } },
    ],
  },
  // US-1737: streetwear & hype group. Mirrors migration 00456's brand_size_charts
  // seed. THE GROUP'S SIGNATURE TRAP LIVES HERE: every chart in this pack is
  // labeled with an ordinary alpha letter, and the letter lies in OPPOSITE
  // directions — a BAPE L is roughly a US M (Japanese sizing, runs small) while an
  // Essentials L drapes like a US XL (deliberately oversized). Unlike 00455's
  // "IT 42", nothing on the tag announces which system it is, so the BAPE and
  // Essentials charts carry their US equivalent INSIDE THE SIZE LABEL, where the
  // model actually reads it.
  //
  // NO CHART FOR MAINLINE "Fear of God", on purpose and for two independent
  // reasons: its sizing is collection-specific and unpublished (a chart would be
  // invention), AND brandMatch is a SUBSTRING test — "fear of god essentials"
  // CONTAINS "fear of god", so a mainline chart would also fire on every
  // Essentials garment and hand it the wrong numbers. Mainline falls through to
  // the generics, as Coach/LV/Gucci do. Guarded by streetwear-content_test.ts.
  {
    brand: "Supreme",
    brandMatch: ["supreme"],
    department: "Men",
    garment: "Tops (tees & hoodies, US alpha)",
    categoryMatch: ["tee", "t-shirt", "shirt", "top", "hoodie", "sweatshirt", "crewneck", "hooded"],
    note:
      "Supreme is US alpha sizing — no national cross-map applies, unlike BAPE in " +
      "this same group, whose L is roughly a US M. The cut is BOXY BY DESIGN: a " +
      "Supreme tee is meant to be short and wide, so a wide flat measurement is the " +
      "intended silhouette and NOT a mislabel, NOT stretching and NOT a defect. " +
      "These are body-equivalent figures for the nominal streetwear grade, not " +
      "Supreme-published specs. Measure the garment flat (chest across the underarm " +
      "seam, doubled). Sizing does not change by season — the SEASON changes the " +
      "price, not the fit.",
    rows: [
      { size: "S", measurements: { chest: "36-38", length: "27-28" } },
      { size: "M", measurements: { chest: "38-40", length: "28-29" } },
      { size: "L", measurements: { chest: "42-44", length: "29-30" } },
      { size: "XL", measurements: { chest: "46-48", length: "30-31" } },
      { size: "XXL", measurements: { chest: "50-52", length: "31-32" } },
    ],
  },
  {
    brand: "Supreme",
    brandMatch: ["supreme"],
    department: "Men",
    garment: "Bottoms (US numeric waist)",
    categoryMatch: ["bottom", "pant", "jean", "short", "trouser", "sweatpant", "cargo"],
    note:
      "Supreme bottoms are US NOMINAL WAIST — the label is a measurement, not a " +
      "letter mapped onto a body (the denim exception applies here too). Cut " +
      "relaxed by design. Measure the flat waistband and double it.",
    rows: [
      { size: "US 28", measurements: { waist: "28-29" } },
      { size: "US 30", measurements: { waist: "30-31" } },
      { size: "US 32", measurements: { waist: "32-33" } },
      { size: "US 34", measurements: { waist: "34-35" } },
      { size: "US 36", measurements: { waist: "36-37" } },
    ],
  },
  {
    brand: "Stüssy",
    // BOTH spellings are required. brandKey() strips the umlaut (the KB key is
    // 'stssy'), but norm() here only LOWERCASES — so the canonical "Stüssy" that
    // brand-knowledge.ts passes in arrives as "stüssy" and would never match a
    // plain "stussy" token. Raw seller text ("stussy") needs the other one.
    brandMatch: ["stussy", "stüssy"],
    department: "Men",
    garment: "Tops (tees & fleece, US alpha)",
    categoryMatch: ["tee", "t-shirt", "shirt", "top", "hoodie", "sweatshirt", "crewneck", "fleece", "hooded"],
    note:
      "Stüssy is US alpha sizing — no national cross-map applies, unlike BAPE in " +
      "this same group. Cut relaxed/boxy by design, which is the intended " +
      "silhouette and not a mislabel. These are body-equivalent figures for the " +
      "nominal streetwear grade, not Stüssy-published specs. Measure the garment " +
      "flat (chest across the underarm seam, doubled). NOTE vintage pieces were " +
      "graded differently from current production, so on this brand especially the " +
      "tag is a claim to check against the actual measurement.",
    rows: [
      { size: "S", measurements: { chest: "36-38", length: "27-28" } },
      { size: "M", measurements: { chest: "38-40", length: "28-29" } },
      { size: "L", measurements: { chest: "42-44", length: "29-30" } },
      { size: "XL", measurements: { chest: "46-48", length: "30-31" } },
      { size: "XXL", measurements: { chest: "50-52", length: "31-32" } },
    ],
  },
  {
    brand: "BAPE",
    brandMatch: ["bape", "a bathing ape", "bathing ape"],
    department: "Men",
    garment: "Tops (JAPANESE sizing)",
    categoryMatch: ["tee", "t-shirt", "shirt", "top", "hoodie", "sweatshirt", "crewneck", "fleece", "hooded", "jacket"],
    note:
      "BAPE is JAPANESE sizing and it runs SMALL against a US body: a BAPE L is " +
      "roughly a US M — one full size down. THIS IS THE GROUP'S COSTLIEST SIZING " +
      "ERROR because nothing on the tag announces it. The tag says only \"L\", " +
      "exactly like the Supreme and Essentials tags in this same pack, and those " +
      "mean completely different bodies — an Essentials L drapes like a US XL, two " +
      "sizes the OTHER way. That is why the US equivalent is written into the size " +
      "label here. These are body-equivalent figures for the nominal JP grade, not " +
      "BAPE-published specs. Measure the garment flat (chest across the underarm " +
      "seam, doubled) and treat the tag as a claim to check. Does not apply to the " +
      "Bapesta, which is a shoe.",
    rows: [
      { size: "JP S (≈US XS)", measurements: { chest: "34-36", length: "25-26" } },
      { size: "JP M (≈US S)", measurements: { chest: "36-38", length: "26-27" } },
      { size: "JP L (≈US M)", measurements: { chest: "38-40", length: "27-28" } },
      { size: "JP XL (≈US L)", measurements: { chest: "42-44", length: "28-29" } },
      { size: "JP XXL (≈US XL)", measurements: { chest: "46-48", length: "29-30" } },
    ],
  },
  {
    brand: "Kith",
    brandMatch: ["kith"],
    department: "Men",
    garment: "Tops (tees & fleece, US alpha)",
    categoryMatch: ["tee", "t-shirt", "shirt", "top", "hoodie", "sweatshirt", "crewneck", "fleece", "hooded"],
    note:
      "Kith is US alpha sizing — no national cross-map applies, unlike BAPE in this " +
      "same group. The house line is cut fuller than a standard tee but nothing " +
      "like the Essentials drape, which is a different brand in this same pack. " +
      "These are body-equivalent figures for the nominal grade, not Kith-published " +
      "specs. Measure the garment flat (chest across the underarm seam, doubled). A " +
      "COLLABORATION does not change the fit — it changes the price.",
    rows: [
      { size: "S", measurements: { chest: "37-39", length: "27-28" } },
      { size: "M", measurements: { chest: "39-41", length: "28-29" } },
      { size: "L", measurements: { chest: "43-45", length: "29-30" } },
      { size: "XL", measurements: { chest: "47-49", length: "30-31" } },
      { size: "XXL", measurements: { chest: "51-53", length: "31-32" } },
    ],
  },
  {
    brand: "Palace",
    brandMatch: ["palace", "palace skateboards"],
    department: "Men",
    garment: "Tops (tees & fleece, US alpha)",
    categoryMatch: ["tee", "t-shirt", "shirt", "top", "hoodie", "sweatshirt", "crewneck", "fleece", "hooded"],
    note:
      "Palace is a UK brand on US alpha sizing — despite the origin, no national " +
      "cross-map applies here (contrast BAPE in this same group, whose L is " +
      "roughly a US M). Cut boxy by design, which is the intended skate " +
      "silhouette and not a mislabel. These are body-equivalent figures for the " +
      "nominal streetwear grade, not Palace-published specs. Measure the garment " +
      "flat (chest across the underarm seam, doubled).",
    rows: [
      { size: "S", measurements: { chest: "36-38", length: "27-28" } },
      { size: "M", measurements: { chest: "38-40", length: "28-29" } },
      { size: "L", measurements: { chest: "42-44", length: "29-30" } },
      { size: "XL", measurements: { chest: "46-48", length: "30-31" } },
      { size: "XXL", measurements: { chest: "50-52", length: "31-32" } },
    ],
  },
  {
    brand: "Fear of God Essentials",
    // NOT ["essentials"] — that is an ordinary retail word (adidas/Nike/H&M all
    // ship an "Essentials" line) and brandMatch is a SUBSTRING test, so it would
    // hand this brand's charts to every one of them.
    brandMatch: ["fear of god essentials", "fearofgodessentials", "essentials by fear of god"],
    department: "Unisex",
    garment: "Tops (OVERSIZED, alpha)",
    categoryMatch: ["tee", "t-shirt", "shirt", "top", "hoodie", "sweatshirt", "crewneck", "fleece", "hooded"],
    note:
      "Fear of God Essentials is cut DELIBERATELY OVERSIZED — dropped shoulders, " +
      "boxy body — so an Essentials L drapes like a US XL, roughly one size up. " +
      "THAT DRAPE IS THE DESIGN: it is not stretching, not a mislabel, not 'runs " +
      "large' as an error, and it must NOT be graded as wear. The drape is written " +
      "into the size label because nothing on the tag announces it — the tag says " +
      "only \"L\", and a BAPE L in this same group is a US M, two sizes the OTHER " +
      "way. No national cross-map applies. These are body-equivalent figures for " +
      "the nominal grade, not brand-published specs. Measure the garment flat " +
      "(chest across the underarm seam, doubled). Sizing does not differ by season " +
      "— the season changes the price, not the fit.",
    rows: [
      { size: "XS (drapes ≈US S)", measurements: { chest: "38-40", length: "26-27" } },
      { size: "S (drapes ≈US M)", measurements: { chest: "42-44", length: "27-28" } },
      { size: "M (drapes ≈US L)", measurements: { chest: "46-48", length: "28-29" } },
      { size: "L (drapes ≈US XL)", measurements: { chest: "50-52", length: "29-30" } },
      { size: "XL (drapes ≈US XXL)", measurements: { chest: "54-56", length: "30-31" } },
    ],
  },
  {
    brand: "Fear of God Essentials",
    brandMatch: ["fear of god essentials", "fearofgodessentials", "essentials by fear of god"],
    department: "Unisex",
    garment: "Bottoms (OVERSIZED, alpha)",
    categoryMatch: ["bottom", "pant", "sweatpant", "jogger", "short", "trouser"],
    note:
      "Fear of God Essentials bottoms are cut DELIBERATELY OVERSIZED and the volume " +
      "is the design, not a fit error — do not grade it as wear. Elasticated waists " +
      "measure relaxed, so the figures are a range rather than a nominal waist. No " +
      "national cross-map applies. Measure the flat waistband relaxed and double it.",
    rows: [
      { size: "XS (drapes ≈US S)", measurements: { waist: "26-28" } },
      { size: "S (drapes ≈US M)", measurements: { waist: "28-31" } },
      { size: "M (drapes ≈US L)", measurements: { waist: "31-34" } },
      { size: "L (drapes ≈US XL)", measurements: { waist: "34-37" } },
      { size: "XL (drapes ≈US XXL)", measurements: { waist: "37-40" } },
    ],
  },
  // US-1738: contemporary women's group. Mirrors migration 00457's
  // brand_size_charts seed — WITH ONE DELIBERATE OMISSION, see below.
  //
  // THE GROUP'S SIGNATURE TRAP LIVES HERE, and this pack lies in THREE directions
  // rather than 00456's two, none of which announces itself on the tag:
  //
  //     Sézane         FR 38 = US 6   — French national sizing; the number lies.
  //     Aritzia        runs SMALL     — starts at 00/XXS; an Aritzia S ≈ US 2-4.
  //     Eileen Fisher  runs LARGE     — an EF M drapes like a US L.
  //
  // So an "M" means different bodies on Aritzia and Eileen Fisher, and a "38" on
  // Sézane is a US 6. Every cross-map is written INSIDE THE SIZE LABEL, where the
  // model actually reads it (the 00455 lesson — a note alone does not survive
  // into the rendered table).
  //
  // NO CHART FOR "Vince", on purpose — the first time this epic has given a brand
  // a DB chart and deliberately withheld the in-code mirror. The two lookups do
  // not match the same way: brand_size_charts is fetched by EXACT brand_key, so
  // 00457's 'vince' row can never reach brandKey("Vince Camuto") = "vincecamuto";
  // but findSizingCharts is a SUBSTRING test, and "vince camuto".includes("vince")
  // is TRUE. VINCE CAMUTO IS A DIFFERENT COMPANY (Camuto Group), not a diffusion
  // line — so an in-code ["vince"] chart would hand an unrelated brand's garments
  // Vince's numbers. No narrowing fixes it: there is no token unique to the
  // shorter name (the 00456 Fear of God finding). Vince therefore falls through to
  // the generics here, as Coach/LV/Gucci do, and gets its real chart from the DB.
  // Guarded by contemporary-womens-content_test.ts.
  //
  // Also note the ANTHROPOLOGIE and ARITZIA charts are reached via the CANONICAL
  // brand, which is what brand-knowledge.ts passes: the house labels (Maeve,
  // Wilfred, Babaton, TNA…) canonicalize to the parent in brand-normalize.ts and
  // must never appear in brandMatch — "tna" is a three-letter substring hazard of
  // exactly the AG kind, and "moth" is a garment-DAMAGE word.
  {
    brand: "Anthropologie",
    brandMatch: ["anthropologie"],
    department: "Women",
    garment: "Tops & dresses (US alpha)",
    categoryMatch: [
      "top", "tee", "shirt", "blouse", "dress", "knit", "sweater", "cardigan",
      "jacket", "long sleeve",
    ],
    note:
      "Anthropologie is US women's sizing and grades close to a general US " +
      "contemporary body — no national cross-map applies (contrast Sézane in this " +
      "same group, whose FR 38 is a US 6). The US numeric equivalent is carried in " +
      "the size label because Anthropologie labels BOTH ways depending on the house " +
      "line. REMEMBER THE TAG USUALLY SAYS A HOUSE LABEL — Maeve, Pilcro, Moth, " +
      "Daily Practice — and not \"Anthropologie\"; the house label is the STYLE and " +
      "this chart applies to all of them. It does NOT apply to a THIRD-PARTY brand " +
      "bought at Anthropologie, which keeps its own brand and its own sizing. These " +
      "are body-equivalent figures for the nominal grade, not Anthropologie-published " +
      "specs. Measure the garment flat (bust across the underarm seam, doubled).",
    rows: [
      { size: "XS (US 0-2)", measurements: { bust: "32-33.5", waist: "25-26.5" } },
      { size: "S (US 4-6)", measurements: { bust: "34.5-35.5", waist: "27-28.5" } },
      { size: "M (US 8-10)", measurements: { bust: "36.5-38", waist: "29.5-31" } },
      { size: "L (US 12-14)", measurements: { bust: "39.5-41", waist: "32.5-34" } },
      { size: "XL (US 16)", measurements: { bust: "42.5-44", waist: "35.5-37" } },
    ],
  },
  {
    brand: "Anthropologie",
    brandMatch: ["anthropologie"],
    department: "Women",
    garment: "Bottoms (US numeric waist)",
    categoryMatch: ["bottom", "pant", "jean", "denim", "short", "trouser", "skirt", "legging"],
    note:
      "Anthropologie bottoms (largely the PILCRO house denim line — the tag says " +
      "PILCRO, not \"Anthropologie\") are US NOMINAL WAIST: the label is a " +
      "measurement, not a letter mapped onto a body. No national cross-map applies. " +
      "These are nominal figures, not published specs. Measure the flat waistband " +
      "and double it.",
    rows: [
      { size: "US 24", measurements: { waist: "24-25", hip: "34-35" } },
      { size: "US 26", measurements: { waist: "26-27", hip: "36-37" } },
      { size: "US 28", measurements: { waist: "28-29", hip: "38-39" } },
      { size: "US 30", measurements: { waist: "30-31", hip: "40-41" } },
      { size: "US 32", measurements: { waist: "32-33", hip: "42-43" } },
    ],
  },
  {
    brand: "Sézane",
    // norm() only LOWERCASES — it does NOT strip accents, while brandKey() strips
    // the "é" entirely (which is why 00457 keys the row 'szane'). The canonical
    // brand-knowledge.ts passes in is the ACCENTED "Sézane", so that spelling MUST
    // be here or the chart is never found; the plain spelling covers raw seller
    // text. Same trap as Stüssy (00456).
    brandMatch: ["sézane", "sezane"],
    department: "Women",
    garment: "Tops & dresses (FRENCH sizing)",
    categoryMatch: [
      "top", "tee", "shirt", "blouse", "dress", "knit", "sweater", "cardigan",
      "jacket", "long sleeve",
    ],
    note:
      "Sézane is a Paris brand on FRENCH national sizing and it runs SMALL against " +
      "a US body: FR 38 is a US 6 — the tag carries a BARE NUMBER that is not a US " +
      "size and not an alpha, and nothing on it says \"FR\". This is the same " +
      "national-system trap as Chanel's FR and Prada's IT tags, which is why the US " +
      "equivalent is written into the size label rather than left in a note. Within " +
      "this same pack Aritzia and Eileen Fisher are alpha-labeled and lie in two " +
      "further directions, so no single \"contemporary womens runs X\" rule holds. " +
      "These are body-equivalent figures for the nominal FR grade, not " +
      "Sézane-published specs. Measure the garment flat (bust across the underarm " +
      "seam, doubled).",
    rows: [
      { size: "FR 34 (US 2)", measurements: { bust: "32-33", waist: "25-26" } },
      { size: "FR 36 (US 4)", measurements: { bust: "33.5-34.5", waist: "26.5-27.5" } },
      { size: "FR 38 (US 6)", measurements: { bust: "35-36", waist: "28-29" } },
      { size: "FR 40 (US 8)", measurements: { bust: "36.5-38", waist: "29.5-31" } },
      { size: "FR 42 (US 10)", measurements: { bust: "38.5-40", waist: "31.5-33" } },
      { size: "FR 44 (US 12)", measurements: { bust: "40.5-42", waist: "33.5-35" } },
    ],
  },
  {
    brand: "Aritzia",
    brandMatch: ["aritzia"],
    department: "Women",
    garment: "Tops & dresses (alpha, RUNS SMALL)",
    categoryMatch: [
      "top", "tee", "shirt", "blouse", "dress", "knit", "sweater", "cardigan",
      "jacket", "long sleeve", "puffer",
    ],
    note:
      "Aritzia RUNS SMALL against a general US contemporary body and its range " +
      "starts at 00/XXS — an Aritzia S sits near a US 2-4, roughly one size down. " +
      "The US numeric equivalent is written into the size label because the tag says " +
      "only a letter and gives no warning. THIS IS ONE OF THE GROUP'S TWO ALPHA " +
      "DIRECTIONS: within this same pack an Eileen Fisher M drapes like a US L, the " +
      "OPPOSITE way, and both tags just say \"M\". No national cross-map applies " +
      "(contrast Sézane, whose FR 38 is a US 6). REMEMBER THE TAG SAYS THE SUB-LABEL " +
      "— Wilfred, Wilfred Free, Babaton, TNA, Sunday Best — and not \"Aritzia\"; the " +
      "sub-label is the STYLE and this chart applies to all of them. These are " +
      "body-equivalent figures for the nominal grade, not Aritzia-published specs. " +
      "Measure the garment flat (bust across the underarm seam, doubled).",
    rows: [
      { size: "XXS (US 00)", measurements: { bust: "30.5-31.5", waist: "23.5-24.5" } },
      { size: "XS (US 0-2)", measurements: { bust: "32-33", waist: "25-26" } },
      { size: "S (US 2-4)", measurements: { bust: "33.5-35", waist: "26.5-28" } },
      { size: "M (US 6-8)", measurements: { bust: "35.5-37", waist: "28.5-30" } },
      { size: "L (US 10-12)", measurements: { bust: "38-39.5", waist: "31-32.5" } },
      { size: "XL (US 14)", measurements: { bust: "40.5-42", waist: "33.5-35" } },
    ],
  },
  {
    brand: "Aritzia",
    brandMatch: ["aritzia"],
    department: "Women",
    garment: "Bottoms (US numeric waist)",
    categoryMatch: [
      "bottom", "pant", "jean", "denim", "short", "trouser", "skirt", "legging",
      "sweatpant", "jogger",
    ],
    note:
      "Aritzia bottoms (largely the SUNDAY BEST denim line — the tag says SUNDAY " +
      "BEST, not \"Aritzia\") are US NOMINAL WAIST: the label is a measurement " +
      "rather than a letter mapped onto a body, so the runs-small alpha caveat does " +
      "NOT apply to them. The range starts at 23. No national cross-map applies. " +
      "These are nominal figures, not published specs. Measure the flat waistband " +
      "and double it.",
    rows: [
      { size: "US 23", measurements: { waist: "23-24", hip: "33-34" } },
      { size: "US 24", measurements: { waist: "24-25", hip: "34-35" } },
      { size: "US 26", measurements: { waist: "26-27", hip: "36-37" } },
      { size: "US 28", measurements: { waist: "28-29", hip: "38-39" } },
      { size: "US 30", measurements: { waist: "30-31", hip: "40-41" } },
      { size: "US 32", measurements: { waist: "32-33", hip: "42-43" } },
    ],
  },
  {
    brand: "Reformation",
    brandMatch: ["reformation"],
    department: "Women",
    garment: "Dresses & tops (US numeric)",
    categoryMatch: [
      "dress", "top", "tee", "shirt", "blouse", "knit", "sweater", "cardigan",
      "jacket", "long sleeve",
    ],
    note:
      "Reformation is US women's NUMERIC sizing (0-12) on a fitted, dress-led cut — " +
      "no national cross-map applies (contrast Sézane in this same group, whose bare " +
      "\"38\" is a US 6, not a US 38: the two look alike on a tag and are not). The " +
      "house cut is close-fitting rather than relaxed, so a snug flat measurement is " +
      "the intended silhouette and NOT a mislabel. These are body-equivalent figures " +
      "for the nominal grade, not Reformation-published specs. Measure the garment " +
      "flat (bust across the underarm seam, doubled). The STYLE NAME changes the " +
      "price, not the fit — a Juliette and any other named dress in the same size " +
      "are the same grade.",
    rows: [
      { size: "US 0", measurements: { bust: "32-33", waist: "25-26" } },
      { size: "US 2", measurements: { bust: "33.5-34.5", waist: "26.5-27.5" } },
      { size: "US 4", measurements: { bust: "35-36", waist: "28-29" } },
      { size: "US 6", measurements: { bust: "36.5-37.5", waist: "29.5-30.5" } },
      { size: "US 8", measurements: { bust: "38-39.5", waist: "31-32.5" } },
      { size: "US 10", measurements: { bust: "40-41.5", waist: "33-34.5" } },
      { size: "US 12", measurements: { bust: "42-43.5", waist: "35-36.5" } },
    ],
  },
  {
    brand: "Theory",
    brandMatch: ["theory"],
    department: "Women",
    garment: "Tops & tailoring (US alpha)",
    categoryMatch: [
      "top", "tee", "shirt", "blouse", "knit", "sweater", "cardigan", "blazer",
      "jacket", "suit", "long sleeve",
    ],
    note:
      "Theory is US women's sizing on a TAILORED cut — no national cross-map applies " +
      "(contrast Sézane in this same group, whose FR 38 is a US 6). BUT: a THEORY " +
      "LUXE tag is the JAPANESE-market line and is sized on the Japanese grade, so " +
      "this chart does NOT apply to it — read the full label. THEYSKENS' THEORY does " +
      "fold here (it is a Theory line). THE FABRIC PLATFORM changes the price, not " +
      "the fit: a Good Wool blazer and a Precision Ponte blazer in the same size are " +
      "the same grade. These are body-equivalent figures for the nominal grade, not " +
      "Theory-published specs. Measure the garment flat (bust across the underarm " +
      "seam, doubled).",
    rows: [
      { size: "XS (US 0-2)", measurements: { bust: "32-33.5", waist: "25-26.5" } },
      { size: "S (US 4-6)", measurements: { bust: "34.5-35.5", waist: "27-28.5" } },
      { size: "M (US 8-10)", measurements: { bust: "36.5-38", waist: "29.5-31" } },
      { size: "L (US 12-14)", measurements: { bust: "39.5-41", waist: "32.5-34" } },
    ],
  },
  {
    brand: "Theory",
    brandMatch: ["theory"],
    department: "Women",
    garment: "Bottoms (US numeric)",
    categoryMatch: ["bottom", "pant", "trouser", "short", "skirt", "jean", "denim"],
    note:
      "Theory bottoms are US women's NUMERIC sizing (0-12) — a size number mapped " +
      "onto a body, NOT a nominal waist measurement like the denim brands, so do not " +
      "read a \"4\" as a 4-inch anything. No national cross-map applies. These are " +
      "body-equivalent figures, not published specs. Measure the flat waistband and " +
      "double it.",
    rows: [
      { size: "US 0", measurements: { waist: "25-26", hip: "34-35" } },
      { size: "US 2", measurements: { waist: "26-27", hip: "35-36" } },
      { size: "US 4", measurements: { waist: "27.5-28.5", hip: "36.5-37.5" } },
      { size: "US 6", measurements: { waist: "29-30", hip: "38-39" } },
      { size: "US 8", measurements: { waist: "30.5-31.5", hip: "39.5-40.5" } },
      { size: "US 10", measurements: { waist: "32-33", hip: "41-42" } },
      { size: "US 12", measurements: { waist: "33.5-34.5", hip: "42.5-43.5" } },
    ],
  },
  {
    brand: "Eileen Fisher",
    brandMatch: ["eileen fisher", "eileenfisher"],
    department: "Women",
    garment: "Tops & knits (alpha, RUNS LARGE)",
    categoryMatch: [
      "top", "tee", "shirt", "blouse", "knit", "sweater", "cardigan", "dress",
      "jacket", "tunic", "long sleeve",
    ],
    note:
      "Eileen Fisher RUNS LARGE: the cut is DELIBERATELY RELAXED and boxy across the " +
      "whole line — dropped shoulders, straight bodies, generous ease — so an Eileen " +
      "Fisher M drapes like a US L, roughly one size up. THAT DRAPE IS THE DESIGN: " +
      "it is not stretching, not wear, not a mislabel, and it must NOT be graded as " +
      "a defect — a garment hanging away from the body is INTACT and correctly " +
      "labeled. The drape is written into the size label because nothing on the tag " +
      "announces it: the tag says only \"M\", and an Aritzia M in this same group is " +
      "a US 6-8, the OTHER direction. No national cross-map applies (contrast " +
      "Sézane, whose FR 38 is a US 6). These are body-equivalent figures for the " +
      "nominal grade, not Eileen Fisher-published specs. Measure the garment flat " +
      "(bust across the underarm seam, doubled).",
    rows: [
      { size: "XXS (drapes ≈US 0)", measurements: { bust: "33-34", waist: "26-27" } },
      { size: "XS (drapes ≈US 2-4)", measurements: { bust: "35-36.5", waist: "28-29.5" } },
      { size: "S (drapes ≈US 6-8)", measurements: { bust: "37.5-39", waist: "30.5-32" } },
      { size: "M (drapes ≈US 10-12)", measurements: { bust: "40-41.5", waist: "33-34.5" } },
      { size: "L (drapes ≈US 14-16)", measurements: { bust: "42.5-44", waist: "35.5-37" } },
      { size: "XL (drapes ≈US 18)", measurements: { bust: "45-46.5", waist: "38-39.5" } },
    ],
  },
  {
    brand: "Eileen Fisher",
    brandMatch: ["eileen fisher", "eileenfisher"],
    department: "Women",
    garment: "Bottoms (alpha, RUNS LARGE)",
    categoryMatch: ["bottom", "pant", "trouser", "short", "skirt", "legging", "ankle pant"],
    note:
      "Eileen Fisher bottoms are cut DELIBERATELY RELAXED and the volume is the " +
      "design, not a fit error — do not grade it as wear. Most are pull-on with an " +
      "elasticated waist, so the figures are a relaxed range rather than a nominal " +
      "waist. No national cross-map applies. These are body-equivalent figures, not " +
      "published specs. Measure the flat waistband relaxed and double it.",
    rows: [
      { size: "XXS (drapes ≈US 0)", measurements: { waist: "25-27" } },
      { size: "XS (drapes ≈US 2-4)", measurements: { waist: "27-29.5" } },
      { size: "S (drapes ≈US 6-8)", measurements: { waist: "29.5-32" } },
      { size: "M (drapes ≈US 10-12)", measurements: { waist: "32-34.5" } },
      { size: "L (drapes ≈US 14-16)", measurements: { waist: "34.5-37" } },
      { size: "XL (drapes ≈US 18)", measurements: { waist: "37-39.5" } },
    ],
  },
  // ── US-1739: basics, mall & fast-fashion group ─────────────────────────────
  // Mirrors migration 00458's brand_size_charts seed (the DB rows win when the
  // pack loads; these are the offline fallback).
  //
  // THE PACK'S SIZING STORY IS THE SPREAD, and it is why these belong together:
  // every one of these tags says the same letters and they mean different bodies.
  //
  //     Uniqlo          runs SMALL  — Japanese grade, slim through the shoulders.
  //     Old Navy        runs LARGE  — value-tier vanity sizing.
  //     American Eagle  runs LARGE  — same pattern.
  //     Gap / BR / A&F / Tommy      — true to size (A&F slim in menswear).
  //
  // So a Uniqlo M and an Old Navy M are meaningfully different garments and
  // NOTHING ON EITHER TAG SAYS SO. Each cross-map is written INSIDE the size
  // label, where the model actually reads it, rather than in the note alone.
  {
    brand: "Uniqlo",
    brandMatch: ["uniqlo"],
    department: "Women",
    garment: "Tops (alpha, RUNS SMALL)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "knit",
      "sweater",
      "cardigan",
      "base layer",
      "heattech",
      "airism",
      "long sleeve",
    ],
    note:
      "Uniqlo RUNS SMALL: the grade is cut to a Japanese fit and sits roughly " +
      "one size below a general US body — a Uniqlo M is nearer a US 4-6. Old " +
      "Navy and American Eagle in this SAME group run the OPPOSITE way, and " +
      "every one of those tags says only a letter, which is why the cross-map " +
      "is in the size label. HEATTECH and AIRism base layers are cut CLOSE TO " +
      "THE BODY BY DESIGN — that is the function of a base layer, not a small " +
      "size and not shrinkage; do not grade the fit as a defect. Body-" +
      "equivalent figures in inches, not Uniqlo-published specs. Measure flat " +
      "across the underarm seam and double it.",
    rows: [
      { size: "XS (fits ≈US 0-2)", measurements: { bust: "31-32.5", waist: "24-25.5" } },
      { size: "S (fits ≈US 2-4)", measurements: { bust: "33-34.5", waist: "26-27.5" } },
      { size: "M (fits ≈US 4-6)", measurements: { bust: "35-36.5", waist: "28-29.5" } },
      { size: "L (fits ≈US 8-10)", measurements: { bust: "37.5-39", waist: "30.5-32" } },
      { size: "XL (fits ≈US 12)", measurements: { bust: "40-41.5", waist: "33-34.5" } },
      { size: "XXL (fits ≈US 14)", measurements: { bust: "42.5-44", waist: "35.5-37" } },
    ],
  },
  {
    brand: "Uniqlo",
    brandMatch: ["uniqlo"],
    department: "Men",
    garment: "Tops (alpha, RUNS SMALL)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "polo",
      "knit",
      "sweater",
      "sweatshirt",
      "base layer",
      "heattech",
      "airism",
      "long sleeve",
    ],
    note:
      "Uniqlo menswear RUNS SMALL and SLIM against a US body — roughly one size " +
      "down, most pronounced across the SHOULDERS and chest rather than the " +
      "length. A Uniqlo L fits nearer a US M. Base layers (HEATTECH/AIRism) are " +
      "cut close to the body BY DESIGN — not a small size and not shrinkage. " +
      "Body-equivalent figures in inches, not published specs. Measure the " +
      "chest flat across the underarm seam and double it.",
    rows: [
      { size: "XS (fits ≈US XS)", measurements: { chest: "33-35", waist: "27-29" } },
      { size: "S (fits ≈US XS-S)", measurements: { chest: "35-37", waist: "29-31" } },
      { size: "M (fits ≈US S-M)", measurements: { chest: "37-39.5", waist: "31-33.5" } },
      { size: "L (fits ≈US M-L)", measurements: { chest: "39.5-42", waist: "33.5-36" } },
      { size: "XL (fits ≈US L-XL)", measurements: { chest: "42-44.5", waist: "36-38.5" } },
      { size: "XXL (fits ≈US XL)", measurements: { chest: "44.5-47", waist: "38.5-41" } },
    ],
  },
  {
    brand: "Gap",
    // THE CONCATENATED SUB-LABEL SPELLINGS ARE LISTED ON PURPOSE and are not
    // redundant: brandTextMatches requires a token to START a word, so a bare
    // "gap" does NOT fire inside "babygap" (the preceding "y" is a word char).
    // Spaced "Baby Gap" matches "gap" fine; the concatenated tags — which is how
    // the labels actually print — would silently miss these charts without this.
    // First bill come due from the US-1738 boundary fix.
    brandMatch: ["gap", "babygap", "gapkids", "gapfit", "gapbody"],
    department: "Women",
    garment: "Tops (alpha/numeric)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "knit",
      "sweater",
      "sweatshirt",
      "hoodie",
      "cardigan",
      "long sleeve",
    ],
    note:
      "Gap is broadly TRUE TO SIZE with a relaxed house cut — it does not carry " +
      "the vanity-sizing lean Old Navy and American Eagle do in this same group, " +
      "despite Old Navy sharing its parent (Gap Inc). Body-equivalent figures in " +
      "inches, not Gap-published specs. Measure flat and treat the tag as a " +
      "claim to check.",
    rows: [
      { size: "XS (0-2)", measurements: { bust: "32.5-34", waist: "25-26.5" } },
      { size: "S (4-6)", measurements: { bust: "35-36.5", waist: "27.5-29" } },
      { size: "M (8-10)", measurements: { bust: "37.5-39.5", waist: "30-32" } },
      { size: "L (12-14)", measurements: { bust: "41-43", waist: "33.5-35.5" } },
      { size: "XL (16-18)", measurements: { bust: "44.5-46.5", waist: "37-39" } },
      { size: "XXL (20)", measurements: { bust: "48-50", waist: "40.5-42.5" } },
    ],
  },
  {
    brand: "Gap",
    brandMatch: ["gap", "babygap", "gapkids", "gapfit", "gapbody"],
    department: "Women",
    garment: "Bottoms / denim (true waist inches)",
    categoryMatch: [
      "bottom",
      "pant",
      "jean",
      "denim",
      "trouser",
      "short",
      "skirt",
      "legging",
      "1969",
    ],
    note:
      "Gap denim is graded in TRUE WAIST INCHES, which makes it the most " +
      "reliable number in this whole brand group — an alpha tag is a claim, a " +
      "waist number is close to a measurement. The parenthesised US numeric is " +
      "the rough equivalent; Gap 1969 is the denim line marking. Stretch denim " +
      "measures smaller relaxed than it wears — note the fibre content. " +
      "Body-equivalent figures in inches, not published specs. Measure the flat " +
      "waistband and DOUBLE it.",
    rows: [
      { size: "24 (00)", measurements: { waist: "24-24.5", hip: "34-34.5" } },
      { size: "25 (0)", measurements: { waist: "25-25.5", hip: "35-35.5" } },
      { size: "26 (2)", measurements: { waist: "26-26.5", hip: "36-36.5" } },
      { size: "27 (4)", measurements: { waist: "27-27.5", hip: "37-37.5" } },
      { size: "28 (6)", measurements: { waist: "28-28.5", hip: "38-38.5" } },
      { size: "29 (8)", measurements: { waist: "29-29.5", hip: "39-39.5" } },
      { size: "30 (10)", measurements: { waist: "30-31", hip: "40-41" } },
      { size: "31 (12)", measurements: { waist: "31-32", hip: "41-42" } },
      { size: "32 (14)", measurements: { waist: "32-33.5", hip: "42-43.5" } },
    ],
  },
  {
    brand: "Banana Republic",
    brandMatch: ["banana republic", "bananarepublic"],
    department: "Women",
    garment: "Tops (alpha/numeric)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "knit",
      "sweater",
      "cardigan",
      "merino",
      "long sleeve",
    ],
    note:
      "Banana Republic is TRUE TO SIZE with a tailored workwear cut — alongside " +
      "Tommy Hilfiger the most conservative grade in this group, and a full step " +
      "from Old Navy's vanity sizing despite the shared Gap Inc parent. TWO ERAS " +
      "ARE NOT THE SAME PRODUCT: safari-era BR (1978-~1988) is a vintage " +
      "collectible on its own grade — check the label before applying this " +
      "chart. The 'Factory Store' line is a lower-spec outlet product; the " +
      "sizing is comparable but the value is not. On merino the FIBRE is the " +
      "value and cannot be read off a photo. Body-equivalent inches, not " +
      "published specs. Measure flat and double.",
    rows: [
      { size: "XXS (00)", measurements: { bust: "31-32", waist: "23.5-24.5" } },
      { size: "XS (0-2)", measurements: { bust: "32.5-34", waist: "25-26.5" } },
      { size: "S (4-6)", measurements: { bust: "35-36.5", waist: "27.5-29" } },
      { size: "M (8-10)", measurements: { bust: "37.5-39.5", waist: "30-32" } },
      { size: "L (12-14)", measurements: { bust: "41-43", waist: "33.5-35.5" } },
      { size: "XL (16)", measurements: { bust: "44.5-46", waist: "37-38.5" } },
    ],
  },
  {
    brand: "Banana Republic",
    brandMatch: ["banana republic", "bananarepublic"],
    department: "Men",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "polo",
      "knit",
      "sweater",
      "merino",
      "oxford",
      "long sleeve",
    ],
    note:
      "Banana Republic menswear is TRUE TO SIZE and tailored. Dress shirts are " +
      "frequently graded by NECK and SLEEVE rather than an alpha, and where both " +
      "appear the neck/sleeve numbers are the reliable ones. BR also cuts the " +
      "same shirt in named fits (slim/standard), which change the body but not " +
      "the neck: read the fit off the tag, never from the drape in a photo. " +
      "Body-equivalent inches, not published specs. Measure the chest flat " +
      "across the underarm seam and double it.",
    rows: [
      { size: "XS", measurements: { chest: "34-36", neck: "14-14.5" } },
      { size: "S", measurements: { chest: "36-38", neck: "14.5-15" } },
      { size: "M", measurements: { chest: "38-40", neck: "15-15.5" } },
      { size: "L", measurements: { chest: "41-43", neck: "15.5-16" } },
      { size: "XL", measurements: { chest: "44-46", neck: "16.5-17" } },
      { size: "XXL", measurements: { chest: "47-49", neck: "17.5-18" } },
    ],
  },
  {
    brand: "Old Navy",
    brandMatch: ["old navy", "oldnavy"],
    department: "Women",
    garment: "Tops (alpha, RUNS LARGE)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "knit",
      "sweater",
      "sweatshirt",
      "hoodie",
      "tank",
      "long sleeve",
    ],
    note:
      "Old Navy RUNS LARGE — it is VANITY-SIZED (the value-tier pattern): an Old " +
      "Navy M sits nearer a US L than the nominal grade suggests. Uniqlo in this " +
      "SAME group runs the OPPOSITE way (a Uniqlo M is nearer a US 4-6) and both " +
      "tags say only 'M', which is exactly why the cross-map is in the size " +
      "label. A garment that measures LARGER than its tag is NORMAL for this " +
      "brand — it is the grade, not stretching, not a mislabel, and not a defect " +
      "to grade down. Body-equivalent inches, not published specs. Measure flat " +
      "and double.",
    rows: [
      { size: "XS (fits ≈US 0-2)", measurements: { bust: "33-34.5", waist: "25.5-27" } },
      { size: "S (fits ≈US 4-6)", measurements: { bust: "35.5-37", waist: "28-29.5" } },
      { size: "M (fits ≈US 8-10)", measurements: { bust: "38-40", waist: "30.5-32.5" } },
      { size: "L (fits ≈US 12-14)", measurements: { bust: "41.5-43.5", waist: "34-36" } },
      { size: "XL (fits ≈US 16-18)", measurements: { bust: "45-47", waist: "37.5-39.5" } },
      { size: "XXL (fits ≈US 20)", measurements: { bust: "48.5-50.5", waist: "41-43" } },
    ],
  },
  {
    brand: "Old Navy",
    brandMatch: ["old navy", "oldnavy"],
    department: "Women",
    garment: "Bottoms / denim (RUNS LARGE)",
    categoryMatch: [
      "bottom",
      "pant",
      "jean",
      "denim",
      "trouser",
      "short",
      "skirt",
      "legging",
      "rockstar",
      "pixie",
    ],
    note:
      "Old Navy bottoms are VANITY-SIZED and run LARGE — the numeric size sits " +
      "generous against a true waist measurement, so the waist inches here are " +
      "the reliable number and the tag number is a claim. Rockstar (skinny/" +
      "jegging) and Pixie (ankle) are the named fits buyers search; both are " +
      "ordinary English words and are fit names ONLY on an actual Old Navy " +
      "garment. Rockstar denim is heavily STRETCH — note the fibre content. " +
      "Body-equivalent inches, not published specs. Measure the flat waistband " +
      "relaxed rather than pulling it taut, and double it.",
    rows: [
      { size: "0 (waist ≈25)", measurements: { waist: "25-25.5", hip: "35-35.5" } },
      { size: "2 (waist ≈26)", measurements: { waist: "26-26.5", hip: "36-36.5" } },
      { size: "4 (waist ≈27)", measurements: { waist: "27-27.5", hip: "37-37.5" } },
      { size: "6 (waist ≈28)", measurements: { waist: "28-28.5", hip: "38-38.5" } },
      { size: "8 (waist ≈29)", measurements: { waist: "29-30", hip: "39-40" } },
      { size: "10 (waist ≈31)", measurements: { waist: "31-32", hip: "41-42" } },
      { size: "12 (waist ≈32.5)", measurements: { waist: "32.5-33.5", hip: "42.5-43.5" } },
      { size: "14 (waist ≈34)", measurements: { waist: "34-35.5", hip: "44-45.5" } },
    ],
  },
  {
    brand: "American Eagle",
    brandMatch: ["american eagle", "americaneagle", "aerie"],
    department: "Women",
    garment: "Jeans / bottoms (true waist inches)",
    categoryMatch: [
      "bottom",
      "pant",
      "jean",
      "denim",
      "jegging",
      "short",
      "skirt",
      "legging",
      "curvy",
    ],
    note:
      "DENIM IS THIS BRAND — jeans are AE's volume product and the piece most " +
      "likely to be resold. AE denim is graded in TRUE WAIST INCHES, far more " +
      "reliable than the brand's alpha tops, which RUN LARGE (vanity-sized, the " +
      "same direction as Old Navy and the opposite of Uniqlo in this group). The " +
      "NAMED FIT printed on the tag is the listing token buyers search — read it " +
      "off the tag, never guess it from the photo. CURVY is a distinct AE fit " +
      "for a smaller waist-to-hip ratio: it measures a LARGER HIP at the same " +
      "tagged waist, which is the DESIGN — not a mislabel and not a stretched " +
      "garment. Most AE denim is heavy STRETCH and measures smaller relaxed " +
      "than it wears. Aerie folds onto this brand and shares the grade. " +
      "Body-equivalent inches, not published specs. Measure the flat waistband " +
      "relaxed and double it.",
    rows: [
      { size: "00 (waist ≈23)", measurements: { waist: "23-23.5", hip: "33-33.5" } },
      { size: "0 (waist ≈24)", measurements: { waist: "24-24.5", hip: "34-34.5" } },
      { size: "2 (waist ≈25)", measurements: { waist: "25-25.5", hip: "35-35.5" } },
      { size: "4 (waist ≈26)", measurements: { waist: "26-26.5", hip: "36-36.5" } },
      { size: "6 (waist ≈27)", measurements: { waist: "27-27.5", hip: "37-37.5" } },
      { size: "8 (waist ≈28)", measurements: { waist: "28-29", hip: "38-39" } },
      { size: "10 (waist ≈30)", measurements: { waist: "30-31", hip: "40-41" } },
      { size: "12 (waist ≈31.5)", measurements: { waist: "31.5-32.5", hip: "41.5-42.5" } },
      { size: "14 (waist ≈33)", measurements: { waist: "33-34.5", hip: "43-44.5" } },
    ],
  },
  {
    brand: "American Eagle",
    brandMatch: ["american eagle", "americaneagle", "aerie"],
    department: "Men",
    garment: "Jeans / bottoms (W x L inches)",
    categoryMatch: ["bottom", "pant", "jean", "denim", "trouser", "short", "chino"],
    note:
      "AE menswear denim is tagged W x L in TRUE INCHES — the most reliable " +
      "sizing in this brand group, since both numbers are measurements rather " +
      "than a graded claim. ALWAYS capture the INSEAM (L) as well as the waist: " +
      "a W32 L30 and a W32 L34 are different products to a buyer, and the length " +
      "is the half most often omitted from a listing. AE stretch denim measures " +
      "smaller relaxed than it wears. Body-equivalent figures in inches, not " +
      "published specs. Measure the flat waistband relaxed, double it, and " +
      "measure the inseam from the crotch seam to the hem.",
    rows: [
      { size: "W28", measurements: { waist: "28-28.5", hip: "35-36" } },
      { size: "W29", measurements: { waist: "29-29.5", hip: "36-37" } },
      { size: "W30", measurements: { waist: "30-30.5", hip: "37-38" } },
      { size: "W31", measurements: { waist: "31-31.5", hip: "38-39" } },
      { size: "W32", measurements: { waist: "32-32.5", hip: "39-40" } },
      { size: "W33", measurements: { waist: "33-33.5", hip: "40-41" } },
      { size: "W34", measurements: { waist: "34-34.5", hip: "41-42" } },
      { size: "W36", measurements: { waist: "36-36.5", hip: "43-44" } },
      { size: "W38", measurements: { waist: "38-38.5", hip: "45-46" } },
      { size: "W40", measurements: { waist: "40-40.5", hip: "47-48" } },
    ],
  },
  {
    brand: "Abercrombie & Fitch",
    brandMatch: ["abercrombie", "abercrombie & fitch", "abercrombiefitch"],
    department: "Women",
    garment: "Jeans / bottoms (true waist inches)",
    categoryMatch: ["bottom", "pant", "jean", "denim", "short", "skirt", "curve love"],
    note:
      "A&F denim is graded in TRUE WAIST INCHES and the modern denim program is " +
      "well regarded — a genuine exception to this group's low-value pattern, " +
      "and the brand's strongest current resale category. CURVE LOVE is A&F's " +
      "named fit for a smaller waist-to-hip ratio: it measures a LARGER HIP " +
      "(roughly an extra inch or more) at the same tagged waist. That is the " +
      "DESIGN — not a mislabel, not a stretched garment, and it must not be " +
      "graded as either. The fit name is printed on the tag and is a searched " +
      "token; read it off the tag rather than inferring it from the hip " +
      "measurement. Body-equivalent inches, not published specs. Measure the " +
      "flat waistband relaxed and double it.",
    rows: [
      { size: "23 (00)", measurements: { waist: "23-23.5", hip: "33.5-34" } },
      { size: "24 (0)", measurements: { waist: "24-24.5", hip: "34.5-35" } },
      { size: "25 (1)", measurements: { waist: "25-25.5", hip: "35.5-36" } },
      { size: "26 (2)", measurements: { waist: "26-26.5", hip: "36.5-37" } },
      { size: "27 (4)", measurements: { waist: "27-27.5", hip: "37.5-38" } },
      { size: "28 (6)", measurements: { waist: "28-28.5", hip: "38.5-39.5" } },
      { size: "29 (8)", measurements: { waist: "29-29.5", hip: "39.5-40.5" } },
      { size: "30 (10)", measurements: { waist: "30-31", hip: "40.5-41.5" } },
      { size: "31 (12)", measurements: { waist: "31-32", hip: "41.5-42.5" } },
      { size: "32 (14)", measurements: { waist: "32-33.5", hip: "42.5-44" } },
    ],
  },
  {
    brand: "Abercrombie & Fitch",
    brandMatch: ["abercrombie", "abercrombie & fitch", "abercrombiefitch"],
    department: "Men",
    garment: "Tops (alpha, cut SLIM)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "polo",
      "knit",
      "sweater",
      "sweatshirt",
      "hoodie",
      "long sleeve",
    ],
    note:
      "A&F menswear is cut SLIM — the mall-era grade is trim through the chest " +
      "and body, closer to Uniqlo's direction than Old Navy's in this group, " +
      "though not as small. THE ERA MATTERS MORE THAN THE GRADE HERE: ~1997-2010 " +
      "logo/moose-era A&F is a distinct Y2K collectible priced above the modern " +
      "rebranded product, and the modern brand deliberately dropped heavy logo " +
      "branding — an absent logo on a modern piece is NORMAL, not a removed " +
      "graphic and not a fake. Pre-1977 sporting-goods A&F is a different " +
      "company entirely and this chart does not apply to it. Body-equivalent " +
      "inches, not published specs. Measure the chest flat across the underarm " +
      "seam and double it.",
    rows: [
      { size: "XS", measurements: { chest: "33-35", waist: "27-29" } },
      { size: "S", measurements: { chest: "35-37", waist: "29-31" } },
      { size: "M", measurements: { chest: "37.5-39.5", waist: "31-33" } },
      { size: "L", measurements: { chest: "40-42", waist: "33.5-35.5" } },
      { size: "XL", measurements: { chest: "42.5-45", waist: "36-38" } },
      { size: "XXL", measurements: { chest: "45.5-48", waist: "38.5-41" } },
    ],
  },
  {
    brand: "Tommy Hilfiger",
    brandMatch: ["tommy hilfiger", "tommyhilfiger", "tommy jeans"],
    department: "Men",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "polo",
      "knit",
      "sweater",
      "sweatshirt",
      "hoodie",
      "rugby",
      "long sleeve",
    ],
    note:
      "Tommy Hilfiger is TRUE TO SIZE with a classic/preppy cut — alongside " +
      "Banana Republic the most conservative grade in this group. THE ERA IS THE " +
      "PRICE ON THIS BRAND, AND THE CHART CANNOT SEE IT: 1990s flag-era Tommy " +
      "was cut deliberately OVERSIZED and resells for MULTIPLES of the modern " +
      "piece, so a vintage garment measuring far larger than this table is " +
      "NORMAL for its era and is not a mislabel or a stretched garment. This " +
      "chart describes the MODERN grade. The modern Tommy Jeans revival reissues " +
      "the 90s look ON PURPOSE, so the graphic cannot date the garment — only " +
      "the label can. Dress shirts are graded by neck/sleeve, the reliable " +
      "numbers. Body-equivalent inches, not published specs. Measure the chest " +
      "flat across the underarm seam and double it.",
    rows: [
      { size: "XS", measurements: { chest: "34-36", neck: "14-14.5" } },
      { size: "S", measurements: { chest: "36-38", neck: "14.5-15" } },
      { size: "M", measurements: { chest: "38-40.5", neck: "15-15.5" } },
      { size: "L", measurements: { chest: "41-43.5", neck: "15.5-16" } },
      { size: "XL", measurements: { chest: "44-46.5", neck: "16.5-17" } },
      { size: "XXL", measurements: { chest: "47-49.5", neck: "17.5-18" } },
    ],
  },
  {
    brand: "Tommy Hilfiger",
    brandMatch: ["tommy hilfiger", "tommyhilfiger", "tommy jeans"],
    department: "Women",
    garment: "Tops (alpha/numeric)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "knit",
      "sweater",
      "polo",
      "cardigan",
      "long sleeve",
    ],
    note:
      "Tommy Hilfiger womenswear is TRUE TO SIZE with a classic cut. As on the " +
      "menswear side, THE ERA IS THE PRICE and this chart describes the MODERN " +
      "grade only: 1990s flag-era pieces were cut oversized and are a different " +
      "market — a vintage garment measuring far larger than this table is normal " +
      "for its era, not a mislabel. The modern revival reissues the 90s look " +
      "deliberately, so the graphic cannot date the garment; only the label can. " +
      "Body-equivalent inches, not published specs. Measure flat and double.",
    rows: [
      { size: "XS (0-2)", measurements: { bust: "32.5-34", waist: "25-26.5" } },
      { size: "S (4-6)", measurements: { bust: "35-36.5", waist: "27.5-29" } },
      { size: "M (8-10)", measurements: { bust: "37.5-39.5", waist: "30-32" } },
      { size: "L (12-14)", measurements: { bust: "41-43", waist: "33.5-35.5" } },
      { size: "XL (16)", measurements: { bust: "44.5-46", waist: "37-38.5" } },
      { size: "XXL (18)", measurements: { bust: "47.5-49", waist: "40-41.5" } },
    ],
  },

  // ── US-1740: footwear group ────────────────────────────────────────────────
  // Mirrors migration 00459's brand_size_charts seed.
  //
  // THESE CHARTS ARE A DIFFERENT KIND OF OBJECT FROM EVERY OTHER CHART IN THIS
  // FILE, and the difference is not cosmetic. Every chart above is an ESTIMATOR:
  // measure the bust, double it, read off the size. A shoe's size CANNOT be
  // measured from a photo — it is STAMPED on the tongue label, the insole or the
  // footbed and must be READ. So these are TRANSLATORS: they turn the brand's own
  // number into every other system's number. The foot-length inches are a sanity
  // check for a shoe in hand, not the primary path.
  //
  // Which makes the SIZE LABEL the deliverable here. The US-1731 lesson — write the
  // cross-map INSIDE the label where the model actually reads it, not in the note
  // alone — is the whole product in this group, so every row carries the full
  // US/UK/EU triple.
  //
  // THE TWO BRANDS WHOSE TAG DOES NOT NAME ITS OWN SYSTEM are the reason the pack
  // exists: a Dr. Martens stamped "7" is a UK 7 (= US M8), and a Birkenstock
  // stamped "38" is an EU 38 (= US W7-7.5). Neither says "UK" or "EU" anywhere.
  // That is not a pricing refinement like the era/line traps of US-1737..1739 — it
  // is a WRONG LISTING that no photo reasoning can catch, because the photo is not
  // wrong: the shoe really does say 7.
  {
    brand: "Dr. Martens",
    brandMatch: [
      "dr. martens",
      "dr martens",
      "drmartens",
      "doc martens",
      "docmartens",
      "airwair",
    ],
    department: "Unisex",
    garment: "Footwear (UK-SIZED — the stamped number is a UK size)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "boot",
      "boots",
      "chelsea",
      "sneaker",
      "1460",
      "1461",
      "2976",
      "sandal",
    ],
    note:
      "THE NUMBER STAMPED ON A DR. MARTENS IS A UK SIZE AND THE BOOT DOES NOT SAY " +
      "SO — the highest-value fact in this brand group. A boot stamped \"7\" is a " +
      "UK 7 = US MEN'S 8 = US WOMEN'S 9 = EU 41, so a seller who reads \"7\" and " +
      "lists a US 7 is a FULL SIZE wrong and the photo will not contradict them. " +
      "ALWAYS convert from UK and state the UK number in the listing. THE BRAND IS " +
      "UNISEX-SIZED: one UK run maps to BOTH a US men's and a US women's size and " +
      "both belong in the listing — which is why every row carries both. NO HALF " +
      "SIZES in the standard run, so a \"US 8.5 Dr. Martens\" is a size the brand " +
      "does not make. THE SIZE IS STAMPED, NOT MEASURED — read it off the boot, " +
      "never infer it from a photo. Body-equivalent approximations, not published " +
      "specs.",
    rows: [
      { size: "UK 3 = US M4 / US W5 = EU 36", measurements: { footLength: "8.7" } },
      { size: "UK 4 = US M5 / US W6 = EU 37", measurements: { footLength: "9.05" } },
      { size: "UK 5 = US M6 / US W7 = EU 38", measurements: { footLength: "9.4" } },
      { size: "UK 6 = US M7 / US W8 = EU 39", measurements: { footLength: "9.75" } },
      { size: "UK 7 = US M8 / US W9 = EU 41", measurements: { footLength: "10.1" } },
      { size: "UK 8 = US M9 / US W10 = EU 42", measurements: { footLength: "10.4" } },
      { size: "UK 9 = US M10 / US W11 = EU 43", measurements: { footLength: "10.75" } },
      { size: "UK 10 = US M11 / US W12 = EU 45", measurements: { footLength: "11.1" } },
      { size: "UK 11 = US M12 = EU 46", measurements: { footLength: "11.4" } },
      { size: "UK 12 = US M13 = EU 47", measurements: { footLength: "11.75" } },
    ],
  },
  {
    brand: "Birkenstock",
    brandMatch: ["birkenstock", "birkenstocks"],
    department: "Unisex",
    garment: "Footwear (EU-SIZED ONLY — no US run exists)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sandal",
      "sandals",
      "clog",
      "clogs",
      "slide",
      "arizona",
      "boston",
      "gizeh",
      "madrid",
    ],
    note:
      "BIRKENSTOCK IS EU-SIZED ONLY — there is NO US-numbered run at all, and the " +
      "number stamped in the footbed carries no system marking. A sandal stamped " +
      "\"38\" is an EU 38 = US WOMEN'S 7-7.5, NOT a US 8. NO HALF SIZES (whole EU " +
      "sizes only), which is exactly why every US equivalent here is a RANGE: the " +
      "brand's grade is coarser than the US one, so one EU size covers two US " +
      "halves. State the EU number in the listing. THE WIDTH IS A FOOT ICON, NOT A " +
      "LETTER: regular vs narrow is marked by a small foot-shaped icon on the " +
      "footbed beside the size (wide icon = REGULAR, narrow icon = NARROW) — there " +
      "is no D/B letter to read, and if the footbed is not photographed say the " +
      "width is UNCONFIRMED rather than assuming regular. THE FOOTBED IS THE " +
      "PRODUCT AND ITS WEAR IS THE GRADE: the cork-latex footbed MOULDS to its " +
      "wearer by design, so a visible FOOT IMPRESSION is NORMAL and expected, not " +
      "damage — but cork CRUMBLING at the edge, a SEPARATED sole and a darkened/" +
      "compressed liner ARE defects. THE SIZE IS STAMPED, NOT MEASURED. " +
      "Body-equivalent approximations, not published specs.",
    rows: [
      { size: "EU 36 = US W5-5.5 = UK 3.5", measurements: { footLength: "8.85" } },
      { size: "EU 37 = US W6-6.5 = UK 4.5", measurements: { footLength: "9.2" } },
      { size: "EU 38 = US W7-7.5 = UK 5.5", measurements: { footLength: "9.5" } },
      {
        size: "EU 39 = US W8-8.5 / US M6-6.5 = UK 6",
        measurements: { footLength: "9.85" },
      },
      {
        size: "EU 40 = US W9-9.5 / US M7-7.5 = UK 7",
        measurements: { footLength: "10.2" },
      },
      {
        size: "EU 41 = US W10-10.5 / US M8-8.5 = UK 7.5",
        measurements: { footLength: "10.5" },
      },
      { size: "EU 42 = US M9-9.5 = UK 8", measurements: { footLength: "10.85" } },
      { size: "EU 43 = US M10-10.5 = UK 9", measurements: { footLength: "11.2" } },
      { size: "EU 44 = US M11-11.5 = UK 9.5", measurements: { footLength: "11.5" } },
      { size: "EU 45 = US M12-12.5 = UK 10.5", measurements: { footLength: "11.85" } },
      { size: "EU 46 = US M13-13.5 = UK 11.5", measurements: { footLength: "12.2" } },
    ],
  },
  {
    brand: "New Balance",
    brandMatch: ["new balance", "newbalance"],
    department: "Men",
    garment: "Footwear (US/UK/EU + WIDTH — D is STANDARD here)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "running",
      "990",
      "574",
      "550",
      "2002r",
    ],
    note:
      "US sizing PLUS a WIDTH LETTER that is part of the product. ON MEN'S NEW " +
      "BALANCE, \"D\" IS THE STANDARD WIDTH (B narrow, D standard, 2E wide, 4E " +
      "extra wide). THAT IS THE OPPOSITE OF THE WOMEN'S READING IN THIS SAME " +
      "BRAND, where B is standard and D is WIDE — the same character is correct in " +
      "both and ONLY the department decides which. Never carry one department's " +
      "width reading onto the other. The width is stamped on the tongue label " +
      "beside the size and it is what a buyer with a wide foot searches. THE SIZE " +
      "IS STAMPED, NOT MEASURED — read the size, width and department off the " +
      "tongue label. The MODEL NUMBER'S PREFIX cross-checks it (M990 = men's, " +
      "W990 = women's, U327 = unisex). MADE IN USA (990/993/992) and MADE IN " +
      "ENGLAND (1500/577) are higher-spec LINES at a higher band — comparable " +
      "sizing, different value. Body-equivalent approximations, not published specs.",
    rows: [
      { size: "US M7 = UK 6.5 = EU 40", measurements: { footLength: "9.6" } },
      { size: "US M8 = UK 7.5 = EU 41.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8.5 = EU 42.5", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9.5 = EU 43.5", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10.5 = EU 45", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11.5 = EU 46", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12.5 = EU 47.5", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "New Balance",
    brandMatch: ["new balance", "newbalance"],
    department: "Women",
    garment: "Footwear (US/UK/EU + WIDTH — D is WIDE here)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "running",
      "990",
      "574",
      "550",
      "2002r",
    ],
    note:
      "US sizing PLUS a WIDTH LETTER that is part of the product. ON WOMEN'S NEW " +
      "BALANCE, \"B\" IS THE STANDARD WIDTH AND \"D\" IS WIDE (2A narrow, B " +
      "standard, D wide, 2E extra wide). THAT IS THE OPPOSITE OF THE MEN'S READING " +
      "IN THIS SAME BRAND, where D is STANDARD — the same character is correct in " +
      "both and ONLY the department decides which. A women's D-width listed as a " +
      "plain 990 is a WIDE shoe sold as a regular one, which is a return — and it " +
      "is a valuable listing token to the buyer who needs it. Never carry one " +
      "department's width reading onto the other. THE SIZE IS STAMPED, NOT " +
      "MEASURED — read the size, width and department off the tongue label. The " +
      "MODEL NUMBER'S PREFIX cross-checks the department (W574 = women's, M990 = " +
      "men's, U327 = unisex). MADE IN USA / MADE IN ENGLAND are higher-spec LINES " +
      "at a higher band. Body-equivalent approximations, not published specs.",
    rows: [
      { size: "US W6 = UK 4 = EU 36.5", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 5 = EU 37.5", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 6 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 7 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 8 = EU 41.5", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 9 = EU 42.5", measurements: { footLength: "10.5" } },
      { size: "US W12 = UK 10 = EU 44", measurements: { footLength: "10.85" } },
    ],
  },
  {
    brand: "Converse",
    brandMatch: ["converse", "chuck taylor", "chuck 70", "all star"],
    department: "Unisex",
    garment: "Footwear (dual-tagged US M/W — offset TWO, RUNS LARGE)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "canvas",
      "chuck",
      "all star",
      "high top",
      "low top",
    ],
    note:
      "CONVERSE DUAL-TAGS men's AND women's on ONE label, and THE OFFSET IS TWO: a " +
      "Converse M8 is a W10. VANS IS NOT THE SAME — the same kind of black canvas " +
      "lace-up, the same price band, the same shelf, and an offset of ONE AND A " +
      "HALF (a Vans M8 is a W9.5). The brands are adjacent enough that an offset " +
      "learned on one gets silently applied to the other, and NO PHOTO CAN CATCH " +
      "IT — which is why both numbers are written into every size label here. Read " +
      "BOTH off the actual tag; never compute one brand's offset with the other's. " +
      "CONVERSE RUNS LARGE — the brand's own guidance is to size DOWN a half size; " +
      "report the STAMPED numbers plus that guidance, never silently adjust the " +
      "size you list. THE SIZE IS STAMPED, NOT MEASURED. CHUCK 70 IS NOT A " +
      "STANDARD CHUCK and both are in production NOW: comparable sizing, different " +
      "value — check the midsole (glossy egret) and heel (black license plate) " +
      "before pricing. Body-equivalent approximations, not published specs.",
    rows: [
      { size: "US M5 = US W7 = UK 5 = EU 37.5", measurements: { footLength: "9.25" } },
      { size: "US M6 = US W8 = UK 6 = EU 39", measurements: { footLength: "9.6" } },
      { size: "US M7 = US W9 = UK 7 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US M8 = US W10 = UK 8 = EU 41.5", measurements: { footLength: "10.2" } },
      { size: "US M9 = US W11 = UK 9 = EU 42.5", measurements: { footLength: "10.6" } },
      { size: "US M10 = US W12 = UK 10 = EU 44", measurements: { footLength: "10.9" } },
      { size: "US M11 = US W13 = UK 11 = EU 45", measurements: { footLength: "11.25" } },
      { size: "US M12 = UK 12 = EU 46.5", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Vans",
    brandMatch: ["vans", "old skool", "sk8-hi", "vault by vans"],
    department: "Unisex",
    garment: "Footwear (dual-tagged US M/W — offset ONE AND A HALF)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "skate",
      "canvas",
      "old skool",
      "sk8-hi",
      "slip-on",
      "authentic",
      "era",
    ],
    note:
      "VANS DUAL-TAGS men's AND women's on ONE label, and THE OFFSET IS ONE AND A " +
      "HALF: a Vans M8 is a W9.5. CONVERSE IS NOT THE SAME — the same kind of " +
      "black canvas lace-up, the same price band, the same shelf, and an offset of " +
      "TWO (a Converse M8 is a W10). The brands are adjacent enough that an offset " +
      "learned on one gets silently applied to the other, and NO PHOTO CAN CATCH " +
      "IT — which is why both numbers are written into every size label here. Read " +
      "BOTH off the actual tag; never compute one brand's offset with the other's. " +
      "THE SIZE IS STAMPED, NOT MEASURED. VAULT BY VANS / OG is the premium LINE " +
      "at a materially higher band and is near-identical in silhouette: comparable " +
      "sizing, different value — check the label for \"OG\"/\"LX\"/\"Vault\". The " +
      "MODEL is genuinely legible here (Old Skool = side stripe; Authentic = no " +
      "stripe, no padding; Era = no stripe, PADDED collar — needs a side-on " +
      "photo). Body-equivalent approximations, not published specs.",
    rows: [
      { size: "US M5 = US W6.5 = UK 4.5 = EU 37", measurements: { footLength: "9.25" } },
      { size: "US M6 = US W7.5 = UK 5.5 = EU 38.5", measurements: { footLength: "9.6" } },
      { size: "US M7 = US W8.5 = UK 6.5 = EU 39.5", measurements: { footLength: "9.9" } },
      { size: "US M8 = US W9.5 = UK 7.5 = EU 41", measurements: { footLength: "10.2" } },
      { size: "US M9 = US W10.5 = UK 8.5 = EU 42.5", measurements: { footLength: "10.6" } },
      { size: "US M10 = US W11.5 = UK 9.5 = EU 43.5", measurements: { footLength: "10.9" } },
      { size: "US M11 = US W12.5 = UK 10.5 = EU 45", measurements: { footLength: "11.25" } },
      { size: "US M12 = UK 11.5 = EU 46.5", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "UGG",
    brandMatch: ["ugg", "uggs", "ugg australia"],
    department: "Women",
    garment: "Footwear (US/UK/EU — RUNS LARGE, whole sizes)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "boot",
      "boots",
      "slipper",
      "slippers",
      "sheepskin",
      "classic",
      "mini",
      "tasman",
    ],
    note:
      "UGG RUNS LARGE — the brand's own guidance is to size DOWN, and the classic " +
      "sheepskin boots are WHOLE SIZES ONLY. AND THE SHEEPSKIN PACKS DOWN: the " +
      "lining COMPRESSES and moulds to its wearer's foot with use, so a worn pair " +
      "fits LARGER than a new pair of the same stamped size. The two effects " +
      "compound, and BOTH are the material behaving as designed. That flattening " +
      "is NORMAL WEAR — worth DISCLOSING, but it is NOT a defect of manufacture, " +
      "the boot is not \"stretched out\", and it must not be graded as damage. THE " +
      "SIZE IS STAMPED, NOT MEASURED — never infer a shoe size from a photo, and " +
      "never silently adjust the stamped number for the size-down guidance (report " +
      "the stamp AND the guidance). \"UGG AUSTRALIA\" on the label DATES a pair " +
      "(the branding until ~2016) and does NOT mean made in Australia — never turn " +
      "it into a provenance claim. The SLIPPERS (Tasman, Mini/Ultra Mini) often " +
      "out-resell the tall Classic. Body-equivalent approximations, not published " +
      "specs.",
    rows: [
      { size: "US W5 = UK 3.5 = EU 36", measurements: { footLength: "8.55" } },
      { size: "US W6 = UK 4.5 = EU 37", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 5.5 = EU 38", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 6.5 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 7.5 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 8.5 = EU 41", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 9.5 = EU 42", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "UGG",
    brandMatch: ["ugg", "uggs", "ugg australia"],
    department: "Men",
    garment: "Footwear (US/UK/EU — RUNS LARGE, whole sizes)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "boot",
      "boots",
      "slipper",
      "slippers",
      "sheepskin",
      "classic",
      "tasman",
      "neumel",
    ],
    note:
      "UGG menswear RUNS LARGE on the same guidance as the women's line — size " +
      "DOWN, and the classics are WHOLE SIZES ONLY. THE SHEEPSKIN PACKS DOWN with " +
      "wear (it moulds to the foot), so a worn pair fits larger than a new pair of " +
      "the same stamped size: that is NORMAL WEAR and the material behaving as " +
      "designed — disclose it, never grade it as a defect or call the boot " +
      "\"stretched out\". THE SIZE IS STAMPED, NOT MEASURED — report the stamped " +
      "number plus the brand's size-down guidance rather than silently adjusting " +
      "the size you list. Body-equivalent approximations, not published specs.",
    rows: [
      { size: "US M7 = UK 6 = EU 39.5", measurements: { footLength: "9.6" } },
      { size: "US M8 = UK 7 = EU 40.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8 = EU 42", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9 = EU 43", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10 = EU 44.5", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11 = EU 45.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12 = EU 47", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Cole Haan",
    brandMatch: ["cole haan", "colehaan"],
    department: "Men",
    garment: "Footwear (US/UK/EU + width)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "dress shoe",
      "loafer",
      "oxford",
      "wingtip",
      "sneaker",
      "zerogrand",
      "grandpro",
    ],
    note:
      "US dress sizing with WIDTHS (B narrow, C, D standard, E, EEE extra wide) — " +
      "the width is stamped beside the size and belongs in the listing. NOTE these " +
      "letters read as they do on MEN'S New Balance (D = standard), but do NOT " +
      "carry that onto a WOMEN'S shoe of any brand: on women's New Balance, D " +
      "means WIDE. THE SIZE IS STAMPED, NOT MEASURED — read it off the insole. THE " +
      "CONSTRUCTION SETS THE VALUE AND THE UPPER DOES NOT SHOW IT: a GOODYEAR-" +
      "WELTED shoe is resoleable and holds value worn, a CEMENTED (glued) shoe is " +
      "not economically resoleable and is worth far less once the sole is gone — " +
      "the tell is the WELT STITCH at the sole EDGE and it needs a SOLE-EDGE " +
      "photo; if unphotographed, say the construction is UNCONFIRMED rather than " +
      "assuming welted. THE SOLE AND HEEL ARE THE GRADE on a dress shoe (heel-cap " +
      "wear, sole thinning at the ball, a broken-down heel counter, vamp creasing) " +
      "and none of it appears in the three-quarter product shot every seller takes " +
      "— require a sole photo and a heel-on photo, and say the sole is UNSEEN " +
      "rather than grading the upper and calling it the shoe. A NIKE AIR / " +
      "LUNARLON mark inside a pre-2012 pair is GENUINE and period-correct, not a " +
      "fake. Body-equivalent approximations, not published specs.",
    rows: [
      { size: "US M7 = UK 6.5 = EU 40", measurements: { footLength: "9.6" } },
      { size: "US M8 = UK 7.5 = EU 41", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8.5 = EU 42", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9.5 = EU 43", measurements: { footLength: "10.6" } },
      { size: "US M10.5 = UK 10 = EU 44", measurements: { footLength: "10.8" } },
      { size: "US M11 = UK 10.5 = EU 44.5", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11.5 = EU 45.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12.5 = EU 47", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Cole Haan",
    brandMatch: ["cole haan", "colehaan"],
    department: "Women",
    garment: "Footwear (US/UK/EU)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "dress shoe",
      "loafer",
      "flat",
      "pump",
      "heel",
      "sneaker",
      "zerogrand",
      "grandpro",
    ],
    note:
      "US women's dress sizing; widths (A narrow, B standard, C/D wide) are " +
      "stamped beside the size where the shoe carries them. NOTE the width letters " +
      "mean what they mean HERE and must not be carried across brands or " +
      "departments: on women's New Balance, D means WIDE while on men's New " +
      "Balance D means STANDARD. THE SIZE IS STAMPED, NOT MEASURED. THE " +
      "CONSTRUCTION SETS THE VALUE: a GOODYEAR-WELTED shoe is resoleable and holds " +
      "value worn, a CEMENTED (glued) shoe is not — the tell is the WELT STITCH at " +
      "the SOLE EDGE and it needs a sole-edge photo; if unphotographed, say the " +
      "construction is UNCONFIRMED. THE SOLE AND HEEL ARE THE GRADE (heel-cap " +
      "wear, sole thinning at the ball, a broken-down heel counter) and none of it " +
      "shows in the standard three-quarter photo — require a sole photo and say " +
      "the sole is UNSEEN rather than grading the upper and calling it the shoe. A " +
      "NIKE AIR / LUNARLON mark inside a pre-2012 pair is GENUINE and " +
      "period-correct. Body-equivalent approximations, not published specs.",
    rows: [
      { size: "US W5 = UK 2.5 = EU 35", measurements: { footLength: "8.55" } },
      { size: "US W6 = UK 3.5 = EU 36.5", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 4.5 = EU 37.5", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 5.5 = EU 38.5", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 6.5 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 7.5 = EU 41", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 8.5 = EU 42", measurements: { footLength: "10.5" } },
    ],
  },
  // ── US-1981: luxury outerwear & down group ─────────────────────────────────
  // Mirrors migration 00460's brand_size_charts seed.
  //
  // FOUR OF THESE SIX BRANDS SIZE IN A SYSTEM THEIR OWN TAG NEVER NAMES, and that
  // is the whole reason this pack is worth more than its style fingerprints:
  //   * MONCLER is 0-5 — its OWN proprietary scale. Not US, not EU, not alpha.
  //   * HERNO is ITALIAN (a men's "50" is IT 50 = US 40 / L).
  //   * BOGNER is GERMAN (a women's "38" is DE 38 = US 8).
  //   * WOOLRICH depends on the ERA — US alpha on the Pennsylvania-mill heritage
  //     wool, EU numbers on the Italian-era outerwear. One label, two systems.
  // So these charts are TRANSLATORS as much as estimators, and the US-1740 lesson
  // applies verbatim: the cross-map goes INSIDE the size LABEL, where the model
  // actually reads it, not in the note alone.
  //
  // MONCLER WOMEN'S IS THE WORST CASE IN THE FILE. Its numbers COLLIDE with US
  // women's numeric sizing — a Moncler tagged "2" is a US 6-8, and "2" is a real
  // US size too. Nothing looks wrong, the photo cannot contradict it, and the
  // seller ships a medium to someone who bought an extra-small.
  //
  // Mackage is the deliberate CONTROL: plain US alpha, no translation needed.
  {
    brand: "Moncler",
    brandMatch: ["moncler"],
    department: "Men",
    garment: "Outerwear (MONCLER 0-5 SCALE)",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "puffer", "parka", "vest", "top"],
    note:
      "THE NUMBER ON A MONCLER IS MONCLER'S OWN 0-5 SIZE AND THE GARMENT DOES NOT " +
      "SAY SO — the highest-value fact in this brand group. It is not US, not EU, " +
      "not alpha. A jacket tagged \"2\" is a MEDIUM (US 38-40 chest), so a seller " +
      "who reads \"2\" and lists a US 2 has listed a medium as an extra-small. " +
      "ALWAYS state the Moncler number AND its alpha equivalent in the listing. " +
      "BODY measurement — NOT flat-garment; a down jacket is cut with loft and " +
      "layering room, so its FLAT chest measures above the body chest it is sized " +
      "to. Approximation from the published 0-5 mapping, not brand-fetched specs.",
    rows: [
      { size: "0 (= XS / US 34-36)", measurements: { chest: "34-36" } },
      { size: "1 (= S / US 36-38)", measurements: { chest: "36-38" } },
      { size: "2 (= M / US 38-40)", measurements: { chest: "38-40" } },
      { size: "3 (= L / US 40-42)", measurements: { chest: "40-42" } },
      { size: "4 (= XL / US 42-44)", measurements: { chest: "42-44" } },
      { size: "5 (= XXL / US 44-46)", measurements: { chest: "44-46" } },
    ],
  },
  {
    brand: "Moncler",
    brandMatch: ["moncler"],
    department: "Women",
    garment: "Outerwear (MONCLER 0-5 SCALE)",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "puffer", "parka", "vest", "top"],
    note:
      "THE NUMBER ON A MONCLER IS MONCLER'S OWN 0-5 SIZE AND THE GARMENT DOES NOT " +
      "SAY SO — and on WOMEN'S it is at its most dangerous, because the numbers " +
      "COLLIDE with US women's numeric sizing. A women's Moncler tagged \"2\" is a " +
      "US 6-8 / MEDIUM, not a US 2 — the same digit is a real size in both " +
      "systems, so nothing looks wrong. That is a THREE-SIZE error the photo " +
      "cannot contradict. ALWAYS state the Moncler number AND its US/alpha " +
      "equivalent. BODY measurement — NOT flat-garment. Approximation from the " +
      "published 0-5 mapping, not brand-fetched specs.",
    rows: [
      { size: "0 (= XS / US 0-2)", measurements: { bust: "32-33" } },
      { size: "1 (= S / US 4)", measurements: { bust: "33-34.5" } },
      { size: "2 (= M / US 6-8)", measurements: { bust: "34.5-36" } },
      { size: "3 (= L / US 10)", measurements: { bust: "36-38" } },
      { size: "4 (= XL / US 12)", measurements: { bust: "38-40" } },
      { size: "5 (= XXL / US 14)", measurements: { bust: "40-42" } },
    ],
  },
  {
    brand: "Canada Goose",
    brandMatch: ["canada goose", "canadagoose"],
    department: "Men",
    garment: "Outerwear",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "parka", "bomber", "vest", "top"],
    note:
      "BODY measurement — NOT flat-garment, and on this brand the gap is EXTREME: " +
      "an arctic parka is built around heavy down loft, so its flat chest measures " +
      "far above the body chest it is sized to. CANADA GOOSE RUNS LARGE and the " +
      "brand's own guidance is to size DOWN — a buyer who takes their usual size " +
      "in an Expedition gets a coat that swims. Say the flat measurements; do not " +
      "let the tag letter stand alone. NOTE the intra-brand spread: the slim " +
      "Kensington/Langford city cuts and the roomy Expedition do NOT wear the same " +
      "at one letter. Standard outerwear-alpha approximation, not brand-fetched specs.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "41-43" } },
      { size: "XL", measurements: { chest: "44-46" } },
      { size: "XXL", measurements: { chest: "47-49" } },
    ],
  },
  {
    brand: "Canada Goose",
    brandMatch: ["canada goose", "canadagoose"],
    department: "Women",
    garment: "Outerwear",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "parka", "bomber", "vest", "top"],
    note:
      "BODY measurement — NOT flat-garment; down loft puts the flat chest well " +
      "above the body bust the coat is sized to. CANADA GOOSE RUNS LARGE — size " +
      "DOWN is the brand's own guidance. The women's line spans a slim cut " +
      "(Kensington) and a relaxed one (Trillium), so one letter does not wear the " +
      "same across the range; state the flat measurements. Standard outerwear-alpha " +
      "approximation, not brand-fetched specs.",
    rows: [
      { size: "XS", measurements: { bust: "32-33" } },
      { size: "S", measurements: { bust: "34-35" } },
      { size: "M", measurements: { bust: "36-37.5" } },
      { size: "L", measurements: { bust: "38.5-40" } },
      { size: "XL", measurements: { bust: "41-43" } },
    ],
  },
  {
    brand: "Mackage",
    brandMatch: ["mackage"],
    department: "Men",
    garment: "Outerwear",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "parka", "leather", "top"],
    note:
      "BODY measurement — NOT flat-garment. MACKAGE IS THE PLAIN-READING CONTROL IN " +
      "THIS GROUP: it sizes in ordinary US alpha (XS-XXL), so unlike Moncler/Herno/" +
      "Bogner the tag means what it appears to mean and needs no translation. The " +
      "cut is TRIM/tailored rather than roomy, so it does not wear like the " +
      "deliberately oversized parkas beside it in this pack. Standard " +
      "outerwear-alpha approximation, not brand-fetched specs.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "41-43" } },
      { size: "XL", measurements: { chest: "44-46" } },
      { size: "XXL", measurements: { chest: "47-49" } },
    ],
  },
  {
    brand: "Mackage",
    brandMatch: ["mackage"],
    department: "Women",
    garment: "Outerwear",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "parka", "leather", "top"],
    note:
      "BODY measurement — NOT flat-garment. Ordinary US alpha sizing (the " +
      "plain-reading control in this group — no translation needed, unlike " +
      "Moncler/Herno/Bogner). The women's range extends to XXS. Cut TRIM/tailored, " +
      "and the belted coats (Adali/Kay) are meant to cinch — a belt-less listing " +
      "misrepresents the fit as well as the completeness. Standard outerwear-alpha " +
      "approximation, not brand-fetched specs.",
    rows: [
      { size: "XXS", measurements: { bust: "31-32" } },
      { size: "XS", measurements: { bust: "32-33" } },
      { size: "S", measurements: { bust: "34-35" } },
      { size: "M", measurements: { bust: "36-37.5" } },
      { size: "L", measurements: { bust: "38.5-40" } },
      { size: "XL", measurements: { bust: "41-43" } },
    ],
  },
  {
    brand: "Herno",
    brandMatch: ["herno"],
    department: "Men",
    garment: "Outerwear (ITALIAN-SIZED)",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "rain", "top", "blazer"],
    note:
      "THE NUMBER ON A HERNO IS AN ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO — " +
      "the highest-value Herno fact. A jacket tagged \"50\" is an IT 50 = US 40 = L. " +
      "SUBTRACT 10 to reach the US number. ALWAYS state both. BODY measurement — " +
      "NOT flat-garment; Italian outerwear is cut TRIM, so a Herno IT 50 wears " +
      "smaller than a US L from an American outdoor brand. Standard IT-to-US " +
      "menswear approximation, not brand-fetched specs.",
    rows: [
      { size: "46 (= IT 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= IT 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= IT 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= IT 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= IT 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= IT 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Herno",
    brandMatch: ["herno"],
    department: "Women",
    garment: "Outerwear (ITALIAN-SIZED)",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "rain", "top"],
    note:
      "THE NUMBER ON A HERNO IS AN ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO — " +
      "and the WOMEN'S chart is the dangerous one, because an IT 42 reads as a " +
      "plausible US 42 while actually being a US 6. SUBTRACT 36 to reach the US " +
      "number (IT 42 - 36 = US 6). ALWAYS state both. BODY measurement — NOT " +
      "flat-garment; Italian outerwear is cut TRIM. Standard IT-to-US womenswear " +
      "approximation, not brand-fetched specs.",
    rows: [
      { size: "38 (= IT 38 / US 2 / XS)", measurements: { bust: "32-33" } },
      { size: "40 (= IT 40 / US 4 / S)", measurements: { bust: "33-34.5" } },
      { size: "42 (= IT 42 / US 6 / M)", measurements: { bust: "34.5-36" } },
      { size: "44 (= IT 44 / US 8 / M-L)", measurements: { bust: "36-37.5" } },
      { size: "46 (= IT 46 / US 10 / L)", measurements: { bust: "38-39.5" } },
      { size: "48 (= IT 48 / US 12 / XL)", measurements: { bust: "40-41.5" } },
    ],
  },
  {
    brand: "Woolrich",
    brandMatch: ["woolrich", "john rich"],
    department: "Men",
    garment: "Outerwear & wool",
    categoryMatch: [
      "jacket",
      "coat",
      "outerwear",
      "down",
      "parka",
      "shirt",
      "wool",
      "flannel",
      "top",
    ],
    note:
      "BODY measurement — NOT flat-garment. WATCH THE SIZE SYSTEM, IT FOLLOWS THE " +
      "ERA: this US alpha chart covers the American heritage wool (the Made-in-USA " +
      "Buffalo Check era, mill closed 2018), but the ITALIAN-era outerwear sold " +
      "under the same label may carry EU sizing instead — one brand, two systems, " +
      "decided by which Woolrich the garment is. Confirm from the origin tag before " +
      "trusting the label. The heritage wool is also cut GENEROUS/boxy as an " +
      "overshirt layer, so the body chart does NOT predict the flat measurement. " +
      "Standard US-alpha approximation, not brand-fetched specs.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "41-43" } },
      { size: "XL", measurements: { chest: "44-46" } },
      { size: "XXL", measurements: { chest: "47-49" } },
    ],
  },
  {
    brand: "Woolrich",
    brandMatch: ["woolrich", "john rich"],
    department: "Women",
    garment: "Outerwear & wool",
    categoryMatch: [
      "jacket",
      "coat",
      "outerwear",
      "down",
      "parka",
      "shirt",
      "wool",
      "flannel",
      "top",
    ],
    note:
      "BODY measurement — NOT flat-garment. WATCH THE SIZE SYSTEM, IT FOLLOWS THE " +
      "ERA: US alpha on the American heritage wool, possibly EU numbers on the " +
      "Italian-era outerwear (the Arctic Parka) under the SAME label. Confirm which " +
      "Woolrich the garment is from the origin tag before trusting the size. " +
      "Standard US-alpha approximation, not brand-fetched specs.",
    rows: [
      { size: "XS", measurements: { bust: "32-33" } },
      { size: "S", measurements: { bust: "34-35" } },
      { size: "M", measurements: { bust: "36-37.5" } },
      { size: "L", measurements: { bust: "38.5-40" } },
      { size: "XL", measurements: { bust: "41-43" } },
    ],
  },
  {
    brand: "Bogner",
    brandMatch: ["bogner", "fire + ice", "fire and ice"],
    department: "Men",
    garment: "Ski & outerwear (GERMAN-SIZED)",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "ski", "pant", "top"],
    note:
      "THE NUMBER ON A BOGNER IS A GERMAN SIZE AND THE GARMENT DOES NOT SAY SO — " +
      "the highest-value Bogner fact. A men's piece tagged \"50\" is a DE 50 = US " +
      "40 = L. SUBTRACT 10 to reach the US number. ALWAYS state both. BODY " +
      "measurement — NOT flat-garment; ski wear is cut with layering room over a " +
      "base layer, so its flat chest measures above the body chest it is sized to. " +
      "This chart serves BOTH ladders (mainline Bogner and the Fire + Ice diffusion " +
      "line) — they share the size system but NOT the price, so read the LINE off " +
      "the tag separately. Standard DE-to-US menswear approximation, not " +
      "brand-fetched specs.",
    rows: [
      { size: "46 (= DE 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= DE 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= DE 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= DE 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= DE 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= DE 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Bogner",
    brandMatch: ["bogner", "fire + ice", "fire and ice"],
    department: "Women",
    garment: "Ski & outerwear (GERMAN-SIZED)",
    categoryMatch: ["jacket", "coat", "outerwear", "down", "ski", "pant", "top"],
    note:
      "THE NUMBER ON A BOGNER IS A GERMAN SIZE AND THE GARMENT DOES NOT SAY SO — " +
      "and the WOMEN'S chart is the dangerous one, because a DE 38 reads as a " +
      "plausible-looking number while actually being a US 8, and a DE 34 is a US 4. " +
      "SUBTRACT 30 to reach the US number (DE 38 - 30 = US 8). ALWAYS state both. " +
      "BODY measurement — NOT flat-garment; ski wear is cut with layering room. " +
      "Serves BOTH ladders (mainline and Fire + Ice) — same size system, different " +
      "price, so read the LINE off the tag. Standard DE-to-US womenswear " +
      "approximation, not brand-fetched specs.",
    rows: [
      { size: "34 (= DE 34 / US 4 / XS)", measurements: { bust: "32-33" } },
      { size: "36 (= DE 36 / US 6 / S)", measurements: { bust: "33.5-34.5" } },
      { size: "38 (= DE 38 / US 8 / M)", measurements: { bust: "35-36" } },
      { size: "40 (= DE 40 / US 10 / L)", measurements: { bust: "36.5-38" } },
      { size: "42 (= DE 42 / US 12 / XL)", measurements: { bust: "38.5-40" } },
      { size: "44 (= DE 44 / US 14 / XXL)", measurements: { bust: "41-42.5" } },
    ],
  },
  // ── US-1982: luxury RTW & leather group (tier 2) ───────────────────────────
  // Mirrors migration 00461's brand_size_charts seed.
  //
  // FRENCH OR ITALIAN — THE SAME NUMBER IS TWO DIFFERENT SIZES. Every house here
  // sizes its women's RTW in a European system its tag never names, and the group
  // SPLITS across two of them:
  //   * FRENCH (Hermès, Dior, Saint Laurent, Balenciaga, Celine): US = FR - 32.
  //   * ITALIAN (Bottega Veneta, Fendi, Versace):                 US = IT - 36.
  // So "42" IS A US 10 ON A DIOR AND A US 6 ON A FENDI — two dark designer dresses
  // that photograph identically, two sizes apart. This is worse than 00460's
  // unnamed-system trap, which at least broke the same way on every brand in its
  // pack: here the seller who correctly learns "42 = US 6" from a Fendi and carries
  // it to a Dior is WRONG BECAUSE THEY LEARNED THE RULE. So the cross-map goes
  // INSIDE the size LABEL (the US-1731/1740 lesson), not in the note alone.
  //
  // MENSWEAR IS UNAFFECTED and every men's note says so: French and Italian
  // tailoring both run the same EU numbers (drop 10). Stating that is the point — a
  // reader who over-generalizes starts "correcting" menswear sizes already right.
  //
  // NOTE the Saint Laurent / Balenciaga / Celine trap: all three are FRENCH houses
  // that manufacture in ITALY, so the origin tag actively points at the wrong size
  // system. The manufacturing country never sets the sizing.
  {
    brand: "Hermès",
    brandMatch: ["hermès", "hermes"],
    department: "Women",
    garment: "RTW (FRENCH-SIZED)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "jacket", "coat", "knit", "shirt", "outerwear", "pant"],
    note:
      "THE NUMBER ON AN HERMÈS IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY SO. " +
      "SUBTRACT 32 to reach the US number (FR 38 - 32 = US 6). ALWAYS state both. " +
      "AND MIND THE OTHER HALF OF THIS PACK: the same number means something " +
      "DIFFERENT on the Italian houses beside it — a \"42\" is a US 10 here and a " +
      "US 6 on a Fendi/Versace/Bottega Veneta. A seller who learns one rule and " +
      "applies it to the whole luxury tier is wrong half the time. BODY " +
      "measurement — NOT flat-garment. Standard FR-to-US approximation, not " +
      "brand-fetched specs.",
    rows: [
      { size: "34 (= FR 34 / US 2 / XS)", measurements: { bust: "32-33" } },
      { size: "36 (= FR 36 / US 4 / S)", measurements: { bust: "33-34.5" } },
      { size: "38 (= FR 38 / US 6 / M)", measurements: { bust: "34.5-36" } },
      { size: "40 (= FR 40 / US 8 / M-L)", measurements: { bust: "36-37.5" } },
      { size: "42 (= FR 42 / US 10 / L)", measurements: { bust: "38-39.5" } },
      { size: "44 (= FR 44 / US 12 / XL)", measurements: { bust: "40-41.5" } },
    ],
  },
  {
    brand: "Hermès",
    brandMatch: ["hermès", "hermes"],
    department: "Men",
    garment: "RTW (EU-SIZED)",
    categoryMatch: ["jacket", "coat", "shirt", "blazer", "knit", "top", "outerwear", "pant", "suit"],
    note:
      "The number on an Hermès men's piece is a EUROPEAN size and the garment does " +
      "not say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). " +
      "MENSWEAR IS THE EASY HALF OF THIS PACK: French and Italian tailoring run the " +
      "SAME numbers, so unlike the women's charts there is no FR-vs-IT collision " +
      "here — a men's 50 is a US 40 on every brand in this group. Do NOT apply the " +
      "women's FR/IT distinction to menswear. BODY measurement — NOT flat-garment; " +
      "the cut is TRIM. Standard EU-to-US approximation, not brand-fetched specs.",
    rows: [
      { size: "46 (= FR 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= FR 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= FR 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= FR 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= FR 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= FR 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Dior",
    brandMatch: ["dior"],
    department: "Women",
    garment: "RTW (FRENCH-SIZED)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "jacket", "coat", "knit", "shirt", "outerwear", "pant"],
    note:
      "THE NUMBER ON A DIOR IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY SO — and " +
      "this is the chart that names the pack's headline collision. A DIOR TAGGED " +
      "\"42\" IS A US 10. A FENDI TAGGED \"42\" IS A US 6. Same two digits, two " +
      "sizes apart, on two dark designer dresses that photograph identically — and " +
      "the seller who correctly learned \"42 = US 6\" from an Italian house is wrong " +
      "here BECAUSE they learned the rule. SUBTRACT 32 for French (FR 42 - 32 = US " +
      "10); it is 36 for the Italian houses. ALWAYS state both. BODY measurement — " +
      "NOT flat-garment. Standard FR-to-US approximation, not brand-fetched specs.",
    rows: [
      { size: "34 (= FR 34 / US 2 / XS)", measurements: { bust: "32-33" } },
      { size: "36 (= FR 36 / US 4 / S)", measurements: { bust: "33-34.5" } },
      { size: "38 (= FR 38 / US 6 / M)", measurements: { bust: "34.5-36" } },
      { size: "40 (= FR 40 / US 8 / M-L)", measurements: { bust: "36-37.5" } },
      { size: "42 (= FR 42 / US 10 / L)", measurements: { bust: "38-39.5" } },
      { size: "44 (= FR 44 / US 12 / XL)", measurements: { bust: "40-41.5" } },
    ],
  },
  {
    brand: "Dior",
    brandMatch: ["dior"],
    department: "Men",
    garment: "RTW (EU-SIZED)",
    categoryMatch: ["jacket", "coat", "shirt", "blazer", "knit", "top", "outerwear", "pant", "suit"],
    note:
      "The number on a Dior men's piece is a EUROPEAN size and the garment does not " +
      "say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). MENSWEAR IS " +
      "THE EASY HALF OF THIS PACK: French and Italian tailoring run the SAME " +
      "numbers, so the women's FR-vs-IT collision does NOT apply here — do not " +
      "\"correct\" a men's size for it. BODY measurement — NOT flat-garment; Dior " +
      "Homme in particular is cut EXTREMELY SLIM (the Slimane lineage), so it wears " +
      "well below its nominal size — the most common Dior menswear fit complaint. " +
      "Standard EU-to-US approximation, not brand-fetched specs.",
    rows: [
      { size: "46 (= EU 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= EU 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= EU 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= EU 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= EU 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= EU 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Saint Laurent",
    brandMatch: ["saint laurent", "yves saint laurent"],
    department: "Women",
    garment: "RTW (FRENCH-SIZED)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "jacket", "coat", "knit", "shirt", "outerwear", "pant"],
    note:
      "THE NUMBER ON A SAINT LAURENT IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY " +
      "SO — and the MADE IN ITALY tag does NOT change that. This is the brand where " +
      "the trap bites hardest: Saint Laurent is a FRENCH house that manufactures in " +
      "ITALY, so the origin tag actively points at the wrong size system. The " +
      "manufacturing country never sets the sizing. SUBTRACT 32 (FR 38 - 32 = US 6); " +
      "an Italian HOUSE would be 36, but this is not one. ALWAYS state both. BODY " +
      "measurement — NOT flat-garment; the cut is famously SLIM (the Slimane " +
      "lineage), so it wears below its nominal size. Standard FR-to-US " +
      "approximation, not brand-fetched specs.",
    rows: [
      { size: "34 (= FR 34 / US 2 / XS)", measurements: { bust: "32-33" } },
      { size: "36 (= FR 36 / US 4 / S)", measurements: { bust: "33-34.5" } },
      { size: "38 (= FR 38 / US 6 / M)", measurements: { bust: "34.5-36" } },
      { size: "40 (= FR 40 / US 8 / M-L)", measurements: { bust: "36-37.5" } },
      { size: "42 (= FR 42 / US 10 / L)", measurements: { bust: "38-39.5" } },
      { size: "44 (= FR 44 / US 12 / XL)", measurements: { bust: "40-41.5" } },
    ],
  },
  {
    brand: "Saint Laurent",
    brandMatch: ["saint laurent", "yves saint laurent"],
    department: "Men",
    garment: "RTW (EU-SIZED)",
    categoryMatch: ["jacket", "coat", "shirt", "blazer", "knit", "top", "outerwear", "pant", "suit"],
    note:
      "The number on a Saint Laurent men's piece is a EUROPEAN size and the garment " +
      "does not say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). " +
      "MENSWEAR IS THE EASY HALF OF THIS PACK — French and Italian tailoring run the " +
      "SAME numbers, so the women's FR-vs-IT collision does not apply. BODY " +
      "measurement — NOT flat-garment; the Slimane-lineage cut is EXTREMELY SLIM and " +
      "wears well below its nominal size, which is this brand's most common " +
      "menswear fit complaint. Standard EU-to-US approximation, not brand-fetched " +
      "specs.",
    rows: [
      { size: "46 (= EU 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= EU 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= EU 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= EU 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= EU 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= EU 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Balenciaga",
    brandMatch: ["balenciaga"],
    department: "Women",
    garment: "RTW (FRENCH-SIZED)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "jacket", "coat", "knit", "shirt", "outerwear", "pant"],
    note:
      "THE NUMBER ON A BALENCIAGA IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY SO — " +
      "and as with Saint Laurent, the MADE IN ITALY tag does not change it: a French " +
      "house that manufactures in Italy still sizes French. SUBTRACT 32 (FR 40 - 32 " +
      "= US 8). ALWAYS state both. THIS BRAND RUNS TWO SIZE SYSTEMS: the RTW is " +
      "French, but the SNEAKERS (Triple S, Speed Trainer) are EU shoe sizes — read " +
      "the OBJECT before the number, since this chart does not apply to footwear. " +
      "Demna-era RTW is also deliberately OVERSIZED, so its flat measurements run " +
      "far above the body chart. BODY measurement — NOT flat-garment. Standard " +
      "FR-to-US approximation, not brand-fetched specs.",
    rows: [
      { size: "34 (= FR 34 / US 2 / XS)", measurements: { bust: "32-33" } },
      { size: "36 (= FR 36 / US 4 / S)", measurements: { bust: "33-34.5" } },
      { size: "38 (= FR 38 / US 6 / M)", measurements: { bust: "34.5-36" } },
      { size: "40 (= FR 40 / US 8 / M-L)", measurements: { bust: "36-37.5" } },
      { size: "42 (= FR 42 / US 10 / L)", measurements: { bust: "38-39.5" } },
      { size: "44 (= FR 44 / US 12 / XL)", measurements: { bust: "40-41.5" } },
    ],
  },
  {
    brand: "Balenciaga",
    brandMatch: ["balenciaga"],
    department: "Men",
    garment: "RTW (EU-SIZED)",
    categoryMatch: ["jacket", "coat", "shirt", "blazer", "knit", "top", "outerwear", "pant", "suit"],
    note:
      "The number on a Balenciaga men's piece is a EUROPEAN size and the garment " +
      "does not say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). " +
      "MENSWEAR IS THE EASY HALF OF THIS PACK — French and Italian tailoring run the " +
      "SAME numbers, so the women's FR-vs-IT collision does not apply. This chart " +
      "does NOT cover the brand's sneakers, which are EU shoe-sized. Demna-era " +
      "pieces are deliberately OVERSIZED — their flat measurements run far above " +
      "this body chart, and that is the design, not a mis-tag. BODY measurement — " +
      "NOT flat-garment. Standard EU-to-US approximation, not brand-fetched specs.",
    rows: [
      { size: "46 (= EU 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= EU 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= EU 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= EU 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= EU 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= EU 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Celine",
    brandMatch: ["celine", "céline"],
    department: "Women",
    garment: "RTW (FRENCH-SIZED)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "jacket", "coat", "knit", "shirt", "outerwear", "pant"],
    note:
      "THE NUMBER ON A CELINE IS A FRENCH SIZE AND THE GARMENT DOES NOT SAY SO — and " +
      "the Made in Italy tag does not change it (French house, Italian manufacture). " +
      "SUBTRACT 32 (FR 38 - 32 = US 6); the Italian houses in this same pack subtract " +
      "36, which is the collision this group exists to prevent. ALWAYS state both. " +
      "ALSO READ THE ACCENT while you are at the label: CÉLINE (accented) is the " +
      "Phoebe Philo era and comps ABOVE modern CELINE — the size and the era are on " +
      "the same tag, so read both in one pass. BODY measurement — NOT flat-garment. " +
      "Standard FR-to-US approximation, not brand-fetched specs.",
    rows: [
      { size: "34 (= FR 34 / US 2 / XS)", measurements: { bust: "32-33" } },
      { size: "36 (= FR 36 / US 4 / S)", measurements: { bust: "33-34.5" } },
      { size: "38 (= FR 38 / US 6 / M)", measurements: { bust: "34.5-36" } },
      { size: "40 (= FR 40 / US 8 / M-L)", measurements: { bust: "36-37.5" } },
      { size: "42 (= FR 42 / US 10 / L)", measurements: { bust: "38-39.5" } },
      { size: "44 (= FR 44 / US 12 / XL)", measurements: { bust: "40-41.5" } },
    ],
  },
  {
    brand: "Celine",
    brandMatch: ["celine", "céline"],
    department: "Men",
    garment: "RTW (EU-SIZED)",
    categoryMatch: ["jacket", "coat", "shirt", "blazer", "knit", "top", "outerwear", "pant", "suit"],
    note:
      "The number on a Celine men's piece is a EUROPEAN size and the garment does " +
      "not say so: SUBTRACT 10 to reach the US number (50 - 10 = US 40 / L). " +
      "MENSWEAR IS THE EASY HALF OF THIS PACK — French and Italian tailoring run the " +
      "SAME numbers, so the women's FR-vs-IT collision does not apply. BODY " +
      "measurement — NOT flat-garment; the Slimane-era menswear is cut EXTREMELY " +
      "SLIM and wears below its nominal size. Standard EU-to-US approximation, not " +
      "brand-fetched specs.",
    rows: [
      { size: "46 (= EU 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= EU 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= EU 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= EU 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= EU 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= EU 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Bottega Veneta",
    brandMatch: ["bottega veneta"],
    department: "Women",
    garment: "RTW (ITALIAN-SIZED)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "jacket", "coat", "knit", "shirt", "outerwear", "pant"],
    note:
      "THE NUMBER ON A BOTTEGA VENETA IS AN ITALIAN SIZE AND THE GARMENT DOES NOT " +
      "SAY SO. SUBTRACT 36 to reach the US number (IT 42 - 36 = US 6). ALWAYS state " +
      "both. AND MIND THE OTHER HALF OF THIS PACK: the FRENCH houses beside it " +
      "(Hermès, Dior, Saint Laurent, Balenciaga, Celine) subtract 32, so a \"42\" is " +
      "a US 6 HERE and a US 10 THERE. Same two digits, two sizes apart. Do not carry " +
      "one rule across the luxury tier — read the HOUSE first, then the number. BODY " +
      "measurement — NOT flat-garment; the cut is TRIM. Standard IT-to-US " +
      "approximation, not brand-fetched specs.",
    rows: [
      { size: "38 (= IT 38 / US 2 / XS)", measurements: { bust: "32-33" } },
      { size: "40 (= IT 40 / US 4 / S)", measurements: { bust: "33-34.5" } },
      { size: "42 (= IT 42 / US 6 / M)", measurements: { bust: "34.5-36" } },
      { size: "44 (= IT 44 / US 8 / M-L)", measurements: { bust: "36-37.5" } },
      { size: "46 (= IT 46 / US 10 / L)", measurements: { bust: "38-39.5" } },
      { size: "48 (= IT 48 / US 12 / XL)", measurements: { bust: "40-41.5" } },
    ],
  },
  {
    brand: "Bottega Veneta",
    brandMatch: ["bottega veneta"],
    department: "Men",
    garment: "RTW (EU-SIZED)",
    categoryMatch: ["jacket", "coat", "shirt", "blazer", "knit", "top", "outerwear", "pant", "suit"],
    note:
      "The number on a Bottega Veneta men's piece is an ITALIAN size and the garment " +
      "does not say so: SUBTRACT 10 to reach the US number (IT 50 - 10 = US 40 / L). " +
      "MENSWEAR IS THE EASY HALF OF THIS PACK: Italian and French tailoring run the " +
      "SAME numbers, so unlike the women's charts there is no IT-vs-FR collision " +
      "here — a men's 50 is a US 40 on every brand in this group. Do NOT apply the " +
      "women's distinction to menswear. BODY measurement — NOT flat-garment; Italian " +
      "tailoring is cut TRIM. Standard EU-to-US approximation, not brand-fetched " +
      "specs.",
    rows: [
      { size: "46 (= IT 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= IT 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= IT 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= IT 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= IT 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= IT 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Fendi",
    brandMatch: ["fendi"],
    department: "Women",
    garment: "RTW (ITALIAN-SIZED)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "jacket", "coat", "knit", "shirt", "outerwear", "pant"],
    note:
      "THE NUMBER ON A FENDI IS AN ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO — " +
      "and this is the other half of the pack's headline collision. A FENDI TAGGED " +
      "\"42\" IS A US 6. A DIOR TAGGED \"42\" IS A US 10. Same two digits, two sizes " +
      "apart, and the seller who learns the rule from one house and carries it to " +
      "the other is wrong BECAUSE they learned it. SUBTRACT 36 for Italian (IT 42 - " +
      "36 = US 6); it is 32 for the French houses. ALWAYS state both. BODY " +
      "measurement — NOT flat-garment; the cut is TRIM. Standard IT-to-US " +
      "approximation, not brand-fetched specs.",
    rows: [
      { size: "38 (= IT 38 / US 2 / XS)", measurements: { bust: "32-33" } },
      { size: "40 (= IT 40 / US 4 / S)", measurements: { bust: "33-34.5" } },
      { size: "42 (= IT 42 / US 6 / M)", measurements: { bust: "34.5-36" } },
      { size: "44 (= IT 44 / US 8 / M-L)", measurements: { bust: "36-37.5" } },
      { size: "46 (= IT 46 / US 10 / L)", measurements: { bust: "38-39.5" } },
      { size: "48 (= IT 48 / US 12 / XL)", measurements: { bust: "40-41.5" } },
    ],
  },
  {
    brand: "Fendi",
    brandMatch: ["fendi"],
    department: "Men",
    garment: "RTW (EU-SIZED)",
    categoryMatch: ["jacket", "coat", "shirt", "blazer", "knit", "top", "outerwear", "pant", "suit"],
    note:
      "The number on a Fendi men's piece is an ITALIAN size and the garment does not " +
      "say so: SUBTRACT 10 to reach the US number (IT 50 - 10 = US 40 / L). MENSWEAR " +
      "IS THE EASY HALF OF THIS PACK — Italian and French tailoring run the SAME " +
      "numbers, so the women's IT-vs-FR collision does not apply here. BODY " +
      "measurement — NOT flat-garment; Italian tailoring is cut TRIM. Standard " +
      "EU-to-US approximation, not brand-fetched specs.",
    rows: [
      { size: "46 (= IT 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= IT 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= IT 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= IT 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= IT 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= IT 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Versace",
    brandMatch: ["versace"],
    department: "Women",
    garment: "RTW (ITALIAN-SIZED)",
    categoryMatch: ["dress", "top", "blouse", "skirt", "jacket", "coat", "knit", "shirt", "outerwear", "pant"],
    note:
      "THE NUMBER ON A VERSACE IS AN ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO. " +
      "SUBTRACT 36 to reach the US number (IT 42 - 36 = US 6). MIND THE OTHER HALF " +
      "OF THIS PACK: the FRENCH houses beside it (Hermès, Dior, Saint Laurent, " +
      "Balenciaga, Celine) subtract 32, so a \"42\" is a US 6 here and a US 10 " +
      "there. ALWAYS state both. AND READ THE FULL LABEL WHILE YOU ARE THERE: this " +
      "chart covers mainline Versace AND the Versus/Collection/Jeans Couture " +
      "diffusion labels — they share the Italian size system but sell an ORDER OF " +
      "MAGNITUDE apart, so the size does NOT tell you the ladder. Versace RTW also " +
      "runs SMALL/tight by design (body-conscious cut), which compounds the number " +
      "misread. BODY measurement — NOT flat-garment. Standard IT-to-US " +
      "approximation, not brand-fetched specs.",
    rows: [
      { size: "38 (= IT 38 / US 2 / XS)", measurements: { bust: "32-33" } },
      { size: "40 (= IT 40 / US 4 / S)", measurements: { bust: "33-34.5" } },
      { size: "42 (= IT 42 / US 6 / M)", measurements: { bust: "34.5-36" } },
      { size: "44 (= IT 44 / US 8 / M-L)", measurements: { bust: "36-37.5" } },
      { size: "46 (= IT 46 / US 10 / L)", measurements: { bust: "38-39.5" } },
      { size: "48 (= IT 48 / US 12 / XL)", measurements: { bust: "40-41.5" } },
    ],
  },
  {
    brand: "Versace",
    brandMatch: ["versace"],
    department: "Men",
    garment: "RTW (EU-SIZED)",
    categoryMatch: ["jacket", "coat", "shirt", "blazer", "knit", "top", "outerwear", "pant", "suit"],
    note:
      "The number on a Versace men's piece is an ITALIAN size and the garment does " +
      "not say so: SUBTRACT 10 to reach the US number (IT 50 - 10 = US 40 / L). " +
      "MENSWEAR IS THE EASY HALF OF THIS PACK — Italian and French tailoring run the " +
      "SAME numbers, so the women's IT-vs-FR collision does not apply. This chart " +
      "serves mainline Versace AND the Versus/Collection/Jeans Couture diffusion " +
      "labels: same size system, ORDER-OF-MAGNITUDE different price, so read the " +
      "LINE off the tag separately — the size never tells you the ladder. The cut is " +
      "body-conscious and runs SMALL. BODY measurement — NOT flat-garment. Standard " +
      "EU-to-US approximation, not brand-fetched specs.",
    rows: [
      { size: "46 (= IT 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= IT 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= IT 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= IT 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= IT 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= IT 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  // ── US-1983: new-generation streetwear & hype group ────────────────────────
  // Mirrors migration 00462's brand_size_charts seed.
  //
  // THIS TIER PUBLISHES NO SIZE CHARTS. That is the honest situation, and it is
  // why every chart here is the standard streetwear-alpha approximation and says
  // so in its own note. What the notes actually carry is the FIT INTENT, because
  // that is the fact a body chart cannot express — and on this tier it SPLITS:
  //   * OVERSIZED BY DESIGN: Hellstar, Gallery Dept. (flat measurements run well
  //     above the body chart ON PURPOSE — that is the design, not a mis-tag).
  //   * RUNS SMALL:          Sp5der, Chrome Hearts, ASSC (buyers size up).
  //   * BOXY (short + wide): Aimé Leon Dore.
  // A grader who carries one brand's fit intent across the tier reports the
  // design as an error in one direction or the other.
  //
  // TWO BRANDS BREAK THE ALPHA SYSTEM ENTIRELY:
  //   * DENIM TEARS — the Cotton Wreath signature is printed on an ACTUAL LEVI'S
  //     501, so the size is a LEVI'S WAIST NUMBER. The only waist chart here.
  //   * OFF-WHITE — a Milan house, so its TAILORING carries Italian numbers
  //     (US = IT - 36, the 00461 rule) while its tees are alpha. One brand, two
  //     systems: read the OBJECT before the number.
  {
    brand: "Off-White",
    brandMatch: ["off-white", "off white", "offwhite"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "hoodie",
      "sweatshirt",
      "knit",
      "sweater",
      "jacket",
      "outerwear",
    ],
    note:
      "Off-White's graphic tees and hoodies are ALPHA-sized and the brand publishes " +
      "no chart — this is the standard streetwear-alpha approximation, NOT " +
      "brand-fetched. ONE BRAND, TWO SYSTEMS: Off-White is a MILAN house, so its " +
      "tailoring and RTW carry ITALIAN NUMBERS (44/46/48 — subtract 36 for the US " +
      "size) while the tees are alpha. READ THE OBJECT BEFORE THE NUMBER; this " +
      "chart covers the alpha-sized pieces only. The cut is Italian and runs " +
      "SMALL/SLIM relative to US streetwear, so many buyers size UP. BODY " +
      "measurement — NOT flat-garment. Capped confidence.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "40-42" } },
      { size: "XL", measurements: { chest: "42-45" } },
      { size: "XXL", measurements: { chest: "45-48" } },
    ],
  },
  {
    brand: "Off-White",
    brandMatch: ["off-white", "off white", "offwhite"],
    department: "Men",
    garment: "RTW (ITALIAN-SIZED)",
    categoryMatch: ["blazer", "suit", "tailoring", "coat", "trouser", "pant"],
    note:
      "The number on an Off-White TAILORED piece is an ITALIAN size and the garment " +
      "does not say so: SUBTRACT 10 to reach the US number (IT 50 - 10 = US 40 / L). " +
      "Off-White is a MILAN house — the same Italian system the luxury RTW pack " +
      "(00461: Bottega Veneta/Fendi/Versace) runs on, and Off-White is the ONLY " +
      "brand in the hype tier that touches it. THE SAME BRAND'S TEES AND HOODIES " +
      "ARE ALPHA-SIZED — read the OBJECT before the number; a number on an " +
      "Off-White is tailoring, a letter is a graphic piece. The cut runs SLIM. " +
      "BODY measurement — NOT flat-garment. Standard IT-to-US approximation, not " +
      "brand-fetched specs.",
    rows: [
      { size: "46 (= IT 46 / US 36 / S)", measurements: { chest: "36-37" } },
      { size: "48 (= IT 48 / US 38 / M)", measurements: { chest: "38-39" } },
      { size: "50 (= IT 50 / US 40 / L)", measurements: { chest: "40-41" } },
      { size: "52 (= IT 52 / US 42 / XL)", measurements: { chest: "42-43" } },
      { size: "54 (= IT 54 / US 44 / XXL)", measurements: { chest: "44-45" } },
      { size: "56 (= IT 56 / US 46 / XXXL)", measurements: { chest: "46-47" } },
    ],
  },
  {
    brand: "Chrome Hearts",
    brandMatch: ["chrome hearts", "chromehearts"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "hoodie",
      "sweatshirt",
      "knit",
      "sweater",
      "jacket",
      "outerwear",
    ],
    note:
      "Chrome Hearts is ALPHA-sized and the brand publishes no size chart at all " +
      "(it runs no e-commerce) — this is the standard streetwear-alpha " +
      "approximation, NOT brand-fetched. THE CUT RUNS SMALL: Chrome Hearts apparel " +
      "is cut close and buyers commonly size UP, which is the opposite of the " +
      "oversized brands in this same pack (Hellstar, Gallery Dept.). Do not carry " +
      "one brand's fit intent across this tier — it splits. BODY measurement — NOT " +
      "flat-garment. Capped confidence.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "40-42" } },
      { size: "XL", measurements: { chest: "42-45" } },
      { size: "XXL", measurements: { chest: "45-48" } },
    ],
  },
  {
    brand: "Aimé Leon Dore",
    // norm() only LOWERCASES — it does NOT strip accents (unlike brandKey), and
    // brand-knowledge.ts passes the ACCENTED canonical in. So the accented
    // spelling is the one that actually matches; the plain one is for raw seller
    // text. Same shape as the Stüssy/'stssy' split (00389).
    brandMatch: ["aimé leon dore", "aime leon dore", "aimeleondore"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "hoodie",
      "sweatshirt",
      "knit",
      "sweater",
      "polo",
      "jacket",
      "outerwear",
    ],
    note:
      "Aimé Leon Dore is ALPHA-sized — the standard streetwear-alpha " +
      "approximation, NOT brand-fetched. THE CUT IS BOXY AND WIDE BY DESIGN, " +
      "especially the knit polos and crewnecks: the garment measures SHORT and " +
      "WIDE relative to its nominal size, and that is the design rather than a " +
      "mis-tag. So a flat chest measurement will read large while the LENGTH reads " +
      "small — report both and do not 'correct' either. BODY measurement — NOT " +
      "flat-garment. Capped confidence.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "40-42" } },
      { size: "XL", measurements: { chest: "42-45" } },
      { size: "XXL", measurements: { chest: "45-48" } },
    ],
  },
  {
    brand: "Gallery Dept.",
    brandMatch: ["gallery dept", "gallerydept"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "hoodie",
      "sweatshirt",
      "knit",
      "jacket",
      "outerwear",
    ],
    note:
      "Gallery Dept. is ALPHA-sized and publishes no chart — the standard " +
      "streetwear-alpha approximation, NOT brand-fetched. TWO WARNINGS THAT MATTER " +
      "MORE THAN THE NUMBERS. (1) The cut is OVERSIZED/boxy by design, so flat " +
      "measurements run well above this body chart on purpose. (2) MUCH OF THE LINE " +
      "IS UPCYCLED FROM VINTAGE GARMENTS, so THE INTERIOR TAG MAY BE THE DONOR " +
      "GARMENT'S — it can read another brand's name and another brand's size system " +
      "entirely (frequently a Levi's). On an upcycled piece the tag is NOT the size: " +
      "measure the garment and say the tag is the donor's. BODY measurement — NOT " +
      "flat-garment. Capped confidence.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "40-42" } },
      { size: "XL", measurements: { chest: "42-45" } },
      { size: "XXL", measurements: { chest: "45-48" } },
    ],
  },
  {
    // THE ONLY WAIST CHART IN THIS PACK — and the collaboration is the reason.
    brand: "Denim Tears",
    brandMatch: ["denim tears", "denimtears"],
    department: "Unisex",
    garment: "Bottoms (LEVI'S WAIST-SIZED)",
    categoryMatch: ["bottom", "jean", "jeans", "denim", "pant", "trouser"],
    note:
      "THE ODD ONE OUT IN THIS PACK, AND IT IS THE COLLABORATION THAT DOES IT: the " +
      "signature Cotton Wreath jeans and trucker jackets are printed on ACTUAL " +
      "LEVI'S GARMENTS under an official collaboration, so the size is a LEVI'S " +
      "WAIST NUMBER (W x L) — NOT the alpha sizing every other brand in this tier " +
      "uses. Read the waist and inseam off the Levi's tag inside the garment. THAT " +
      "SAME TAG SAYS LEVI'S, AND THE PIECE IS STILL A DENIM TEARS: both brands are " +
      "true at once. Do not conclude 'this is a Levi's 501' from the interior tag — " +
      "that throws away an order of magnitude of value — and do not discard the tag " +
      "either, because it is the only place the size lives. The Cotton Wreath " +
      "SWEATSHIRTS are alpha-sized on a collaborator's blank; this chart is for the " +
      "denim. BODY measurement (natural waist) — NOT the flat-garment waist, which " +
      "measures roughly half. Capped confidence.",
    rows: [
      { size: "W28 (= Levi's 28 / US 28in waist)", measurements: { waist: "28-29" } },
      { size: "W30 (= Levi's 30 / US 30in waist)", measurements: { waist: "30-31" } },
      { size: "W32 (= Levi's 32 / US 32in waist)", measurements: { waist: "32-33" } },
      { size: "W34 (= Levi's 34 / US 34in waist)", measurements: { waist: "34-35" } },
      { size: "W36 (= Levi's 36 / US 36in waist)", measurements: { waist: "36-37" } },
      { size: "W38 (= Levi's 38 / US 38in waist)", measurements: { waist: "38-39" } },
    ],
  },
  {
    brand: "Rhude",
    brandMatch: ["rhude"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "hoodie",
      "sweatshirt",
      "knit",
      "jacket",
      "outerwear",
    ],
    note:
      "Rhude is ALPHA-sized — the standard streetwear-alpha approximation, NOT " +
      "brand-fetched. The cut sits between the two poles of this pack: closer to " +
      "true-to-size than the oversized brands (Hellstar, Gallery Dept.) and not as " +
      "tight as the small-running ones (Sp5der, Chrome Hearts, ASSC), with some " +
      "Italian-made pieces running slim. Report the measurement rather than applying " +
      "a fit adjustment. BODY measurement — NOT flat-garment. Capped confidence.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "40-42" } },
      { size: "XL", measurements: { chest: "42-45" } },
      { size: "XXL", measurements: { chest: "45-48" } },
    ],
  },
  {
    brand: "Sp5der",
    // A bare "spider" is DELIBERATELY not here — it is an ordinary word and a
    // common graphic SUBJECT, so it would fire on any garment whose own print is
    // described as a spider. The chart is reached via the canonical, which is
    // what brand-knowledge.ts passes in.
    brandMatch: ["sp5der", "spider worldwide"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "hoodie",
      "sweatshirt",
      "jacket",
      "outerwear",
    ],
    note:
      "Sp5der is ALPHA-sized and the brand publishes essentially nothing, including " +
      "no size chart — this is the standard streetwear-alpha approximation, NOT " +
      "brand-fetched, and it is the least-sourced chart in this pack. THE CUT RUNS " +
      "SMALL and buyers commonly size UP — the opposite of the oversized brands " +
      "beside it (Hellstar, Gallery Dept.). The fit intent SPLITS across this tier: " +
      "do not carry one brand's to another. BODY measurement — NOT flat-garment. " +
      "Capped confidence.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "40-42" } },
      { size: "XL", measurements: { chest: "42-45" } },
      { size: "XXL", measurements: { chest: "45-48" } },
    ],
  },
  {
    brand: "Hellstar",
    brandMatch: ["hellstar"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "hoodie",
      "sweatshirt",
      "jacket",
      "outerwear",
    ],
    note:
      "Hellstar is ALPHA-sized and the brand publishes essentially nothing, " +
      "including no size chart — the standard streetwear-alpha approximation, NOT " +
      "brand-fetched. THE CUT IS OVERSIZED BY DESIGN: flat measurements run well " +
      "above this body chart ON PURPOSE, and a grader who reads that as a mis-tag is " +
      "reporting the design as an error. That is the opposite of the small-running " +
      "brands in this same pack (Sp5der, Chrome Hearts, ASSC) — the fit intent " +
      "SPLITS across this tier, so read the HOUSE before adjusting anything. BODY " +
      "measurement — NOT flat-garment. Capped confidence.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "40-42" } },
      { size: "XL", measurements: { chest: "42-45" } },
      { size: "XXL", measurements: { chest: "45-48" } },
    ],
  },
  {
    brand: "Anti Social Social Club",
    // A bare "assc" is DELIBERATELY not here — four letters are too short to
    // match safely as a substring. The chart is reached via the canonical.
    brandMatch: ["anti social social club", "antisocialsocialclub"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "hoodie",
      "sweatshirt",
      "jacket",
      "outerwear",
    ],
    note:
      "Anti Social Social Club is ALPHA-sized and publishes no chart — the standard " +
      "streetwear-alpha approximation, NOT brand-fetched. The pieces are printed on " +
      "ordinary blanks from various suppliers, so the fit is NOT consistent drop to " +
      "drop: ASSC generally runs SMALL, but the blank changes, which is a real " +
      "reason to trust a measurement over the tag here more than anywhere else in " +
      "this pack. BODY measurement — NOT flat-garment. Capped confidence.",
    rows: [
      { size: "XS", measurements: { chest: "34-36" } },
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "40-42" } },
      { size: "XL", measurements: { chest: "42-45" } },
      { size: "XXL", measurements: { chest: "45-48" } },
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

  // ── US-1985: activewear group (tier 2) ─────────────────────────────────────
  // Mirrors migration 00465's brand_size_charts seed (the DB rows win when the
  // pack loads; these are the offline fallback).
  //
  // THIS PACK IS THE FIRST WITH TWO SIZING SYSTEMS UNDER ONE BRAND, and it is why
  // these rows are shaped as they are. Before 00465 no brand in this table owned
  // both a Footwear chart and a garment chart: 00459 was footwear-only, 00464 was
  // apparel-only, the athleisure packs are apparel-only. Here FILA, PUMA and
  // REEBOK own BOTH — one brand, one tag, and the size on it is a STAMPED shoe
  // number or an alpha chest letter depending only on what the item is.
  //
  // `categoryMatch` is the ONLY thing choosing between them, and a miss silently
  // hands a hoodie a shoe chart. So the category lists below are drawn TIGHT and
  // do not overlap between a brand's two systems, and every `garment` string
  // NAMES ITS SYSTEM so the model can see which chart it was given.
  //
  // THE TWO SYSTEMS READ IN OPPOSITE DIRECTIONS:
  //   * a GARMENT chart is an ESTIMATOR — measure the chest, double it, read off;
  //   * a SHOE chart is a TRANSLATOR (the 00459 rule) — a shoe size cannot be
  //     measured from a photo, it is STAMPED and must be READ, then converted.
  //     The US/UK/EU triple lives INSIDE the size label, where the model reads it.
  //
  // AND THE FIT DIRECTION SPLITS THE SIX SHOE BRANDS IN TWO — there is no single
  // "athletic shoes run X" rule:
  //     ASICS / On       run SMALL and NARROW   (a Japanese last; a narrow Swiss one)
  //     PUMA             runs SMALL
  //     Reebok classics  run LARGE
  //     HOKA / Fila      ≈ true to size (the Disruptor a touch large)
  //
  // brandMatch tokens deliberately ABSENT: "on" (brandTextMatches is
  // leading-word-boundary only and "on" STARTS "Onitsuka" — a bare token would
  // hand an Onitsuka Tiger On Running's charts; the canonical "On Running" is
  // what the resolver passes anyway), and "ov"/"girlfriend" (alias KEYS only —
  // a 2-letter or ordinary-word token here is the "ag"-hands-Patagonia-AG's-
  // charts bug, US-1735).
  //
  // Cross-maps are the standard US/UK/EU grade and the run-small/run-large calls
  // are the reported resale consensus — not brand-published specs.
  {
    brand: "Champion",
    brandMatch: ["champion"],
    department: "Men",
    garment: "Tops (alpha — vintage runs BOXY)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "sweatshirt",
      "hoodie",
      "crewneck",
      "sweater",
      "jersey",
      "long sleeve",
    ],
    note:
      "BODY measurement (chest) — an ESTIMATOR: measure the flat chest (armpit " +
      "to armpit) and DOUBLE IT. CHAMPION IS APPAREL ONLY — it makes no " +
      "footwear, so unlike PUMA/Reebok/Fila in this same pack there is no shoe " +
      "chart to confuse this with. CHAMPION-SPECIFIC AND IT IS THE POINT OF THIS " +
      "ROW: THE VINTAGE CUT IS BOXY AND THE MODERN CUT IS NOT. A 1980s-90s " +
      "Champion sweatshirt is cut SHORT AND WIDE — the chest may hit this chart " +
      "while the body length runs several inches shorter than a modern " +
      "equivalent letter, so the same L is a materially different garment across " +
      "eras and the tag will never say so. Measure the LENGTH as well as the " +
      "chest on any vintage piece and publish both; the era comes off the NECK " +
      "TAG. Reverse Weave resists vertical shrinkage by design (that is what the " +
      "construction is for), so a vintage piece has usually NOT shrunk in length " +
      "— it was cut that way. Standard US alpha approximation — capped confidence.",
    rows: [
      { size: "S", measurements: { chest: "34-37" } },
      { size: "M", measurements: { chest: "38-41" } },
      { size: "L", measurements: { chest: "42-45" } },
      { size: "XL", measurements: { chest: "46-49" } },
      { size: "XXL", measurements: { chest: "50-53" } },
      { size: "XXXL", measurements: { chest: "54-57" } },
    ],
  },
  {
    brand: "Champion",
    brandMatch: ["champion"],
    department: "Women",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "sweatshirt",
      "hoodie",
      "crewneck",
      "sweater",
      "blouse",
      "long sleeve",
    ],
    note:
      "BODY measurement (bust) — measure the flat chest and DOUBLE IT. Champion " +
      "is apparel-only (no footwear), so there is no shoe chart to confuse this " +
      "with. NOTE THE UNISEX TRAP ON THIS BRAND SPECIFICALLY: much of Champion's " +
      "sweatshirt volume — including most vintage Reverse Weave — is cut on a " +
      "MEN'S/unisex block and merely sold to women, so a sweatshirt found in a " +
      "women's wardrobe is frequently a men's-graded garment and belongs on the " +
      "men's chart. If the tag does not state a department, measure and use the " +
      "men's row rather than assuming. Standard US alpha approximation — capped " +
      "confidence.",
    rows: [
      { size: "XS", measurements: { bust: "31-32.5" } },
      { size: "S", measurements: { bust: "33-34.5" } },
      { size: "M", measurements: { bust: "35-36.5" } },
      { size: "L", measurements: { bust: "37.5-39" } },
      { size: "XL", measurements: { bust: "40.5-42.5" } },
      { size: "XXL", measurements: { bust: "44-46" } },
    ],
  },

  // Fila — the first of the pack's dual-system brands. NOTE no "boot" category
  // token: categoryMatch is a plain substring test, so "boot" would fire on
  // "bootcut" and hand a bootcut garment a shoe chart. Fila sells no boots.
  {
    brand: "Fila",
    brandMatch: ["fila"],
    department: "Men",
    garment: "Footwear (US/UK/EU — the size is STAMPED, not measured)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "disruptor",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR, NOT AN ESTIMATOR — the size CANNOT be " +
      "measured from a photo. It is STAMPED on the tongue label or the insole " +
      "and must be READ, then converted; the foot-length inches are a sanity " +
      "check for a shoe in hand. FILA SELLS SHOES AND CLOTHES UNDER ONE NAME, so " +
      "settle the GARMENT TYPE before reading the size: a stamped 9 is this " +
      "chart, an M is the Fila tops chart. Never carry one onto the other. " +
      "FILA-SPECIFIC: roughly true to size, though the DISRUPTOR runs a touch " +
      "LARGE and is often sized down a half — state the stamped number so the " +
      "buyer can judge. Condition for the Disruptor: the white midsole YELLOWS " +
      "progressively and irreversibly (a real value lever); its oversized sole " +
      "is DESIGNED and is not deformity. Standard US/UK/EU grade and the " +
      "reported resale consensus, not Fila-published specs — capped confidence.",
    rows: [
      { size: "US M7 = UK 6 = EU 40", measurements: { footLength: "9.6" } },
      { size: "US M8 = UK 7 = EU 41", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8 = EU 42.5", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9 = EU 44", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10 = EU 45", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11 = EU 46", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12 = EU 47.5", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Fila",
    brandMatch: ["fila"],
    department: "Women",
    garment: "Footwear (US/UK/EU — the size is STAMPED, not measured)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "disruptor",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR — the size is STAMPED on the tongue label " +
      "and must be READ, not measured from a photo. Fila sells shoes AND clothes " +
      "under one name, so settle the garment type before reading the size. " +
      "FILA-SPECIFIC: roughly true to size; the DISRUPTOR — overwhelmingly a " +
      "women's seller — runs a touch LARGE. Its oversized sawtooth sole is " +
      "DESIGNED and is not deformity; the white midsole's YELLOWING is the real, " +
      "irreversible condition axis. Standard US/UK/EU grade and the reported " +
      "resale consensus, not Fila-published specs — capped confidence.",
    rows: [
      { size: "US W6 = UK 3.5 = EU 36.5", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 4.5 = EU 37.5", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 5.5 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 6.5 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 7.5 = EU 41.5", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 8.5 = EU 42.5", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "Fila",
    brandMatch: ["fila"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "jacket",
      "track jacket",
      "sweatshirt",
      "hoodie",
      "jersey",
      "long sleeve",
    ],
    note:
      "BODY measurement (chest) — an ESTIMATOR, unlike the Fila FOOTWEAR charts " +
      "on this same brand: measure the flat chest (armpit to armpit) and DOUBLE " +
      "IT. THIS IS THE GARMENT CHART. A size on a Fila tag is a shoe number OR a " +
      "chest letter depending on what the item is, and the item type is the only " +
      "thing that decides — never read an alpha letter off a shoe or a stamped " +
      "number off a track jacket. FILA-SPECIFIC: the vintage ITALIAN-MADE track " +
      "jackets (Settanta/Terrinda) are cut to a 1970s-80s European grade and run " +
      "SMALLER and shorter than the modern line at the same letter — measure a " +
      "vintage piece rather than trusting its letter. Standard US alpha " +
      "approximation — capped confidence.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "42-44" } },
      { size: "XL", measurements: { chest: "46-48" } },
      { size: "XXL", measurements: { chest: "50-52" } },
    ],
  },

  // PUMA — shoe + garment under one brand. Runs SMALL.
  {
    brand: "PUMA",
    brandMatch: ["puma"],
    department: "Men",
    garment: "Footwear (US/UK/EU — RUNS SMALL, size is STAMPED)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "suede",
      "clyde",
      "speedcat",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR, NOT AN ESTIMATOR — the size CANNOT be " +
      "measured from a photo. It is STAMPED on the tongue label and must be " +
      "READ, then converted; the foot-length inches are a sanity check for a " +
      "shoe in hand. PUMA SELLS SHOES AND CLOTHES UNDER ONE NAME, so settle the " +
      "GARMENT TYPE before reading the size: a stamped 9 is this chart, an M is " +
      "the PUMA tops chart. PUMA-SPECIFIC: the brand is widely reported to RUN " +
      "SMALL (roughly a half size) — the same direction as ASICS and On in this " +
      "pack and the OPPOSITE of the Reebok classics, so there is no single " +
      "athletic-shoe rule and the brand decides. State the stamped number so the " +
      "buyer can judge. Condition on the Suede/Clyde: the suede NAP is the grade " +
      "— scuffing, matting and water staining are progressive and irreversible, " +
      "and a straight-on photo hides all three. Standard US/UK/EU grade and the " +
      "reported resale consensus, not PUMA-published specs — capped confidence.",
    rows: [
      { size: "US M7 = UK 6 = EU 39", measurements: { footLength: "9.6" } },
      { size: "US M8 = UK 7 = EU 40.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8 = EU 42", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9 = EU 43", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10 = EU 44.5", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11 = EU 46", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12 = EU 47", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "PUMA",
    brandMatch: ["puma"],
    department: "Women",
    garment: "Footwear (US/UK/EU — RUNS SMALL, size is STAMPED)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "suede",
      "clyde",
      "speedcat",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR — the size is STAMPED on the tongue label " +
      "and must be READ, not measured from a photo. PUMA sells shoes AND clothes " +
      "under one name, so settle the garment type before reading the size. " +
      "PUMA-SPECIFIC: the brand RUNS SMALL (roughly a half size) — the opposite " +
      "of the Reebok classics in this same pack. State the stamped number in the " +
      "listing. Standard US/UK/EU grade and the reported resale consensus, not " +
      "PUMA-published specs — capped confidence.",
    rows: [
      { size: "US W6 = UK 3.5 = EU 36", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 4.5 = EU 37.5", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 5.5 = EU 38.5", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 6.5 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 7.5 = EU 41", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 8.5 = EU 42.5", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "PUMA",
    brandMatch: ["puma"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "jacket",
      "track jacket",
      "sweatshirt",
      "hoodie",
      "jersey",
      "long sleeve",
    ],
    note:
      "BODY measurement (chest) — an ESTIMATOR, unlike the PUMA FOOTWEAR charts " +
      "on this same brand: measure the flat chest (armpit to armpit) and DOUBLE " +
      "IT. THIS IS THE GARMENT CHART. A size on a PUMA tag is a stamped shoe " +
      "number OR an alpha chest letter depending on what the item is, and only " +
      "the item type decides — a T7 track jacket reads here, a Suede reads on " +
      "the footwear chart. Never carry one onto the other. Standard US alpha " +
      "approximation — capped confidence.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "42-44" } },
      { size: "XL", measurements: { chest: "46-48" } },
      { size: "XXL", measurements: { chest: "50-52" } },
    ],
  },

  // Reebok — the pack's ONLY runs-LARGE shoe brand. Shoe + garment.
  {
    brand: "Reebok",
    brandMatch: ["reebok"],
    department: "Men",
    garment: "Footwear (US/UK/EU — classics RUN LARGE, size is STAMPED)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "classic leather",
      "club c",
      "nano",
      "pump",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR, NOT AN ESTIMATOR — the size CANNOT be " +
      "measured from a photo. It is STAMPED on the tongue label and must be " +
      "READ, then converted; the foot-length inches are a sanity check for a " +
      "shoe in hand. REEBOK SELLS SHOES AND CLOTHES UNDER ONE NAME, so settle " +
      "the GARMENT TYPE before reading the size. REEBOK-SPECIFIC AND IT RUNS " +
      "OPPOSITE TO MOST OF THIS PACK: the CLASSICS (Classic Leather, Club C, " +
      "Freestyle) are widely reported to RUN LARGE and are commonly sized DOWN a " +
      "half — where ASICS, On and PUMA in this same pack all run SMALL. So one " +
      "blanket athletic-shoe rule is wrong in both directions here, and the " +
      "brand decides. The performance line (Nano) is closer to true to size. " +
      "State the stamped number so the buyer can judge. Condition: the white " +
      "midsole on the classics YELLOWS progressively and irreversibly — a real " +
      "value lever. On any PUMP model the inflation bladder is a FUNCTIONAL " +
      "component that no photo reveals: test it in hand and say whether it " +
      "holds. Standard US/UK/EU grade and the reported resale consensus, not " +
      "Reebok-published specs — capped confidence.",
    rows: [
      { size: "US M7 = UK 6 = EU 39", measurements: { footLength: "9.6" } },
      { size: "US M8 = UK 7 = EU 40.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8 = EU 42", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9 = EU 43", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10 = EU 44.5", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11 = EU 45.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12 = EU 47", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Reebok",
    brandMatch: ["reebok"],
    department: "Women",
    garment: "Footwear (US/UK/EU — classics RUN LARGE, size is STAMPED)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "classic leather",
      "club c",
      "freestyle",
      "nano",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR — the size is STAMPED on the tongue label " +
      "and must be READ, not measured from a photo. Reebok sells shoes AND " +
      "clothes under one name, so settle the garment type before reading the " +
      "size. REEBOK-SPECIFIC: the CLASSICS (Club C, Classic Leather, Freestyle) " +
      "RUN LARGE and are commonly sized DOWN a half — the OPPOSITE direction to " +
      "ASICS, On and PUMA in this same pack. State the stamped number in the " +
      "listing. The white midsole YELLOWS progressively and irreversibly, which " +
      "is a real value lever on the classics. Standard US/UK/EU grade and the " +
      "reported resale consensus, not Reebok-published specs — capped confidence.",
    rows: [
      { size: "US W6 = UK 3.5 = EU 36", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 4.5 = EU 37.5", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 5.5 = EU 38.5", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 6.5 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 7.5 = EU 41", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 8.5 = EU 42", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "Reebok",
    brandMatch: ["reebok"],
    department: "Unisex",
    garment: "Tops (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "jacket",
      "track jacket",
      "sweatshirt",
      "hoodie",
      "jersey",
      "long sleeve",
    ],
    note:
      "BODY measurement (chest) — an ESTIMATOR, unlike the Reebok FOOTWEAR " +
      "charts on this same brand: measure the flat chest (armpit to armpit) and " +
      "DOUBLE IT. THIS IS THE GARMENT CHART. A size on a Reebok tag is a stamped " +
      "shoe number OR an alpha chest letter depending on the item, and only the " +
      "item type decides. NOTE the runs-large caveat on the Reebok footwear " +
      "charts is a FOOTWEAR fact and does NOT transfer here — the apparel is " +
      "roughly true to size. Standard US alpha approximation — capped confidence.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "42-44" } },
      { size: "XL", measurements: { chest: "46-48" } },
      { size: "XXL", measurements: { chest: "50-52" } },
    ],
  },

  // ASICS — footwear only in practice. RUNS SMALL AND NARROW.
  {
    brand: "ASICS",
    brandMatch: ["asics"],
    department: "Men",
    garment: "Footwear (US/UK/EU + width — RUNS SMALL AND NARROW)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "running",
      "gel",
      "kayano",
      "nimbus",
      "gel-lyte",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR, NOT AN ESTIMATOR — the size CANNOT be " +
      "measured from a photo. It is STAMPED on the tongue label and must be " +
      "READ, then converted; the foot-length inches are a sanity check for a " +
      "shoe in hand. ASICS-SPECIFIC AND IT IS THE MOST USEFUL FACT THIS BRAND " +
      "HAS: THE LAST IS CUT TO A JAPANESE GRADE AND RUNS SMALL AND NARROW — " +
      "roughly a half size small, and snug through the midfoot. So a buyer's " +
      "usual size is frequently wrong on this brand specifically, and it is the " +
      "opposite of the Reebok classics in this same pack. WIDTH IS PART OF THE " +
      "PRODUCT: D is the standard men's width and a 2E/4E is a genuinely " +
      "different shoe that a wide-footed buyer searches for — it is stamped " +
      "beside the size and belongs in the listing. THE TONGUE LABEL ALSO CARRIES " +
      "THE 8-CHARACTER ARTICLE NUMBER (1011B491), which identifies the model " +
      "when the name is not legible — transcribe it. Condition: the foam midsole " +
      "COMPRESSES and the shoe is functionally dead before the upper looks it — " +
      "check the midsole sidewall for deep creasing, not just the mesh. Standard " +
      "US/UK/EU grade and the reported resale consensus, not ASICS-published " +
      "specs — capped confidence.",
    rows: [
      { size: "US M7 = UK 6 = EU 40", measurements: { footLength: "9.6" } },
      { size: "US M8 = UK 7 = EU 41.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8 = EU 42.5", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9 = EU 44", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10 = EU 45", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11 = EU 46.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12 = EU 48", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "ASICS",
    brandMatch: ["asics"],
    department: "Women",
    garment: "Footwear (US/UK/EU + width — RUNS SMALL AND NARROW)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "running",
      "gel",
      "kayano",
      "nimbus",
      "gel-lyte",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR — the size is STAMPED on the tongue label " +
      "and must be READ, not measured from a photo. ASICS-SPECIFIC: the last is " +
      "cut to a JAPANESE GRADE and RUNS SMALL AND NARROW (roughly a half size " +
      "small, snug through the midfoot) — the opposite of the Reebok classics in " +
      "this same pack. WIDTH IS PART OF THE PRODUCT and it is stamped beside the " +
      "size: B is the standard women's width and a D is WIDE here — note that " +
      "the SAME letter D means the STANDARD width on ASICS MEN'S, so never carry " +
      "one department's width reading onto the other (the same trap New Balance " +
      "carries in 00459). The tongue label also carries the 8-character article " +
      "number, which identifies the model when the name is not legible. Standard " +
      "US/UK/EU grade and the reported resale consensus, not ASICS-published " +
      "specs — capped confidence.",
    rows: [
      { size: "US W6 = UK 4.5 = EU 37", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 5.5 = EU 38", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 6.5 = EU 39.5", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 7.5 = EU 40.5", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 8.5 = EU 42", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 9.5 = EU 43", measurements: { footLength: "10.5" } },
    ],
  },

  // On Running — footwear only. RUNS SMALL AND NARROW. The voids are designed.
  // NOTE brandMatch carries NO bare "on": brandTextMatches is leading-word-
  // boundary only and "on" STARTS "Onitsuka", so the token would hand an
  // Onitsuka Tiger these charts. The canonical "On Running" is what the resolver
  // passes anyway, so the chart is reached without it.
  {
    brand: "On Running",
    brandMatch: ["on running", "onrunning"],
    department: "Men",
    garment: "Footwear (US/UK/EU — RUNS SMALL AND NARROW)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "running",
      "cloud",
      "cloudmonster",
      "cloudnova",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR, NOT AN ESTIMATOR — the size CANNOT be " +
      "measured from a photo. It is STAMPED on the tongue label and must be " +
      "READ, then converted; the foot-length inches are a sanity check for a " +
      "shoe in hand. ON-SPECIFIC: the brand RUNS SMALL (roughly a half size) " +
      "with a NARROW midfoot and a snug toe box — the same direction as ASICS in " +
      "this pack and the opposite of the Reebok classics. AND THE CONDITION RULE " +
      "THAT MATTERS MORE THAN THE SIZE: THE HOLES THROUGH THE SOLE ARE THE " +
      "PRODUCT. CloudTec is an outsole of hollow pods, so a brand-new shoe has " +
      "large open voids right through it and looks worn through to daylight — " +
      "grading them as damage marks a mint shoe to Poor. Designed voids are " +
      "uniform, clean-edged and identical on both shoes. The real defects: a " +
      "COLLAPSED or TORN pod, debris wedged in the pods (cleanable — note it, do " +
      "not grade it as structural), and a midfoot that flexes limply (a broken " +
      "Speedboard plate). Standard US/UK/EU grade and the reported resale " +
      "consensus, not On-published specs — capped confidence.",
    rows: [
      { size: "US M7 = UK 6.5 = EU 40", measurements: { footLength: "9.6" } },
      { size: "US M8 = UK 7.5 = EU 41.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8.5 = EU 42.5", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9.5 = EU 44", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10.5 = EU 45", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11.5 = EU 46.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12.5 = EU 47.5", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "On Running",
    brandMatch: ["on running", "onrunning"],
    department: "Women",
    garment: "Footwear (US/UK/EU — RUNS SMALL AND NARROW)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "running",
      "cloud",
      "cloudmonster",
      "cloudnova",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR — the size is STAMPED on the tongue label " +
      "and must be READ, not measured from a photo. ON-SPECIFIC: RUNS SMALL " +
      "(roughly a half size) and NARROW — the same direction as ASICS in this " +
      "pack, the opposite of the Reebok classics. THE HOLES THROUGH THE SOLE ARE " +
      "THE PRODUCT: the CloudTec pods are hollow by design, so a new shoe has " +
      "open voids right through it and a grader reading them as damage marks a " +
      "mint shoe to Poor. The real defects are a COLLAPSED or TORN pod and " +
      "debris wedged inside the pods (cleanable — note it rather than grading it " +
      "as structural damage). Standard US/UK/EU grade and the reported resale " +
      "consensus, not On-published specs — capped confidence.",
    rows: [
      { size: "US W6 = UK 4 = EU 36.5", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 5 = EU 38", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 6 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 7 = EU 40.5", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 8 = EU 41.5", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 9 = EU 43", measurements: { footLength: "10.5" } },
    ],
  },

  // HOKA — footwear only. The midsole is the grade.
  {
    brand: "HOKA",
    brandMatch: ["hoka"],
    department: "Men",
    garment: "Footwear (US/UK/EU — the size is STAMPED, not measured)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "running",
      "bondi",
      "clifton",
      "speedgoat",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR, NOT AN ESTIMATOR — the size CANNOT be " +
      "measured from a photo. It is STAMPED on the tongue label and must be " +
      "READ, then converted; the foot-length inches are a sanity check for a " +
      "shoe in hand. HOKA-SPECIFIC: roughly true to size, unlike ASICS/On " +
      "(small) and the Reebok classics (large) in this same pack — WIDTH is the " +
      "axis that matters here instead, and a 2E/4E wide is stamped beside the " +
      "size and is a genuinely different product a wide-footed buyer searches " +
      "for. AND THE RULE THAT MATTERS MOST ON THIS BRAND: THE MIDSOLE IS THE " +
      "PRODUCT AND ALSO THE GRADE. Its deliberately enormous volume is the " +
      "DESIGN, not swelling or delamination — but because the foam is what the " +
      "buyer is buying, a COMPRESSED midsole is a TOTAL LOSS even under a " +
      "spotless upper, and it is nearly invisible in a normal photo. Look at the " +
      "midsole SIDEWALL side-on: deep horizontal creasing, a flattened section, " +
      "or foam that does not spring back means the shoe is functionally dead. " +
      "Photograph the midsole from the side. Also: the META-ROCKER curve means " +
      "the shoe DOES NOT SIT FLAT on a table by design — that is not a warped " +
      "sole. Standard US/UK/EU grade and the reported resale consensus, not " +
      "HOKA-published specs — capped confidence.",
    rows: [
      { size: "US M7 = UK 6.5 = EU 40", measurements: { footLength: "9.6" } },
      { size: "US M8 = UK 7.5 = EU 41.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8.5 = EU 42.5", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9.5 = EU 44", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10.5 = EU 45.5", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11.5 = EU 46.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12.5 = EU 48", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "HOKA",
    brandMatch: ["hoka"],
    department: "Women",
    garment: "Footwear (US/UK/EU — the size is STAMPED, not measured)",
    categoryMatch: [
      "footwear",
      "shoe",
      "shoes",
      "sneaker",
      "sneakers",
      "trainer",
      "running",
      "bondi",
      "clifton",
      "speedgoat",
    ],
    note:
      "A SHOE CHART IS A TRANSLATOR — the size is STAMPED on the tongue label " +
      "and must be READ, not measured from a photo. HOKA-SPECIFIC: roughly true " +
      "to size (unlike ASICS/On, which run small, and the Reebok classics, which " +
      "run large); a D width is WIDE on women's here and is stamped beside the " +
      "size. THE MIDSOLE IS THE PRODUCT AND ALSO THE GRADE: the enormous volume " +
      "is the design and not a deformity, but a COMPRESSED midsole is a total " +
      "loss even under a spotless upper and is nearly invisible in a photo — " +
      "check the midsole SIDEWALL side-on for deep creasing or a collapsed " +
      "section and photograph it. The META-ROCKER curve means the shoe does not " +
      "sit flat by design; that is not a warped sole. Standard US/UK/EU grade " +
      "and the reported resale consensus, not HOKA-published specs — capped " +
      "confidence.",
    rows: [
      { size: "US W6 = UK 4 = EU 36.5", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 5 = EU 38", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 6 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 7 = EU 40.5", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 8 = EU 42", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 9 = EU 43", measurements: { footLength: "10.5" } },
    ],
  },

  // Outdoor Voices — apparel only. NOTE brandMatch carries no bare "ov" (a
  // 2-letter token here is the "ag"-hands-Patagonia-AG's-charts bug) and no bare
  // "outdoor" (an ordinary category word).
  {
    brand: "Outdoor Voices",
    brandMatch: ["outdoor voices", "outdoorvoices"],
    department: "Women",
    garment: "Tops, dresses & bottoms (alpha)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "dress",
      "legging",
      "pant",
      "bottom",
      "short",
      "sweatshirt",
      "hoodie",
      "bra",
      "exercise dress",
      "long sleeve",
    ],
    note:
      "BODY measurement — an ESTIMATOR: measure the flat garment and DOUBLE IT. " +
      "The US numeric cross-map is written INSIDE the size label, where the " +
      "model actually reads it. OUTDOOR VOICES IS APPAREL ONLY — it makes no " +
      "footwear, so unlike Fila/PUMA/Reebok/ASICS/On/HOKA in this same pack " +
      "there is no shoe chart to confuse this with and an alpha letter is always " +
      "a garment size. OV-SPECIFIC AND IT DEFEATS A FLAT PHOTO: the performance " +
      "pieces are TECHSWEAT, a compressive knit, and compressive knits fail by " +
      "PILLING (inner thigh, under the seat) and by losing elastane recovery — " +
      "which shows as a waistband that will not spring back and a fabric that " +
      "goes SHEER WHEN STRETCHED. NONE of that appears in a flat, unstretched " +
      "flat-lay, so a clean photo is not evidence of good condition: check the " +
      "high-abrasion zones and the stretch-sheerness and report what you found. " +
      "THE EXERCISE DRESS has a built-in bra AND built-in shorts — those " +
      "interior layers are the CONSTRUCTION, not a defect and not a second " +
      "garment. Standard US alpha/numeric approximation — capped confidence.",
    rows: [
      { size: "XS (≈US 0-2)", measurements: { bust: "31.5-33", waist: "24-25.5", hip: "34-35.5" } },
      { size: "S (≈US 4-6)", measurements: { bust: "33.5-35", waist: "26-27.5", hip: "36-37.5" } },
      { size: "M (≈US 8-10)", measurements: { bust: "35.5-37.5", waist: "28-30", hip: "38-40" } },
      { size: "L (≈US 12-14)", measurements: { bust: "38.5-40.5", waist: "31-33", hip: "41-43" } },
      { size: "XL (≈US 16-18)", measurements: { bust: "41.5-44", waist: "34-36.5", hip: "44-46.5" } },
      { size: "XXL (≈US 20)", measurements: { bust: "45-47", waist: "37.5-39.5", hip: "47.5-49.5" } },
    ],
  },

  // Girlfriend Collective — women's only, and the WIDEST run in the KB. NOTE
  // brandMatch carries no bare "girlfriend" (an ordinary word; it is an alias
  // KEY only, where an exact whole-field lookup makes it safe).
  {
    brand: "Girlfriend Collective",
    brandMatch: ["girlfriend collective", "girlfriendcollective"],
    department: "Women",
    garment: "Tops & bottoms (alpha XXS-6XL — the widest run in the KB)",
    categoryMatch: [
      "top",
      "tee",
      "legging",
      "pant",
      "bottom",
      "short",
      "bra",
      "sweatshirt",
      "hoodie",
      "dress",
      "long sleeve",
    ],
    note:
      "BODY measurement — an ESTIMATOR: measure the flat garment and DOUBLE IT. " +
      "The US numeric cross-map is written INSIDE the size label, where the " +
      "model actually reads it. Girlfriend Collective is APPAREL ONLY (no " +
      "footwear) and WOMEN'S ONLY, so no men's chart is seeded rather than " +
      "inventing one. THIS IS THE WIDEST SIZE RUN IN THE KNOWLEDGE BASE — XXS " +
      "THROUGH 6XL — AND THAT IS THE POINT OF THE BRAND, not a footnote: a plus " +
      "size here is a MAINLINE product, and the larger sizes are genuinely " +
      "sought and are frequently the harder ones to find secondhand. TWO " +
      "CONSEQUENCES. First, the letter spans a far wider range than a " +
      "conventional brand's, so an XL on this tag is NOT an XL on a brand whose " +
      "run stops at XL — NEVER cross-map the letter between brands; read this " +
      "chart or measure. Second, read the size off the tag exactly and state it. " +
      "FIT: the Compressive fabric is a firm HIGH-COMPRESSION knit, so it fits " +
      "tighter than an ordinary legging at the same letter by design — that is " +
      "the product, not a mis-size. CONDITION, AND A FLAT PHOTO HIDES ALL OF IT: " +
      "compressive knits fail by PILLING (inner thigh, under the seat) and by " +
      "losing elastane recovery, which shows as a waistband that will not spring " +
      "back and a fabric that goes SHEER WHEN STRETCHED. Check the " +
      "high-abrasion zones and the stretch-sheerness explicitly and say what you " +
      "found. Standard US alpha/numeric approximation — capped confidence.",
    rows: [
      { size: "XXS (≈US 0-2)", measurements: { bust: "30-32", waist: "23-25", hip: "33-35" } },
      { size: "XS (≈US 2-4)", measurements: { bust: "32-34", waist: "25-27", hip: "35-37" } },
      { size: "S (≈US 4-6)", measurements: { bust: "34-36", waist: "27-29", hip: "37-39" } },
      { size: "M (≈US 8-10)", measurements: { bust: "36-38", waist: "29-31", hip: "39-41" } },
      { size: "L (≈US 12-14)", measurements: { bust: "38-41", waist: "31-34", hip: "41-44" } },
      { size: "XL (≈US 16-18)", measurements: { bust: "41-44", waist: "34-37", hip: "44-47" } },
      { size: "2XL (≈US 18-20)", measurements: { bust: "44-47", waist: "37-40", hip: "47-50" } },
      { size: "3XL (≈US 22-24)", measurements: { bust: "47-50", waist: "40-43", hip: "50-53" } },
      { size: "4XL (≈US 26)", measurements: { bust: "50-53", waist: "43-46", hip: "53-56" } },
      { size: "5XL (≈US 28)", measurements: { bust: "53-56", waist: "46-49", hip: "56-59" } },
      { size: "6XL (≈US 30-32)", measurements: { bust: "56-59", waist: "49-52", hip: "59-62" } },
    ],
  },

  // ── US-1986: fast-fashion & mall group, tier 2 ──────────────────────────────
  // Mirrors migration 00466's brand_size_charts seed (the DB rows win when the
  // pack loads; these are the offline fallback).
  //
  // 00458's pack was about the SPREAD — every tag says the same letters and they
  // mean different bodies (a Uniqlo M vs an Old Navy M). THIS pack is a harder
  // problem one level up, and it is why these brands belong together:
  //
  //     THE SAME NUMBER IS TWO DIFFERENT SIZE SYSTEMS, AND ONLY THE BRAND SAYS
  //     WHICH. A Zara or H&M "38" is an EU size (≈ US 6-8). A Levi's, Lucky Brand
  //     or Express "38" is a WAIST IN INCHES. That is not a fit nuance — it is a
  //     ~10-inch error, and it is silent: both tags print two digits and nothing
  //     else. The European brands here (Zara, H&M) label in the EU grade; the
  //     American ones (Express, Lucky, Ann Taylor, LOFT, Talbots) label US.
  //
  // So every chart below names its SYSTEM in the `garment` string and carries the
  // cross-map INSIDE the size label, where the model actually reads it — the
  // US-1739 convention, applied to a system rather than to a fit.
  //
  // A NOTE ON CONFIDENCE, WHICH IS DELIBERATELY UNEVEN HERE. Zara, Express and
  // PacSun serve 403 to automated fetches of their own size guides, so those
  // charts come from third-party aggregators and are scored DOWN (0.55-0.6)
  // against the brand-published ones (BDG 0.85, from URBN's own guide). The
  // confidence column exists for exactly this, and an honest 0.55 is worth more
  // than a fabricated 0.9 — a chart is a suggestion to a model, not a promise.

  // Urban Outfitters / BDG. The ONLY brand-published chart in this group: URBN's
  // own size guide (mirrored by Nordstrom as a PDF), so it earns 0.85.
  //
  // TWO TRAPS, BOTH FROM THE PUBLISHED GUIDE ITSELF:
  //   1. THE TAG NUMBER IS NOT THE BODY WAIST. A BDG "25" is a 24.5in waist — the
  //      label runs ~0.5in ABOVE the body it fits. Small, but it is the difference
  //      between a right and a wrong size call at the bottom of the range.
  //   2. THESE ARE **BODY** MEASUREMENTS, NOT FLAT-GARMENT ONES — the guide says
  //      so explicitly. A tape laid across a flat waistband and doubled is NOT
  //      comparable to this column without accounting for the garment's own ease.
  //      Every other chart in this file is read flat, so this one says it aloud.
  {
    brand: "Urban Outfitters",
    brandMatch: ["urban outfitters", "urbanoutfitters", "bdg"],
    department: "Women",
    garment: "BDG denim (US numeric waist label — NOT inches, see note)",
    categoryMatch: ["jean", "denim", "pant", "bottom", "short", "trouser"],
    note:
      "BDG is Urban Outfitters' house denim label and its tag says BDG, never " +
      "'Urban Outfitters'. Sized by a US numeric waist label 25-31 (= apparel " +
      "0-12). THE LABEL IS NOT THE BODY WAIST: a tagged 25 fits a 24.5in waist, " +
      "so the number runs ~0.5in HIGH. These are BODY measurements per URBN's own " +
      "guide, NOT flat-garment measurements — do not compare a doubled flat " +
      "waistband to them without allowing for ease. A non-US chart (General Pants " +
      "AU) maps these sizes differently (tag ≈ literal waist); the US mapping " +
      "below is the one that applies to US resale.",
    rows: [
      { size: "25 (= US 0)", measurements: { waist: "24.5", hip: "34" } },
      { size: "26 (= US 2)", measurements: { waist: "25.5", hip: "35" } },
      { size: "27 (= US 4)", measurements: { waist: "26.5", hip: "36" } },
      { size: "28 (= US 6)", measurements: { waist: "27.5", hip: "37" } },
      { size: "29 (= US 8)", measurements: { waist: "28.5", hip: "38" } },
      { size: "30 (= US 10)", measurements: { waist: "29.5", hip: "39" } },
      { size: "31 (= US 12)", measurements: { waist: "30.5", hip: "40" } },
    ],
  },
  {
    brand: "Urban Outfitters",
    brandMatch: ["urban outfitters", "urbanoutfitters", "bdg"],
    department: "Women",
    garment: "Tops & dresses (US numeric)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "dress",
      "sweater",
      "hoodie",
      "jacket",
      "tank",
    ],
    note:
      "Urban Outfitters / BDG apparel runs US numeric 0-16; bust is the primary " +
      "signal. UO also sells its house labels in ALPHA (XS-XL) — if the tag shows " +
      "a letter, read it as standard US alpha, not against this table. BODY " +
      "measurements per URBN's published guide, not flat-garment.",
    rows: [
      { size: "0", measurements: { bust: "31", waist: "23.5", hip: "33" } },
      { size: "2", measurements: { bust: "32", waist: "24.5", hip: "34" } },
      { size: "4", measurements: { bust: "33", waist: "25.5", hip: "35" } },
      { size: "6", measurements: { bust: "34", waist: "26.5", hip: "36" } },
      { size: "8", measurements: { bust: "35", waist: "27.5", hip: "37" } },
      { size: "10", measurements: { bust: "36", waist: "28.5", hip: "38" } },
      { size: "12", measurements: { bust: "37", waist: "29.5", hip: "39" } },
      { size: "14", measurements: { bust: "38.5", waist: "31", hip: "40.5" } },
      { size: "16", measurements: { bust: "40", waist: "32.5", hip: "42" } },
    ],
  },

  // Express. US numeric 00-18 — the SYSTEM is certain, the MEASUREMENTS are not:
  // express.com serves 403 to automated fetches of its own size chart, so the
  // numbers below come from a third-party aggregator and are capped at 0.6.
  {
    brand: "Express",
    brandMatch: ["express"],
    department: "Women",
    garment: "Bottoms (US numeric 00-18 — the number is a US SIZE, not inches)",
    categoryMatch: ["pant", "jean", "denim", "bottom", "short", "trouser", "legging", "skirt"],
    note:
      "Express women's bottoms run US numeric 00-18. CONTRAST ZARA AND H&M IN " +
      "THIS SAME PACK: their two-digit numbers are EU sizes. Express's are US " +
      "sizes — an Express 4 is a US 4 (≈26in waist), not an EU 4. Inseams: " +
      "Regular 33in, Short 30in, Tall 34-35in, all sharing one waist/hip grade, so " +
      "a length suffix says nothing about the size. Aggregator-sourced (Express's " +
      "own guide is not machine-readable) — capped confidence.",
    rows: [
      { size: "00", measurements: { waist: "23", hip: "34", bust: "30.5" } },
      { size: "0", measurements: { waist: "24", hip: "35", bust: "31.5" } },
      { size: "2", measurements: { waist: "25", hip: "36", bust: "32.5" } },
      { size: "4", measurements: { waist: "26", hip: "37", bust: "33.5" } },
      { size: "6", measurements: { waist: "27", hip: "38", bust: "34.5" } },
      { size: "8", measurements: { waist: "28", hip: "39", bust: "35.5" } },
      { size: "10", measurements: { waist: "29.5", hip: "40.5", bust: "37" } },
      { size: "12", measurements: { waist: "31", hip: "42", bust: "38.5" } },
      { size: "14", measurements: { waist: "32.5", hip: "43.5", bust: "40" } },
      { size: "16", measurements: { waist: "34", hip: "45", bust: "41.5" } },
      { size: "18", measurements: { waist: "35.5", hip: "46.5", bust: "43" } },
    ],
  },
  {
    brand: "Express",
    brandMatch: ["express"],
    department: "Women",
    garment: "Tops (US numeric 00-18 / alpha)",
    categoryMatch: ["top", "tee", "shirt", "blouse", "dress", "sweater", "tank", "bodysuit"],
    note:
      "Express women's tops run US numeric 00-18 and ALSO alpha (XS-XL) " +
      "depending on the line — the Portofino shirt is typically alpha, the " +
      "wear-to-work tops numeric. Bust is the primary signal. Aggregator-sourced " +
      "— capped confidence.",
    rows: [
      { size: "00 (≈XXS)", measurements: { bust: "30.5", waist: "23" } },
      { size: "0-2 (≈XS)", measurements: { bust: "31.5-32.5", waist: "24-25" } },
      { size: "4-6 (≈S)", measurements: { bust: "33.5-34.5", waist: "26-27" } },
      { size: "8-10 (≈M)", measurements: { bust: "35.5-37", waist: "28-29.5" } },
      { size: "12-14 (≈L)", measurements: { bust: "38.5-40", waist: "31-32.5" } },
      { size: "16-18 (≈XL)", measurements: { bust: "41.5-43", waist: "34-35.5" } },
    ],
  },

  // PacSun / Bullhead. The LOWEST-confidence chart in the pack (0.55) and the one
  // most likely to be the wrong table entirely — see the retailer trap in 00466:
  // ~70% of PacSun's sales were third-party brands, so a garment "from PacSun" is
  // more often NOT a PacSun garment. This chart applies ONLY when the tag itself
  // says Bullhead / PacSun / Kirra / LA Hearts / Nollie / On the Byas.
  {
    brand: "PacSun",
    brandMatch: ["pacsun", "pacific sunwear", "bullhead"],
    department: "Women",
    garment: "Bullhead / PacSun denim (US numeric waist label — NOT inches)",
    categoryMatch: ["jean", "denim", "pant", "bottom", "short", "trouser"],
    note:
      "Bullhead is PacSun's house denim label (renamed PacSun Denim ~2016) and " +
      "its tag says Bullhead, never 'PacSun'. US numeric waist label 23-32. LIKE " +
      "BDG, THE LABEL IS NOT THE LITERAL WAIST — a tagged 23 fits a 24in waist, " +
      "so the number runs ~1in LOW at the bottom of the range and the offset " +
      "grows. ONLY use this chart when the tag names a PacSun house label: PacSun " +
      "is primarily a MULTI-BRAND RETAILER and most garments bought there carry " +
      "another brand's tag and another brand's grade. Aggregator-sourced " +
      "(pacsun.com's own guide is not machine-readable) — capped confidence.",
    rows: [
      { size: "23", measurements: { waist: "24", hip: "34.5" } },
      { size: "24", measurements: { waist: "25", hip: "35.5" } },
      { size: "25", measurements: { waist: "26", hip: "36.5" } },
      { size: "26", measurements: { waist: "27", hip: "37.5" } },
      { size: "27", measurements: { waist: "28", hip: "38.5" } },
      { size: "28", measurements: { waist: "29", hip: "39.5" } },
      { size: "29", measurements: { waist: "30", hip: "40.5" } },
      { size: "30", measurements: { waist: "31.5", hip: "42" } },
      { size: "31", measurements: { waist: "33", hip: "43.5" } },
      { size: "32", measurements: { waist: "34.5", hip: "45" } },
    ],
  },

  // ── The two EU brands — the pack's headline problem ────────────────────────
  // AND THE CONVERSION ITSELF IS DISPUTED. This is the part that surprised the
  // research and it is seeded honestly rather than smoothed over: the sources do
  // not agree on the EU->US map by a FULL SIZE. Zara's grade goes through UK
  // (EU 38 = UK 10 = US 6); H&M's aggregators use EU = US + 30 (EU 38 = US 8).
  // Both conventions are in live circulation and neither brand's own chart is
  // machine-reachable (zara.com and hm.com both serve 403).
  //
  // So every EU label below carries a RANGE, not a point ("≈US 6-8"). A model
  // told "EU 38 = US 6" would state a false precision that the evidence does not
  // support; a model told "≈US 6-8, and the tag's EU number is what is certain"
  // can hedge correctly and defer to the measurements. Capped confidence, and the
  // note says WHY the confidence is capped — which is the useful part.
  {
    brand: "Zara",
    brandMatch: ["zara"],
    department: "Women",
    garment: "Bottoms (EU numeric 34-42 — an EU SIZE, never inches)",
    categoryMatch: ["bottom", "pant", "jean", "denim", "short", "trouser", "skirt", "legging"],
    note:
      "⚠ THE NUMBER ON A ZARA TAG IS AN EU SIZE, NOT A WAIST IN INCHES. A Zara " +
      "38 is a ~27.5in waist (≈US 6-8), NOT a 38in waist — reading it as inches " +
      "is a ~10in error and the tag gives no hint, because a Levi's or Express 38 " +
      "in the same photo IS inches. THE EU->US MAP IS DISPUTED BY ONE FULL SIZE " +
      "across sources (EU 38 = US 6 via the UK grade, or US 8 via EU = US+30), so " +
      "the US equivalents below are RANGES and the EU number is the only certain " +
      "part — prefer the measurements over the conversion. Zara is widely SAID to " +
      "run small, but that is folk knowledge, not a sourced fact (measurement " +
      "tests cut both ways), so do not assert it. Some US-market Zara denim is " +
      "reported to carry US/inch sizing instead — if a tag shows 'U.S. 31' with a " +
      "31in waist, believe the tag, not this table. Aggregator-sourced (zara.com " +
      "is not machine-readable) — capped confidence.",
    rows: [
      { size: "EU 34 / XS (≈US 2-4, UK 6)", measurements: { bust: "32.25", waist: "24.5" } },
      { size: "EU 36 / S (≈US 4-6, UK 8)", measurements: { bust: "34", waist: "26" } },
      { size: "EU 38 / M (≈US 6-8, UK 10)", measurements: { bust: "35.5", waist: "27.5" } },
      { size: "EU 40 / L (≈US 8-10, UK 12)", measurements: { bust: "37.75", waist: "30" } },
      { size: "EU 42 / XL (≈US 10-12, UK 14)", measurements: { bust: "40.25", waist: "32.25" } },
    ],
  },
  {
    brand: "Zara",
    brandMatch: ["zara"],
    department: "Women",
    garment: "Tops & dresses (EU numeric 34-42 / alpha)",
    categoryMatch: ["top", "tee", "shirt", "blouse", "dress", "sweater", "jacket", "coat", "tank"],
    note:
      "Zara tops run the EU grade 34-42 and ALSO alpha (XS-XL); bust is the " +
      "primary signal. Zara Basic / Zara Woman / TRF (Trafaluc) / Zara Man are " +
      "LINES of Zara, not separate brands or size systems — the line does not " +
      "change the grade. Same EU->US caveat as the bottoms chart: the US column " +
      "is a disputed range, the EU number is the certain part. Aggregator-sourced " +
      "— capped confidence.",
    rows: [
      { size: "EU 34 / XS (≈US 2-4)", measurements: { bust: "32.25", waist: "24.5" } },
      { size: "EU 36 / S (≈US 4-6)", measurements: { bust: "34", waist: "26" } },
      { size: "EU 38 / M (≈US 6-8)", measurements: { bust: "35.5", waist: "27.5" } },
      { size: "EU 40 / L (≈US 8-10)", measurements: { bust: "37.75", waist: "30" } },
      { size: "EU 42 / XL (≈US 10-12)", measurements: { bust: "40.25", waist: "32.25" } },
    ],
  },

  // H&M. THE LOWEST-CONFIDENCE CHART IN THE FILE (0.5) AND IT SAYS SO. H&M's own
  // size guide is not machine-reachable and NO trustworthy published inch chart
  // for H&M could be sourced at all. What IS sourced is the SCHEME — H&M labels
  // in the EU grade 32-44 — so that is what this chart is for: the SYSTEM, not
  // the inches. The measurements are the standard EU grade's approximation, NOT
  // H&M-published numbers, and the note says so outright rather than passing them
  // off. This is the alternative to fabricating a chart, and the alternative to
  // shipping nothing at all for one of the highest-volume brands in resale.
  {
    brand: "H&M",
    brandMatch: ["h&m", "h & m", "handm", "hennes", "divided"],
    department: "Women",
    garment: "Bottoms (EU numeric 32-44 — an EU SIZE, never inches)",
    categoryMatch: ["bottom", "pant", "jean", "denim", "short", "trouser", "skirt", "legging"],
    note:
      "⚠ THE NUMBER ON AN H&M TAG IS AN EU SIZE, NOT A WAIST IN INCHES — the " +
      "Zara rule, same trap. EU 32-44. THE MEASUREMENTS BELOW ARE THE STANDARD EU " +
      "GRADE'S APPROXIMATION, NOT H&M'S OWN PUBLISHED NUMBERS: no trustworthy H&M " +
      "inch chart could be sourced (hm.com is not machine-readable), so treat them " +
      "as a rough frame and PREFER the garment's actual measurements. The EU->US " +
      "map is disputed by a full size (this brand's aggregators use EU = US+30, " +
      "giving EU 38 = US 8; Zara's UK-derived grade gives US 6), hence the ranges. " +
      "H&M is widely said to run small; the evidence is thin, so hedge rather than " +
      "assert. Divided / L.O.G.G. / H&M Studio / MAMA are H&M's own in-store " +
      "LINES and share this grade. LOW confidence, deliberately.",
    rows: [
      { size: "EU 32 / XS (≈US 0-2)", measurements: { waist: "24-25", hip: "33.5-34.5" } },
      { size: "EU 34 / XS-S (≈US 2-4)", measurements: { waist: "25-26.5", hip: "34.5-36" } },
      { size: "EU 36 / S (≈US 4-6)", measurements: { waist: "26.5-28", hip: "36-37.5" } },
      { size: "EU 38 / M (≈US 6-8)", measurements: { waist: "28-29.5", hip: "37.5-39" } },
      { size: "EU 40 / L (≈US 8-10)", measurements: { waist: "29.5-31", hip: "39-40.5" } },
      { size: "EU 42 / L-XL (≈US 10-12)", measurements: { waist: "31-33", hip: "40.5-42.5" } },
      { size: "EU 44 / XL (≈US 12-14)", measurements: { waist: "33-35", hip: "42.5-44.5" } },
    ],
  },
  {
    brand: "H&M",
    brandMatch: ["h&m", "h & m", "handm", "hennes", "divided"],
    department: "Women",
    garment: "Tops & dresses (EU numeric 32-44 / alpha)",
    categoryMatch: ["top", "tee", "shirt", "blouse", "dress", "sweater", "hoodie", "jacket", "tank"],
    note:
      "H&M tops run the EU grade 32-44 and ALSO alpha (XS-XL). AS WITH THE " +
      "BOTTOMS CHART, THESE ARE STANDARD-EU-GRADE APPROXIMATIONS, NOT H&M'S OWN " +
      "PUBLISHED NUMBERS — no sourceable H&M inch chart exists. Prefer the " +
      "garment's measurements; the EU label is the certain part. LOW confidence.",
    rows: [
      { size: "EU 32 / XS (≈US 0-2)", measurements: { bust: "31-32" } },
      { size: "EU 34 / XS-S (≈US 2-4)", measurements: { bust: "32-33.5" } },
      { size: "EU 36 / S (≈US 4-6)", measurements: { bust: "33.5-35" } },
      { size: "EU 38 / M (≈US 6-8)", measurements: { bust: "35-36.5" } },
      { size: "EU 40 / L (≈US 8-10)", measurements: { bust: "36.5-38.5" } },
      { size: "EU 42 / L-XL (≈US 10-12)", measurements: { bust: "38.5-40.5" } },
      { size: "EU 44 / XL (≈US 12-14)", measurements: { bust: "40.5-43" } },
    ],
  },

  // Brandy Melville — ONE ROW, AND THAT IS THE WHOLE POINT.
  //
  // THE NUMBERS THAT ARE NOT HERE ARE THE DELIVERABLE. Every "Brandy Melville
  // size chart" on the open web (bust 30-34, waist 24-26) traces back to
  // scraper/SEO spam domains — they are FABRICATED, and they are exactly what a
  // model asked to recall this brand's chart will reproduce. Brandy publishes NO
  // global size chart at all; it publishes PER-GARMENT measurements on each
  // product page. So this chart's job is to say what the size MEANS and to send
  // the reader to the garment, not to invent a grade.
  {
    brand: "Brandy Melville",
    brandMatch: ["brandy melville", "brandymelville"],
    department: "Women",
    garment: "One Size / XS-S (a SINGLE small size — the brand has no grade)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "dress",
      "sweater",
      "hoodie",
      "tank",
      "bottom",
      "pant",
      "jean",
      "short",
      "skirt",
    ],
    note:
      "⚠ 'ONE SIZE' HERE MEANS SMALL, NOT UNIVERSAL. Brandy Melville sells " +
      "essentially one size, roughly US 00-4 / XS-S — it is not a generous " +
      "one-size-fits-all and it does not fit most people. A model that reads 'One " +
      "Size' as universal will mis-set buyer expectation on every listing. " +
      "CURRENT TAGS SAY 'XS/S'; the older ones say 'One Size' / 'One Size Fits " +
      "Most', so the tag text is a rough DATING tell (no reliable switch date " +
      "exists — do not state a year). BRANDY PUBLISHES NO SIZE CHART: it lists " +
      "per-garment measurements on each product page, so MEASURE THE GARMENT — " +
      "every circulating 'Brandy size chart' on the web is SEO fabrication. When " +
      "reading Brandy's own product-page numbers, note a listed 'bust' of ~15in " +
      "is a FLAT PIT-TO-PIT half-measurement (≈30in circumference), not a " +
      "circumference — do not ingest it as one. The single row below is the US " +
      "00-4 equivalent for orientation ONLY, not Brandy's published grade. " +
      "Bottoms are XS/S too, NOT an EU numeric grade despite the brand's Italian " +
      "origin. LOW confidence, deliberately.",
    rows: [
      {
        size: "One Size / XS-S (≈US 00-4)",
        measurements: { bust: "30-33", waist: "23-26", hip: "33-36" },
      },
    ],
  },

  // ── The KnitWell three + Lucky Brand — the US-sized half of the pack ───────
  // Ann Taylor, LOFT and Talbots share ONE parent (KnitWell Group) and are the
  // pack's counter-example to itself: they must NOT be merged (different bands,
  // separately searched, separate eBay brand nodes) even though — see below —
  // two of them publish the SAME body chart. Parentage decides nothing; the
  // published grade is a fact about the garment.
  //
  // ANN TAYLOR AND LOFT PUBLISH THE SAME CHART. Verified against both live
  // charts, and it is the useful finding: the two grades are IDENTICAL through
  // size 14 and diverge only at 16/18. So a LOFT 8 and an Ann Taylor 8 are the
  // same body even though LOFT sells 30-40% cheaper — the price band differs, the
  // fit does not. One chart, both brandMatch sets, rather than a duplicated table
  // that could silently drift apart.
  //
  // ⚠ ROWS ARE A SOURCED SUBSET, NOT THE WHOLE PUBLISHED CHART: the sizes below
  // are the ones actually transcribed from the brands' own charts. The gaps (6,
  // 10, 14) are real published sizes whose numbers were not captured — they grade
  // evenly between their neighbours. Omitting them is deliberate; inventing them
  // was the alternative.
  {
    brand: "Ann Taylor",
    brandMatch: ["ann taylor", "anntaylor", "loft"],
    department: "Women",
    garment: "Tops & dresses (US numeric 00-18 — shared Ann Taylor / LOFT grade)",
    categoryMatch: ["top", "tee", "shirt", "blouse", "dress", "sweater", "jacket", "blazer", "tank"],
    note:
      "ANN TAYLOR AND LOFT PUBLISH THE SAME BODY CHART — identical through size " +
      "14, diverging only at 16/18 (Ann Taylor bust 42.5/44.5; LOFT 42/44). So " +
      "the two brands' sizes are interchangeable even though LOFT sits ~30-40% " +
      "cheaper: the band differs, the grade does not. US numeric 00-18 (also " +
      "XXS-XXL). A 'P' suffix is PETITE and a 'T' suffix is TALL — both are " +
      "LENGTH variants that share this waist/bust grade, so a suffix says nothing " +
      "about the size. A 'Curvy' fit axis also exists. THESE ARE US SIZES, NOT EU " +
      "— contrast Zara/H&M in this same pack, where the number is an EU size. " +
      "Rows are a sourced SUBSET of the published chart; 6/10/14 exist and grade " +
      "evenly between their neighbours.",
    rows: [
      { size: "00", measurements: { bust: "31.5", waist: "24.5" } },
      { size: "2", measurements: { bust: "33.5", waist: "26.5" } },
      { size: "4", measurements: { bust: "34.5", waist: "27.5" } },
      { size: "8", measurements: { bust: "36.5", waist: "29.5" } },
      { size: "12", measurements: { bust: "39", waist: "32" } },
      { size: "16", measurements: { bust: "42.5 (LOFT 42)", waist: "35.5" } },
      { size: "18", measurements: { bust: "44.5 (LOFT 44)", waist: "37.5" } },
    ],
  },
  {
    brand: "Ann Taylor",
    brandMatch: ["ann taylor", "anntaylor", "loft"],
    department: "Women",
    garment: "Pants & skirts (US numeric 00-18 — shared Ann Taylor / LOFT grade)",
    categoryMatch: ["pant", "bottom", "skirt", "trouser", "short", "legging"],
    note:
      "The shared Ann Taylor / LOFT bottoms grade: US numeric 00-18, NOT inches " +
      "and NOT EU. 'P' = petite and 'T' = tall are LENGTH variants sharing this " +
      "waist/hip grade. ⚠ LOFT'S **DENIM** IS A DIFFERENT SYSTEM — it is labelled " +
      "in WAIST INCHES (24-34); see LOFT's denim chart. So a LOFT '8' is a US 8 " +
      "and a LOFT '28' is a 28in waist, on the same brand. Only the ENDPOINTS " +
      "below are sourced from the published chart; the sizes between them grade " +
      "evenly and are NOT published values — prefer the garment's measurements. " +
      "Capped confidence.",
    rows: [
      { size: "00", measurements: { waist: "24.5", hip: "34.5" } },
      { size: "18", measurements: { waist: "37.5", hip: "47.5" } },
    ],
  },
  {
    brand: "LOFT",
    brandMatch: ["loft"],
    department: "Women",
    garment: "Denim (waist in INCHES 24-34 — NOT a US size)",
    categoryMatch: ["jean", "denim"],
    note:
      "⚠ LOFT USES TWO SYSTEMS AT ONCE AND ONLY THE GARMENT SAYS WHICH: its DENIM " +
      "is sized by WAIST IN INCHES (24-34) while its pants run US numeric 00-18. " +
      "So a LOFT '28' is a 28in waist and a LOFT '8' is a US 8 — one brand, one " +
      "tag family, two systems. Ann Taylor's chart has NO inch-denim column, so " +
      "this is LOFT-only. DATING TELL: a LOFT garment in size 20-26 is from Feb " +
      "2018 - fall 2021 — LOFT Plus launched Feb 2018 (sizes 16-26) and was " +
      "discontinued in 2021, after which the range returned to 00-18. The US " +
      "equivalents below are approximate.",
    rows: [
      { size: "24 (≈US 00)", measurements: { waist: "24" } },
      { size: "26 (≈US 2)", measurements: { waist: "26" } },
      { size: "28 (≈US 6)", measurements: { waist: "28" } },
      { size: "30 (≈US 10)", measurements: { waist: "30" } },
      { size: "32 (≈US 14)", measurements: { waist: "32" } },
      { size: "34 (≈US 18)", measurements: { waist: "34" } },
    ],
  },

  // Talbots — THREE separate size systems under one brand, and the ranges below
  // are the correction: the widely-repeated "2-20 / 14W-24W / petites start at
  // 2P" is WRONG on all three counts per Talbots' own live charts.
  {
    brand: "Talbots",
    brandMatch: ["talbots"],
    department: "Women",
    garment: "Misses (US numeric 2-18) / Petite (0P-16P) / Plus (14W-26W)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "dress",
      "sweater",
      "jacket",
      "blazer",
      "pant",
      "bottom",
      "skirt",
      "trouser",
    ],
    note:
      "THREE SYSTEMS UNDER ONE BRAND, and the published ranges are NOT the ones " +
      "commonly repeated: MISSES IS 2-18 (not 2-20), PETITE STARTS AT 0P (not " +
      "2P) and runs 0P-16P, and PLUS IS 14W-26W (not 14W-24W). The 'W' is a " +
      "vestigial 'Woman' marker; the range is labelled 'Plus' today. Tall is a " +
      "LENGTH option on select styles, not a size category. A 'Curvy' fit axis " +
      "also exists. Talbots' published chart MEASURES LARGER THAN YOUTH-TARGETED " +
      "BRANDS at the same nominal size (a peer-reviewed study of 54 retailers' " +
      "published charts finds brands targeting younger customers measure " +
      "significantly smaller) — but do NOT call this vanity sizing: the study " +
      "compared CHARTS, not garments, and Talbots' customer skews older, so a " +
      "larger measurement may simply be accurate fitting for the target body. " +
      "Endpoints are sourced; intermediate sizes are an EVEN INTERPOLATION, not " +
      "published values — capped confidence, prefer the garment.",
    rows: [
      { size: "0P (petite)", measurements: { waist: "24.5", hip: "34.5" } },
      { size: "16P (petite)", measurements: { waist: "34", hip: "44" } },
      { size: "2 (misses)", measurements: { waist: "26", hip: "36" } },
      { size: "6 (misses)", measurements: { waist: "28.5", hip: "38.5" } },
      { size: "10 (misses)", measurements: { waist: "31", hip: "41" } },
      { size: "14 (misses)", measurements: { waist: "34", hip: "44" } },
      { size: "18 (misses)", measurements: { waist: "36.5", hip: "46.5" } },
      { size: "14W (plus)", measurements: { waist: "37", hip: "45" } },
      { size: "26W (plus)", measurements: { waist: "49", hip: "57" } },
    ],
  },

  // Lucky Brand — the pack's cleanest "the number IS inches" case, and the direct
  // foil to Zara/H&M sitting a few rows above.
  {
    brand: "Lucky Brand",
    brandMatch: ["lucky brand", "luckybrand"],
    department: "Men",
    garment: "Jeans (waist x inseam, INCHES — the number IS the waist)",
    categoryMatch: ["jean", "denim", "pant", "bottom", "short", "trouser", "chino"],
    note:
      "Lucky Brand men's jeans are sold as WAIST x INSEAM IN INCHES: waist 28-42, " +
      "inseams 30/32/34/36/38. THIS IS THE FOIL TO ZARA AND H&M IN THE SAME PACK " +
      "— a Lucky '38' IS a 38in waist, while a Zara '38' is an EU size on a " +
      "~27.5in waist. Same two digits, ~10in apart, and only the brand says " +
      "which. Read the flat waistband and double it. Named men's fits (121 " +
      "Heritage Slim, 181 Relaxed Straight, 410 Athletic, 221 Original Straight, " +
      "363 Vintage Straight) are FITS, not sizes — and the numbering logic is " +
      "opaque, so do not infer a fit from a number.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
      { size: "W40", measurements: { waist: "40" } },
      { size: "W42", measurements: { waist: "42" } },
    ],
  },
  {
    brand: "Lucky Brand",
    brandMatch: ["lucky brand", "luckybrand"],
    department: "Women",
    garment: "Jeans (waist in INCHES 24-35) — NOT a dress size",
    categoryMatch: ["jean", "denim", "pant", "bottom", "short", "trouser"],
    note:
      "⚠ Lucky Brand women's jeans are sold by WAIST IN INCHES (24-35), NOT by a " +
      "dress size — the alpha/numeric 0-16 grade is not the jean selector. " +
      "Inseams 27/29/31. The published BODY chart (a separate thing from the jean " +
      "label) stops at size 10, so the numeric-to-body map below is only the " +
      "sourced part: 0 = 24-25in waist / 36in hip, 10 = 30in waist / 41in hip. " +
      "Named women's fits (Ava, Sweet, Sienna) are FITS, not sizes.",
    rows: [
      { size: "24 (≈US 0)", measurements: { waist: "24-25", hip: "36" } },
      { size: "26 (≈US 2-4)", measurements: { waist: "26" } },
      { size: "28 (≈US 6)", measurements: { waist: "28" } },
      { size: "30 (≈US 10)", measurements: { waist: "30", hip: "41" } },
      { size: "32", measurements: { waist: "32" } },
      { size: "35", measurements: { waist: "35" } },
    ],
  },

  // ── US-1987: preppy & contemporary men's group ─────────────────────────────
  // Mirrors migration 00467's brand_size_charts seed (the DB rows win when the
  // pack loads; these are the offline fallback).
  //
  // 00466's pack was about the SIZE SYSTEM: a Zara "38" is an EU size and a Lucky
  // "38" is a waist in inches — same two digits, ~10in apart. THIS pack is one
  // axis over, and it is why these brands belong together:
  //
  //     THE SIZE GRADE IS NOT IN DISPUTE — THE **FIT NAME** IS THE GARMENT-
  //     DEFINING FACT, AND IT IS TAG-ONLY. A Bonobos 32x32 is a 32x32 in every
  //     fit; a Slim UNTUCKit L and a Relaxed L are both "L"; a Brooks Brothers
  //     16-34 Milano and a 16-34 Madison are both 16-34. What changes is the CUT,
  //     by up to 5 INCHES of chest and waist, and the only thing that says which
  //     is a WORD PRINTED ON THE TAG. It is not in the photo and not in the
  //     number.
  //
  // And the ladder's ORDER is counterintuitive in TWO of these brands, with the
  // open web backwards on both and the brand's OWN chart refuting it:
  //   • BONOBOS: Tailored is TRIMMER than Slim.
  //   • BROOKS BROTHERS: Madison is the ROOMIEST suit fit (+3" chest, +5" waist).
  // The fit ladders live in the pack's brand_styles rows (brandPackPromptBlock
  // renders fingerprints VERBATIM, which is the only channel that reaches the
  // extract prompt); the notes below carry the size-side half of the same fact.
  //
  // MENSWEAR ALSO RUNS FOUR SYSTEMS AT ONCE, often on ONE brand — Brooks Brothers
  // sells dress shirts by NECK x SLEEVE, sport shirts by ALPHA, suits by CHEST +
  // a LENGTH LETTER, and trousers by WAIST IN INCHES. So every chart names its
  // SYSTEM in `garment`, the US-1739 convention applied to a system.
  //
  // A NOTE ON CONFIDENCE, WHICH IS DELIBERATELY UNEVEN. Peter Millar, UNTUCKit,
  // Johnnie-O, Vineyard Vines and Brooks Brothers publish their own charts (0.85).
  // Faherty's are its own but the assets are dated 2019 (0.70). Bonobos' grid is
  // not published anywhere reachable, so its chart carries the SYSTEM only (0.55).
  // Todd Snyder (403s everywhere) and Buck Mason (JS-rendered modals; its own fit
  // guides are prose with no tables) yield NO numbers at all, so those rows carry
  // the size SYSTEM and say outright the numbers are not the brand's (0.40).
  // An honest 0.4 beats a fabricated 0.9 — the Brandy Melville rule from 00466.

  // Peter Millar — brand-published, and the one chart with an ERA hazard.
  {
    brand: "Peter Millar",
    brandMatch: ["peter millar", "petermillar"],
    department: "Men",
    garment: "Tops (ALPHA S-3XL + numeric — body measurements)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "polo",
      "sweater",
      "quarter zip",
      "pullover",
      "hoodie",
      "jacket",
      "outerwear",
      "blazer",
    ],
    note:
      "⚠ PETER MILLAR RE-CUT THIS CHART BETWEEN 2023 AND 2025 — 'Peter Millar M' " +
      "MEANS A DIFFERENT BODY DEPENDING ON THE ERA. These rows are the CURRENT " +
      "(2025) grade; the prior generation ran ~1in smaller (S chest 36-38, M 39-41, " +
      "L 42-44, XL 45-47) and carried a waist column since dropped. THIS IS WHY " +
      "AGGREGATORS DISAGREE and neither is wrong — some mirror the current chart, " +
      "some the 2023 one. Prefer the garment on anything of unknown age. BODY " +
      "measurements, not flat-garment. SPORT AND DRESS SHIRTS HAVE NO SEPARATE " +
      "CHART — Peter Millar sizes them ALPHA against this table, NOT neck x sleeve, " +
      "so there is no 16/34 system for this brand; outerwear falls back here too. " +
      "CLASSIC vs TAILORED ('Tour') FIT DOES NOT CHANGE THIS GRADE — PM publishes " +
      "ONE chart for both, and THE COLLECTION NAME IS THE FIT TELL (Crown / Crown " +
      "Sport = Classic; Crown Crafted / Peter Millar Collection = Tailored). Big & " +
      "tall is not offered in-house: PM stops at 3XL.",
    rows: [
      {
        size: "S (38)",
        measurements: { chest: "37-39", neck: "14.5-15", sleeve: "33-33.5" },
      },
      {
        size: "M (40)",
        measurements: { chest: "40-42", neck: "15.5-16", sleeve: "34-35" },
      },
      {
        size: "L (42-44)",
        measurements: { chest: "43-45", neck: "16.5-17", sleeve: "35.5-36" },
      },
      {
        size: "XL (46)",
        measurements: { chest: "46-48", neck: "17.5-18", sleeve: "36.5-37" },
      },
      {
        size: "XXL (48)",
        measurements: { chest: "49-51", neck: "18.5-19", sleeve: "37.5" },
      },
      {
        size: "3XL (50)",
        measurements: { chest: "52-54", neck: "19.5-20", sleeve: "37.5" },
      },
    ],
  },
  {
    brand: "Peter Millar",
    brandMatch: ["peter millar", "petermillar"],
    department: "Men",
    garment: "Bottoms (numeric WAIST IN INCHES 28-46)",
    categoryMatch: [
      "pant",
      "bottom",
      "short",
      "trouser",
      "chino",
      "jean",
      "denim",
      "swim",
    ],
    note:
      "THE TAG NUMBER IS A WAIST IN INCHES — contrast Zara/H&M (00466), where the " +
      "same two digits are an EU size. VANITY SIZING, AND IT IS EXACTLY REGULAR: " +
      "the body waist is the TAG SIZE + 1.5in across the whole run, which is usable " +
      "as a validation rule. Alpha map: S = 28-30, M = 31-34, L = 35-38, XL = 40-42, " +
      "XXL = 44-46. ⚠ THERE IS NO INSEAM GRID — PM sells men's pants at a SINGLE " +
      "34in inseam and HEMS TO ORDER (shorts/swim 8-10in), SO A USED PM PANT'S " +
      "INSEAM MAY BE A CUSTOM HEM, NOT A CATALOGUE LENGTH. Measure it. SUITING is a " +
      "different system again: bare jacket numerics (38-48) with an optional LONG " +
      "for 42-48 and NO Short; PM's older chart carried a drop rule it has since " +
      "dropped from the page ('all pants will be six sizes below selected jacket " +
      "size').",
    rows: [
      { size: "28 (S)", measurements: { waist: "29.5", hips: "35.5" } },
      { size: "30 (S)", measurements: { waist: "31.5", hips: "37.5" } },
      { size: "32 (M)", measurements: { waist: "33.5", hips: "39.5" } },
      { size: "34 (M)", measurements: { waist: "35.5", hips: "41.5" } },
      { size: "36 (L)", measurements: { waist: "37.5", hips: "43.5" } },
      { size: "38 (L)", measurements: { waist: "39.5", hips: "45.5" } },
      { size: "40 (XL)", measurements: { waist: "41.5", hips: "47.5" } },
      { size: "42 (XL)", measurements: { waist: "43.5", hips: "49.5" } },
      { size: "44 (XXL)", measurements: { waist: "45.5", hips: "51.5" } },
      { size: "46 (XXL)", measurements: { waist: "47.5", hips: "53.5" } },
    ],
  },
  {
    brand: "Peter Millar",
    brandMatch: ["peter millar", "petermillar"],
    department: "Women",
    garment: "Tops & dresses (numeric 0-18 + alpha XS-XXL)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "dress",
      "sweater",
      "polo",
      "skort",
      "jacket",
    ],
    note:
      "Peter Millar women's runs a DUAL system — US numeric 0-18 AND alpha XS-XXL " +
      "— and runs to 18/XXL, past where many peers stop. Brand-published. ⚠ THE " +
      "SAME 2023→2025 RE-CUT APPLIES (the 2023 chart gave XXL a 38-40in waist vs " +
      "the current 39-40), so prefer the garment on anything of unknown age. " +
      "Women's pants are a single 27.5in inseam and skorts 18in, hemmed to order — " +
      "a used inseam may be a custom hem.",
    rows: [
      {
        size: "XS (0-2)",
        measurements: { bust: "32.5-33.5", waist: "26-27", hip: "35-36" },
      },
      {
        size: "S (4-6)",
        measurements: { bust: "34.5-35.5", waist: "28-29", hip: "37-38" },
      },
      {
        size: "M (8-10)",
        measurements: { bust: "36.5-37.5", waist: "30-31", hip: "39-40" },
      },
      {
        size: "L (12-14)",
        measurements: { bust: "39-40.5", waist: "32-35", hip: "42-43" },
      },
      {
        size: "XL (16)",
        measurements: { bust: "42-43.5", waist: "36-37", hip: "45-46" },
      },
      {
        size: "XXL (18)",
        measurements: { bust: "45-46.5", waist: "39-40", hip: "48-50" },
      },
    ],
  },

  // Brooks Brothers — the brand that sells all four menswear systems at once.
  {
    brand: "Brooks Brothers",
    // ⚠ NEVER add a bare "brooks" here: findSizingCharts matches brandMatch as a
    // LEADING-word substring, so it would hand every Brooks RUNNING garment (a
    // different company) Brooks Brothers' dress-shirt charts. The US-1735 rule.
    brandMatch: ["brooks brothers", "brooksbrothers"],
    department: "Men",
    garment: "Dress shirts (NECK x SLEEVE in inches — two independent measurements)",
    categoryMatch: ["dress shirt", "shirt", "ocbd", "oxford", "button down"],
    note:
      "BROOKS BROTHERS SELLS FOUR SIZE SYSTEMS AT ONCE AND THIS IS THE FIRST: " +
      "DRESS SHIRTS ARE NECK x SLEEVE IN INCHES, selected independently and written " +
      "'16-34/35' — neck 14.5-18.5, sleeve 32/33/34/35/36. ⚠ BUT ALPHA RUNS IN " +
      "PARALLEL: BB's sport/casual oxfords sell XS-XXL, so accept BOTH — 'BB dress " +
      "shirts are neck x sleeve' is only ~true. The alpha-to-inch map below is BB's " +
      "own. ⚠ THE PUBLISHED CHART IS INCOMPLETE ON ITS OWN TERMS: L ends at neck " +
      "16.5 and XL starts at 17 (neck 16.75 is unrepresented), and it publishes NO " +
      "sleeve lengths at all. Reproduced faithfully — do not interpolate. ⚠ THE FIT " +
      "DOES NOT CHANGE THIS GRADE: a 16-34 Milano and a 16-34 Madison are both " +
      "16-34. The SHIRT ladder is Soho (-5in chest) / Milano (-2.75) / REGENT " +
      "(baseline) / Madison (+2.5) / Traditional (+5) — note MADISON IS RELAXED, " +
      "NOT TRIM, and the SUIT ladder is a different one. Big & tall: neck 16-24.",
    rows: [
      {
        size: "XS (neck 14.5-15)",
        measurements: { neck: "14.5-15", chest: "34.5-36", waist: "28.5-30.5" },
      },
      {
        size: "S (neck 15-15.5)",
        measurements: { neck: "15-15.5", chest: "37-38.5", waist: "31.5-32.5" },
      },
      {
        size: "M (neck 15.5-16)",
        measurements: { neck: "15.5-16", chest: "39-41.5", waist: "33.5-35.5" },
      },
      {
        size: "L (neck 16-16.5)",
        measurements: { neck: "16-16.5", chest: "42-44.5", waist: "36.5-38.5" },
      },
      {
        size: "XL (neck 17-17.5)",
        measurements: { neck: "17-17.5", chest: "45-47.5", waist: "39.5-41.5" },
      },
      {
        size: "XXL (neck 18)",
        measurements: { neck: "18", chest: "48-50", waist: "42.5-44.5" },
      },
    ],
  },
  {
    brand: "Brooks Brothers",
    brandMatch: ["brooks brothers", "brooksbrothers"],
    department: "Men",
    garment: "Suits & sport coats (CHEST in inches + a LENGTH LETTER: 42R / 42L / 42S)",
    categoryMatch: ["suit", "sport coat", "blazer", "jacket", "tailoring"],
    note:
      "BB'S SECOND AND THIRD SYSTEMS. TAILORING = CHEST IN INCHES (34-56, half-inch " +
      "increments) + A LENGTH LETTER — 42R is a 42in chest in a Regular length; " +
      "S/R/L adjust the body and sleeve (i.e. HEIGHT), never the chest. TROUSERS = " +
      "WAIST IN INCHES (28-50, seat 36-58), listed SEPARATELY. ⚠ NO DROP IS SEEDED " +
      "— BB publishes none, and listing trousers separately suggests independent " +
      "trouser sizing; the conventional 6in drop is NOT stated by BB, so do not " +
      "assume it. ⚠ NO S/R/L HEIGHT RANGES ARE SEEDED — BB publishes none across " +
      "four of its own pages; the familiar figures come from third-party retailer " +
      "blogs and must not be attributed to BB. ⚠ THE SUIT FIT LADDER IS ONLY THREE " +
      "RUNGS AND IS NOT THE SHIRT LADDER: Milano (-1.5in chest) / REGENT (baseline) " +
      "/ MADISON (+3in chest, +5in waist — THE ROOMIEST). SEO fit-guides say Madison " +
      "is trim; BB's own chart refutes them. The fit does not change the number.",
    rows: [
      {
        size: "Chest 34-56 in half-inch increments",
        measurements: {
          chest: "34-56",
          note: "the NUMBER is the chest in inches",
        },
      },
      {
        size: "Suffix S / R / L",
        measurements: {
          note:
            "Short / Regular / Long — a BODY AND SLEEVE LENGTH adjustment, not a girth change",
        },
      },
      {
        size: "Suit trousers (sold separately)",
        measurements: { waist: "28-50", seat: "36-58" },
      },
    ],
  },

  // UNTUCKit — the category-conditional system.
  {
    brand: "UNTUCKit",
    brandMatch: ["untuckit"],
    department: "Men",
    garment:
      "Button-down shirts (ALPHA S-XXXL) — but dress shirts are NECK x SLEEVE, see note",
    categoryMatch: [
      "shirt",
      "button down",
      "casual shirt",
      "top",
      "polo",
      "tee",
      "henley",
    ],
    note:
      "⚠ 'UNTUCKit IS ALPHA-SIZED' IS ONLY HALF TRUE — THE SYSTEM IS CATEGORY-" +
      "CONDITIONAL. Its BUTTON-DOWNS run ALPHA S-XXXL (below); its DRESS SHIRTS run " +
      "NECK x SLEEVE (neck 15-17.5 against sleeve 32-33 / 34-35 / 36-37), and eBay " +
      "keeps 'UNTUCKit Dress Shirts' as a separate category from 'Casual " +
      "Button-Down Shirts', so the split is real. Do not encode a flat alpha rule. " +
      "⚠ THE XXXL CHEST CELL IS DELIBERATELY OMITTED: the brand's chart shows XXL " +
      "and XXXL BOTH at chest 48-50, almost certainly an upstream error. ⚠ THE " +
      "BRAND'S OWN GUIDANCE IS THAT IT RUNS SMALL ('order one size up' if between " +
      "sizes), so an UNTUCKit L flat-measures SMALLER than a mainstream L. ⚠ NO " +
      "BODY LENGTH APPEARS IN ANY UNTUCKit CHART — which matters more here than " +
      "anywhere, because the shorter untucked hem IS the brand and there is nothing " +
      "published to measure it against (the brand's rule is qualitative: 'around " +
      "mid-zipper'). ⚠ THE FIT DOES NOT CHANGE THIS GRADE — Regular / Slim / " +
      "Relaxed / Regular Tall / Slim Tall all share this run, and there is NO " +
      "'Athletic' fit. The shorts chart is not mirrored: the brand's own is " +
      "internally incoherent (labels itself alpha, lists numerics).",
    rows: [
      {
        size: "S",
        measurements: { chest: "36-38", waist: "29-31", sleeve: "33-34" },
      },
      {
        size: "M",
        measurements: { chest: "39-41", waist: "32-34", sleeve: "33.5-34.5" },
      },
      {
        size: "L",
        measurements: { chest: "42-44", waist: "35-37", sleeve: "34.5-35.5" },
      },
      {
        size: "XL",
        measurements: { chest: "45-47", waist: "38-40", sleeve: "35-36" },
      },
      {
        size: "XXL",
        measurements: { chest: "48-50", waist: "41-43", sleeve: "35.5-36.5" },
      },
      { size: "XXXL", measurements: { waist: "44-46", sleeve: "36.5-37.5" } },
    ],
  },
  {
    brand: "UNTUCKit",
    brandMatch: ["untuckit"],
    department: "Women",
    garment: "Tops & dresses (ALPHA XS-XL)",
    categoryMatch: [
      "top",
      "shirt",
      "blouse",
      "dress",
      "shirtdress",
      "tee",
      "sweater",
    ],
    note:
      "UNTUCKit's women's line (launched 2017, driven by the fact that ~45% of the " +
      "brand's customers were women buying for men) runs ALPHA XS-XL; the waist " +
      "column is the brand's NATURAL waist. Brand-published. As with the men's " +
      "chart, NO BODY LENGTH is published, so the untucked-hem premise has no " +
      "number to check against here either.",
    rows: [
      {
        size: "XS",
        measurements: { bust: "32.5-34.5", waist: "25.5-26.5", hip: "36-39" },
      },
      {
        size: "S",
        measurements: { bust: "34.5-36.5", waist: "27.5-29.5", hip: "38-41" },
      },
      {
        size: "M",
        measurements: { bust: "36.5-38.5", waist: "29.5-31.5", hip: "40-43" },
      },
      {
        size: "L",
        measurements: { bust: "38.5-40.5", waist: "31.5-33.5", hip: "42-45" },
      },
      {
        size: "XL",
        measurements: { bust: "40.5-42.5", waist: "34.5-36.5", hip: "44-47" },
      },
    ],
  },

  // Johnnie-O — brand-published, faithfully including its own discontinuity.
  {
    brand: "Johnnie-O",
    brandMatch: ["johnnie-o", "johnnieo", "johnnie o"],
    department: "Men",
    garment: "Tops (ALPHA S-XXXL — body measurements)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "polo",
      "sweater",
      "hoodie",
      "quarter zip",
      "pullover",
      "jacket",
      "outerwear",
    ],
    note:
      "Johnnie-O's own published chart — BODY measurements, not flat-garment. ⚠ " +
      "NOTE THE DISCONTINUITY, REPRODUCED FAITHFULLY: XXL chest ends at 48 and XXXL " +
      "starts at 50 (and the waist jumps 48→49), so there is a gap in the brand's " +
      "own grade. It may be a brand-side typo — do NOT silently 'fix' it; prefer " +
      "the garment. Brand guidance is 'true to size', sizing up if between sizes. " +
      "THE STANDARD (non-big-&-tall) BOTTOMS CHART COULD NOT BE SOURCED and is " +
      "deliberately absent; big & tall bottoms run 42R-56R (42R = 41-42in waist).",
    rows: [
      {
        size: "S",
        measurements: {
          neck: "14-14.5",
          chest: "38-40",
          waist: "28-32",
          sleeve: "32-33",
        },
      },
      {
        size: "M",
        measurements: {
          neck: "15-15.5",
          chest: "40-42",
          waist: "32-36",
          sleeve: "33-34",
        },
      },
      {
        size: "L",
        measurements: {
          neck: "16-16.5",
          chest: "42-44",
          waist: "36-40",
          sleeve: "34-35",
        },
      },
      {
        size: "XL",
        measurements: {
          neck: "17-17.5",
          chest: "44-46",
          waist: "40-44",
          sleeve: "35-36",
        },
      },
      {
        size: "XXL",
        measurements: {
          neck: "18-18.5",
          chest: "46-48",
          waist: "44-48",
          sleeve: "36-37",
        },
      },
      {
        size: "XXXL",
        measurements: {
          neck: "18.5-19",
          chest: "50-52",
          waist: "49-52",
          sleeve: "37-38",
        },
      },
    ],
  },

  // Vineyard Vines — brand-published, with its own chart's oddity flagged.
  {
    brand: "Vineyard Vines",
    brandMatch: ["vineyard vines", "vineyardvines"],
    department: "Men",
    garment: "Tops (ALPHA XS-XXL — body measurements)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "polo",
      "sweater",
      "quarter zip",
      "pullover",
      "shep shirt",
      "jacket",
      "tie",
      "necktie",
    ],
    note:
      "Vineyard Vines' own published men's chart. ⚠ FLAGGED FOR HUMAN VERIFICATION, " +
      "REPRODUCED AS PUBLISHED: the WAIST progression is DISCONTINUOUS — S is 30-32 " +
      "and M is 32-34, but L jumps to 36-38, leaving 34-36 unassigned, while chest " +
      "and neck grade evenly. Either a genuine quirk or a transcription artifact; " +
      "do not interpolate it away, prefer the garment. BIG & TALL is a separate " +
      "grade: 'Big' 1X-6X and 'Tall' XL-5X at the SAME GIRTH as Big but +2in of " +
      "sleeve — so Big vs Tall is a SLEEVE-LENGTH fact, a real discriminator. " +
      "MEN'S BOTTOMS are sold as WAIST x INSEAM IN INCHES, but no brand-published " +
      "numeric men's-pant chart exists — the waist column here is per alpha size.",
    rows: [
      {
        size: "XS",
        measurements: {
          neck: "13.5-14",
          chest: "36-38",
          sleeve: "32.5",
          waist: "28-30",
        },
      },
      {
        size: "S",
        measurements: {
          neck: "14-14.5",
          chest: "38-40",
          sleeve: "33.5",
          waist: "30-32",
        },
      },
      {
        size: "M",
        measurements: {
          neck: "15-15.5",
          chest: "40-42",
          sleeve: "34.5",
          waist: "32-34",
        },
      },
      {
        size: "L",
        measurements: {
          neck: "16-16.5",
          chest: "42-44",
          sleeve: "35.5",
          waist: "36-38",
        },
      },
      {
        size: "XL",
        measurements: {
          neck: "17-17.5",
          chest: "44-46",
          sleeve: "36.5",
          waist: "40-42",
        },
      },
      {
        size: "XXL",
        measurements: {
          neck: "18-18.5",
          chest: "46-48",
          sleeve: "37.5",
          waist: "42-44",
        },
      },
    ],
  },
  {
    brand: "Vineyard Vines",
    brandMatch: ["vineyard vines", "vineyardvines"],
    department: "Women",
    garment: "Tops & dresses (US numeric 00-24 + alpha XXS-3X)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "dress",
      "sweater",
      "shep shirt",
      "jacket",
      "skirt",
    ],
    note:
      "Vineyard Vines publishes ONE unified women's chart (no separate tops/bottoms/" +
      "dresses), running US numeric 00-24 mapped to alpha XXS-3X. ⚠ THE ALPHA " +
      "MAPPING IS NOT SETTLED AND THE NUMERIC IS THE RELIABLE PART. Two problems, " +
      "both flagged rather than smoothed: (a) the published mapping is " +
      "NON-MONOTONIC — 18→XXL, 20→2X, then 22 back to XXL — almost certainly an " +
      "upstream error, so size 22 is deliberately OMITTED rather than guessed; (b) " +
      "a second rendering of the same brand chart returns RANGE-based values " +
      "(S = chest 35-36) instead of the single-value table below, so the brand may " +
      "serve two variants. PREFER THE NUMERIC SIZE AND THE GARMENT. Women's DENIM: " +
      "the brand publishes only a numeric-to-alpha conversion (24-37 → 00-24) with " +
      "NO measurements at all.",
    rows: [
      {
        size: "00 / XXS",
        measurements: { chest: "32", waist: "24", hip: "34" },
      },
      { size: "0 / XS", measurements: { chest: "33", waist: "25", hip: "35" } },
      { size: "2 / S", measurements: { chest: "34", waist: "26", hip: "36" } },
      { size: "4 / S", measurements: { chest: "35", waist: "27", hip: "37" } },
      { size: "6 / M", measurements: { chest: "36", waist: "28", hip: "38" } },
      { size: "8 / M", measurements: { chest: "37", waist: "29", hip: "39" } },
      {
        size: "10 / L",
        measurements: { chest: "38.5", waist: "30.5", hip: "40.5" },
      },
      { size: "12 / L", measurements: { chest: "40", waist: "32", hip: "42" } },
      {
        size: "14 / XL",
        measurements: { chest: "41.5", waist: "33.5", hip: "43.5" },
      },
      {
        size: "16 / XL",
        measurements: { chest: "43.5", waist: "35", hip: "45" },
      },
      {
        size: "18 / XXL",
        measurements: { chest: "45.5", waist: "39", hip: "48.5" },
      },
      {
        size: "20 / 2X",
        measurements: { chest: "47", waist: "40.5", hip: "50" },
      },
      {
        size: "24 / 3X",
        measurements: { chest: "51.5", waist: "45", hip: "54.5" },
      },
    ],
  },

  // Faherty — the brand's own numbers, but the assets are 2019.
  {
    brand: "Faherty",
    brandMatch: ["faherty"],
    department: "Men",
    garment: "Tops (ALPHA XS-XXXL — body measurements)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "polo",
      "sweater",
      "sweatshirt",
      "flannel",
      "overshirt",
      "blazer",
      "jacket",
    ],
    note:
      "Faherty's OWN published chart — but ⚠ THE PUBLISHED ASSETS ARE DATED 2019, " +
      "so the live fit may have drifted; the chart's own header says 'ALL SIZES ARE " +
      "APPROXIMATE'. Brand-published-but-stale: capped confidence, prefer the " +
      "garment. Faherty's fabric names are ™ and NOT ®, and the ® marks on its tags " +
      "(REPREVE®, Supima®) belong to OTHER companies — see the pack's fabric row.",
    rows: [
      {
        size: "XS",
        measurements: {
          neck: "14",
          chest: "34-36",
          waist: "26-28",
          sleeve: "32.5-33",
        },
      },
      {
        size: "S",
        measurements: {
          neck: "14-14.5",
          chest: "37-39",
          waist: "28-30",
          sleeve: "32.5-34",
        },
      },
      {
        size: "M",
        measurements: {
          neck: "15-15.5",
          chest: "40-41",
          waist: "31-33",
          sleeve: "34-35",
        },
      },
      {
        size: "L",
        measurements: {
          neck: "16-16.5",
          chest: "42-44",
          waist: "34-36",
          sleeve: "35-36",
        },
      },
      {
        size: "XL",
        measurements: {
          neck: "17-17.5",
          chest: "45-47",
          waist: "37-39",
          sleeve: "36-36.5",
        },
      },
      {
        size: "XXL",
        measurements: {
          neck: "18-18.5",
          chest: "48-51",
          waist: "40-43",
          sleeve: "36.5-37",
        },
      },
      {
        size: "XXXL",
        measurements: {
          neck: "19-19.5",
          chest: "52-54",
          waist: "44-47",
          sleeve: "37.5-38",
        },
      },
    ],
  },
  {
    brand: "Faherty",
    brandMatch: ["faherty"],
    department: "Men",
    garment:
      "Bottoms (WAIST IN INCHES 28-42 + alpha — the tag runs ~2in SMALL, see note)",
    categoryMatch: [
      "pant",
      "bottom",
      "short",
      "trouser",
      "chino",
      "jean",
      "denim",
      "boardshort",
      "swim",
    ],
    note:
      "⚠ VANITY SIZING, QUANTIFIED: THE TAGGED WAIST RUNS ~2-2.5in SMALLER THAN THE " +
      "BODY IT FITS — a Faherty '32' fits a ~34.5in waist. AND THE OFFSET COMPRESSES " +
      "AT THE TOP: a tagged 42 is only 43.5in, so the error is ~2.5in at 28-34 and " +
      "~1.5in by 42. Same shape as BDG's and Bullhead's label-is-not-the-waist rule " +
      "(00466), one axis larger. Faherty runs a DUAL system — alpha AND " +
      "waist-in-inches. ⚠ THERE IS A GAP IN FAHERTY'S OWN ALPHA MAP: L ends at 37.5 " +
      "and XL starts at 40, leaving 37.5-40in unassigned. That is the brand's error, " +
      "reproduced rather than papered over. 2019 assets — prefer the garment.",
    rows: [
      { size: "28 (XS)", measurements: { waist: "30.5" } },
      { size: "30 (XS-S)", measurements: { waist: "32.5" } },
      { size: "32 (S-M)", measurements: { waist: "34.5" } },
      { size: "34 (M)", measurements: { waist: "36.5" } },
      { size: "36 (L)", measurements: { waist: "39.5" } },
      { size: "38 (L-XL)", measurements: { waist: "41.5" } },
      { size: "40 (XL)", measurements: { waist: "42.5" } },
      { size: "42 (XXL)", measurements: { waist: "43.5" } },
    ],
  },
  {
    brand: "Faherty",
    brandMatch: ["faherty"],
    department: "Women",
    garment: "Tops & dresses (ALPHA XS-XL + US numeric 0-16)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "blouse",
      "dress",
      "sweater",
      "legend",
      "jacket",
      "skirt",
    ],
    note:
      "Faherty women's runs a DUAL system: alpha XS-XL mapped to US numeric 0-16. " +
      "⚠ THIS CHART STOPS AT XL/16 AND IS A 2019 ASSET — if Faherty now sells " +
      "extended sizes, this chart does not cover them; do NOT extrapolate past XL. " +
      "Women's dresses launched spring 2020 and are ~40% of women's sales, so a " +
      "Faherty dress is a common resale garment sized against this table.",
    rows: [
      {
        size: "XS (0-2)",
        measurements: { bust: "31.5-33", waist: "24-25", hips: "33.5-35" },
      },
      {
        size: "S (4-6)",
        measurements: { bust: "33.5-34.5", waist: "26-27", hips: "36-37" },
      },
      {
        size: "M (8-10)",
        measurements: { bust: "35-37.5", waist: "28-29", hips: "38-39" },
      },
      {
        size: "L (12-14)",
        measurements: { bust: "38-39.5", waist: "30-31", hips: "40-42" },
      },
      {
        size: "XL (16)",
        measurements: { bust: "40-42", waist: "32-34", hips: "42.5-44.5" },
      },
    ],
  },

  // Bonobos — the SYSTEM is confirmed three ways; the grid is not published.
  {
    brand: "Bonobos",
    brandMatch: ["bonobos"],
    department: "Men",
    garment: "Bottoms (WAIST x INSEAM in INCHES — the number IS the waist)",
    categoryMatch: [
      "pant",
      "bottom",
      "chino",
      "trouser",
      "short",
      "jean",
      "denim",
      "dress pant",
    ],
    note:
      "BONOBOS BOTTOMS ARE SOLD AS WAIST x INSEAM IN INCHES ('32x32') — the SYSTEM " +
      "is confirmed three independent ways (the brand's own model copy, its variant " +
      "SKUs, and retailer listings), and a Bonobos '32' IS a 32in waist, not an EU " +
      "size (contrast Zara/H&M in 00466). ⚠ THE SYSTEM IS ALL THAT IS SEEDED: " +
      "BONOBOS PUBLISHES NO REACHABLE NUMERIC GRID — its charts live on " +
      "help.bonobos.com, which is unreadable to every automated fetcher INCLUDING " +
      "the Wayback Machine, so no body-measurement table could be obtained and NONE " +
      "IS INVENTED. The rows below simply restate that the label is the waist. " +
      "PREFER THE GARMENT. ⚠ BONOBOS HEMS PANTS TO THE ORDERED INSEAM BEFORE " +
      "SHIPPING, SO A USED BONOBOS PANT'S INSEAM MAY BE A CUSTOM HEM, NOT A " +
      "CATALOGUE LENGTH — measure it. ⚠ THE FIT NAME DOES NOT CHANGE THIS GRADE — a " +
      "32x32 is a 32x32 in Tailored, Slim, Straight, Athletic and Classic alike, and " +
      "TAILORED IS TRIMMER THAN SLIM (see the pack's fit-vocabulary row). SHIRTS are " +
      "a different system: ALPHA x FIT x LENGTH, not neck x sleeve. Blazers are " +
      "numeric chest + fit; NO R/L/S length grade could be found and none is " +
      "asserted.",
    rows: [
      { size: "W28", measurements: { waist: "28" } },
      { size: "W30", measurements: { waist: "30" } },
      { size: "W32", measurements: { waist: "32" } },
      { size: "W34", measurements: { waist: "34" } },
      { size: "W36", measurements: { waist: "36" } },
      { size: "W38", measurements: { waist: "38" } },
      { size: "W40", measurements: { waist: "40" } },
    ],
  },

  // Todd Snyder / Buck Mason — system-only rows. The numbers do not exist.
  {
    brand: "Todd Snyder",
    brandMatch: ["todd snyder", "toddsnyder"],
    department: "Men",
    garment: "Size SYSTEMS only (alpha tops / waist-inches bottoms / chest+R-L-S tailoring)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "sweater",
      "sweatshirt",
      "hoodie",
      "pant",
      "bottom",
      "chino",
      "jean",
      "denim",
      "suit",
      "blazer",
      "sport coat",
      "tailoring",
      "chore coat",
      "outerwear",
    ],
    note:
      "⚠ NO BRAND-PUBLISHED MEASUREMENTS ARE SEEDED FOR TODD SNYDER, AND THAT IS " +
      "DELIBERATE: toddsnyder.com RETURNS HTTP 403 TO AUTOMATED FETCHING ON EVERY " +
      "SIZE-GUIDE PATH, so no chart could be obtained and NONE IS INVENTED. This row " +
      "carries THE SIZE SYSTEM ONLY, which is the honestly sourceable part. THE " +
      "NUMBERS HERE ARE NOT THE BRAND'S OWN — MEASURE THE GARMENT. Todd Snyder runs " +
      "the standard menswear systems: alpha tops, waist-in-inches bottoms, chest + " +
      "R/L/S tailoring. ⚠ ONE GENUINE COMPLICATION: the brand ALSO runs a " +
      "LETTER-SIZED bottoms line alongside the numeric one, so do not assume " +
      "waist-only. Named tailoring fits (Sutton / Madison / Wythe / Hollywood) are a " +
      "signal IN TEXT, not in photos — and note 'Madison' here is a TODD SNYDER fit " +
      "name with NOTHING to do with Brooks Brothers' Madison in this same pack.",
    rows: [
      {
        size: "Tops: ALPHA S/M/L/XL",
        measurements: {
          note: "alpha; the brand measures chest 1in below the armhole, pit to pit",
        },
      },
      {
        size: "Bottoms: numeric WAIST IN INCHES (selvedge denim 28-38)",
        measurements: { note: "the number is the waist in inches" },
      },
      {
        size: "Tailoring: CHEST + R/L/S (e.g. 40R)",
        measurements: {
          note:
            "US standard: the number is the chest in inches, the letter is a length",
        },
      },
    ],
  },
  {
    brand: "Buck Mason",
    brandMatch: ["buck mason", "buckmason"],
    department: "Men",
    garment: "Size SYSTEMS only (alpha tops XS-XXL / denim waist-inches 28-38)",
    categoryMatch: [
      "top",
      "tee",
      "shirt",
      "flannel",
      "sweatshirt",
      "hoodie",
      "pant",
      "bottom",
      "jean",
      "denim",
      "field pant",
      "chino",
    ],
    note:
      "⚠ NO BRAND-PUBLISHED MEASUREMENTS ARE SEEDED FOR BUCK MASON, AND THE REASON " +
      "IS NOT AN ACCESS PROBLEM: buckmason.com fetches cleanly, but its numeric " +
      "charts live in JS-RENDERED PRODUCT MODALS and its two official fit guides " +
      "(tee and denim) are PROSE WITH NO MEASUREMENT TABLES AT ALL. So no inch-level " +
      "table could be obtained and NONE IS INVENTED — this row carries THE SIZE " +
      "SYSTEM ONLY. THE NUMBERS HERE ARE NOT THE BRAND'S OWN — MEASURE THE GARMENT. " +
      "The one aggregator chart found is an undated, uncited flat JPEG on a " +
      "retailer's page: the worst possible source for numbers a grader would treat " +
      "as authoritative, and deliberately not ingested. ⚠ BUCK MASON OFFERS FREE " +
      "HEMMING ON ALL JEANS AND SHIPS NO INSEAM AXIS, which implies jeans ship at a " +
      "single long inseam and are hemmed to order — SO A LARGE SHARE OF SECONDHAND " +
      "BUCK MASON JEANS WILL HAVE A CUSTOM, NON-FACTORY INSEAM AND HEM. Measure, " +
      "never assume. Tops add SHORT and TALL as separate SKUs.",
    rows: [
      {
        size: "Tops: ALPHA XS/S/M/L/XL/XXL",
        measurements: {
          note: "alpha; SHORT and TALL variants ship as separate SKUs",
        },
      },
      {
        size: "Denim: numeric WAIST IN INCHES 28-38",
        measurements: {
          note:
            "28,29,30,31,32,33,34,36,38 — the run is NOT continuous above 34 (no 35, no 37)",
        },
      },
    ],
  },

  // ── US-1988: handbags & accessories group ──────────────────────────────────
  // Mirrors migration 00468's brand_size_charts seed (the DB rows win when the
  // pack loads; these are the offline fallback).
  //
  // ⚠ A "SIZE CHART" HERE IS A **DIMENSION TABLE, NOT A BODY-MEASUREMENT GRID** —
  // the first such block in this file, and the reason is the group: every pack
  // from 00443..00467 graded GARMENTS, and this one grades BAGS. A bag has no
  // chest and no inseam; it has a length, a depth, a height and a strap drop.
  // (The ONE exception is Rebecca Minkoff's apparel chart below — she is the only
  // brand here selling real RTW, and it is the only body-measurement table.)
  //
  // THE HAZARD THIS BLOCK EXISTS TO CONTAIN IS **AXIS ORDER**, and it is silent:
  //   • Dooney publishes H x D x L        (normalised to L x D x H below)
  //   • Tumi publishes H x D x W, NOT H x W x D (transcribing it the usual way
  //     silently SWAPS DEPTH AND WIDTH)
  //   • Brahmin is internally inconsistent AND self-evidently mislabelled on the
  //     Lorelei — preserved as published rather than silently "fixed"
  //   • Fossil splits UNITS INSIDE ONE BRAND: watches in MM, bags/wallets in
  //     inches. A parser that does not branch on category reads a 44MM case as 44
  //     inches.
  // So every chart names its axis order AND its unit in `garment`, the US-1739
  // convention applied to an axis.
  //
  // A NOTE ON CONFIDENCE, DELIBERATELY UNEVEN. Longchamp, Rebecca Minkoff,
  // Herschel and Fossil's watches are brand-published and fetched (0.85). Vera
  // Bradley and Marc Jacobs render specs client-side or block fetching outright,
  // so those are search-read (0.70). Brahmin's own axis labels contradict each
  // other and its Duxbury pages 404 (0.55); Fossil's bag dims could not be
  // isolated from retailer copy (0.60). An honest 0.55 beats a fabricated 0.9 —
  // the Brandy Melville rule from 00466.

  // Longchamp — the size NAME is the trap; the 4-digit model is the truth.
  {
    brand: "Longchamp",
    brandMatch: ["longchamp", "longchamps"],
    department: "Unisex",
    garment: "Le Pliage bag dimensions (INCHES, L x H x W)",
    categoryMatch: [
      "bag",
      "tote",
      "handbag",
      "travel bag",
      "purse",
      "shoulder bag",
      "backpack",
    ],
    note:
      "⚠ MATCH ON THE 4-DIGIT MODEL NUMBER, NEVER THE SIZE LETTER — the highest-" +
      "operational-impact fact about Longchamp. The brand renamed the range to " +
      "XS/S/M/L/XL while retailers and sellers still use legacy short-handle/" +
      "long-handle naming, so THE SAME REFERENCE L2605 089 is sold as 'Le Pliage " +
      "Original M Tote' (longchamp.com), 'Le Pliage Shoulder Bag S' AND 'Le Pliage " +
      "Original Shoulder Bag M' by different sellers. A seller's 'Small' and " +
      "Longchamp's 'S' are frequently DIFFERENT BAGS. The 4-digit model is stable " +
      "enough that LONGCHAMP PLEADS IT IN ITS OWN FEDERAL COMPLAINT ('Style 1623'). " +
      "⚠ HANDLE DROP IS THE SEPARATOR for the classic ambiguity: the M Tote (8.3in " +
      "drop) and the S Handbag (3.5in drop) are DIFFERENT MODELS, not a handle " +
      "option on one model. ⚠ THERE IS NO OFFICIAL LE PLIAGE SIZE CHART — the " +
      "brand's 'by Size' hub lists NAMES ONLY with no dimensions; these rows were " +
      "assembled from individual product pages. L is measured AT THE BASE. " +
      "Reference format [L][model 4][material 3][colour 3] — L2605 089 001 = M " +
      "Tote / recycled canvas / Black. IT IS A CATALOGUE REFERENCE, NOT A TAG CODE.",
    rows: [
      {
        size: "S Handbag (L1621)",
        measurements: {
          dimensions_in: "9.1 x 8.7 x 5.5",
          dimensions_cm: "23.1 x 22.1 x 14",
          handle_drop_in: "3.5",
          weight: "178 g",
        },
      },
      {
        size: "M Tote (L2605)",
        measurements: {
          dimensions_in: "11 x 10.4 x 6.1",
          dimensions_cm: "28 x 26.4 x 15.5",
          handle_drop_in: "8.3",
          weight: "220 g",
        },
      },
      {
        size: "L Tote (L1899)",
        measurements: {
          dimensions_in: "12.2 x 11.8 x 7.5",
          dimensions_cm: "31 x 30 x 19",
          handle_drop_in: "9.8",
        },
      },
      {
        size: "L Travel (L1624)",
        measurements: {
          dimensions_in: "17.7 x 13.8 x 9.1",
          dimensions_cm: "45 x 35 x 23",
        },
      },
      {
        size: "XL Travel (L1625)",
        measurements: {
          dimensions_in: "21.7 x 15.7 x 9.1",
          dimensions_cm: "55 x 40 x 23",
          handle_drop_in: "3.5",
          capacity: "42 L",
          weight: "445 g",
        },
      },
    ],
  },

  // Marc Jacobs — snippet-sourced; marcjacobs.com blocks fetching entirely.
  {
    brand: "Marc Jacobs",
    brandMatch: ["marc jacobs", "marcjacobs", "the marc jacobs"],
    department: "Women",
    garment: "Bag dimensions (INCHES, L x D x H)",
    categoryMatch: [
      "bag",
      "tote",
      "handbag",
      "crossbody",
      "purse",
      "camera bag",
      "shoulder bag",
    ],
    note:
      "⚠ THESE NUMBERS ARE SNIPPET-SOURCED, NOT FETCHED — marcjacobs.com BLOCKS " +
      "AUTOMATED FETCHING ON EVERY LOCALE, so the official Tote Bag size guide " +
      "could not be read directly. The S/M/L rows reproduced identically across " +
      "two independent passes, which is why they clear 0.7 rather than being " +
      "refused. ⚠ ONE UNRESOLVED CONTRADICTION FROM THE SAME PAGE: a further " +
      "snippet returned '7in L x 6in D x 13in H', which fits none of the three " +
      "rows — possibly a Mini or vertical variant. FLAGGED, NOT DISCARDED, and not " +
      "silently reconciled. ⚠ HANDLE DROP IS NOT PUBLISHED and is not invented. " +
      "⚠ THE STYLE NUMBER IS NOT DECODED: MJ's own FAQ confirms one is 'marked on " +
      "the interior tag', but the site exposes at least FOUR incompatible shapes — " +
      "M0016161, H020L01FA21 (an H-form carrying what LOOKS like a season code " +
      "SP/FA/PF/RE + year), 2S3HCR500H03, and EAN-13 BARCODES like 191267866253 " +
      "which are not style numbers at all. The season reading is an INFERENCE from " +
      "URL patterns; MJ publishes no decoder and tag-string == web-SKU is unproven.",
    rows: [
      {
        size: "The Tote Bag — Small",
        measurements: { dimensions_in: "10 x 5 x 8", dimensions_cm: "26 x 13 x 21" },
      },
      {
        size: "The Tote Bag — Medium",
        measurements: { dimensions_in: "13 x 6 x 11", dimensions_cm: "34 x 15 x 27" },
      },
      {
        size: "The Tote Bag — Large",
        measurements: { dimensions_in: "17 x 6 x 13", dimensions_cm: "42 x 16 x 34" },
      },
      {
        size: "The Snapshot (M0012007)",
        measurements: {
          dimensions_in: "7 x 2 x 4",
          dimensions_cm: "18 x 6 x 11",
          strap_adjustable_in: "8-57",
          strap_drop_in: "27",
        },
      },
    ],
  },

  // Rebecca Minkoff — bags.
  {
    brand: "Rebecca Minkoff",
    brandMatch: ["rebecca minkoff", "rebeccaminkoff"],
    department: "Women",
    garment: "Bag dimensions (INCHES, W x H x D)",
    categoryMatch: [
      "bag",
      "tote",
      "handbag",
      "crossbody",
      "purse",
      "backpack",
      "shoulder bag",
    ],
    note:
      "Brand-published, fetched from live product pages. ⚠ THE STYLE CODE IS A " +
      "HANGTAG/WEB CODE, NOT A TAG CODE, AND THE EVIDENCE IS UNUSUALLY SHARP: " +
      "across owner threads where interior tags are photographed and TRANSCRIBED " +
      "constantly, NOBODY quotes a style code off a sewn tag — the sewn seam tag " +
      "carries COUNTRY OF ORIGIN + 'genuine leather' and nothing more. The only " +
      "sellers quoting codes are NWT listings. DO NOT BUILD A FLOW THAT ASSUMES A " +
      "SELLER CAN READ A STYLE CODE OFF A USED REBECCA MINKOFF BAG. ⚠ The code is " +
      "also NOT a stable per-style key: 'Darren Small Crescent Crossbody' alone " +
      "appears as RVHS26TDDXBY, HF25TDNXBD, HS26TDDXBY, HS26EDDXBY and RVFB0104 — " +
      "it identifies a SEASON/MATERIAL/COLOUR RUN, not a style. ⚠ THE DURABLE " +
      "NAMED AXIS IS HARDWARE FINISH, NOT COLOUR — 'Antique Brass' and 'Black " +
      "Shellac' recur across styles, seasons and years and are photo-verifiable.",
    rows: [
      {
        size: "M.A.B. Crossbody (HS23MMBXBO)",
        measurements: {
          dimensions_in: "11.5 x 8 x 4",
          strap_in: "15",
          hardware: "Black Shellac",
        },
      },
      {
        size: "M.A.B. Hobo (HU22MMBH74)",
        measurements: { dimensions_in: "12.5 x 11 x 4", strap_in: "19" },
      },
      {
        size: "M.A.B. Mini Shoulder (HH25TMBXMI)",
        measurements: {
          dimensions_in: "9.25 x 5.5 x 2.625",
          strap_drop_in: "21.5",
          handle_drop_in: "4.625",
          hardware: "Antique Brass",
        },
      },
      {
        size: "M.A.B. Medium Crossbody (HH25TMBXMD)",
        measurements: {
          dimensions_in: "13.125 x 7.25 x 3.375",
          strap_drop_in: "19.5",
          handle_drop_in: "7.5",
        },
      },
      {
        size: "Julian Backpack (HF21MPBB01)",
        measurements: { dimensions_in: "11.25 x 12 x 6", strap: "not published" },
      },
      {
        size: "Darren Shoulder Bag (HF25TDDD28)",
        measurements: {
          dimensions_in: "9.625 x 10.75 x 4.5",
          strap_drop_in: "13",
          hardware: "Antique Brass turn lock",
        },
      },
      {
        size: "Edie Medium Crossbody (HU23TWSXMD)",
        measurements: {
          dimensions_in: "10.75 x 6 x 3",
          strap_in: "11.5",
          material: "90% paper / 10% faux leather (woven straw)",
        },
      },
    ],
  },

  // Rebecca Minkoff — the ONLY body-measurement chart in this pack.
  {
    brand: "Rebecca Minkoff",
    brandMatch: ["rebecca minkoff", "rebeccaminkoff"],
    department: "Women",
    garment: "Apparel (US 0-12 — BODY measurements, INCHES)",
    categoryMatch: [
      "top",
      "dress",
      "jacket",
      "pant",
      "bottom",
      "skirt",
      "rtw",
      "apparel",
      "denim",
      "blouse",
    ],
    note:
      "THE ONLY BODY-MEASUREMENT CHART IN THIS PACK, and it exists because Rebecca " +
      "Minkoff is the one brand here that sells real RTW (added 2009). " +
      "Brand-published, verbatim from its own size guide. ⚠ PRESERVED AS-PUBLISHED " +
      "WITH A KNOWN BRAND TYPO: US 6 AND US 8 BOTH LIST A 39in HIP. US 6 should " +
      "almost certainly read ~38in given the otherwise regular 1in grade. IT IS " +
      "NOT SILENTLY CORRECTED — the brand's own chart is the source of record, and " +
      "quietly 'fixing' a published number is how a fabrication enters a KB. Flag " +
      "on ingest; the US-1715 queue owns the correction. (The shoe chart carries " +
      "the same shape of error: JP 9.5 = '26.6', almost certainly 26.5.) These are " +
      "BODY measurements, not flat-garment. Shoes run US 6-10 / FR 37-41 / IT " +
      "36-40 / UK 3-7.",
    rows: [
      {
        size: "0 (XXS)",
        measurements: {
          bust: "32",
          waist: "25",
          hip: "35",
          denim: "23",
          uk_fr_it: "4/34/36",
        },
      },
      {
        size: "2 (XS)",
        measurements: {
          bust: "33",
          waist: "26",
          hip: "36",
          denim: "24-25",
          uk_fr_it: "6/36/38",
        },
      },
      {
        size: "4 (S)",
        measurements: {
          bust: "34",
          waist: "27",
          hip: "37",
          denim: "25-27",
          uk_fr_it: "8/38/40",
        },
      },
      {
        size: "6 (M)",
        measurements: {
          bust: "35",
          waist: "28",
          hip: "39",
          denim: "27-28",
          uk_fr_it: "10/40/42",
        },
      },
      {
        size: "8 (L)",
        measurements: {
          bust: "36",
          waist: "29",
          hip: "39",
          denim: "29-30",
          uk_fr_it: "12/42/44",
        },
      },
      {
        size: "10 (XL)",
        measurements: {
          bust: "37",
          waist: "30",
          hip: "40",
          denim: "31-32",
          uk_fr_it: "14/44/46",
        },
      },
      {
        size: "12 (XXL)",
        measurements: {
          bust: "38.5",
          waist: "31.5",
          hip: "41.5",
          denim: "32-33",
          uk_fr_it: "16/46/48",
        },
      },
    ],
  },

  // Fossil — watches. ⚠ MILLIMETRES, and the code beats the collection name.
  {
    brand: "Fossil",
    brandMatch: ["fossil"],
    department: "Unisex",
    garment: "Watches (case diameter in MILLIMETRES — ⚠ NOT inches)",
    categoryMatch: ["watch", "smartwatch", "chronograph", "wearable"],
    note:
      "⚠ THE UNIT SPLIT IS WITHIN ONE BRAND AND IT IS A REAL PARSER TRAP: FOSSIL " +
      "WATCHES ARE SPEC'D IN MILLIMETRES AND FOSSIL BAGS/WALLETS IN INCHES. A " +
      "parser that does not branch on category will read a 44MM case as 44 inches. " +
      "⚠ A FOSSIL COLLECTION NAME DOES NOT DETERMINE CASE SIZE — READ THE " +
      "CASE-BACK CODE. ES5331 is 28MM/5ATM and ES4341P is 35mm/3ATM, and BOTH are " +
      "titled 'Carlie Three-Hand Stainless Steel Watch': same collection name, " +
      "different diameter AND different water resistance. Worse, fossil.com indexes " +
      "ES5331 under BOTH 'Carlie' and 'Carlie Mini'. THE CODE IS RELIABLE; THE NAME " +
      "ATTACHED TO IT IS NOT — which is exactly why this brand has the pack's only " +
      "decoder. ⚠ CARLIE vs CARLIE MINI IS NOT PHOTO-SEPARABLE. The ATM rating is " +
      "marked on the caseback or dial, so a caseback marking that contradicts the " +
      "model's published spec is a genuine inconsistency — flag in condition notes " +
      "only, never as an authenticity verdict.",
    rows: [
      {
        size: "ES5331 — Carlie Three-Hand SS",
        measurements: {
          case_mm: "28",
          strap_width_mm: "12",
          water_resistance: "5 ATM",
          strap_inner_circumference_mm: "185 +/-5",
          crystal: "mineral",
          battery: "SR621SW",
        },
      },
      {
        size: "ES4341P — Carlie Three-Hand SS",
        measurements: {
          case_mm: "35",
          water_resistance: "3 ATM",
          note: "marked discontinued",
        },
      },
      {
        size: "ES4343P — Carlie Three-Hand Sand Leather",
        measurements: {
          case_mm: "35",
          thickness_mm: "9",
          water_resistance: "3 ATM",
        },
      },
      {
        size: "FS4736 / FS4812 / FS4832 / FS5061 / FS6131 — Grant Chronograph",
        measurements: { case_mm: "44", water_resistance: "5 ATM" },
      },
    ],
  },

  // Fossil — bags/wallets. ⚠ INCHES. Same brand, different unit.
  {
    brand: "Fossil",
    brandMatch: ["fossil"],
    department: "Men",
    garment: "Bags & wallets (INCHES — ⚠ note the unit differs from Fossil watches)",
    categoryMatch: [
      "bag",
      "tote",
      "wallet",
      "card holder",
      "small leather goods",
      "handbag",
    ],
    note:
      "⚠ INCHES HERE, MILLIMETRES ON THE WATCH CHART — same brand. ⚠ CONFIDENCE IS " +
      "DELIBERATELY LOW: these numbers are a search-read of fossil.com mixed with " +
      "retailer listings and could NOT be cleanly isolated to fossil.com for every " +
      "figure. MEASURE THE ITEM. ⚠ THERE IS NO FOSSIL 'DEFENDER' WALLET — the line " +
      "is DERRICK. The name is plausible enough to be confabulated on demand, and " +
      "is recorded here so it is not. ⚠ A ZB CODE IS NOT A STYLE KEY: the same " +
      "Rachel Tote carries ZB7507263 (US), ZB1829015 (AU) and ZB7991080 elsewhere " +
      "— ZB codes are per-colourway and per-region. The seeded decoder deliberately " +
      "covers ES|FS|FTW only (watches), NOT ZB or ML, because only the watch code " +
      "is sourced to a physical mark.",
    rows: [
      { size: "Rachel Tote (ZB)", measurements: { dimensions_in: "14 x 4 x 13" } },
      {
        size: "Derrick RFID Passcase",
        measurements: {
          dimensions_in: "3.75 x 0.25 x 2.75",
          note: "removable bifold",
        },
      },
      {
        size: "Derrick Bifold",
        measurements: { dimensions_in: "4.5 x 0.75 x 3.7" },
      },
      {
        size: "Derrick Executive Checkbook",
        measurements: {
          dimensions_in: "3.5 x 0.5 x 6.75",
          note: "the outlier — clearly taller",
        },
      },
      {
        size: "Derrick Card Holder",
        measurements: { dimensions_in: "2.75 x 0.4 x 3.81" },
      },
    ],
  },

  // Vera Bradley — the pattern is the identity; do not spend confidence on style.
  {
    brand: "Vera Bradley",
    brandMatch: ["vera bradley", "verabradley"],
    department: "Women",
    garment: "Bag dimensions (INCHES, W x H x D)",
    categoryMatch: [
      "bag",
      "tote",
      "backpack",
      "travel bag",
      "duffel",
      "crossbody",
      "handbag",
      "purse",
    ],
    note:
      "⚠ CURRENT-VERSION-ONLY: VB's product pages render specs client-side, so " +
      "these were read through a search engine rather than fetched, and they " +
      "describe the CURRENT version of each style — VB has re-specced silhouettes " +
      "over time (the Campus Backpack also circulates as 11 x 17 x 8). ⚠ THE STRAP " +
      "DROP IS THE ONLY RELIABLE SEPARATOR IN THIS TABLE: Weekender 6.5in vs " +
      "Iconic Compact Weekender 4.50in vs Miller 13in. Campus vs XL CAMPUS is the " +
      "same silhouette scaled up and is NOT photo-separable without a scale " +
      "reference. ⚠ REMEMBER THIS BRAND INVERTS THE USUAL WEIGHTING — THE PATTERN " +
      "IS THE IDENTITY, NOT THE STYLE: VB silhouettes are near-duplicates across a " +
      "dozen variants and every fabric line, so do NOT spend confidence on style " +
      "resolution here. ⚠ NO DIMENSIONS ARE SEEDED FOR THE ORIGINAL ZIP HIPSTER — " +
      "VB's page did not yield specs and none is invented. ⚠ NO STYLE CODE EXISTS: " +
      "VB's URLs carry numeric Shopify IDs (26468t77) with no evidence of tag print.",
    rows: [
      {
        size: "Campus Backpack",
        measurements: {
          dimensions_in: "12.0 x 16.5 x 7.5",
          strap_adjustable_in: "32.0",
          handle_drop_in: "2.75",
        },
      },
      {
        size: "Weekender Travel Bag",
        measurements: {
          dimensions_in: "18.5 x 12.5 x 7.5",
          strap_drop_in: "6.5",
          removable_strap_in: "52.5",
        },
      },
      {
        size: "Iconic Compact Weekender",
        measurements: {
          dimensions_in: "16.25 x 10.00 x 7.25",
          handle_drop_in: "4.50",
          removable_strap_in: "52.50",
        },
      },
      {
        size: "Miller Travel Bag",
        measurements: { dimensions_in: "16 x 14 x 8", strap_drop_in: "13" },
      },
    ],
  },

  // Dooney & Bourke — ⚠ the brand publishes H x D x L; normalised below.
  {
    brand: "Dooney & Bourke",
    brandMatch: ["dooney & bourke", "dooney and bourke", "dooneybourke", "dooney"],
    department: "Women",
    garment:
      "Bag dimensions (INCHES — ⚠ NORMALISED to L x D x H; Dooney publishes H x D x L)",
    categoryMatch: [
      "bag",
      "tote",
      "handbag",
      "satchel",
      "crossbody",
      "purse",
      "shoulder bag",
    ],
    note:
      "⚠ AXIS ORDER IS A LIVE DATA-QUALITY RISK HERE: DOONEY PUBLISHES ITS FIELDS " +
      "AS H x D x L AND THE ROWS ABOVE ARE NORMALISED TO L x D x H. Mis-ordering " +
      "these silently produces a wrong bag. ⚠ THE VINTAGE ROWS ARE " +
      "COLLECTOR-SOURCED AND THEIR AXIS ORDER IS NOT STATED BY THE SOURCE AT ALL — " +
      "seeded for rough orientation only; measure the bag. ⚠ THE VINTAGE STYLE " +
      "NUMBER'S LETTER PREFIX REPORTEDLY ENCODES TRIM COLOUR (R = British Tan, B = " +
      "Burnt Cedar, P = matching trim) — internally consistent across the model " +
      "list, but collector-sourced and NOT verified. ⚠ MODERN STYLE NUMBERS carry a " +
      "2-letter COLOUR SUFFIX (8L980NA = Natural, Q150CWH = White). ⚠ NONE OF THESE " +
      "STYLE NUMBERS IS CONFIRMED ON THE BAG — no source shows 8L980 or R730 " +
      "printed on a Dooney, and Dooney's own registration form reportedly asks for " +
      "the SKU from the paper GUARANTEE CARD. Do NOT instruct a seller to look for " +
      "a style number on the bag. The ONE code that IS on the bag is the " +
      "REGISTRATION NUMBER on the reverse of the sewn tag — deliberately not " +
      "decoded, because its date semantics are flatly contradicted.",
    rows: [
      {
        size: "Florentine Satchel (8L980)",
        measurements: {
          dimensions_in: "12 x 4.75 x 7",
          handle_drop_in: "4.5",
          strap_drop_in: "19",
        },
      },
      {
        size: "AWL 2 Duck Bag (Q150C)",
        measurements: { dimensions_in: "6 x 3 x 6", strap_drop_in: "25" },
      },
      {
        size: "Vintage R03 Doctor Bag",
        measurements: {
          dimensions_in: "11 x 7 x 5.5",
          note: "axis order NOT stated by the source — do not assume",
        },
      },
      {
        size: "Vintage R710 Small Satchel",
        measurements: {
          dimensions_in: "10 x 7 x 4.5",
          note: "axis order NOT stated",
        },
      },
      {
        size: "Vintage R28 Medium Satchel",
        measurements: {
          dimensions_in: "10.5 x 8.5 x 5.5",
          note: "axis order NOT stated",
        },
      },
      {
        size: "Vintage R730 Large Satchel",
        measurements: {
          dimensions_in: "12 x 10 x 6",
          note: "axis order NOT stated",
        },
      },
    ],
  },

  // Brahmin — ⚠ the brand's own axis labels contradict each other.
  {
    brand: "Brahmin",
    brandMatch: ["brahmin"],
    department: "Women",
    garment:
      "Bag dimensions (INCHES — ⚠ AXIS ORDER IS INTERNALLY INCONSISTENT, see note)",
    categoryMatch: [
      "bag",
      "tote",
      "handbag",
      "satchel",
      "crossbody",
      "purse",
      "shoulder bag",
    ],
    note:
      "⚠ CONFIDENCE IS DELIBERATELY LOW: BRAHMIN'S OWN AXIS ORDERING IS INTERNALLY " +
      "INCONSISTENT — the Lorelei is published L x D x H while the Duxbury family " +
      "is W x H x D, and the Lorelei's numbers are self-evidently mislabelled " +
      "(6.0L x 9.0D x 2.25H describes a bag deeper than it is long). THE PUBLISHED " +
      "LABELS ARE PRESERVED RATHER THAN SILENTLY CORRECTED, with the discrepancy " +
      "flagged for the US-1715 queue. ⚠ THE DUXBURY ROWS ARE SNIPPET-DERIVED (the " +
      "product pages 404'd) — VERIFY BEFORE RELYING. ⚠ DUXBURY vs LARGE DUXBURY IS " +
      "NOT PHOTO-SEPARABLE: same silhouette, same finish, 1.5in apart — without a " +
      "scale reference the model must ABSTAIN. ⚠ BRAHMIN MEASURES 'at the widest " +
      "and tallest points, excluding handles' — a METHODOLOGY note worth keeping, " +
      "because it makes these numbers NON-COMPARABLE to brands that measure the " +
      "base. ⚠ THE SKU DECODES CLEANLY BUT IS A LISTING PARSER, NOT A TAG CODE: " +
      "[style 3][material 3-4][colour 5], parsed RIGHT-TO-LEFT (last 5 = colour, " +
      "first 3 = style, remainder = material) because the material field is 3 OR 4 " +
      "digits — a fixed-offset parser WILL corrupt data. ⚠ MELBOURNE IS A " +
      "MATERIAL, NOT A COLOUR OR A STYLE.",
    rows: [
      {
        size: "Lorelei Shoulder (S10)",
        measurements: {
          dimensions_in_as_published: "6.0 L x 9.0 D x 2.25 H",
          strap_in: "10.5",
          warning:
            "⚠ THE AXIS LABELS LOOK WRONG — this implies a bag deeper than it is long; almost certainly 9in L x 6in H x 2.25in D",
        },
      },
      {
        size: "Duxbury Satchel (K43 / V48)",
        measurements: {
          dimensions_in: "12.75 W x 9.75 H x 5.0 D",
          handle_drop_in: "4",
          strap_in: "25",
          confidence: "snippet-derived, product page 404'd",
        },
      },
      {
        size: "Large Duxbury (V49)",
        measurements: {
          dimensions_in: "14.2 W x 12 H x 5.0 D",
          handle_drop_in: "4",
          strap_in: "13",
          confidence: "snippet-derived",
        },
      },
      {
        size: "Priscilla Satchel (N79)",
        measurements: { dimensions_in: "15.0 W x 10.25 H x 5.5 D" },
      },
    ],
  },

  // Tumi — ⚠ publishes H x D x W (not H x W x D); inches are DERIVED.
  {
    brand: "Tumi",
    brandMatch: ["tumi"],
    department: "Unisex",
    garment:
      "Luggage & bags (⚠ Tumi publishes CENTIMETRES as H x D x W — inches below are DERIVED)",
    categoryMatch: [
      "bag",
      "luggage",
      "carry-on",
      "suitcase",
      "backpack",
      "briefcase",
      "duffel",
      "travel bag",
    ],
    note:
      "⚠ TUMI PUBLISHES H x D x W, NOT H x W x D — transcribing as H x W x D " +
      "silently SWAPS DEPTH AND WIDTH. ⚠ THE INCH FIGURES ARE DERIVED FROM TUMI'S " +
      "PUBLISHED CENTIMETRES, not sourced — Tumi's EU pages do not publish inches " +
      "at all. ⚠ DO NOT ASSERT 'AIRLINE COMPLIANT': TUMI PUBLISHES NO COMPLIANCE " +
      "GUARANTEE. It markets by regional cabin CONVENTION ('International' ~56cm / " +
      "~22in) and confirms only a TSA-approved lock — and EXPANSION PUSHES THE BAG " +
      "OUT OF SPEC (up to 2in / 5cm additional). ⚠ SPEC DRIFT IS REAL AND " +
      "UNRESOLVED: the flagship 117154 is published as BOTH 35 L / 4.604 kg AND " +
      "35/45 L / 4.946 kg on BRAND-OWNED sites. Neither is picked. ERA-SCOPE SPEC " +
      "EQUALITY; never grade a listing 'misdescribed' on capacity or weight alone. " +
      "⚠ THE STYLE NUMBER IS A CATALOGUE CODE, NOT A TAG CODE — and Tumi runs THREE " +
      "INCOMPATIBLE FORMATS on its own regional sites: NNNNNN-CCCC (uk/be/es), " +
      "0NNNNNNCCCC concatenated (US), 464.NNNNNNNND (gr). The 4-char SUFFIX IS A " +
      "DURABLE COLOUR CODE (1041 = Black across 13+ styles) — ⚠ IT IS ALPHANUMERIC " +
      "(A639, T522, B186): parse as string, never as int. ⚠ Style-number blocks " +
      "appear to cluster by collection (Alpha 3 = 1171xx) but the pattern BREAKS " +
      "(139685 is a Short Trip, not 19 Degree) — NOT seeded as a rule.",
    rows: [
      {
        size: "Alpha 3 International Expandable Carry-On (117154)",
        measurements: {
          dimensions_cm_hdw: "56 x 23 x 35.5 (expanded 56 x 28 x 35.5)",
          dimensions_in_derived: "~22 x 9 x 14",
          capacity: "⚠ CONTRADICTED: 35 L or 35/45 L",
          weight: "⚠ CONTRADICTED: 4.604 kg or 4.946 kg",
        },
      },
      {
        size: "19 Degree Aluminium International Carry-On (124851)",
        measurements: {
          dimensions_cm_hdw: "56 x 23 x 35.5",
          dimensions_in_derived: "~22 x 9 x 14",
          capacity: "31 L",
          weight: "5.076 kg",
        },
      },
      {
        size: "Alpha 3 Short Trip Expandable Packing Case (117165)",
        measurements: {
          dimensions_cm_hdw: "66 x 33 x 48.5",
          dimensions_in_derived: "~26 x 13 x 19",
          capacity: "83 L",
          weight: "7.365 kg",
        },
      },
      {
        size: "Alpha 3 Extended Trip Expandable (117167)",
        measurements: { height_cm: "78.5", capacity: "126 L" },
      },
      {
        size: "Alpha 3 Worldwide Trip Expandable (117168)",
        measurements: { height_cm: "86.5", capacity: "138 L" },
      },
      {
        size: "Voyageur Celina Backpack (146566)",
        measurements: {
          dimensions_cm_hdw: "40.5 x 16.5 x 27",
          dimensions_in_derived: "~16 x 6.5 x 10.6",
          capacity: "32.12 L",
          weight: "0.91 kg",
        },
      },
      {
        size: "Alpha Bravo Navigation Backpack (142497)",
        measurements: {
          dimensions_cm_hdw: "40.5 x 18.5 x 35.5 (expanded 40.5 x 25.5 x 35.5)",
          dimensions_in_derived: "~16 x 7.3 x 14",
          weight: "1.273 kg",
        },
      },
    ],
  },

  // Herschel — native inches. ⚠ capacity is NOT a model identifier.
  {
    brand: "Herschel Supply Co.",
    brandMatch: [
      "herschel",
      "herschel supply",
      "herschel supply co",
      "herschelsupplyco",
    ],
    department: "Unisex",
    garment: "Backpacks & duffles (INCHES, H x W x D — Herschel publishes native inches)",
    categoryMatch: [
      "bag",
      "backpack",
      "duffel",
      "luggage",
      "tote",
      "travel bag",
      "hip pack",
    ],
    note:
      "⚠ CAPACITY IS NOT A MODEL IDENTIFIER AND THIS IS THE BRAND'S HEADLINE " +
      "RESALE TRAP: THE SAME MODEL NAME SHIPS AT DIFFERENT SPECS ACROSS ERAS. " +
      "Little America 30L (current) vs 25L (older stock and its own Amazon " +
      "listing); Mid 21L vs 17L; and 'Classic XL' names BOTH a 30L and a 26L bag. " +
      "A 2015 and a 2025 Little America are BOTH GENUINE AND DIFFERENTLY SIZED — " +
      "never grade a listing 'misdescribed' on capacity alone, and era-scope any " +
      "spec equality check. ⚠ THE OBVIOUS DISCRIMINATOR IS WRONG: LITTLE AMERICA " +
      "AND RETREAT ARE NOT SEPARABLE BY CLOSURE OR STRAP HARDWARE — both are " +
      "verbatim 'Easy U-pull drawcord closure' + 'Magnet fastened straps with metal " +
      "pin buckles'. Separate them on the SIDE PROFILE (7.09in vs 5.91in depth), " +
      "the TOP-LID ZIP (LA only) or the SIDE-ENTRY ZIP (Retreat only). ⚠ HERITAGE " +
      "vs SETTLEMENT is the hardest pair — both zippered, same capacity class, " +
      "separable only on proportion; ROUTE TO HUMAN REVIEW. ⚠ Herschel publishes " +
      "NATIVE INCHES, so unlike Tumi no conversion is involved. ⚠ NO STYLE CODE IS " +
      "SEEDED: 10014-00001-OS traces only to URLs, and Herschel's warranty flow " +
      "never asks the owner to read a number off the bag.",
    rows: [
      {
        size: "Little America",
        measurements: {
          dimensions_in: "19.09 x 11.22 x 7.09",
          capacity: "⚠ 30 L current / 25 L on older stock",
          weight: "2.43 lb",
          laptop_sleeve_in: "12.5 x 11.25",
        },
      },
      {
        size: "Little America Mid",
        measurements: {
          dimensions_in: "16.93 x 11.02 x 5.32",
          capacity: "⚠ 21 L current / 17 L cached",
          weight: "2.09 lb",
          laptop_sleeve_in: "12.5 x 11",
        },
      },
      {
        size: "Retreat",
        measurements: {
          dimensions_in: "18.11 x 11.02 x 5.91",
          capacity: "23 L",
          weight: "1.63 lb",
        },
      },
      {
        size: "Settlement",
        measurements: {
          dimensions_in: "17.13 x 11.42 x 5.91",
          capacity: "23 L",
          weight: "1.37 lb",
          laptop_sleeve_in: "11.25 x 11",
        },
      },
      {
        size: "Heritage",
        measurements: {
          dimensions_in: "18.11 x 12.21 x 6.5",
          capacity: "24 L",
          weight: "1.43 lb",
          laptop_sleeve_in: "9.5 x 10.5",
        },
      },
      {
        size: "Classic",
        measurements: {
          dimensions_in: "16.73 x 12.21 x 6.3",
          capacity: "26 L",
          weight: "1.1 lb",
        },
      },
      {
        size: "Classic XL",
        measurements: {
          dimensions_in: "17.72 x 12.8 x 6.5",
          capacity: '⚠ 30 L — but a "Classic Backpack XL 26L" page also exists',
        },
      },
      {
        size: "Novel Duffle",
        measurements: {
          dimensions_in: "11.73 x 20.51 x 10.98",
          capacity: "43 L",
          weight: "2.21 lb",
        },
      },
    ],
  },
  // US-1989: heritage & workwear (mirrors migration 00469's brand_size_charts).
  // A mix of APPAREL (waist x inseam / chest) and FOOTWEAR (US shoe) charts. For
  // this group the tag ERA drives value, so the notes carry the fit caveats.
  {
    brand: "Dickies",
    brandMatch: ["dickies"],
    department: "Men",
    garment: "Work pants (WAIST x INSEAM, inches)",
    categoryMatch: ["pant", "bottom", "trouser", "work pant", "874", "jean", "short"],
    note:
      "Dickies men's work pants use a numeric WAIST x INSEAM grid (the tag prints " +
      "both). ⚠ THE 874 FIT FAMILY IS THE TRAP, NOT THE SIZE: 874 (Original), " +
      "WP314 (Slim Straight) and 872 (Slim) share the size grid but differ in cut " +
      "— read the STYLE NUMBER for fit. Waist runs ~28-44, inseam ~28-34.",
    rows: [
      { size: "30x32", measurements: { waist: "30", inseam: "32" } },
      { size: "32x32", measurements: { waist: "32", inseam: "32" } },
      { size: "34x32", measurements: { waist: "34", inseam: "32" } },
      { size: "36x32", measurements: { waist: "36", inseam: "32" } },
      { size: "38x32", measurements: { waist: "38", inseam: "32" } },
      { size: "40x30", measurements: { waist: "40", inseam: "30" } },
    ],
  },
  {
    brand: "Filson",
    brandMatch: ["filson"],
    department: "Men",
    garment: "Tops & outerwear (alpha, CHEST inches)",
    categoryMatch: [
      "top",
      "shirt",
      "jacket",
      "coat",
      "vest",
      "outerwear",
      "mackinaw",
      "cruiser",
      "tin cloth",
    ],
    note:
      "Filson men's tops/outerwear run alpha S-XXL against a chest grid " +
      "(approximate — verify against the garment). ⚠ WOOL MACKINAW and heavy Tin " +
      "Cloth are cut for LAYERING, so a Filson garment often measures generously " +
      "vs a fashion top of the same alpha size; measure the chest flat and double.",
    rows: [
      { size: "S", measurements: { chest: "36-38" } },
      { size: "M", measurements: { chest: "39-41" } },
      { size: "L", measurements: { chest: "42-44" } },
      { size: "XL", measurements: { chest: "45-47" } },
      { size: "XXL", measurements: { chest: "48-50" } },
    ],
  },
  {
    brand: "Red Wing",
    brandMatch: ["red wing", "redwing"],
    department: "Men",
    garment: "Boots (US men's shoe size)",
    categoryMatch: ["boot", "shoe", "footwear", "moc", "iron ranger"],
    note:
      "⚠ RED WING HERITAGE BOOTS RUN LARGE: the common fit guidance is to go ~0.5 " +
      "size DOWN from your Brannock/US sneaker size (some models a full size). The " +
      "US↔UK↔EU conversions are approximate and vary by last (the 875's last " +
      "differs from the Iron Ranger's). Read the size off the boot/box, and note " +
      "the fit caveat rather than 'correcting' a listing.",
    rows: [
      { size: "US 8", measurements: { uk: "7", eu: "41" } },
      { size: "US 9", measurements: { uk: "8", eu: "42" } },
      { size: "US 10", measurements: { uk: "9", eu: "43" } },
      { size: "US 11", measurements: { uk: "10", eu: "44.5" } },
      { size: "US 12", measurements: { uk: "11", eu: "45" } },
    ],
  },
  {
    brand: "Timberland",
    brandMatch: ["timberland"],
    department: "Men",
    garment: "Boots (US men's shoe size)",
    categoryMatch: ["boot", "shoe", "footwear", "yellow boot", "pro"],
    note:
      "⚠ THE ORIGINAL 6-INCH (YELLOW BOOT) RUNS LARGE — common guidance is to go " +
      "~0.5 size DOWN from a sneaker size. The US↔UK↔EU conversions are " +
      "approximate. Timberland also makes women's and kids' versions of the boot " +
      "at different numbering — read the department off the box. PRO safety boots " +
      "use the same US grid.",
    rows: [
      { size: "US 8", measurements: { uk: "7.5", eu: "41.5" } },
      { size: "US 9", measurements: { uk: "8.5", eu: "43" } },
      { size: "US 10", measurements: { uk: "9.5", eu: "44.5" } },
      { size: "US 11", measurements: { uk: "10.5", eu: "45.5" } },
      { size: "US 12", measurements: { uk: "11.5", eu: "46.5" } },
    ],
  },
  {
    brand: "Duluth Trading Co.",
    // ⚠ brandMatch is "duluth trading", NEVER a bare "duluth" — Duluth Pack (est.
    // 1882) is a different company and a bare "duluth" must not reach this chart.
    brandMatch: ["duluth trading", "duluthtrading"],
    department: "Men",
    garment: "Work pants (WAIST x INSEAM, inches)",
    categoryMatch: ["pant", "bottom", "trouser", "work pant", "fire hose", "jean", "ballroom"],
    note:
      "⚠ THE BRAND-MATCH IS 'duluth trading', NEVER A BARE 'duluth' — Duluth Pack " +
      "(est. 1882) is a DIFFERENT company. Duluth Trading men's pants use a " +
      "numeric WAIST x INSEAM grid; Fire Hose canvas is cut relaxed/gusseted. " +
      "Approximate — verify against the labelled size.",
    rows: [
      { size: "32x32", measurements: { waist: "32", inseam: "32" } },
      { size: "34x32", measurements: { waist: "34", inseam: "32" } },
      { size: "36x34", measurements: { waist: "36", inseam: "34" } },
      { size: "38x34", measurements: { waist: "38", inseam: "34" } },
      { size: "40x32", measurements: { waist: "40", inseam: "32" } },
    ],
  },
  {
    brand: "Pendleton",
    brandMatch: ["pendleton"],
    department: "Men",
    garment: "Wool shirts & tops (alpha, CHEST inches)",
    categoryMatch: ["shirt", "top", "board shirt", "wool shirt", "overshirt", "jacket"],
    note:
      "⚠ VINTAGE PENDLETON WOOL SHIRTS OFTEN RUN SMALLER / BOXIER than the modern " +
      "alpha grid above (mid-century sizing + wool shrinkage) — measure the chest " +
      "flat rather than trusting the tag's alpha letter. ⚠ BLANKETS ARE NOT SIZED " +
      "BY THIS CHART (fixed bed dimensions). Remember the tag ERA, not the size, " +
      "drives vintage value.",
    rows: [
      { size: "S", measurements: { chest: "35-37", neck: "14.5-15" } },
      { size: "M", measurements: { chest: "38-40", neck: "15.5-16" } },
      { size: "L", measurements: { chest: "41-43", neck: "16.5-17" } },
      { size: "XL", measurements: { chest: "44-46", neck: "17.5-18" } },
      { size: "XXL", measurements: { chest: "47-50", neck: "18.5-19" } },
    ],
  },
  {
    brand: "Barbour",
    brandMatch: ["barbour"],
    department: "Men",
    garment: "Waxed & quilted jackets (UK alpha / CHEST inches)",
    categoryMatch: ["jacket", "coat", "waxed jacket", "quilted jacket", "outerwear", "gilet"],
    note:
      "⚠ BARBOUR IS UK-SIZED and its WAXED jackets are cut CLOSE / for country " +
      "layering — many buyers size UP one to layer knitwear underneath, so a " +
      "Barbour 'L' is not a US 'L'. Barbour also labels some jackets by NUMERIC " +
      "chest (C38/C40 = 38in/40in chest). The interior style code (MWX/LWX) also " +
      "carries the size. Approximate — verify.",
    rows: [
      { size: "S", measurements: { chest: "36-38", uk: "S" } },
      { size: "M", measurements: { chest: "38-40", uk: "M" } },
      { size: "L", measurements: { chest: "40-42", uk: "L" } },
      { size: "XL", measurements: { chest: "42-44", uk: "XL" } },
      { size: "XXL", measurements: { chest: "44-46", uk: "XXL" } },
    ],
  },
  {
    brand: "Orvis",
    brandMatch: ["orvis"],
    department: "Men",
    garment: "Tops & outerwear (alpha, CHEST inches)",
    categoryMatch: ["top", "shirt", "jacket", "coat", "vest", "barn coat", "field coat"],
    note:
      "Orvis men's tops/outerwear run alpha S-XXL against a chest grid " +
      "(approximate — verify against the garment). Field/barn coats are cut for " +
      "layering and measure generously; measure the chest flat. Orvis publishes " +
      "garment-specific charts per item.",
    rows: [
      { size: "S", measurements: { chest: "35-37" } },
      { size: "M", measurements: { chest: "38-40" } },
      { size: "L", measurements: { chest: "41-43" } },
      { size: "XL", measurements: { chest: "44-46" } },
      { size: "XXL", measurements: { chest: "47-49" } },
    ],
  },

  // US-1990: footwear tier 2 (mirrors migration 00470's brand_size_charts). The
  // charts are US/UK/EU TRANSLATORS (a shoe's size is stamped, not measured) with
  // the cross-map written INTO the size label; foot-length inches are a sanity
  // check for a shoe in hand.
  {
    brand: "Clarks",
    brandMatch: ["clarks"],
    department: "Unisex",
    garment: "Footwear (US/UK/EU + letter width fittings)",
    categoryMatch: ["shoe", "shoes", "footwear", "boot", "desert boot", "wallabee", "loafer", "sandal"],
    note:
      "CLARKS IS A UK BRAND and much of its stock is UK-stamped; the US market " +
      "uses US medium numbering, so read the label and state the UK number for the " +
      "buyer. THE WIDTH IS A LETTER FITTING (G = standard, H = wide), not a US " +
      "letter. THE SIZE IS STAMPED, NOT MEASURED. Conversions approximate; the " +
      "men's/women's split is in each label (Clarks is often unisex-referenced).",
    rows: [
      { size: "UK 6 = US M7 / US W8.5 = EU 39.5", measurements: { footLength: "9.6" } },
      { size: "UK 7 = US M8 / US W9.5 = EU 41", measurements: { footLength: "9.95" } },
      { size: "UK 8 = US M9 / US W10.5 = EU 42", measurements: { footLength: "10.3" } },
      { size: "UK 9 = US M10 / US W11.5 = EU 43", measurements: { footLength: "10.6" } },
      { size: "UK 10 = US M11 = EU 44.5", measurements: { footLength: "10.95" } },
      { size: "UK 11 = US M12 = EU 46", measurements: { footLength: "11.25" } },
      { size: "UK 12 = US M13 = EU 47", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Merrell",
    brandMatch: ["merrell"],
    department: "Men",
    garment: "Footwear (US/UK/EU — hiking, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "boot", "hiking", "moab", "trail", "sneaker"],
    note:
      "Merrell men's hikers use US numbering; conversions approximate. WIDTHS: a " +
      "WIDE (W) width is offered on many hikers — read it off the tongue label. " +
      "THE SIZE IS STAMPED, NOT MEASURED. The OUTSOLE is the grade on a hiking " +
      "shoe (worn lugs, packed-out midsole) and needs a sole photo.",
    rows: [
      { size: "US M8 = UK 7.5 = EU 41.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8.5 = EU 43", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9.5 = EU 44.5", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10.5 = EU 45.5", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11.5 = EU 46.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12.5 = EU 48", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Merrell",
    brandMatch: ["merrell"],
    department: "Women",
    garment: "Footwear (US/UK/EU — hiking, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "boot", "hiking", "moab", "trail", "sneaker"],
    note:
      "Merrell women's hikers use US numbering; conversions approximate. WIDTHS: a " +
      "WIDE (W) width is offered on many models. THE SIZE IS STAMPED, NOT " +
      "MEASURED. The OUTSOLE + midsole are the grade and need a sole photo.",
    rows: [
      { size: "US W6 = UK 4 = EU 37", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 5 = EU 38", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 6 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 7 = EU 40.5", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 8 = EU 41.5", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 9 = EU 43", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "KEEN",
    brandMatch: ["keen"],
    department: "Men",
    garment: "Footwear (US/UK/EU — RUNS ROOMY, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "sandal", "boot", "newport", "targhee", "hiking"],
    note:
      "⚠ KEEN RUNS ROOMY / WIDE in the toe box by design — report the STAMPED size " +
      "plus the runs-roomy note rather than adjusting the number. US numbering; " +
      "conversions approximate. THE SIZE IS STAMPED, NOT MEASURED.",
    rows: [
      { size: "US M8 = UK 7 = EU 41", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8 = EU 42", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9 = EU 43", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10 = EU 44", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11 = EU 45", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12 = EU 46", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "KEEN",
    brandMatch: ["keen"],
    department: "Women",
    garment: "Footwear (US/UK/EU — RUNS ROOMY, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "sandal", "boot", "newport", "targhee", "hiking"],
    note:
      "⚠ KEEN RUNS ROOMY / WIDE in the toe box by design — report the STAMPED size " +
      "plus the runs-roomy note. US numbering; conversions approximate. THE SIZE " +
      "IS STAMPED, NOT MEASURED.",
    rows: [
      { size: "US W6 = UK 3.5 = EU 36.5", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 4.5 = EU 37.5", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 5.5 = EU 38.5", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 6.5 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 7.5 = EU 41", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 8.5 = EU 42", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "Sorel",
    brandMatch: ["sorel"],
    department: "Women",
    garment: "Footwear (US/UK/EU — winter boots, the size is STAMPED)",
    categoryMatch: ["boot", "boots", "shoe", "shoes", "footwear", "wedge", "caribou", "joan of arctic", "kinetic"],
    note:
      "Sorel women's boots use US numbering; conversions approximate. ⚠ TWO " +
      "DIFFERENT PRODUCTS SHARE THIS BRAND: the technical CARIBOU pac boot (with a " +
      "removable felt liner — a missing/matted liner is a defect) and the FASHION " +
      "line (Joan of Arctic wedge, Kinetic) — they comp SEPARATELY, so read the " +
      "model. THE SIZE IS STAMPED, NOT MEASURED.",
    rows: [
      { size: "US W6 = UK 4 = EU 37", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 5 = EU 38", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 6 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 7 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 8 = EU 41", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 9 = EU 42", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "Sorel",
    brandMatch: ["sorel"],
    department: "Men",
    garment: "Footwear (US/UK/EU — winter boots, the size is STAMPED)",
    categoryMatch: ["boot", "boots", "shoe", "shoes", "footwear", "caribou", "1964 pac", "pac"],
    note:
      "Sorel men's pac boots use US numbering; conversions approximate. ⚠ THE " +
      "REMOVABLE FELT LINER on the Caribou/1964 pac boots is part of the product — " +
      "a missing/matted liner is a real defect; check for cracking at the rubber " +
      "shell flex point. THE SIZE IS STAMPED, NOT MEASURED.",
    rows: [
      { size: "US M8 = UK 7 = EU 41", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8 = EU 42.5", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9 = EU 44", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10 = EU 45", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11 = EU 46.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12 = EU 48", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Brooks",
    // ⚠ brandMatch "brooks" is a LEADING-word match, so a "Brooks Brothers" garment
    // (00467, a DIFFERENT company) also pulls these into the pool — but Brooks
    // Brothers charts match the longer "brooks brothers", and category narrowing
    // separates the two (a shirt category never reaches a footwear chart). Never
    // add a bare "brooks" to a Brooks BROTHERS chart's brandMatch (the note at that
    // chart). This is Brooks RUNNING, a Berkshire Hathaway company.
    brandMatch: ["brooks"],
    department: "Men",
    garment: "Footwear (US/UK/EU — running, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "running", "ghost", "adrenaline", "glycerin", "trainer", "sneaker"],
    note:
      "⚠ THIS IS BROOKS RUNNING, NOT BROOKS BROTHERS — a different company. Brooks " +
      "running shoes use US numbering; conversions approximate. WIDTHS: Narrow " +
      "(B/2A), Medium (D), Wide (2E), Extra-Wide (4E) on many models — read the " +
      "width off the tongue label. THE SIZE IS STAMPED, NOT MEASURED, and a " +
      "running shoe is graded on MILEAGE (outsole + midsole) — require a sole photo.",
    rows: [
      { size: "US M8 = UK 7 = EU 41.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8 = EU 42.5", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9 = EU 44", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10 = EU 45", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11 = EU 46.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12 = EU 47.5", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Brooks",
    brandMatch: ["brooks"],
    department: "Women",
    garment: "Footwear (US/UK/EU — running, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "running", "ghost", "adrenaline", "glycerin", "trainer", "sneaker"],
    note:
      "⚠ THIS IS BROOKS RUNNING, NOT BROOKS BROTHERS. Brooks women's running shoes " +
      "use US numbering; conversions approximate. WIDTHS: Narrow (2A), Medium (B), " +
      "Wide (D), Extra-Wide (2E) on many models. THE SIZE IS STAMPED, NOT " +
      "MEASURED, and the shoe is graded on MILEAGE — require a sole photo.",
    rows: [
      { size: "US W6 = UK 3.5 = EU 36.5", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 4.5 = EU 38", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 5.5 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 6.5 = EU 40.5", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 7.5 = EU 42", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 8.5 = EU 43", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "Saucony",
    brandMatch: ["saucony"],
    department: "Men",
    garment: "Footwear (US/UK/EU — running, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "running", "kinvara", "triumph", "peregrine", "jazz", "shadow", "sneaker"],
    note:
      "Saucony men's running shoes use US numbering; conversions approximate. " +
      "WIDTHS: a WIDE (2E) width is offered on many models. ⚠ THE STYLE NUMBER " +
      "(S2xxxx) IS NOT A DECODER — it collides with adidas's style-code format; " +
      "identify by the model NAME. THE SIZE IS STAMPED, NOT MEASURED, and a " +
      "running shoe is graded on MILEAGE — require a sole photo.",
    rows: [
      { size: "US M8 = UK 7 = EU 41", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8 = EU 42.5", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9 = EU 44", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10 = EU 45", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11 = EU 46.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12 = EU 47.5", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Saucony",
    brandMatch: ["saucony"],
    department: "Women",
    garment: "Footwear (US/UK/EU — running, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "running", "kinvara", "triumph", "peregrine", "jazz", "shadow", "sneaker"],
    note:
      "Saucony women's running shoes use US numbering; conversions approximate. " +
      "WIDTHS: a WIDE width is offered on many models. ⚠ THE STYLE NUMBER (S1xxxx) " +
      "IS NOT A DECODER — identify by the model NAME. THE SIZE IS STAMPED, NOT " +
      "MEASURED, and the shoe is graded on MILEAGE — require a sole photo.",
    rows: [
      { size: "US W6 = UK 4 = EU 37", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 5 = EU 38", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 6 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 7 = EU 40.5", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 8 = EU 42", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 9 = EU 43", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "Steve Madden",
    brandMatch: ["steve madden", "stevemadden"],
    department: "Women",
    garment: "Footwear (US/UK/EU — women's fashion, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "sneaker", "sandal", "heel", "boot", "bootie", "platform", "loafer", "flat"],
    note:
      "Steve Madden women's fashion footwear uses US numbering; conversions " +
      "approximate. THE SIZE IS STAMPED, NOT MEASURED — read it off the insole; " +
      "read the MODEL name off the insole/box. On a heel/sandal the HEEL and SOLE " +
      "are the grade (heel-tip wear, scuffing) and need a sole/heel photo.",
    rows: [
      { size: "US W6 = UK 3.5 = EU 36", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 4.5 = EU 37.5", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 5.5 = EU 38.5", measurements: { footLength: "9.5" } },
      { size: "US W8.5 = UK 6 = EU 39", measurements: { footLength: "9.7" } },
      { size: "US W9 = UK 6.5 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 7.5 = EU 41", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 8.5 = EU 42", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "Sam Edelman",
    brandMatch: ["sam edelman", "samedelman"],
    department: "Women",
    garment: "Footwear (US/UK/EU — women's fashion, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "flat", "loafer", "heel", "pump", "sandal", "boot", "bootie"],
    note:
      "Sam Edelman women's fashion footwear uses US numbering; conversions " +
      "approximate. THE SIZE IS STAMPED, NOT MEASURED — read it off the insole; " +
      "read the MODEL name (Loraine, Felicia, Hazel, Yaro). On a flat/loafer/heel " +
      "the LEATHER, HEEL and SOLE are the grade and need a sole/heel photo.",
    rows: [
      { size: "US W6 = UK 3.5 = EU 36", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 4.5 = EU 37.5", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 5.5 = EU 38.5", measurements: { footLength: "9.5" } },
      { size: "US W8.5 = UK 6 = EU 39", measurements: { footLength: "9.7" } },
      { size: "US W9 = UK 6.5 = EU 40", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 7.5 = EU 41", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 8.5 = EU 42", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "Allen Edmonds",
    brandMatch: ["allen edmonds", "allenedmonds"],
    department: "Men",
    garment: "Footwear (US/UK/EU + width — dress, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "dress shoe", "oxford", "loafer", "wingtip", "brogue", "boot", "park avenue", "strand"],
    note:
      "US men's dress sizing PLUS WIDTHS (A/AA narrow -> B -> D standard -> E -> " +
      "EEE extra wide) — the width is stamped beside the size. THE SIZE IS STAMPED, " +
      "NOT MEASURED. ⚠ THE CONSTRUCTION SETS THE VALUE: the core line is " +
      "GOODYEAR-WELTED and RESOLEABLE (AE runs a RECRAFTING program), so a welted " +
      "pair with a worn sole is still valuable — the tell is the WELT STITCH at the " +
      "sole EDGE and needs a sole-edge photo (say UNCONFIRMED if unphotographed). " +
      "THE SOLE AND HEEL ARE THE GRADE — require a sole and heel-on photo and say " +
      "the sole is UNSEEN rather than grading the upper. A recrafted pair (newer " +
      "sole, older upper) is a serviced shoe, not a fake.",
    rows: [
      { size: "US M8 = UK 7.5 = EU 41", measurements: { footLength: "9.95" } },
      { size: "US M8.5 = UK 8 = EU 41.5", measurements: { footLength: "10.1" } },
      { size: "US M9 = UK 8.5 = EU 42", measurements: { footLength: "10.3" } },
      { size: "US M9.5 = UK 9 = EU 42.5", measurements: { footLength: "10.45" } },
      { size: "US M10 = UK 9.5 = EU 43", measurements: { footLength: "10.6" } },
      { size: "US M10.5 = UK 10 = EU 44", measurements: { footLength: "10.8" } },
      { size: "US M11 = UK 10.5 = EU 44.5", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11.5 = EU 45.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12.5 = EU 47", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Crocs",
    brandMatch: ["crocs"],
    department: "Unisex",
    garment: "Footwear (dual US M/W — RUNS LARGE / roomy, whole sizes)",
    categoryMatch: ["clog", "shoe", "shoes", "footwear", "sandal", "slide", "classic clog", "literide", "bistro"],
    note:
      "CROCS DUAL-TAGS men's AND women's on ONE label (a Crocs 'M8 / W10' is one " +
      "size), in WHOLE SIZES ONLY — no half-size run, which is why the EU column is " +
      "a range. ⚠ CROCS RUN LARGE / ROOMY (a 'relaxed' fit) — report the stamped " +
      "size plus the runs-roomy note. THE SIZE IS STAMPED, NOT MEASURED. The FOAM " +
      "is the grade (heat-shrink/warping, compressed footbed); missing Jibbitz " +
      "charms are NOT a defect.",
    rows: [
      { size: "M4 / W6 = UK 3 = EU 36-37", measurements: { footLength: "8.75" } },
      { size: "M5 / W7 = UK 4 = EU 37-38", measurements: { footLength: "9.1" } },
      { size: "M6 / W8 = UK 5 = EU 38-39", measurements: { footLength: "9.45" } },
      { size: "M7 / W9 = UK 6 = EU 39-40", measurements: { footLength: "9.8" } },
      { size: "M8 / W10 = UK 7 = EU 41-42", measurements: { footLength: "10.15" } },
      { size: "M9 / W11 = UK 8 = EU 42-43", measurements: { footLength: "10.5" } },
      { size: "M10 / W12 = UK 9 = EU 43-44", measurements: { footLength: "10.85" } },
      { size: "M11 = UK 10 = EU 45", measurements: { footLength: "11.2" } },
      { size: "M12 = UK 11 = EU 46-47", measurements: { footLength: "11.55" } },
    ],
  },

  // US-1991: intimates, loungewear & shapewear. Mirrors migration 00471's
  // brand_size_charts 1:1. THE STORY'S KEY SIGNAL — three incompatible size
  // systems (BRA band+cup, SHAPEWEAR alpha, APPAREL/underwear alpha/waist), with
  // the system named IN THE LABEL and the cup-difference math in the note.
  {
    brand: "SKIMS",
    brandMatch: ["skims"],
    department: "Women",
    garment: "Intimates apparel / shapewear (alpha XXS-4X, body inches)",
    categoryMatch: ["shapewear", "bodysuit", "loungewear", "underwear", "dress", "top", "legging", "brief", "thong", "tank"],
    note:
      "SKIMS is SIZE-INCLUSIVE (XXS-4X) and its fabric is COMPRESSIVE: the Fits " +
      "Everybody/Sculpting lines fit snug, so size to the BODY measurement, not the " +
      "flat garment (a Fits Everybody piece measures much smaller than the body it " +
      "fits). Bust/waist/hip are the signals. THE FABRIC IS THE GRADE — a " +
      "stretched-out, non-recovering piece is a defect. Body-equivalent " +
      "approximations, not brand-published specs.",
    rows: [
      { size: "XXS", measurements: { bust: "30-31", waist: "23-24", hip: "33-34" } },
      { size: "XS", measurements: { bust: "32-33", waist: "25-26", hip: "35-36" } },
      { size: "S", measurements: { bust: "34-35", waist: "27-28", hip: "37-38" } },
      { size: "M", measurements: { bust: "36-37.5", waist: "29-30.5", hip: "39-40.5" } },
      { size: "L", measurements: { bust: "38.5-40", waist: "32-33.5", hip: "42-43.5" } },
      { size: "XL", measurements: { bust: "41-43", waist: "35-37", hip: "45-47" } },
      { size: "2X", measurements: { bust: "44-46.5", waist: "38-40.5", hip: "48-50.5" } },
      { size: "3X", measurements: { bust: "47.5-50", waist: "42-44.5", hip: "52-54.5" } },
      { size: "4X", measurements: { bust: "51-53.5", waist: "46-48.5", hip: "56-58.5" } },
    ],
  },
  {
    brand: "Spanx",
    brandMatch: ["spanx"],
    department: "Women",
    garment: "Shapewear / leggings (alpha XS-3X, body inches)",
    categoryMatch: ["shapewear", "legging", "bodysuit", "short", "loungewear", "faux leather", "oncore", "bra"],
    note:
      "Spanx sizes alpha XS-3X. ⚠ FIRM SHAPEWEAR (OnCore/Higher Power) is graded on " +
      "COMPRESSION and runs true-to-snug — size to the body, not the flat garment. " +
      "The FAUX LEATHER LEGGINGS are a fashion legging (comp separately) and their " +
      "COATED FINISH is part of the grade (cracking at the knee). Waist is the " +
      "primary signal, hip secondary. Body-equivalent approximations, not " +
      "brand-published specs.",
    rows: [
      { size: "XS", measurements: { waist: "25-26", hip: "35-36" } },
      { size: "S", measurements: { waist: "27-28.5", hip: "37-38.5" } },
      { size: "M", measurements: { waist: "29.5-31", hip: "39.5-41" } },
      { size: "L", measurements: { waist: "32-34", hip: "42-44" } },
      { size: "XL", measurements: { waist: "35-37", hip: "45-47" } },
      { size: "1X", measurements: { waist: "38-40.5", hip: "48-50.5" } },
      { size: "2X", measurements: { waist: "41.5-44", hip: "52-54.5" } },
      { size: "3X", measurements: { waist: "45-47.5", hip: "56-58.5" } },
    ],
  },
  {
    brand: "Victoria's Secret",
    brandMatch: ["victoria's secret", "victorias secret", "victoriassecret"],
    department: "Women",
    garment: "Bras (BAND + CUP two-axis system, underbust inches)",
    categoryMatch: ["bra", "bralette", "bombshell", "push-up", "t-shirt bra", "lingerie", "demi"],
    note:
      "⚠ A BRA SIZE IS TWO AXES: the BAND number (30-44) is the UNDERBUST, and the " +
      "CUP letter is RELATIVE — it is (bust minus band): A=+1in, B=+2in, C=+3in, " +
      "D=+4in, DD/E=+5in, DDD/F=+6in, G=+7in. So a 34B and a 36A share a cup VOLUME " +
      "but a different band (sister sizes). READ THE STAMPED BAND+CUP off the tag " +
      "and state both. ⚠ THE BOMBSHELL ADDS TWO CUP SIZES of padding, so a labelled " +
      "Bombshell 34B fits a smaller bust than a plain 34B. Elastic recovery + " +
      "underwire condition are the grade. Body-equivalent approximations, not " +
      "brand-published specs.",
    rows: [
      { size: "Band 30 (underbust ~26-27in)", measurements: { underbust: "26-27" } },
      { size: "Band 32 (underbust ~28-29in)", measurements: { underbust: "28-29" } },
      { size: "Band 34 (underbust ~30-31in)", measurements: { underbust: "30-31" } },
      { size: "Band 36 (underbust ~32-33in)", measurements: { underbust: "32-33" } },
      { size: "Band 38 (underbust ~34-35in)", measurements: { underbust: "34-35" } },
      { size: "Band 40 (underbust ~36-37in)", measurements: { underbust: "36-37" } },
      { size: "Band 42 (underbust ~38-39in)", measurements: { underbust: "38-39" } },
    ],
  },
  {
    brand: "Victoria's Secret",
    brandMatch: ["victoria's secret", "victorias secret", "victoriassecret"],
    department: "Women",
    garment: "Panties / apparel (alpha XS-XL, body inches)",
    categoryMatch: ["panty", "panties", "underwear", "thong", "sleepwear", "loungewear", "top", "swim"],
    note:
      "VS panties/apparel size alpha XS-XL; waist + hip are the primary signals. " +
      "Panties are a hygiene-sensitive category — grade condition and note " +
      "new-with-tags vs worn explicitly. Body-equivalent approximations, not " +
      "brand-published specs.",
    rows: [
      { size: "XS", measurements: { waist: "24-25", hip: "34-35" } },
      { size: "S", measurements: { waist: "26-27", hip: "36-37" } },
      { size: "M", measurements: { waist: "28-29.5", hip: "38-39.5" } },
      { size: "L", measurements: { waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL", measurements: { waist: "33-35", hip: "43-45" } },
    ],
  },
  {
    brand: "PINK",
    brandMatch: ["pink"],
    department: "Women",
    garment: "Loungewear / apparel (alpha XS-XL, body inches)",
    categoryMatch: ["loungewear", "hoodie", "sweatpants", "legging", "top", "tee", "panty", "bralette", "sleepwear"],
    note:
      "⚠ PINK IS NOT VICTORIA'S SECRET — a younger, LOWER-band line; comp a PINK " +
      "hoodie/legging on the PINK ladder, not the VS lingerie one. Apparel sizes " +
      "alpha XS-XL; bust/waist/hip are the signals. On graphic loungewear the " +
      "PRINT/logo condition (cracking, fading) is part of the grade. Body-equivalent " +
      "approximations, not brand-published specs.",
    rows: [
      { size: "XS", measurements: { bust: "31-32", waist: "24-25", hip: "34-35" } },
      { size: "S", measurements: { bust: "33-34", waist: "26-27", hip: "36-37" } },
      { size: "M", measurements: { bust: "35-36.5", waist: "28-29.5", hip: "38-39.5" } },
      { size: "L", measurements: { bust: "37.5-39", waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL", measurements: { bust: "40-42", waist: "33-35", hip: "43-45" } },
    ],
  },
  {
    brand: "Aerie",
    brandMatch: ["aerie"],
    department: "Women",
    garment: "Apparel / leggings / bralettes (alpha XXS-XXL, body inches)",
    categoryMatch: ["legging", "offline", "bralette", "loungewear", "top", "tee", "swim", "underwear", "activewear"],
    note:
      "Aerie sizes alpha XXS-XXL. ⚠ THE OFFLINE LEGGINGS ARE COMPRESSIVE ACTIVEWEAR " +
      "— size to the body, not the flat garment. Bust/waist/hip are the signals; " +
      "the bralettes (Real Me/Real Sunnie) size S-XL. The elastane RECOVERY is the " +
      "grade on leggings/bralettes. Body-equivalent approximations, not " +
      "brand-published specs.",
    rows: [
      { size: "XXS", measurements: { bust: "30-31", waist: "23-24", hip: "33-34" } },
      { size: "XS", measurements: { bust: "32-33", waist: "25-26", hip: "35-36" } },
      { size: "S", measurements: { bust: "34-35", waist: "27-28", hip: "37-38" } },
      { size: "M", measurements: { bust: "36-37.5", waist: "29-30.5", hip: "39-40.5" } },
      { size: "L", measurements: { bust: "38.5-40", waist: "32-33.5", hip: "42-43.5" } },
      { size: "XL", measurements: { bust: "41-43", waist: "35-37", hip: "45-47" } },
      { size: "XXL", measurements: { bust: "44-46", waist: "38-40", hip: "48-50" } },
    ],
  },
  {
    brand: "Savage X Fenty",
    brandMatch: ["savage x fenty", "savagexfenty", "savage x"],
    department: "Women",
    garment: "Bras (INCLUSIVE BAND + CUP, underbust inches)",
    categoryMatch: ["bra", "bralette", "lingerie", "push-up", "unlined", "corset"],
    note:
      "⚠ SAVAGE X FENTY IS SIZE-INCLUSIVE (bras 30A-46DDD). A BRA SIZE IS TWO AXES: " +
      "the BAND (30-46) is the UNDERBUST, and the CUP letter is RELATIVE — (bust " +
      "minus band): A=+1in, B=+2in, C=+3in, D=+4in, DD/E=+5in, DDD/F=+6in. Sister " +
      "sizes share a cup VOLUME across bands (34B ≈ 36A). READ THE STAMPED BAND+CUP " +
      "and state both. Elastic + underwire + lace snags are the grade. " +
      "Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "Band 30 (underbust ~26-27in)", measurements: { underbust: "26-27" } },
      { size: "Band 32 (underbust ~28-29in)", measurements: { underbust: "28-29" } },
      { size: "Band 34 (underbust ~30-31in)", measurements: { underbust: "30-31" } },
      { size: "Band 36 (underbust ~32-33in)", measurements: { underbust: "32-33" } },
      { size: "Band 38 (underbust ~34-35in)", measurements: { underbust: "34-35" } },
      { size: "Band 40 (underbust ~36-37in)", measurements: { underbust: "36-37" } },
      { size: "Band 42 (underbust ~38-39in)", measurements: { underbust: "38-39" } },
      { size: "Band 44 (underbust ~40-41in)", measurements: { underbust: "40-41" } },
      { size: "Band 46 (underbust ~42-43in)", measurements: { underbust: "42-43" } },
    ],
  },
  {
    brand: "Savage X Fenty",
    brandMatch: ["savage x fenty", "savagexfenty", "savage x"],
    department: "Women",
    garment: "Undies / loungewear (alpha XS-4X, body inches)",
    categoryMatch: ["undies", "underwear", "thong", "brief", "loungewear", "set"],
    note:
      "Savage X undies/loungewear are SIZE-INCLUSIVE (XS-4X); waist + hip are the " +
      "signals. Undies are hygiene-sensitive — grade condition and note " +
      "new-with-tags vs worn explicitly. Body-equivalent approximations, not " +
      "brand-published specs.",
    rows: [
      { size: "XS", measurements: { waist: "24-25", hip: "34-35" } },
      { size: "S", measurements: { waist: "26-27", hip: "36-37" } },
      { size: "M", measurements: { waist: "28-29.5", hip: "38-39.5" } },
      { size: "L", measurements: { waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL", measurements: { waist: "33-35", hip: "43-45" } },
      { size: "1X", measurements: { waist: "36-38.5", hip: "46-48.5" } },
      { size: "2X", measurements: { waist: "39.5-42", hip: "49.5-52" } },
      { size: "3X", measurements: { waist: "43-45.5", hip: "53-55.5" } },
      { size: "4X", measurements: { waist: "46.5-49", hip: "57-59.5" } },
    ],
  },
  {
    brand: "Calvin Klein",
    brandMatch: ["calvin klein", "calvinklein"],
    department: "Men",
    garment: "Underwear (alpha S-XL, waist inches)",
    categoryMatch: ["underwear", "boxer brief", "trunk", "brief", "boxer", "undershirt"],
    note:
      "Calvin Klein men's underwear sizes alpha S-XL to a WAIST inch run (read it " +
      "off the tag / packaging). ⚠ THE LOGO WAISTBAND IS THE PRODUCT and the grade: " +
      "a stretched, greyed or cracked-logo band is a defect (grade it explicitly). " +
      "Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "S (waist ~28-30in)", measurements: { waist: "28-30" } },
      { size: "M (waist ~32-34in)", measurements: { waist: "32-34" } },
      { size: "L (waist ~36-38in)", measurements: { waist: "36-38" } },
      { size: "XL (waist ~40-42in)", measurements: { waist: "40-42" } },
    ],
  },
  {
    brand: "Calvin Klein",
    brandMatch: ["calvin klein", "calvinklein"],
    department: "Women",
    garment: "Bras / bralettes / undies (alpha XS-XL, body inches)",
    categoryMatch: ["bra", "bralette", "modern cotton", "underwear", "panty", "loungewear"],
    note:
      "CK women's Modern Cotton bralettes/bras/undies size alpha XS-XL (band+cup on " +
      "the structured bras — see the VS/Savage X note for the two-axis system); " +
      "bust/waist/hip are the signals. The exposed logo band + elastic recovery are " +
      "the grade. Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "XS", measurements: { bust: "31-32", waist: "24-25", hip: "34-35" } },
      { size: "S", measurements: { bust: "33-34", waist: "26-27", hip: "36-37" } },
      { size: "M", measurements: { bust: "35-36.5", waist: "28-29.5", hip: "38-39.5" } },
      { size: "L", measurements: { bust: "37.5-39", waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL", measurements: { bust: "40-42", waist: "33-35", hip: "43-45" } },
    ],
  },
  {
    brand: "Tommy John",
    brandMatch: ["tommy john", "tommyjohn"],
    department: "Men",
    garment: "Underwear / undershirts (alpha S-XXL, waist inches)",
    categoryMatch: ["underwear", "boxer brief", "trunk", "brief", "undershirt", "loungewear"],
    note:
      "Tommy John men's underwear/undershirts size alpha S-XXL to a WAIST inch run " +
      "(read it off the tag). The SECOND SKIN (micromodal) vs COOL COTTON fabric " +
      "line is the identifier — read it off the tag. The no-roll WAISTBAND recovery " +
      "+ fabric pilling are the grade. Body-equivalent approximations, not " +
      "brand-published specs.",
    rows: [
      { size: "S (waist ~28-30in)", measurements: { waist: "28-30" } },
      { size: "M (waist ~31-33in)", measurements: { waist: "31-33" } },
      { size: "L (waist ~34-36in)", measurements: { waist: "34-36" } },
      { size: "XL (waist ~37-40in)", measurements: { waist: "37-40" } },
      { size: "XXL (waist ~41-44in)", measurements: { waist: "41-44" } },
    ],
  },
  // US-1992: outdoor & technical (tier 2). Mirrors migration 00472's
  // brand_size_charts 1:1. THE SYSTEM is the signal — EU numeric (Fjällräven,
  // Helly Hansen, Mammut) / UK-EU (Rab) vs US alpha (Cotopaxi, Kühl, Outdoor
  // Research), and a STAMPED US/UK/EU footwear number for Salomon.
  {
    brand: "Fjällräven",
    brandMatch: ["fjällräven", "fjallraven"],
    department: "Men",
    garment: "Apparel (EU numeric ↔ US alpha, body inches)",
    categoryMatch: ["jacket", "pants", "trouser", "shirt", "fleece", "top", "vest", "shell", "greenland", "keb", "vidda"],
    note:
      "FJÄLLRÄVEN IS A EUROPEAN BRAND — much stock is EU-numbered (a EU 50 ≈ US M), " +
      "so the SYSTEM (EU numeric vs US alpha) is the signal; read the label and " +
      "state the EU number for the buyer to check. Trousers are often sold by WAIST " +
      "inch (and a numeric leg length). G-1000 is a WAXABLE fabric — a re-waxed face " +
      "is maintenance, not damage; abrasion holes and a broken zip are the defects. " +
      "Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "S = EU 46-48", measurements: { chest: "35-37", waist: "29-31" } },
      { size: "M = EU 50", measurements: { chest: "38-40", waist: "32-34" } },
      { size: "L = EU 52", measurements: { chest: "41-43", waist: "35-37" } },
      { size: "XL = EU 54", measurements: { chest: "44-46", waist: "38-40" } },
      { size: "XXL = EU 56", measurements: { chest: "47-49", waist: "41-43" } },
    ],
  },
  {
    brand: "Fjällräven",
    brandMatch: ["fjällräven", "fjallraven"],
    department: "Women",
    garment: "Apparel (EU numeric ↔ US alpha, body inches)",
    categoryMatch: ["jacket", "pants", "trouser", "shirt", "fleece", "top", "vest", "shell", "greenland", "keb", "vidda"],
    note:
      "FJÄLLRÄVEN IS A EUROPEAN BRAND — women's stock is often EU-numbered (a EU 38 ≈ " +
      "US M/S), so the SYSTEM (EU numeric vs US alpha) is the signal; read the label " +
      "and state the EU number. Trousers are often sold by WAIST inch. Body-equivalent " +
      "approximations, not brand-published specs.",
    rows: [
      { size: "XS = EU 34", measurements: { bust: "32-33", waist: "24-25", hip: "34-35" } },
      { size: "S = EU 36", measurements: { bust: "34-35", waist: "26-27", hip: "36-37" } },
      { size: "M = EU 38", measurements: { bust: "36-37.5", waist: "28-29.5", hip: "38-39.5" } },
      { size: "L = EU 40", measurements: { bust: "38.5-40", waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL = EU 42", measurements: { bust: "41-43", waist: "33-35", hip: "43-45" } },
    ],
  },
  {
    brand: "Salomon",
    brandMatch: ["salomon"],
    department: "Men",
    garment: "Footwear (US/UK/EU — trail/hiking, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "boot", "trail", "hiking", "running", "xt-6", "speedcross", "x ultra", "quest", "sneaker"],
    note:
      "SALOMON IS A FRENCH/EU BRAND and its shoes are primarily EU-stamped; the " +
      "US<->UK<->EU conversions are approximate. THE SIZE IS STAMPED, NOT MEASURED — " +
      "read it off the tongue/insole. A trail runner is graded on MILEAGE: Contagrip " +
      "OUTSOLE lug loss, a packed-out midsole and a frayed Quicklace/Sensifit cage are " +
      "the real defects and need a SOLE photo. Foot-length inches are a sanity check " +
      "for a shoe in hand. Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "US M8 = UK 7.5 = EU 41.5", measurements: { footLength: "9.95" } },
      { size: "US M9 = UK 8.5 = EU 43", measurements: { footLength: "10.3" } },
      { size: "US M10 = UK 9.5 = EU 44.5", measurements: { footLength: "10.6" } },
      { size: "US M11 = UK 10.5 = EU 45.5", measurements: { footLength: "10.95" } },
      { size: "US M12 = UK 11.5 = EU 46.5", measurements: { footLength: "11.25" } },
      { size: "US M13 = UK 12.5 = EU 48", measurements: { footLength: "11.6" } },
    ],
  },
  {
    brand: "Salomon",
    brandMatch: ["salomon"],
    department: "Women",
    garment: "Footwear (US/UK/EU — trail/hiking, the size is STAMPED)",
    categoryMatch: ["shoe", "shoes", "footwear", "boot", "trail", "hiking", "running", "xt-6", "speedcross", "x ultra", "sneaker"],
    note:
      "SALOMON IS A FRENCH/EU BRAND and its shoes are primarily EU-stamped; the " +
      "US<->UK<->EU conversions are approximate. THE SIZE IS STAMPED, NOT MEASURED. A " +
      "trail runner is graded on MILEAGE — Contagrip OUTSOLE lug loss + a packed-out " +
      "midsole need a SOLE photo. Foot-length inches are a sanity check for a shoe in " +
      "hand. Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "US W6 = UK 4 = EU 37", measurements: { footLength: "8.9" } },
      { size: "US W7 = UK 5 = EU 38", measurements: { footLength: "9.25" } },
      { size: "US W8 = UK 6 = EU 39", measurements: { footLength: "9.5" } },
      { size: "US W9 = UK 7 = EU 40.5", measurements: { footLength: "9.9" } },
      { size: "US W10 = UK 8 = EU 41.5", measurements: { footLength: "10.2" } },
      { size: "US W11 = UK 9 = EU 43", measurements: { footLength: "10.5" } },
    ],
  },
  {
    brand: "Cotopaxi",
    brandMatch: ["cotopaxi"],
    department: "Men",
    garment: "Apparel (US alpha, body inches)",
    categoryMatch: ["jacket", "fleece", "vest", "top", "shirt", "windbreaker", "fuego", "teca", "down", "shell"],
    note:
      "Cotopaxi men's apparel sizes US alpha (S-XXL); the SYSTEM is US alpha. ⚠ THE " +
      "DEL DÍA colour blocking is ONE-OF-A-KIND (remnant fabric, the sewer picks the " +
      "colours) — a wild colour block is the PRODUCT, not a flaw. On the Fuego down " +
      "jacket the FILL LOFT is the grade (a flat/leaking baffle is a defect). " +
      "Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "S", measurements: { chest: "35-37", waist: "29-31" } },
      { size: "M", measurements: { chest: "38-40", waist: "32-34" } },
      { size: "L", measurements: { chest: "41-43", waist: "35-37" } },
      { size: "XL", measurements: { chest: "44-46", waist: "38-40" } },
      { size: "XXL", measurements: { chest: "47-49", waist: "41-43" } },
    ],
  },
  {
    brand: "Cotopaxi",
    brandMatch: ["cotopaxi"],
    department: "Women",
    garment: "Apparel (US alpha, body inches)",
    categoryMatch: ["jacket", "fleece", "vest", "top", "shirt", "windbreaker", "fuego", "teca", "down", "shell"],
    note:
      "Cotopaxi women's apparel sizes US alpha (XS-XL); the SYSTEM is US alpha. ⚠ THE " +
      "DEL DÍA colour blocking is ONE-OF-A-KIND (remnant fabric) — a wild colour block " +
      "is the PRODUCT. On the Fuego the FILL LOFT is the grade. Body-equivalent " +
      "approximations, not brand-published specs.",
    rows: [
      { size: "XS", measurements: { bust: "32-33", waist: "24-25", hip: "34-35" } },
      { size: "S", measurements: { bust: "34-35", waist: "26-27", hip: "36-37" } },
      { size: "M", measurements: { bust: "36-37.5", waist: "28-29.5", hip: "38-39.5" } },
      { size: "L", measurements: { bust: "38.5-40", waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL", measurements: { bust: "41-43", waist: "33-35", hip: "43-45" } },
    ],
  },
  {
    brand: "Kühl",
    brandMatch: ["kühl", "kuhl"],
    department: "Men",
    garment: "Apparel (US alpha tops; pants by WAIST inch)",
    categoryMatch: ["jacket", "fleece", "pant", "pants", "softshell", "trouser", "top", "shirt", "hoodie", "renegade", "law", "rydr"],
    note:
      "Kühl men's tops size US alpha; ⚠ PANTS (Renegade / Law / Rydr) ARE SOLD BY " +
      "WAIST x INSEAM INCH — read the waist number off the tag, the alpha here is an " +
      "approximate cross-map. The FIT is articulated and the FABRIC (abrasion, knee " +
      "wear, a broken gusset) is the grade. Body-equivalent approximations, not " +
      "brand-published specs.",
    rows: [
      { size: "S (pant waist ~30-31)", measurements: { chest: "35-37", waist: "30-31" } },
      { size: "M (pant waist ~32-33)", measurements: { chest: "38-40", waist: "32-33" } },
      { size: "L (pant waist ~34-36)", measurements: { chest: "41-43", waist: "34-36" } },
      { size: "XL (pant waist ~38-40)", measurements: { chest: "44-46", waist: "38-40" } },
      { size: "XXL (pant waist ~42-44)", measurements: { chest: "47-49", waist: "42-44" } },
    ],
  },
  {
    brand: "Kühl",
    brandMatch: ["kühl", "kuhl"],
    department: "Women",
    garment: "Apparel (US alpha, body inches)",
    categoryMatch: ["jacket", "fleece", "pant", "pants", "softshell", "top", "shirt", "hoodie", "legging"],
    note:
      "Kühl women's apparel sizes US alpha (XS-XL); pants may also carry a numeric " +
      "waist. The articulated FIT + the FABRIC are the grade. Body-equivalent " +
      "approximations, not brand-published specs.",
    rows: [
      { size: "XS", measurements: { bust: "32-33", waist: "24-25", hip: "34-35" } },
      { size: "S", measurements: { bust: "34-35", waist: "26-27", hip: "36-37" } },
      { size: "M", measurements: { bust: "36-37.5", waist: "28-29.5", hip: "38-39.5" } },
      { size: "L", measurements: { bust: "38.5-40", waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL", measurements: { bust: "41-43", waist: "33-35", hip: "43-45" } },
    ],
  },
  {
    brand: "Helly Hansen",
    brandMatch: ["helly hansen", "hellyhansen"],
    department: "Men",
    garment: "Apparel (EU numeric ↔ US alpha, body inches)",
    categoryMatch: ["jacket", "shell", "ski", "base layer", "fleece", "top", "shirt", "pant", "alpha", "odin", "verglas", "crew", "lifa"],
    note:
      "HELLY HANSEN IS A EUROPEAN (Norwegian) BRAND — stock is often EU-numbered (a " +
      "EU 50 ≈ US M), so the SYSTEM (EU numeric vs US alpha) is the signal; read the " +
      "label and state the EU number. On a shell the MEMBRANE (delamination, " +
      "wetting-out) and the seam tape are the grade — require a lining photo. " +
      "Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "S = EU 46-48", measurements: { chest: "35-37", waist: "29-31" } },
      { size: "M = EU 50", measurements: { chest: "38-40", waist: "32-34" } },
      { size: "L = EU 52", measurements: { chest: "41-43", waist: "35-37" } },
      { size: "XL = EU 54", measurements: { chest: "44-46", waist: "38-40" } },
      { size: "XXL = EU 56", measurements: { chest: "47-49", waist: "41-43" } },
    ],
  },
  {
    brand: "Helly Hansen",
    brandMatch: ["helly hansen", "hellyhansen"],
    department: "Women",
    garment: "Apparel (EU numeric ↔ US alpha, body inches)",
    categoryMatch: ["jacket", "shell", "ski", "base layer", "fleece", "top", "shirt", "pant", "alpha", "crew", "lifa"],
    note:
      "HELLY HANSEN IS A EUROPEAN (Norwegian) BRAND — women's stock is often " +
      "EU-numbered (a EU 38 ≈ US M/S), so the SYSTEM (EU numeric vs US alpha) is the " +
      "signal; read the label. On a shell the membrane + seam tape are the grade. " +
      "Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "XS = EU 34", measurements: { bust: "32-33", waist: "24-25", hip: "34-35" } },
      { size: "S = EU 36", measurements: { bust: "34-35", waist: "26-27", hip: "36-37" } },
      { size: "M = EU 38", measurements: { bust: "36-37.5", waist: "28-29.5", hip: "38-39.5" } },
      { size: "L = EU 40", measurements: { bust: "38.5-40", waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL = EU 42", measurements: { bust: "41-43", waist: "33-35", hip: "43-45" } },
    ],
  },
  {
    brand: "Mammut",
    brandMatch: ["mammut"],
    department: "Men",
    garment: "Apparel (EU numeric ↔ US alpha, body inches)",
    categoryMatch: ["jacket", "shell", "softshell", "fleece", "top", "shirt", "pant", "eiger extreme", "ultimate"],
    note:
      "MAMMUT IS A EUROPEAN (Swiss) BRAND — stock is often EU-numbered (a EU 50 ≈ US " +
      "M), so the SYSTEM (EU numeric vs US alpha) is the signal; read the label and " +
      "state the EU number. The EIGER EXTREME line comps ABOVE the mainline — read the " +
      "exact collection. On a shell the membrane + seam tape are the grade. " +
      "Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "S = EU 46-48", measurements: { chest: "35-37", waist: "29-31" } },
      { size: "M = EU 50", measurements: { chest: "38-40", waist: "32-34" } },
      { size: "L = EU 52", measurements: { chest: "41-43", waist: "35-37" } },
      { size: "XL = EU 54", measurements: { chest: "44-46", waist: "38-40" } },
      { size: "XXL = EU 56", measurements: { chest: "47-49", waist: "41-43" } },
    ],
  },
  {
    brand: "Mammut",
    brandMatch: ["mammut"],
    department: "Women",
    garment: "Apparel (EU numeric ↔ US alpha, body inches)",
    categoryMatch: ["jacket", "shell", "softshell", "fleece", "top", "shirt", "pant", "eiger extreme", "ultimate"],
    note:
      "MAMMUT IS A EUROPEAN (Swiss) BRAND — women's stock is often EU-numbered (a EU " +
      "38 ≈ US M/S), so the SYSTEM (EU numeric vs US alpha) is the signal; read the " +
      "label. On a shell the membrane + seam tape are the grade. Body-equivalent " +
      "approximations, not brand-published specs.",
    rows: [
      { size: "XS = EU 34", measurements: { bust: "32-33", waist: "24-25", hip: "34-35" } },
      { size: "S = EU 36", measurements: { bust: "34-35", waist: "26-27", hip: "36-37" } },
      { size: "M = EU 38", measurements: { bust: "36-37.5", waist: "28-29.5", hip: "38-39.5" } },
      { size: "L = EU 40", measurements: { bust: "38.5-40", waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL = EU 42", measurements: { bust: "41-43", waist: "33-35", hip: "43-45" } },
    ],
  },
  {
    brand: "Rab",
    brandMatch: ["rab"],
    department: "Men",
    garment: "Apparel (UK/EU ↔ US alpha, body inches)",
    categoryMatch: ["jacket", "down", "softshell", "shell", "fleece", "top", "pant", "microlight", "neutrino", "kinetic", "xenon"],
    note:
      "RAB IS A BRITISH BRAND — sizing is UK/EU referenced (a EU 50 ≈ US M), so the " +
      "SYSTEM (UK/EU vs US alpha) is the signal; read the label. On a DOWN jacket " +
      "(Microlight / Neutrino) the FILL LOFT and any leaking baffle are the grade — " +
      "stitch-through (Microlight) vs box-wall (Neutrino) comp differently. " +
      "Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "S = EU 46-48", measurements: { chest: "35-37", waist: "29-31" } },
      { size: "M = EU 50", measurements: { chest: "38-40", waist: "32-34" } },
      { size: "L = EU 52", measurements: { chest: "41-43", waist: "35-37" } },
      { size: "XL = EU 54", measurements: { chest: "44-46", waist: "38-40" } },
      { size: "XXL = EU 56", measurements: { chest: "47-49", waist: "41-43" } },
    ],
  },
  {
    brand: "Rab",
    brandMatch: ["rab"],
    department: "Women",
    garment: "Apparel (UK/EU ↔ US alpha, body inches)",
    categoryMatch: ["jacket", "down", "softshell", "shell", "fleece", "top", "pant", "microlight", "neutrino", "kinetic", "xenon"],
    note:
      "RAB IS A BRITISH BRAND — women's sizing is UK/EU referenced (a UK 12 ≈ US M), " +
      "so the SYSTEM (UK/EU vs US alpha) is the signal; read the label. On a down " +
      "jacket the FILL LOFT + baffles are the grade. Body-equivalent approximations, " +
      "not brand-published specs.",
    rows: [
      { size: "XS = EU 34 (UK 8)", measurements: { bust: "32-33", waist: "24-25", hip: "34-35" } },
      { size: "S = EU 36 (UK 10)", measurements: { bust: "34-35", waist: "26-27", hip: "36-37" } },
      { size: "M = EU 38 (UK 12)", measurements: { bust: "36-37.5", waist: "28-29.5", hip: "38-39.5" } },
      { size: "L = EU 40 (UK 14)", measurements: { bust: "38.5-40", waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL = EU 42 (UK 16)", measurements: { bust: "41-43", waist: "33-35", hip: "43-45" } },
    ],
  },
  {
    brand: "Outdoor Research",
    brandMatch: ["outdoor research", "outdoorresearch"],
    department: "Men",
    garment: "Apparel (US alpha, body inches)",
    categoryMatch: ["jacket", "shell", "softshell", "fleece", "top", "shirt", "pant", "foray", "ferrosi", "helium", "gaiter", "glove"],
    note:
      "Outdoor Research men's apparel sizes US alpha (S-XXL); the SYSTEM is US alpha. " +
      "On a GORE-TEX shell (Foray) the membrane, the TorsoFlo zips and the seam tape " +
      "are the grade — require a lining photo. OR is unusually strong in accessories " +
      "(gaiters, gloves) — grade those on the accessory market. Body-equivalent " +
      "approximations, not brand-published specs.",
    rows: [
      { size: "S", measurements: { chest: "35-37", waist: "29-31" } },
      { size: "M", measurements: { chest: "38-40", waist: "32-34" } },
      { size: "L", measurements: { chest: "41-43", waist: "35-37" } },
      { size: "XL", measurements: { chest: "44-46", waist: "38-40" } },
      { size: "XXL", measurements: { chest: "47-49", waist: "41-43" } },
    ],
  },
  {
    brand: "Outdoor Research",
    brandMatch: ["outdoor research", "outdoorresearch"],
    department: "Women",
    garment: "Apparel (US alpha, body inches)",
    categoryMatch: ["jacket", "shell", "softshell", "fleece", "top", "shirt", "pant", "aspire", "ferrosi", "helium", "gaiter", "glove"],
    note:
      "Outdoor Research women's apparel sizes US alpha (XS-XL); the SYSTEM is US " +
      "alpha. On a GORE-TEX shell (Aspire) the membrane + TorsoFlo zips + seam tape " +
      "are the grade. Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "XS", measurements: { bust: "32-33", waist: "24-25", hip: "34-35" } },
      { size: "S", measurements: { bust: "34-35", waist: "26-27", hip: "36-37" } },
      { size: "M", measurements: { bust: "36-37.5", waist: "28-29.5", hip: "38-39.5" } },
      { size: "L", measurements: { bust: "38.5-40", waist: "30.5-32", hip: "40.5-42" } },
      { size: "XL", measurements: { bust: "41-43", waist: "33-35", hip: "43-45" } },
    ],
  },
  // US-1993: kids & baby. Mirrors migration 00473's brand_size_charts 1:1. THE
  // SYSTEM is the signal and it is NOT one system — BABY = MONTHS ↔ weight ↔
  // height; TODDLER = T-sizes; KIDS = numeric / alpha; and HANNA ANDERSSON =
  // HEIGHT IN CM (a genuinely different axis); Mini Boden = British AGE-YEARS +
  // height cm. These are TRANSLATORS. ⚠ A KIDS SIZE IS THE SIZE, NOT A CODE.
  {
    brand: "Carter's",
    brandMatch: ["carter's", "carters"],
    department: "Baby",
    garment: "Baby (MONTHS ↔ weight ↔ height)",
    categoryMatch: ["bodysuit", "onesie", "sleeper", "footie", "footed", "romper", "pajama", "coverall", "layette", "one-piece", "bib", "baby"],
    note:
      "BABY IS SIZED IN MONTHS — but a baby is fitted by WEIGHT + HEIGHT, and the " +
      "month label is only a proxy, so THE SYSTEM is months ↔ weight ↔ height (read " +
      "all three off the tag). ⚠ A KIDS SIZE (24M / 2T) IS THE SIZE, NOT A CODE. " +
      "Carter's baby is high-volume basics; grade snaps/zips, pilling and stains, and " +
      "value the size-matched SET. Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "Preemie (months system)", measurements: { weight: "up to 6 lb", height: "up to 17 in" } },
      { size: "Newborn / NB", measurements: { weight: "6-9 lb", height: "17-21.5 in" } },
      { size: "3M (0-3M)", measurements: { weight: "9-12.5 lb", height: "21.5-24 in" } },
      { size: "6M (3-6M)", measurements: { weight: "12.5-16.5 lb", height: "24-26.5 in" } },
      { size: "9M (6-9M)", measurements: { weight: "16.5-20.5 lb", height: "26.5-28.5 in" } },
      { size: "12M (9-12M)", measurements: { weight: "20.5-24 lb", height: "28.5-30.5 in" } },
      { size: "18M (12-18M)", measurements: { weight: "24-27 lb", height: "30.5-32.5 in" } },
      { size: "24M / 2T (18-24M)", measurements: { weight: "27-30 lb", height: "32.5-34 in" } },
    ],
  },
  {
    brand: "Carter's",
    brandMatch: ["carter's", "carters"],
    department: "Kids",
    garment: "Toddler & Kids (2T-5T ↔ numeric 4-16 / XS-XL)",
    categoryMatch: ["tee", "shirt", "top", "pant", "pants", "legging", "short", "hoodie", "jacket", "sweater", "pajama", "dress", "skirt", "jeans", "uniform", "polo", "toddler", "kid"],
    note:
      "TODDLER is T-SIZES (2T-5T); KIDS is NUMERIC (4-16) or ALPHA (XS-XL) — a " +
      "DIFFERENT system from baby months, and the SAME numeric label means different " +
      "garments across brands, so read the SYSTEM off the label. ⚠ A KIDS SIZE (4T / " +
      "10-12) IS THE SIZE, NOT A CODE. Body-equivalent approximations, not " +
      "brand-published specs.",
    rows: [
      { size: "2T", measurements: { height: "33-35 in", weight: "29-31 lb", chest: "21" } },
      { size: "3T", measurements: { height: "36-38.5 in", weight: "32-34 lb", chest: "22" } },
      { size: "4T / 4 (XS)", measurements: { height: "39-41 in", weight: "35-39 lb", chest: "23" } },
      { size: "5T / 5 (S)", measurements: { height: "42-44 in", weight: "40-45 lb", chest: "24" } },
      { size: "6 / 6X", measurements: { height: "45-47.5 in", weight: "46-53 lb", chest: "25.5" } },
      { size: "7-8 (M)", measurements: { height: "48-52 in", weight: "54-65 lb", chest: "27" } },
      { size: "10-12 (L)", measurements: { height: "53-58 in", weight: "66-90 lb", chest: "29-30" } },
      { size: "14-16 (XL)", measurements: { height: "59-63 in", weight: "91-115 lb", chest: "32-33" } },
    ],
  },
  {
    brand: "Janie and Jack",
    brandMatch: ["janie and jack", "janieandjack", "janie & jack"],
    department: "Baby",
    garment: "Baby / Layette (MONTHS ↔ weight ↔ height)",
    categoryMatch: ["bodysuit", "onesie", "sleeper", "footie", "romper", "layette", "gown", "set", "coverall", "baby", "pajama"],
    note:
      "BABY / LAYETTE IS SIZED IN MONTHS, fitted by WEIGHT + HEIGHT — THE SYSTEM is " +
      "months ↔ weight ↔ height. ⚠ A KIDS SIZE (18-24M / 2T) IS THE SIZE, NOT A CODE. " +
      "Janie and Jack layette comps as coordinated SETS; grade the snaps, fabric and " +
      "any stain. Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "Newborn / NB", measurements: { weight: "6-9 lb", height: "17-21.5 in" } },
      { size: "3M (0-3M)", measurements: { weight: "9-12.5 lb", height: "21.5-24 in" } },
      { size: "6M (3-6M)", measurements: { weight: "12.5-16.5 lb", height: "24-26.5 in" } },
      { size: "12M (6-12M)", measurements: { weight: "16.5-22 lb", height: "26.5-29 in" } },
      { size: "18M (12-18M)", measurements: { weight: "22-27 lb", height: "29-32 in" } },
      { size: "24M / 2T (18-24M)", measurements: { weight: "27-30 lb", height: "32-34 in" } },
    ],
  },
  {
    brand: "Janie and Jack",
    brandMatch: ["janie and jack", "janieandjack", "janie & jack"],
    department: "Kids",
    garment: "Toddler & Kids (2T-5T ↔ numeric 4-16)",
    categoryMatch: ["dress", "top", "shirt", "pant", "pants", "sweater", "cardigan", "skirt", "short", "suit", "set", "knit", "toddler", "kid"],
    note:
      "TODDLER is T-SIZES (2T-5T); KIDS is NUMERIC (4-12) — a DIFFERENT system from " +
      "baby months. Read the SYSTEM off the label. ⚠ A KIDS SIZE IS THE SIZE, NOT A " +
      "CODE. J&J special-occasion pieces comp as coordinated SETS. Body-equivalent " +
      "approximations, not brand-published specs.",
    rows: [
      { size: "2T", measurements: { height: "33-35 in", weight: "29-31 lb", chest: "21" } },
      { size: "3T", measurements: { height: "36-38.5 in", weight: "32-34 lb", chest: "22" } },
      { size: "4T / 4", measurements: { height: "39-41 in", weight: "35-39 lb", chest: "23" } },
      { size: "5 / 5T", measurements: { height: "42-44 in", weight: "40-45 lb", chest: "24" } },
      { size: "6-7", measurements: { height: "45-49 in", weight: "46-58 lb", chest: "25.5-26.5" } },
      { size: "8-10", measurements: { height: "50-56 in", weight: "59-80 lb", chest: "27-29" } },
      { size: "12", measurements: { height: "57-59 in", weight: "81-95 lb", chest: "30-31" } },
    ],
  },
  {
    brand: "The Children's Place",
    brandMatch: ["the children's place", "children's place", "childrens place", "thechildrensplace"],
    department: "Baby",
    garment: "Baby (MONTHS ↔ weight ↔ height)",
    categoryMatch: ["bodysuit", "onesie", "sleeper", "footie", "romper", "pajama", "coverall", "layette", "one-piece", "baby"],
    note:
      "BABY IS SIZED IN MONTHS, fitted by WEIGHT + HEIGHT — THE SYSTEM is months ↔ " +
      "weight ↔ height. ⚠ A KIDS SIZE (24M / 2T) IS THE SIZE, NOT A CODE. TCP is " +
      "high-volume VALUE basics; grade snaps, fade and pilling, and value the " +
      "size-matched lot. Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "Newborn / NB", measurements: { weight: "6-9 lb", height: "17-21.5 in" } },
      { size: "3M (0-3M)", measurements: { weight: "9-12.5 lb", height: "21.5-24 in" } },
      { size: "6M (3-6M)", measurements: { weight: "12.5-16.5 lb", height: "24-26.5 in" } },
      { size: "9M (6-9M)", measurements: { weight: "16.5-20.5 lb", height: "26.5-28.5 in" } },
      { size: "12M (9-12M)", measurements: { weight: "20.5-24 lb", height: "28.5-30.5 in" } },
      { size: "18M (12-18M)", measurements: { weight: "24-27 lb", height: "30.5-32.5 in" } },
      { size: "24M / 2T (18-24M)", measurements: { weight: "27-30 lb", height: "32.5-34 in" } },
    ],
  },
  {
    brand: "The Children's Place",
    brandMatch: ["the children's place", "children's place", "childrens place", "thechildrensplace"],
    department: "Kids",
    garment: "Toddler & Kids (2T-5T ↔ numeric 4-16 / XS-XL)",
    categoryMatch: ["tee", "shirt", "top", "pant", "pants", "legging", "short", "hoodie", "jacket", "jeans", "polo", "chino", "uniform", "activewear", "jogger", "dress", "skirt", "toddler", "kid"],
    note:
      "TODDLER is T-SIZES (2T-5T); KIDS is NUMERIC (4-16) or ALPHA (XS-XL) — a " +
      "DIFFERENT system from baby months, and the SAME numeric label differs across " +
      "brands, so read the SYSTEM off the label. ⚠ A KIDS SIZE (4T / 10-12) IS THE " +
      "SIZE, NOT A CODE. Uniform basics comp as size-matched bundles. Body-equivalent " +
      "approximations, not brand-published specs.",
    rows: [
      { size: "2T", measurements: { height: "33-35 in", weight: "29-31 lb", chest: "21" } },
      { size: "3T", measurements: { height: "36-38.5 in", weight: "32-34 lb", chest: "22" } },
      { size: "4T / 4 (XS)", measurements: { height: "39-41 in", weight: "35-39 lb", chest: "23" } },
      { size: "5 / 5T (S)", measurements: { height: "42-44 in", weight: "40-45 lb", chest: "24" } },
      { size: "6-7 (S)", measurements: { height: "45-49 in", weight: "46-58 lb", chest: "25.5-26.5" } },
      { size: "8 (M)", measurements: { height: "50-52 in", weight: "59-65 lb", chest: "27" } },
      { size: "10-12 (L)", measurements: { height: "53-58 in", weight: "66-90 lb", chest: "28-30" } },
      { size: "14-16 (XL)", measurements: { height: "59-63 in", weight: "91-115 lb", chest: "31-33" } },
    ],
  },
  {
    brand: "Gymboree",
    brandMatch: ["gymboree"],
    department: "Baby",
    garment: "Baby (MONTHS ↔ weight ↔ height)",
    categoryMatch: ["bodysuit", "onesie", "sleeper", "footie", "romper", "pajama", "coverall", "set", "one-piece", "baby"],
    note:
      "BABY IS SIZED IN MONTHS, fitted by WEIGHT + HEIGHT — THE SYSTEM is months ↔ " +
      "weight ↔ height. ⚠ A KIDS SIZE (24M / 2T) IS THE SIZE, NOT A CODE. ⚠ For " +
      "VINTAGE Gymboree the value is the COLLECTION/LINE NAME, not the size. " +
      "Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "Newborn / NB", measurements: { weight: "6-9 lb", height: "17-21.5 in" } },
      { size: "3M (0-3M)", measurements: { weight: "9-12.5 lb", height: "21.5-24 in" } },
      { size: "6M (3-6M)", measurements: { weight: "12.5-16.5 lb", height: "24-26.5 in" } },
      { size: "12M (6-12M)", measurements: { weight: "16.5-22 lb", height: "26.5-29 in" } },
      { size: "18M (12-18M)", measurements: { weight: "22-27 lb", height: "29-32 in" } },
      { size: "24M / 2T (18-24M)", measurements: { weight: "27-30 lb", height: "32-34 in" } },
    ],
  },
  {
    brand: "Gymboree",
    brandMatch: ["gymboree"],
    department: "Kids",
    garment: "Toddler & Kids (2T-5T ↔ numeric 4-14)",
    categoryMatch: ["tee", "shirt", "top", "pant", "pants", "legging", "short", "hoodie", "dress", "skirt", "jeans", "activewear", "gymgo", "jogger", "set", "toddler", "kid"],
    note:
      "TODDLER is T-SIZES (2T-5T); KIDS is NUMERIC (4-14) — a DIFFERENT system from " +
      "baby months. Read the SYSTEM off the label. ⚠ A KIDS SIZE IS THE SIZE, NOT A " +
      "CODE — and for a VINTAGE Gymboree COLLECTION the value is the LINE NAME, never " +
      "a number. Body-equivalent approximations, not brand-published specs.",
    rows: [
      { size: "2T", measurements: { height: "33-35 in", weight: "29-31 lb", chest: "21" } },
      { size: "3T", measurements: { height: "36-38.5 in", weight: "32-34 lb", chest: "22" } },
      { size: "4T / 4", measurements: { height: "39-41 in", weight: "35-39 lb", chest: "23" } },
      { size: "5 / 5T", measurements: { height: "42-44 in", weight: "40-45 lb", chest: "24" } },
      { size: "6-7", measurements: { height: "45-49 in", weight: "46-58 lb", chest: "25.5-26.5" } },
      { size: "8-10", measurements: { height: "50-56 in", weight: "59-80 lb", chest: "27-29" } },
      { size: "12-14", measurements: { height: "57-61 in", weight: "81-105 lb", chest: "30-32" } },
    ],
  },
  {
    brand: "Hanna Andersson",
    brandMatch: ["hanna andersson", "hannaandersson"],
    department: "Kids",
    garment: "Baby & Kids (HEIGHT IN CM ↔ US age)",
    categoryMatch: ["pajama", "sleeper", "bodysuit", "dress", "top", "tee", "pant", "legging", "romper", "onesie", "footie", "long johns", "playwear", "baby", "kid"],
    note:
      "HANNA ANDERSSON SIZES BY HEIGHT IN CM, not US age — 50 / 60 / 70 / 80 / 90 / " +
      "100 / 110 / 120 / 130 / 140 / 150 = the child's HEIGHT in centimetres, a " +
      "genuinely DIFFERENT AXIS from the US months/T/numeric systems. THE SYSTEM is " +
      "the signal: read the cm number off the neck label and translate to US age via " +
      "this chart (90 cm ≈ US 2T, 110 cm ≈ US 4-5, 130 cm ≈ US 8). A mis-read cm size " +
      "is the most common listing error on this brand. Body-equivalent approximations, " +
      "not brand-published specs.",
    rows: [
      { size: "50 cm (US Newborn / 0-3M)", measurements: { height: "up to 21.5 in", usAge: "NB / 0-3M" } },
      { size: "60 cm (US 3-6M)", measurements: { height: "21.5-24 in", usAge: "3-6M" } },
      { size: "70 cm (US 6-12M)", measurements: { height: "24-28 in", usAge: "6-12M" } },
      { size: "80 cm (US 12-18M)", measurements: { height: "28-31 in", usAge: "12-18M" } },
      { size: "90 cm (US 18-24M / 2T)", measurements: { height: "31-35 in", usAge: "18-24M / 2T" } },
      { size: "100 cm (US 3T)", measurements: { height: "35-39 in", usAge: "3T" } },
      { size: "110 cm (US 4-5)", measurements: { height: "39-43 in", usAge: "4-5" } },
      { size: "120 cm (US 6-7)", measurements: { height: "43-47 in", usAge: "6-7" } },
      { size: "130 cm (US 8)", measurements: { height: "47-51 in", usAge: "8" } },
      { size: "140 cm (US 10)", measurements: { height: "51-55 in", usAge: "10" } },
      { size: "150 cm (US 12)", measurements: { height: "55-59 in", usAge: "12" } },
    ],
  },
  {
    brand: "Mini Boden",
    brandMatch: ["mini boden", "miniboden", "baby boden"],
    department: "Kids",
    garment: "Baby & Kids (AGE-YEARS ↔ height cm, British)",
    categoryMatch: ["dress", "top", "tee", "pant", "legging", "romper", "bodysuit", "onesie", "sleeper", "sleepsuit", "applique", "playsuit", "short", "jumper", "baby", "kid"],
    note:
      "MINI BODEN IS BRITISH — SIZED BY AGE-YEARS (0-3M, 3-6M ... then 2-3Y, 3-4Y, " +
      "4-5Y ...) + HEIGHT in cm, a DIFFERENT system from the US months/T/numeric axis. " +
      "THE SYSTEM is the signal: read the age-band off the tag (a \"2-3Y\" label is an " +
      "AGE, not a US size) and use the height cm to translate. ⚠ A KIDS SIZE (2-3Y / " +
      "24M) IS THE SIZE, NOT A CODE. Body-equivalent approximations, not " +
      "brand-published specs.",
    rows: [
      { size: "0-3M (up to 62 cm)", measurements: { height: "up to 24 in", age: "0-3 months" } },
      { size: "3-6M (62-68 cm)", measurements: { height: "24-27 in", age: "3-6 months" } },
      { size: "6-12M (68-80 cm)", measurements: { height: "27-31 in", age: "6-12 months" } },
      { size: "12-18M (80-86 cm)", measurements: { height: "31-34 in", age: "12-18 months" } },
      { size: "18-24M (86-92 cm)", measurements: { height: "34-36 in", age: "18-24 months" } },
      { size: "2-3Y (92-98 cm)", measurements: { height: "36-39 in", age: "2-3 years" } },
      { size: "3-4Y (98-104 cm)", measurements: { height: "39-41 in", age: "3-4 years" } },
      { size: "4-5Y (104-110 cm)", measurements: { height: "41-43 in", age: "4-5 years" } },
      { size: "5-6Y (110-116 cm)", measurements: { height: "43-46 in", age: "5-6 years" } },
      { size: "7-8Y (122-128 cm)", measurements: { height: "48-50 in", age: "7-8 years" } },
      { size: "9-10Y (134-140 cm)", measurements: { height: "53-55 in", age: "9-10 years" } },
    ],
  },
];

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

/** True when `ch` is a letter or digit in ANY script — `\p{L}` rather than an
 *  ASCII class, so the accented canonicals in this table (Stüssy, Sézane) are
 *  treated as ordinary word characters and not as boundaries. */
function isWordChar(ch: string): boolean {
  return ch !== "" && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * US-1738: does brand text `b` contain the brandMatch token `m` at the START of
 * a word?
 *
 * This used to be a bare `b.includes(m)`, which made every SHORT brandMatch a
 * live hazard — a token fires inside any longer word that happens to contain its
 * letters, and this table is full of 2-4 letter brands. The motivating case, found
 * while seeding US-1738:
 *
 *     "eileen fisher".includes("lee")  -> TRUE   ("ei-LEE-n")
 *
 * which handed every Eileen Fisher garment Lee's DENIM charts — waist-and-inseam
 * numbers for a silk tunic. It is NOT fixable in the data: any brandMatch that
 * still matches its own canonical "lee" is necessarily also a substring of the
 * "eileen" containing it, so there is no narrowing to write. The matcher is the
 * only place it can be fixed.
 *
 * WHY THE BOUNDARY IS LEADING-ONLY, and not on both sides. A trailing letter is
 * legitimate and load-bearing: English suffixes attach at the END, so the
 * pre-1999 "Burberrys" spelling is "Burberry" + s and MUST still reach Burberry's
 * charts (US-1736 relies on exactly this — it is why Burberry carries no second
 * brandMatch token). A LEADING letter never is: a brand token does not begin in
 * the middle of a word. So `m` must start a word, and may continue into one.
 *
 * The boundary is LETTER-based (\p{L}, any script) rather than whitespace-based,
 * so accented canonicals and both token shapes keep working: "alo" matches "alo
 * yoga", "aloyoga" matches "aloyoga", "north face" matches "the north face",
 * "stüssy" matches "stüssy".
 *
 * NOTE this does NOT (and must not) rescue a token that is a genuine leading WORD
 * of a longer brand NAME: "vince camuto" still matches "vince", and "fear of god
 * essentials" still matches "fear of god". Those are real prefix collisions
 * between real brands, and no matcher rule can separate them — they are handled
 * by omitting the shorter brand's chart (see the Vince and Fear of God notes
 * above). Category matching deliberately stays a plain substring test
 * ("long sleeve tee".includes("tee") is intended).
 */
function brandTextMatches(b: string, m: string): boolean {
  if (m === "") return false;
  for (let i = b.indexOf(m); i !== -1; i = b.indexOf(m, i + 1)) {
    if (!isWordChar(i === 0 ? "" : b[i - 1])) return true;
  }
  return false;
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
        (c) => c.brandMatch.length > 0 && c.brandMatch.some((m) => brandTextMatches(b, m)),
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

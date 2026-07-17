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

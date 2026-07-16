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

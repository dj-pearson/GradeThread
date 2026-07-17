// US-544: brand canonicalization + style-code resolution for AutoLister.
//
// The model (and the tag-OCR pass, US-543) emit brand as FREE TEXT — "Levis",
// "levi strauss", "THE NORTHFACE" — and comp search keyed on that raw string.
// eBay's Browse/Marketplace-Insights aspect filter is `Brand:{...}` with an
// EXACT-match value, so a misspelled or non-canonical brand silently drops the
// brand filter to zero matches and prices off an unfiltered category. This
// module:
//
//   1. canonicalizeBrand() — maps a free-text brand onto eBay's canonical brand
//      name via a curated alias table ("Levis" -> "Levi's"), so the comp filter
//      and the Brand item-specific both use the value eBay indexes on.
//   2. resolveStyleCode() — for sneakers/streetwear, turns a style/model code
//      ("CW2288-111") into a canonical product: the authoritative brand, an
//      exact comp query (the code itself returns the SAME shoe, not a fuzzy
//      category match), and auto-filled item specifics.
//
// Everything here is PURE (no network, no DB) so it unit-tests directly.

// ── Brand canonicalization ────────────────────────────────────────────────

/** Normalize to a match key: lowercase, strip everything but [a-z0-9]. Exported
 *  (US-1711) so the brand-knowledge resolver derives brand_key identically to
 *  the 00389 seed (which normalized canonical brands the same way). */
export function brandKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Collapse internal whitespace and trim — the cleaned passthrough for an
 *  unknown brand (we keep the seller's casing rather than guessing). */
function cleanBrand(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

// Curated alias key (brandKey-normalized) -> eBay canonical brand name. The
// VALUES are the strings eBay's Brand aspect indexes on (note "adidas" is
// lowercase, "GUESS" is upper — these are eBay-canonical, not stylistic). Add
// rows as misspellings surface in production; the table is intentionally a flat
// map so it stays cheap to extend.
const BRAND_ALIASES: Record<string, string> = {
  // Denim / Americana
  levis: "Levi's",
  levi: "Levi's",
  levistrauss: "Levi's",
  levistraussco: "Levi's",
  wrangler: "Wrangler",
  lee: "Lee",
  dickies: "Dickies",
  carhartt: "Carhartt",
  // US-1735 premium & vintage denim group. Wrangler + Lee were already above;
  // these four were passthrough-only, so the pack rendered the seller's own
  // casing ("true religion") into the prompt block and the eBay Brand aspect.
  bluebell: "Wrangler", // the pre-1986 parent's mark — a Blue Bell tag IS a Wrangler
  bluebellwrangler: "Wrangler",
  hdlee: "Lee",
  leejeans: "Lee",
  "7forallmankind": "7 For All Mankind",
  sevenforallmankind: "7 For All Mankind",
  "7fam": "7 For All Mankind",
  truereligion: "True Religion",
  truereligionbrandjeans: "True Religion",
  truereligionapparel: "True Religion",
  // CANONICAL IS "AG Jeans", NOT "AG" — deliberately. detectBrandInText scans
  // CANONICAL_BRANDS against free text, and a two-letter "AG" would fire on any
  // stray word-bounded "ag"; sizing-charts.ts matches brandMatch by SUBSTRING,
  // where "ag" is contained in "patAGonia". Keeping the short form as an
  // exact-key ALIAS only (this map is an exact lookup, so it is safe here) gives
  // us the recovery without either hazard.
  ag: "AG Jeans",
  agjeans: "AG Jeans",
  adrianogoldschmied: "AG Jeans",
  agadrianogoldschmied: "AG Jeans",
  citizensofhumanity: "Citizens of Humanity",
  coh: "Citizens of Humanity",
  // AGOLDE is a Citizens of Humanity label, NOT an AG Jeans one despite the
  // name. Mapping it to its own canonical keeps the two from merging.
  agolde: "AGOLDE",
  // Outdoor
  thenorthface: "The North Face",
  northface: "The North Face",
  tnf: "The North Face",
  patagonia: "Patagonia",
  columbia: "Columbia",
  columbiasportswear: "Columbia",
  llbean: "L.L.Bean",
  eddiebauer: "Eddie Bauer",
  marmot: "Marmot",
  arcteryx: "Arc'teryx",
  pendleton: "Pendleton",
  // US-1734 outdoor & technical group. Columbia/L.L.Bean/Marmot/Arc'teryx were
  // already above; these two were passthrough-only, so the pack rendered the
  // seller's casing ("rei co-op") into the prompt block and the eBay Brand
  // aspect. NOTE: a bare "bean" is deliberately NOT aliased to L.L.Bean — it's an
  // ordinary word, and mapping it would rebrand anything tagged "bean".
  reicoop: "REI Co-op",
  rei: "REI Co-op",
  recreationalequipmentinc: "REI Co-op",
  mountainhardwear: "Mountain Hardwear",
  // Athletic / sneakers
  nike: "Nike",
  adidas: "adidas",
  jordan: "Jordan",
  airjordan: "Jordan",
  puma: "PUMA",
  reebok: "Reebok",
  newbalance: "New Balance",
  underarmour: "Under Armour",
  ua: "Under Armour",
  vans: "Vans",
  converse: "Converse",
  asics: "ASICS",
  fila: "Fila",
  champion: "Champion",
  lululemon: "Lululemon",
  gymshark: "Gymshark",
  // US-1733 athleisure group. Under Armour + Gymshark were already above; these
  // four were passthrough-only, so the pack rendered the seller's casing
  // ("beyond yoga") into the prompt block and the eBay Brand aspect.
  vuori: "Vuori",
  fabletics: "Fabletics",
  beyondyoga: "Beyond Yoga",
  sweatybetty: "Sweaty Betty",
  // Mall / mainstream
  tommyhilfiger: "Tommy Hilfiger",
  ralphlauren: "Ralph Lauren",
  poloralphlauren: "Polo Ralph Lauren",
  calvinklein: "Calvin Klein",
  guess: "GUESS",
  abercrombiefitch: "Abercrombie & Fitch",
  abercrombie: "Abercrombie & Fitch",
  hollister: "Hollister",
  americaneagle: "American Eagle",
  aeropostale: "Aeropostale",
  gap: "Gap",
  oldnavy: "Old Navy",
  bananarepublic: "Banana Republic",
  jcrew: "J.Crew",
  uniqlo: "Uniqlo",
  hanes: "Hanes",
  gildan: "Gildan",
  nautica: "Nautica",
  // Streetwear / heritage
  supreme: "Supreme",
  stussy: "Stüssy",
  harleydavidson: "Harley-Davidson",
  // Luxury / accessories
  michaelkors: "Michael Kors",
  coach: "Coach",
  katespade: "Kate Spade",
  gucci: "Gucci",
  versace: "Versace",
  burberry: "Burberry",
  // US-1736 (luxury & designer group). Without these, canonicalizeBrand passed
  // the seller's own casing straight through into the prompt block and the eBay
  // Brand aspect.
  chanel: "Chanel",
  cocochanel: "Chanel",
  chanelparis: "Chanel",
  prada: "Prada",
  pradamilano: "Prada",
  toryburch: "Tory Burch",
  // "Burberrys" (with the S) is the pre-1999 label — it IS a Burberry tag, so it
  // canonicalizes to Burberry. The spelling is a dating tell, carried as a
  // tag_era in migration 00455, not a separate brand.
  burberrys: "Burberry",
  burberryslondon: "Burberry",
  burberrysoflondon: "Burberry",
  burberrylondon: "Burberry",
  // The MK line hierarchy (Collection >> KORS >> MICHAEL) is a STYLE, not a
  // brand — all three labels are the eBay brand "Michael Kors". Keeping the line
  // out of `brand` is what lets brand_styles rank it (00455).
  mk: "Michael Kors",
  kors: "Michael Kors",
  michaelmichaelkors: "Michael Kors",
  korsmichaelkors: "Michael Kors",
  michaelkorscollection: "Michael Kors",
  katespadenewyork: "Kate Spade",
  ksny: "Kate Spade",
};

/**
 * Canonicalize a free-text brand against the known-brand table. Returns the
 * eBay-canonical spelling when recognized (`"Levis"` -> `"Levi's"`), otherwise
 * the cleaned (whitespace-collapsed, trimmed) input unchanged. Returns `null`
 * for an empty/blank input so callers can treat "no brand" uniformly.
 */
export function canonicalizeBrand(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const cleaned = cleanBrand(String(raw));
  if (cleaned === "") return null;
  return BRAND_ALIASES[brandKey(cleaned)] ?? cleaned;
}

/** True when the brand resolves to a curated canonical entry (vs. passthrough). */
export function isKnownBrand(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const cleaned = cleanBrand(String(raw));
  return cleaned !== "" && brandKey(cleaned) in BRAND_ALIASES;
}

/** Unique canonical brand names, longest-first so multi-word brands ("Polo
 *  Ralph Lauren") win over a contained shorter one ("Ralph Lauren"). */
const CANONICAL_BRANDS: readonly string[] = Array.from(
  new Set(Object.values(BRAND_ALIASES)),
).sort((a, b) => b.length - a.length);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect a known brand inside free text — e.g. an eBay product title from a
 * barcode (UPC/EAN) match ("The North Face Men's Apex Jacket Medium" ->
 * "The North Face"). Used by the barcode scan-to-autofill intake (US-598) to
 * pull a canonical brand off a matched listing's title. Word-boundary matched
 * (so "Gap" doesn't fire on "Gaps") and longest-brand-first. Returns the
 * eBay-canonical brand string, or null when no known brand appears.
 */
export function detectBrandInText(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const brand of CANONICAL_BRANDS) {
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(brand)}(?![A-Za-z0-9])`, "i");
    if (re.test(text)) return brand;
  }
  return null;
}

// ── Style-code resolution ─────────────────────────────────────────────────

export interface StyleResolution {
  /** Authoritative brand the code belongs to (already canonical). */
  brand: string;
  /** The normalized style code (uppercased, single-spaced). */
  styleCode: string;
  /** Exact comp query — the code returns the same product, not a fuzzy match. */
  compQuery: string;
  /** Auto-fillable eBay item specifics derived from the resolved product. */
  aspects: Record<string, string[]>;
  /** True when matched against the curated product table (vs. format-inferred). */
  exact: boolean;
}

interface StyleProduct {
  brand: string;
  model?: string; // product line, e.g. "Air Force 1 '07"
  department?: string; // Men / Women / Unisex Adult / ...
  type?: string; // Athletic / Sneakers / ...
}

/**
 * Curated style-code -> canonical product table. Keys are the canonical
 * (dash-form) code. Kept conservative: only fields we're confident about per
 * code, so we never fabricate a colorway. Extend as the catalog grows; unknown
 * codes still resolve a brand via format inference below.
 */
const STYLE_CODE_PRODUCTS: Record<string, StyleProduct> = {
  "CW2288-111": { brand: "Nike", model: "Air Force 1 '07", department: "Men", type: "Athletic" },
  "DD1391-100": { brand: "Nike", model: "Dunk Low", department: "Men", type: "Athletic" },
  "315122-111": { brand: "Nike", model: "Air Force 1 '07", department: "Men", type: "Athletic" },
  "555088-101": { brand: "Jordan", model: "Air Jordan 1 Retro High OG", department: "Men", type: "Athletic" },
  "DZ5485-612": { brand: "Jordan", model: "Air Jordan 1 Retro High OG", department: "Men", type: "Athletic" },
};

/** Normalize a raw style code: uppercase, trim, collapse internal whitespace. */
function cleanStyleCode(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Infer the brand from a style-code FORMAT alone, for codes not in the curated
 * table. Returns null when the string doesn't look like a recognized brand's
 * style code (so a generic "Style: Slim Fit" tag value isn't mistaken for one).
 */
function brandFromStyleFormat(code: string): string | null {
  const c = code.replace(/\s+/g, "");
  // Nike/Jordan: two letters + 4 digits + "-" + 3 digits (CW2288-111), or the
  // older all-numeric 6+3 form (555088-101).
  if (/^[A-Z]{2}\d{4}-\d{3}$/.test(c)) return "Nike";
  if (/^\d{6}-\d{3}$/.test(c)) return "Nike";
  // adidas: two letters + 4 digits, no dash (GZ5230, BB6168), or 1 letter + 5
  // digits (S79166).
  if (/^[A-Z]{2}\d{4}$/.test(c)) return "adidas";
  if (/^[A-Z]\d{5}$/.test(c)) return "adidas";
  // New Balance: M/W/U + 3-4 digits + optional trailing letters/digit (M990GL6).
  if (/^[MWU]\d{3,4}[A-Z]{0,3}\d?$/.test(c)) return "New Balance";
  return null;
}

/**
 * Resolve a style/model code to a canonical product for sneakers/streetwear.
 * Tries the curated product table first (exact: true), then brand-by-format
 * inference (exact: false). Returns null when the value isn't a recognizable
 * style code, so non-sneaker "style" fields (e.g. "Slim Fit") are left alone.
 *
 * `brandHint` (an already-canonical brand) disambiguates only when the format
 * is itself unrecognized — a known sneaker brand + a short alphanumeric code is
 * still treated as a code so its brand keys the comp search.
 */
export function resolveStyleCode(
  raw: string | null | undefined,
  brandHint?: string | null,
): StyleResolution | null {
  if (raw == null) return null;
  const code = cleanStyleCode(String(raw));
  if (code === "") return null;

  // Curated exact match (try both as-typed and dash-normalized spacing forms).
  const dashForm = code.replace(/\s+/g, "-");
  const product = STYLE_CODE_PRODUCTS[code] ?? STYLE_CODE_PRODUCTS[dashForm];
  if (product) {
    return buildResolution(dashForm, product, true);
  }

  // Format inference.
  const inferredBrand = brandFromStyleFormat(code);
  if (inferredBrand) {
    return buildResolution(code, { brand: inferredBrand }, false);
  }

  // Last resort: a known sneaker brand + a plausible alphanumeric code (letters
  // AND digits, no spaces) — treat as a code so comps key on it, but only when
  // the hint says this is footwear-ish so we don't grab "Style: Relaxed".
  if (brandHint && SNEAKER_BRANDS.has(brandHint) && /^[A-Z0-9-]{5,12}$/.test(code) && /[A-Z]/.test(code) && /\d/.test(code)) {
    return buildResolution(code, { brand: brandHint }, false);
  }

  return null;
}

const SNEAKER_BRANDS: ReadonlySet<string> = new Set([
  "Nike",
  "Jordan",
  "adidas",
  "New Balance",
  "PUMA",
  "Reebok",
  "ASICS",
  "Vans",
  "Converse",
]);

function buildResolution(
  styleCode: string,
  product: StyleProduct,
  exact: boolean,
): StyleResolution {
  const aspects: Record<string, string[]> = { Brand: [product.brand] };
  if (product.model) aspects["Model"] = [product.model];
  if (product.department) aspects["Department"] = [product.department];
  if (product.type) aspects["Type"] = [product.type];
  return {
    brand: product.brand,
    styleCode,
    // The style code is the single most precise comp key for sneakers — the
    // SAME product, regardless of how the title is phrased.
    compQuery: styleCode,
    aspects,
    exact,
  };
}

// ── Applying the canonical brand + style aspects to item specifics ─────────

/**
 * Fold the canonical brand and any style-resolved product aspects into a
 * listing's item specifics.
 *
 * - Brand: the canonical value WINS (replaces whatever the model emitted), since
 *   a misspelled Brand aspect is both a comp-filter miss and a buyer-trust hit.
 *   Forced unconditionally unless an `allowedNames` constraint excludes Brand.
 * - Other style aspects (Model/Department/Type): only applied when the resolved
 *   category permits the aspect (`allowedNames` contains it) AND the listing
 *   doesn't already have a non-empty value — we never clobber a model-determined
 *   specific, and never push an aspect the category would reject at publish.
 *   With no `allowedNames` constraint, these are skipped (safe default).
 *
 * Pure — returns a new map.
 */
export function applyCanonicalBrandAndStyle(
  specifics: Record<string, string[]>,
  brand: string | null,
  resolution: StyleResolution | null,
  allowedNames?: Iterable<string>,
): Record<string, string[]> {
  const out: Record<string, string[]> = { ...specifics };
  const allowed = allowedNames
    ? new Map([...allowedNames].map((n) => [n.toLowerCase(), n]))
    : null;
  const constrained = !!allowed && allowed.size > 0;
  const canonicalName = (name: string): string | null => {
    if (!constrained) return name;
    return allowed!.get(name.toLowerCase()) ?? null;
  };

  if (brand) {
    // Brand is universally accepted by apparel/shoe categories; force it even
    // when unconstrained, but honor an explicit constraint that omits it.
    const bn = constrained ? allowed!.get("brand") ?? null : "Brand";
    if (bn) out[bn] = [brand];
  }

  if (resolution) {
    for (const [name, values] of Object.entries(resolution.aspects)) {
      if (name.toLowerCase() === "brand") continue; // handled above
      // Product aspects only land when the category explicitly allows them.
      if (!constrained) continue;
      const cn = canonicalName(name);
      if (!cn) continue;
      const existing = out[cn];
      const hasValue = Array.isArray(existing) &&
        existing.some((v) => typeof v === "string" && v.trim() !== "");
      if (hasValue) continue; // never clobber a model-determined value
      out[cn] = values;
    }
  }

  return out;
}

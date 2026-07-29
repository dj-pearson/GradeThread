// US-2211: cross-check a transcribed RN/CA number against the brand KB.
//
// An RN (US FTC Registered Identification Number) or CA (its Canadian
// equivalent) is the one identity string on a care label issued by a government
// registry — a seller cannot type it into existence. ai-extract.ts and
// ai-tag-ocr.ts have transcribed it for a long time; brand_knowledge has carried
// a registered_numbers text[] since 00389; and NOTHING has ever compared the
// two. This module is that comparison.
//
// ── WHAT AN RN CAN AND CANNOT DO ───────────────────────────────────────────
//
// The brand corpus already worked this out, and the rules are the design:
//
//   * An RN names a COMPANY, not a brand. URBN's RN 66170 covers Urban
//     Outfitters, Anthropologie AND Free People (00466), so a match on it says
//     "one of these three" and can never pick between them.
//   * An RN is PUBLIC and a counterfeit prints it too (00447, 00465). A match is
//     corroboration; it is never proof, and this module never emits a verdict.
//   * An RN NEVER mints a brand. That is the decoder bar's fourth question —
//     which entity does the identifier name? — and an RN answers "the registrant",
//     which is frequently not the brand on the tag. See
//     vault/20-domain/brands/brand-kb-decoder-bar.md.
//
// ── "NO REFERENCE" IS NOT A NEGATIVE SIGNAL, AND USUALLY THAT IS ALL WE GET ──
//
// Exactly SIX brands in the entire KB carry a seeded RN (alo yoga, zara, urban
// outfitters, lucky brand, brooks brothers' pack-mate, and one handbag brand
// with two). Every other pack omitted them DELIBERATELY as unsourced — 00466
// records why: the FTC RN database is auth-gated, so most circulating RNs trace
// only to eBay listing text, and 00467 refuses two on exactly that ground.
//
// So an unmatched RN means "we have no reference for this", which is the normal
// case, and it must never read as "this RN is wrong". `no_reference` is a
// distinct outcome from `contradicts` for that reason, and nothing downstream
// may collapse them.
//
// Pure logic + one cached table read, so every rule above is unit-testable.

import { supabaseAdmin } from "./supabase.ts";
import { brandKey } from "./brand-normalize.ts";

/** A registry-issued number, split into its registry and its digits. */
export interface ParsedRegisteredNumber {
  /** "RN" (US FTC) or "CA" (Canadian). */
  kind: "RN" | "CA";
  /** Digits only, leading zeros stripped — the comparable part. */
  digits: string;
}

// A bare digit run is read as an RN: that is what the OCR tool asks for
// ("digits only or 'RN 12345' as printed") and CA numbers are, in practice,
// always printed with their prefix.
const NUMBER_RE = /^\s*(RN|CA)?\s*#?\s*(\d{2,7})\s*$/i;

/**
 * Parse "RN 106259" / "RN106259" / "rn# 106259" / "106259" / "CA 32054".
 * Returns null for anything that is not a plausible registry number — including
 * digit runs too short or too long to be one, which is what keeps a stray style
 * code from being cross-checked as an RN.
 */
export function parseRegisteredNumber(
  raw: string | null | undefined,
): ParsedRegisteredNumber | null {
  if (!raw) return null;
  const m = raw.match(NUMBER_RE);
  if (!m) return null;
  const digits = m[2].replace(/^0+/, "");
  if (digits.length === 0) return null;
  return { kind: (m[1] ?? "RN").toUpperCase() as "RN" | "CA", digits };
}

/** Canonical comparable form, e.g. `RN:106259`. */
export function registeredNumberKey(p: ParsedRegisteredNumber): string {
  return `${p.kind}:${p.digits}`;
}

/**
 * Expand one seeded `registered_numbers` entry into comparable keys. The 00389
 * column comment allows ranges as well as singletons, so "RN 96919-96925" is
 * accepted; ranges are capped so a typo'd or hostile row cannot expand into a
 * huge set (and a wide range is poor evidence anyway — a registrant's numbers
 * are not contiguous by any rule we can rely on).
 */
export const MAX_RANGE_EXPANSION = 200;

export function expandSeededNumber(entry: string): string[] {
  const range = entry.match(/^\s*(RN|CA)?\s*#?\s*(\d{2,7})\s*[-–]\s*(\d{2,7})\s*$/i);
  if (range) {
    const kind = (range[1] ?? "RN").toUpperCase() as "RN" | "CA";
    const lo = Number(range[2]);
    const hi = Number(range[3]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
    if (hi - lo + 1 > MAX_RANGE_EXPANSION) return [];
    const out: string[] = [];
    for (let n = lo; n <= hi; n++) out.push(`${kind}:${n}`);
    return out;
  }
  const single = parseRegisteredNumber(entry);
  return single ? [registeredNumberKey(single)] : [];
}

/** One brand a registry number resolves to. */
export interface RegisteredNumberOwner {
  brandKey: string;
  canonicalBrand: string;
}

/**
 * Build the reverse index: comparable key -> the brands whose KB row claims it.
 * A key mapping to MORE THAN ONE brand is the URBN case and is expected, not a
 * data error. Pure — exported so the index logic is testable without a DB.
 */
export function buildRegisteredNumberIndex(
  rows: Array<{
    brand_key: string;
    canonical_brand: string;
    registered_numbers: string[] | null;
  }>,
): Map<string, RegisteredNumberOwner[]> {
  const index = new Map<string, RegisteredNumberOwner[]>();
  for (const row of rows) {
    for (const entry of row.registered_numbers ?? []) {
      for (const key of expandSeededNumber(entry)) {
        const owners = index.get(key) ?? [];
        // A brand listing the same number twice must not appear twice.
        if (owners.some((o) => o.brandKey === row.brand_key)) continue;
        owners.push({
          brandKey: row.brand_key,
          canonicalBrand: row.canonical_brand,
        });
        index.set(key, owners);
      }
    }
  }
  return index;
}

// ── The verdict ─────────────────────────────────────────────────────────────

export type RegisteredNumberOutcome =
  /** The transcription was not a plausible registry number. */
  | "unparsed"
  /**
   * Parsed, but no KB row claims it. THE NORMAL CASE — six brands carry an RN.
   * Carries NO information either way and must never lower confidence.
   */
  | "no_reference"
  /** The number resolves to the brand on the tag. Corroboration, not proof. */
  | "corroborates"
  /**
   * Resolves to several brands, the declared one among them (a shared parent /
   * registrant, e.g. URBN). Consistent, and cannot disambiguate siblings.
   */
  | "ambiguous"
  /** Resolves ONLY to brands other than the declared one. A flag to review. */
  | "contradicts";

export interface RegisteredNumberAssessment {
  outcome: RegisteredNumberOutcome;
  /** Canonical comparable form, when it parsed. */
  normalized: string | null;
  /** Brands the number resolves to (empty unless corroborates/ambiguous/contradicts). */
  owners: RegisteredNumberOwner[];
  /**
   * US-2244: the registrant COMPANY, when an operator has resolved this number
   * (00502). A company is not a brand — this is display + reviewer context only
   * and, on its own, never changes the outcome.
   */
  registrant: string | null;
  /** One line a human reviewer can read without opening this file. */
  note: string;
}

/**
 * Classify a transcribed registry number against the index. DETERMINISTIC — no
 * model call — so the outcome is reproducible and explainable, which is the
 * whole reason to prefer this signal over asking a model whether a brand "looks
 * right". Never returns a brand to write: `owners` is evidence for a human or a
 * downstream flag, not a correction to apply.
 */
export function assessRegisteredNumber(
  raw: string | null | undefined,
  declaredBrand: string | null | undefined,
  index: Map<string, RegisteredNumberOwner[]>,
  /**
   * US-2244: registry_key -> registrant company name (00502). Optional so every
   * pre-2244 caller and test keeps working with a two-table-free index.
   */
  registrants?: Map<string, string>,
): RegisteredNumberAssessment {
  const parsed = parseRegisteredNumber(raw);
  if (!parsed) {
    return {
      outcome: "unparsed",
      normalized: null,
      owners: [],
      registrant: null,
      note: "Not a parseable RN/CA number.",
    };
  }
  const normalized = registeredNumberKey(parsed);
  const owners = index.get(normalized) ?? [];
  const registrant = registrants?.get(normalized) ?? null;
  if (owners.length === 0) {
    return {
      outcome: "no_reference",
      normalized,
      owners: [],
      registrant,
      note: registrant
        // The company is known but its labels are not established, so the
        // outcome stays no_reference: a registrant can never mint a brand.
        ? `${parsed.kind} ${parsed.digits} is registered to ${registrant}, ` +
          "whose brands have not been established. Context only — it cannot " +
          "confirm or contradict the brand on this item."
        : `${parsed.kind} ${parsed.digits} is not in the brand knowledge base. ` +
          "Carries no information — most brands have no seeded registry number.",
    };
  }

  const declaredKey = declaredBrand ? brandKey(declaredBrand) : "";
  const names = owners.map((o) => o.canonicalBrand).join(", ");

  // No brand to compare against: the number resolved, and that is all we know.
  if (!declaredKey) {
    return {
      outcome: owners.length > 1 ? "ambiguous" : "corroborates",
      normalized,
      owners,
      registrant,
      note:
        `${parsed.kind} ${parsed.digits} is registered to ${names}. ` +
        "No brand was declared to compare against.",
    };
  }

  const matches = owners.some((o) => o.brandKey === declaredKey);
  if (!matches) {
    return {
      outcome: "contradicts",
      normalized,
      owners,
      registrant,
      note:
        `${parsed.kind} ${parsed.digits} is registered to ${names}, not to the ` +
        "brand on this item. Corroboration only — an RN is public and can be " +
        "copied, and registrants change. Review rather than conclude.",
    };
  }
  if (owners.length > 1) {
    return {
      outcome: "ambiguous",
      normalized,
      owners,
      registrant,
      note:
        `${parsed.kind} ${parsed.digits} is shared across ${names} (one ` +
        "registrant, several brands), so it is CONSISTENT with this item but " +
        "cannot distinguish between them.",
    };
  }
  return {
    outcome: "corroborates",
    normalized,
    owners,
    registrant,
    note:
      `${parsed.kind} ${parsed.digits} is registered to ${names}, matching the ` +
      "brand on this item. Supporting signal only — never proof of authenticity.",
  };
}

// ── Sightings: learning which numbers actually arrive (US-2243) ─────────────
//
// The FTC registry has no API and no bulk download, so coverage cannot be bought
// or imported. It CAN be earned in arrival order: count the numbers real tags
// carry, and resolve those (US-2244). A few thousand items covers the registrants
// that actually walk into thrift stores, weighted by how often they do.
//
// Aggregate only — the table has one row per registry number, no owner column and
// no item reference (00501), so a sighting cannot say who photographed the tag.

/** Injectable writer — the real one is the 00501 RPC. Exists for tests. */
export type SightingWriter = (args: {
  registryKey: string;
  kind: "RN" | "CA";
  digits: string;
  declaredBrand: string | null;
}) => Promise<void>;

const defaultSightingWriter: SightingWriter = async (args) => {
  const { error } = await supabaseAdmin.rpc(
    "record_registered_number_sighting",
    {
      p_registry_key: args.registryKey,
      p_kind: args.kind,
      p_digits: args.digits,
      p_declared_brand: args.declaredBrand,
    },
  );
  if (error) throw error;
};

/**
 * Record a registry number we have NO reference for, so it can be resolved later.
 *
 * Writes for `no_reference` and nothing else: a number that already resolved
 * teaches us nothing, and an `unparsed` string is not a number at all. Never
 * throws — a grade must not fail over bookkeeping — so callers may `void` it.
 */
export async function recordRegisteredNumberSighting(
  assessment: RegisteredNumberAssessment,
  declaredBrand: string | null | undefined,
  write: SightingWriter = defaultSightingWriter,
): Promise<void> {
  if (assessment.outcome !== "no_reference" || !assessment.normalized) return;
  // `normalized` is a KEY ("RN:87370"), not a printed number, so it is split
  // rather than re-parsed — parseRegisteredNumber would reject the colon.
  const [kind, digits] = assessment.normalized.split(":");
  if ((kind !== "RN" && kind !== "CA") || !digits) return;
  const brand = (declaredBrand ?? "").trim();
  try {
    await write({
      registryKey: assessment.normalized,
      kind,
      digits,
      declaredBrand: brand === "" ? null : brand,
    });
  } catch (err) {
    console.error(
      "[RegisteredNumbers] sighting write failed (ignored):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Merging the resolved registry into the index (US-2244) ──────────────────

/** One resolved registrant row (00502). */
export interface RegistryRow {
  registry_key: string;
  company_name: string | null;
  brand_keys: string[] | null;
}

/**
 * Fold resolved registry rows into an existing brand-derived index.
 *
 * A registry row contributes an OWNER only for brand_keys that exist in
 * brand_knowledge: an operator types a company, and a company is not a brand, so
 * an unknown key must not invent one. A row with no usable brand_keys still
 * contributes its company to `registrants`, which surfaces in the note without
 * changing the outcome. Pure — testable with no DB.
 */
export function mergeRegistryRows(
  index: Map<string, RegisteredNumberOwner[]>,
  rows: readonly RegistryRow[],
  knownBrands: Map<string, string>,
): { index: Map<string, RegisteredNumberOwner[]>; registrants: Map<string, string> } {
  const registrants = new Map<string, string>();
  for (const row of rows) {
    const key = row.registry_key?.trim();
    if (!key) continue;
    const company = row.company_name?.trim();
    if (company) registrants.set(key, company);
    for (const rawBrand of row.brand_keys ?? []) {
      const bk = brandKey(rawBrand ?? "");
      const canonical = knownBrands.get(bk);
      if (!canonical) continue;
      const owners = index.get(key) ?? [];
      if (owners.some((o) => o.brandKey === bk)) continue;
      owners.push({ brandKey: bk, canonicalBrand: canonical });
      index.set(key, owners);
    }
  }
  return { index, registrants };
}

// ── The cached reverse index ────────────────────────────────────────────────

/** Everything a lookup needs: the brand index plus the resolved registrants. */
export interface RegisteredNumberContext {
  index: Map<string, RegisteredNumberOwner[]>;
  registrants: Map<string, string>;
}

const INDEX_TTL_MS = 5 * 60 * 1000;
let cached: { context: RegisteredNumberContext; expires: number } | null = null;

/** Test seam, and the post-resolve invalidation for the admin write path. */
export function resetRegisteredNumberIndex(): void {
  cached = null;
}

/**
 * Load (and cache) the reverse index plus the resolved registrants. Two small
 * reads: ~180 brand rows and the resolved-registry table, both whole — no GIN
 * index needed at this size.
 *
 * On any DB error BOTH maps are EMPTY, which degrades every lookup to
 * `no_reference`: the outcome that carries no information. A partial load is
 * deliberately not used, because a half-built index is exactly what could
 * manufacture a `contradicts` out of missing data.
 *
 * US-2244: the TTL is 5 minutes and the admin resolve route calls
 * resetRegisteredNumberIndex() on write, so a freshly resolved number starts
 * corroborating immediately on that instance and within the TTL everywhere else.
 */
export async function getRegisteredNumberContext(): Promise<
  RegisteredNumberContext
> {
  if (cached && cached.expires > Date.now()) return cached.context;
  try {
    const [brands, registry] = await Promise.all([
      supabaseAdmin
        .from("brand_knowledge")
        .select("brand_key, canonical_brand, registered_numbers"),
      supabaseAdmin
        .from("registered_number_registry")
        .select("registry_key, company_name, brand_keys"),
    ]);
    if (brands.error) throw brands.error;
    if (registry.error) throw registry.error;

    const brandRows = (brands.data ?? []) as Array<{
      brand_key: string;
      canonical_brand: string;
      registered_numbers: string[] | null;
    }>;
    const knownBrands = new Map(
      brandRows.map((b) => [b.brand_key, b.canonical_brand]),
    );
    const { index, registrants } = mergeRegistryRows(
      buildRegisteredNumberIndex(brandRows),
      (registry.data ?? []) as RegistryRow[],
      knownBrands,
    );
    const context: RegisteredNumberContext = { index, registrants };
    cached = { context, expires: Date.now() + INDEX_TTL_MS };
    return context;
  } catch (err) {
    console.error(
      "[RegisteredNumbers] index load failed — every lookup degrades to no_reference:",
      err instanceof Error ? err.message : String(err),
    );
    return { index: new Map(), registrants: new Map() };
  }
}

/** Back-compat shim for callers that only need the brand index. */
export async function getRegisteredNumberIndex(): Promise<
  Map<string, RegisteredNumberOwner[]>
> {
  return (await getRegisteredNumberContext()).index;
}

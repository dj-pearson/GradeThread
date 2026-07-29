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
): RegisteredNumberAssessment {
  const parsed = parseRegisteredNumber(raw);
  if (!parsed) {
    return {
      outcome: "unparsed",
      normalized: null,
      owners: [],
      note: "Not a parseable RN/CA number.",
    };
  }
  const normalized = registeredNumberKey(parsed);
  const owners = index.get(normalized) ?? [];
  if (owners.length === 0) {
    return {
      outcome: "no_reference",
      normalized,
      owners: [],
      note:
        `${parsed.kind} ${parsed.digits} is not in the brand knowledge base. ` +
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
    note:
      `${parsed.kind} ${parsed.digits} is registered to ${names}, matching the ` +
      "brand on this item. Supporting signal only — never proof of authenticity.",
  };
}

// ── The cached reverse index ────────────────────────────────────────────────

const INDEX_TTL_MS = 10 * 60 * 1000;
let cached: { index: Map<string, RegisteredNumberOwner[]>; expires: number } | null =
  null;

/** Test seam — drops the cache so a test can supply its own rows. */
export function resetRegisteredNumberIndex(): void {
  cached = null;
}

/**
 * Load (and cache) the reverse index. The whole corpus is ~180 brand rows of
 * which six carry a number, so this is one small filtered read rather than a
 * per-lookup query — and it needs no GIN index, which is why this story ships
 * without a migration. On any DB error the index is EMPTY, which degrades every
 * lookup to `no_reference`: the outcome that carries no information. A failed
 * read must never manufacture a contradiction.
 */
export async function getRegisteredNumberIndex(): Promise<
  Map<string, RegisteredNumberOwner[]>
> {
  if (cached && cached.expires > Date.now()) return cached.index;
  try {
    const { data, error } = await supabaseAdmin
      .from("brand_knowledge")
      .select("brand_key, canonical_brand, registered_numbers")
      .not("registered_numbers", "eq", "{}");
    if (error) throw error;
    const index = buildRegisteredNumberIndex(
      (data ?? []) as Array<{
        brand_key: string;
        canonical_brand: string;
        registered_numbers: string[] | null;
      }>,
    );
    cached = { index, expires: Date.now() + INDEX_TTL_MS };
    return index;
  } catch (err) {
    console.error(
      "[RegisteredNumbers] index load failed — every lookup degrades to no_reference:",
      err instanceof Error ? err.message : String(err),
    );
    return new Map();
  }
}

// Structured, checkable brand authentication tells (US-1768).
//
// The authenticity add-on (epic US-1767) must be GROUNDED and AUDITABLE: instead
// of asking the AI to "guess authentic", we store per-brand tells as structured,
// checkable rules — each a claim (what a genuine item shows), a check (how to
// verify it), an optional red flag (the counterfeit signal), a source, and a
// confidence. This file owns the tell SHAPE + validation/normalization, a
// code-side canonical SEED for the tier-1 brands, and the merge that makes the
// admin-curated DB rows authoritative over the seed.
//
// LIABILITY: a tell is an informational CHECK, never a verdict. Nothing here
// asserts authenticity; the scoring pass (US-1769) is confidence-capped and
// disclaimer-bounded, and low-confidence cases route to human review (US-1770).
//
// Storage: brand_knowledge.authentication_tells is a JSONB array (00389), so the
// structure lives in the JSON — no schema migration. Legacy free-text entries
// are tolerated on read (coerced to category 'other') and canonicalized on the
// next admin write.

import { supabaseAdmin } from "./supabase.ts";
import { brandKey, canonicalizeBrand } from "./brand-normalize.ts";

export type AuthTellCategory =
  | "stitching"
  | "hardware"
  | "tag"
  | "font"
  | "date_code"
  | "serial"
  | "stamp"
  | "material"
  | "construction"
  | "packaging"
  | "other";

export const AUTH_TELL_CATEGORIES: readonly AuthTellCategory[] = [
  "stitching", "hardware", "tag", "font", "date_code", "serial",
  "stamp", "material", "construction", "packaging", "other",
];

export function isAuthTellCategory(v: unknown): v is AuthTellCategory {
  return typeof v === "string" && (AUTH_TELL_CATEGORIES as readonly string[]).includes(v);
}

export interface AuthenticationTell {
  /** What kind of feature the tell is about. */
  category: AuthTellCategory;
  /** What a GENUINE item exhibits (the ground-truth claim). */
  claim: string;
  /** How to CHECK it on the item in hand (actionable, observable). */
  check: string;
  /** The counterfeit signal, when there's a clear one (optional). */
  redFlag?: string;
  /** Provenance for the claim. */
  source?: string;
  /** 0..1 — how reliable/discriminating this tell is. */
  confidence: number;
}

const MAX_TELLS = 60;
const MAX_STR = 600;
const DEFAULT_CONFIDENCE = 0.6;

function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_CONFIDENCE;
  return Math.min(1, Math.max(0, n));
}

function str(v: unknown, max = MAX_STR): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

/**
 * Tolerant coercion of ONE raw entry into a structured tell, or null if it
 * carries no usable claim. Accepts an already-structured object OR a legacy
 * free-text string (→ category 'other'). Used on READ so old data still works.
 */
export function coerceTell(raw: unknown): AuthenticationTell | null {
  if (typeof raw === "string") {
    const claim = str(raw);
    if (!claim) return null;
    return { category: "other", claim, check: "", confidence: DEFAULT_CONFIDENCE };
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  // Legacy shape used {tell, detail}; map it onto claim/check.
  const claim = str(o.claim ?? o.tell);
  if (!claim) return null;
  const check = str(o.check ?? o.detail ?? o.how);
  const redFlag = str(o.redFlag ?? o.red_flag);
  const source = str(o.source ?? o.source_url, 300);
  return {
    category: isAuthTellCategory(o.category) ? o.category : "other",
    claim,
    check,
    ...(redFlag ? { redFlag } : {}),
    ...(source ? { source } : {}),
    confidence: clampConfidence(o.confidence),
  };
}

/** Normalize a raw JSONB tells array into structured tells (read path). */
export function normalizeTells(raw: unknown): AuthenticationTell[] {
  if (!Array.isArray(raw)) return [];
  const out: AuthenticationTell[] = [];
  for (const entry of raw) {
    const t = coerceTell(entry);
    if (t) out.push(t);
    if (out.length >= MAX_TELLS) break;
  }
  return out;
}

/**
 * Strict-enough validation for the ADMIN WRITE path (US-1768 AC3): the body must
 * be an array, every entry must yield a non-empty claim, and the result is
 * CANONICALIZED (unknown categories → 'other', confidence clamped, strings
 * capped) so what lands in the DB is always well-formed structured data. A
 * non-array or an all-empty array is rejected so a typo can't wipe the column.
 */
export function validateTellsForWrite(
  raw: unknown,
): { ok: true; tells: AuthenticationTell[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "authentication_tells must be an array" };
  }
  if (raw.length > MAX_TELLS) {
    return { ok: false, error: `authentication_tells is capped at ${MAX_TELLS} entries` };
  }
  const tells: AuthenticationTell[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = coerceTell(raw[i]);
    if (!t) {
      return { ok: false, error: `authentication_tells[${i}] has no usable 'claim'` };
    }
    tells.push(t);
  }
  return { ok: true, tells };
}

// Normalized dedupe key for a claim (case/space-insensitive).
function claimKey(t: AuthenticationTell): string {
  return t.claim.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Merge admin-curated DB tells over the code seed: DB entries are authoritative
 * (they override a seed tell with the same claim); seed tells the admin hasn't
 * touched fill the gaps. Order: DB tells first (curated), then remaining seed.
 */
export function mergeTells(
  dbTells: AuthenticationTell[],
  seedTells: AuthenticationTell[],
): AuthenticationTell[] {
  const seen = new Set(dbTells.map(claimKey));
  const merged = [...dbTells];
  for (const s of seedTells) {
    if (!seen.has(claimKey(s))) {
      merged.push(s);
      seen.add(claimKey(s));
    }
    if (merged.length >= MAX_TELLS) break;
  }
  return merged;
}

// ── Canonical seed for tier-1 brands ────────────────────────────────────────
// Widely-documented, low-controversy tells as a STARTING POINT. Modest
// confidence + a 'needs review' source so a reviewer verifies them via the admin
// surface (the KB's AI-drafted-then-human-verified model). Keyed by brand_key.
const REVIEW_SRC = "seed:brand-authentication-tells (unverified — review in admin)";

export const CANONICAL_TELLS: Record<string, AuthenticationTell[]> = {
  louisvuitton: [
    {
      category: "date_code",
      claim:
        "Louis Vuitton items made 1980s–2020 carry a date code (letters = factory, digits = week/year) heat-stamped into the leather/lining, not a separate sewn-in label. LV replaced date codes with an embedded microchip from 2021.",
      check:
        "Locate the date code (inside pocket, under a tab, on a seam). Confirm it is stamped into the material, and that its format matches the era.",
      redFlag:
        "A separate white sewn-in tag with a barcode presented as an 'authenticity card' — LV never uses one.",
      source: REVIEW_SRC,
      confidence: 0.65,
    },
    {
      category: "stamp",
      claim:
        "The 'LOUIS VUITTON / made in ...' heat stamp has crisp, evenly-spaced serifs; the letter O is round and the two Ts of 'VUITTON' nearly touch.",
      check: "Inspect the stamp under good light; compare letter spacing/shape to a known-genuine reference.",
      source: REVIEW_SRC,
      confidence: 0.55,
    },
    {
      category: "hardware",
      claim: "Hardware is heavy solid brass with a clean engraved 'LOUIS VUITTON'; zippers are usually branded.",
      check: "Weigh the hardware in hand and read the engraving; genuine pieces feel substantial, not hollow/light.",
      source: REVIEW_SRC,
      confidence: 0.5,
    },
  ],
  coach: [
    {
      category: "serial",
      claim:
        "Coach leather goods have a creed patch with a style/serial number. Boutique (full-price) style numbers differ from outlet (MFF) numbers, which typically start with 'F'.",
      check:
        "Read the creed patch; cross-check the style-number format against boutique vs outlet patterns.",
      source: REVIEW_SRC,
      confidence: 0.6,
    },
    {
      category: "font",
      claim: "The creed text is evenly embossed with consistent spacing; older creeds omit a style number.",
      check: "Confirm the embossing depth/spacing is uniform and matches the item's era.",
      source: REVIEW_SRC,
      confidence: 0.5,
    },
  ],
  gucci: [
    {
      category: "serial",
      claim:
        "Gucci leather goods carry a leather tab with two rows of numbers — the style number over the supplier code — heat-stamped and evenly spaced.",
      check: "Find the interior leather tab; confirm two rows of cleanly-stamped digits with even spacing.",
      source: REVIEW_SRC,
      confidence: 0.6,
    },
    {
      category: "font",
      claim: "The 'GUCCI made in Italy' stamp with a trademark/registered mark is crisp; the interlocking GG is symmetric.",
      check: "Inspect the stamp and GG hardware; look for symmetric, evenly-weighted letterforms.",
      source: REVIEW_SRC,
      confidence: 0.5,
    },
  ],
};

/** Seed tells for a brand key (empty if we ship none). */
export function getSeedTells(brandKey: string): AuthenticationTell[] {
  return CANONICAL_TELLS[brandKey] ?? [];
}

/**
 * Effective structured tells for a brand: the admin-curated DB rows
 * (normalized) merged over the code seed. Best-effort — a DB hiccup falls back
 * to the seed so a consumer always gets grounded structure. Not the grading
 * prompt (that's US-1769); this is the shared read used by admin + the future
 * scoring pass.
 */
export async function getEffectiveTells(brandKey: string): Promise<AuthenticationTell[]> {
  const seed = getSeedTells(brandKey);
  try {
    const { data } = await supabaseAdmin
      .from("brand_knowledge")
      .select("authentication_tells")
      .eq("brand_key", brandKey)
      .maybeSingle();
    const dbTells = normalizeTells(
      (data as { authentication_tells?: unknown } | null)?.authentication_tells,
    );
    return mergeTells(dbTells, seed);
  } catch {
    return seed;
  }
}

/**
 * Effective tells for a raw brand NAME (as a listing/seller supplies it), by
 * canonicalizing it to a brand_key first. Returns [] for an unrecognizable
 * brand. Best-effort — the authenticity pass (US-1769) treats tells as optional
 * grounding, so a miss simply means an ungrounded assessment, never a failure.
 */
export async function getEffectiveTellsForBrand(
  rawBrand: string | null | undefined,
): Promise<AuthenticationTell[]> {
  const canonical = canonicalizeBrand(rawBrand ?? "");
  if (!canonical) return [];
  return await getEffectiveTells(brandKey(canonical));
}

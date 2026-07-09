// US-1712: deterministic tag-code decoder engine + Lululemon decoders.
//
// Some brands encode identity in the tag itself. When that code is legible we
// should DERIVE brand/style/size/colorway/season in CODE — not ask the AI to
// guess — which recovers identity even when the main size tag is cut off (the
// motivating Lululemon case). A decoder that matches returns a HIGH, provenance-
// tagged confidence; the caller (US-1713) lets a decoder result OVERRIDE the AI
// on conflict.
//
// The engine is DATA-DRIVEN: a DecoderSpec is a regex (named groups) + a
// field-map + optional named transforms. Adding a brand whose format is regular
// is a DATA change (a brand_style_codes row, US-1711 pack) reusing an existing
// transform — not a code change. Only a genuinely novel transform needs code.
// The in-code DEFAULT_DECODER_SPECS are the fallback (used before US-1718 seeds
// brand_style_codes), mirroring the DB-first-with-code-fallback pattern.
//
// Lululemon reality (verified): the "size dot" is NOT an encoded dot pattern —
// the numeric size is PRINTED in the center of the small circle in the pocket /
// waistband / neckband, so it is read by OCR of that region. The style number
// is W|M + style code + color-initial + "." + SSYY (season 01-04 + 2-digit
// year). The style NAME is not derivable from the number without Lululemon's
// private mapping, so the decoder yields gender/color-initial/season/year + the
// raw code (enough to confirm the brand and recover the season) and the size
// comes from the size dot or care tag.

// ── Result + spec shapes ────────────────────────────────────────────────────
export interface DecodeResult {
  /** Canonical brand the decoder is scoped to. */
  brand: string;
  /** Which decoder matched (style_number | size_dot | date_code | ...). */
  decoderKind: string;
  /** Raw normalized code that matched. */
  raw: string;
  /** Derived fields (only those the decoder could resolve). */
  gender?: string;
  styleCode?: string;
  size?: string;
  colorInitial?: string;
  colorway?: string;
  season?: string;
  year?: string;
  /** 0..1 — high on a clean match; feeds the confidence boost (US-1714). */
  confidence: number;
}

export type TransformId = "genderCode" | "seasonCode" | "year2to4" | "upper";

export interface DecoderSpec {
  brandKey: string;
  decoderKind: string;
  /** Regex source with named groups; matched case-insensitively, anchored. */
  pattern: string;
  /** Named group -> DecodeResult field. */
  fieldMap: Record<string, keyof DecodeResult>;
  /** DecodeResult field -> transform applied to the captured value. */
  transforms?: Partial<Record<string, TransformId>>;
  /** Confidence on a clean match. */
  confidence: number;
}

// ── Named transforms (the only code-side piece) ─────────────────────────────
const GENDER: Record<string, string> = { W: "Women", M: "Men" };
const SEASON: Record<string, string> = {
  "01": "Spring",
  "02": "Summer",
  "03": "Fall",
  "04": "Winter",
};

const TRANSFORMS: Record<TransformId, (v: string) => string> = {
  genderCode: (v) => GENDER[v.toUpperCase()] ?? v,
  seasonCode: (v) => SEASON[v] ?? v,
  // 2-digit year -> 20YY (these brands' codes are all post-2000).
  year2to4: (v) => (v.length === 2 ? `20${v}` : v),
  upper: (v) => v.toUpperCase(),
};

// ── In-code default specs (fallback until brand_style_codes is seeded) ──────
export const DEFAULT_DECODER_SPECS: DecoderSpec[] = [
  {
    brandKey: "lululemon",
    decoderKind: "style_number",
    // W|M + style code (3-5) + color initial (1 letter) + "." + SSYY.
    pattern:
      "^(?<gender>[WM])(?<style>[A-Z0-9]{3,5})(?<color>[A-Z])\\.(?<season>0[1-4])(?<year>\\d{2})$",
    fieldMap: {
      gender: "gender",
      style: "styleCode",
      color: "colorInitial",
      season: "season",
      year: "year",
    },
    transforms: {
      gender: "genderCode",
      season: "seasonCode",
      year: "year2to4",
      color: "upper",
    },
    confidence: 0.9,
  },
  {
    brandKey: "lululemon",
    decoderKind: "size_dot",
    // The size PRINTED in the pocket size-dot. Anchored to a lone number so it
    // only fires when the caller isolates the dot region (no false positives on
    // arbitrary OCR). Covers women's 0-16 and men's waist 26-44.
    pattern: "^\\s*(?<size>\\d{1,2})\\s*$",
    fieldMap: { size: "size" },
    confidence: 0.85,
  },
];

// ── Engine ──────────────────────────────────────────────────────────────────

/** Normalize a raw tag code for matching: trim + collapse internal whitespace.
 *  Case is handled by the case-insensitive regex flag. */
function normalizeCode(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Run ONE spec against a raw code. Returns null on no-match (never a false
 *  positive — the regex is anchored). */
export function runDecoderSpec(
  spec: DecoderSpec,
  raw: string,
): DecodeResult | null {
  const code = normalizeCode(raw);
  if (!code) return null;
  let re: RegExp;
  try {
    re = new RegExp(spec.pattern, "i");
  } catch {
    return null; // a malformed spec never matches (defensive)
  }
  const m = re.exec(code);
  if (!m || !m.groups) return null;

  const result: DecodeResult = {
    brand: canonicalForKey(spec.brandKey),
    decoderKind: spec.decoderKind,
    raw: code,
    confidence: spec.confidence,
  };
  for (const [group, value] of Object.entries(m.groups)) {
    if (value == null) continue;
    const field = spec.fieldMap[group];
    if (!field) continue;
    const tid = spec.transforms?.[group];
    const out = tid ? TRANSFORMS[tid](value) : value;
    // All mapped fields are string-typed on DecodeResult.
    (result as unknown as Record<string, unknown>)[field] = out;
  }
  return result;
}

/**
 * Decode a raw tag code for a brand. Tries the provided specs first (DB-seeded,
 * from the US-1711 pack), then the in-code defaults for that brand. Returns the
 * FIRST matching decoder's result, or null when nothing matches.
 */
export function decodeTagCode(
  brandKey: string,
  raw: string,
  dbSpecs: DecoderSpec[] = [],
): DecodeResult | null {
  if (!raw) return null;
  const specs = dbSpecs.length > 0
    ? dbSpecs
    : DEFAULT_DECODER_SPECS.filter((s) => s.brandKey === brandKey);
  for (const spec of specs) {
    const hit = runDecoderSpec(spec, raw);
    if (hit) return hit;
  }
  return null;
}

/** A small display-name map for the brands that ship an in-code decoder, so a
 *  DecodeResult carries the canonical brand without importing the alias table
 *  (avoids a cycle; brand-knowledge.ts owns full canonicalization). */
const KEY_TO_CANONICAL: Record<string, string> = {
  lululemon: "Lululemon",
};
function canonicalForKey(key: string): string {
  return KEY_TO_CANONICAL[key] ?? key;
}

// ── Decoder cross-checks (US-1768 AC2) ──────────────────────────────────────
// A decode result confirms FORMAT (the anchored regex matched). Authenticity
// wants CONSISTENCY: does what the code decoded to agree with the wider world
// and with what the listing claims? These are grounded, checkable flags — an
// impossible year, a code that predates the brand, a decoded field that
// contradicts the seller's stated attribute — never an authenticity verdict.

export type InconsistencySeverity = "info" | "warn" | "flag";

export interface DecodeInconsistency {
  /** Stable machine code (e.g. "date_in_future"). */
  code: string;
  severity: InconsistencySeverity;
  /** Human-readable, reviewer-facing explanation. */
  message: string;
}

export interface CrossCheckContext {
  /** The year "now" (injected so the check is deterministic/testable). */
  currentYear?: number;
  /** The brand's founding year — a code decoding to before it is impossible. */
  brandFoundedYear?: number;
  /** What the listing/seller claims, to compare against the decode. */
  claimedYear?: number | string;
  claimedGender?: string;
  claimedStyleCode?: string;
}

function toYear(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 1800 && n < 3000 ? n : null;
}

/**
 * Cross-check a decode result against known bounds + any listing claims.
 * Returns a (possibly empty) list of inconsistencies, most-severe first. Pure +
 * deterministic (time is injected via ctx.currentYear). Never throws.
 */
export function crossCheckDecodeResult(
  result: DecodeResult,
  ctx: CrossCheckContext = {},
): DecodeInconsistency[] {
  const out: DecodeInconsistency[] = [];
  const decodedYear = toYear(result.year);

  // Impossible dates — the strongest signal.
  if (decodedYear != null) {
    const now = Number.isFinite(ctx.currentYear) ? (ctx.currentYear as number) : null;
    if (now != null && decodedYear > now + 1) {
      out.push({
        code: "date_in_future",
        severity: "flag",
        message: `Decoded production year ${decodedYear} is in the future (now ${now}).`,
      });
    }
    if (ctx.brandFoundedYear && decodedYear < ctx.brandFoundedYear) {
      out.push({
        code: "date_before_brand",
        severity: "flag",
        message: `Decoded year ${decodedYear} predates ${result.brand}'s founding (${ctx.brandFoundedYear}).`,
      });
    }
    const claimedYear = toYear(ctx.claimedYear);
    if (claimedYear != null && claimedYear !== decodedYear) {
      out.push({
        code: "year_mismatch",
        severity: "warn",
        message: `Code decodes to ${decodedYear} but the listing claims ${claimedYear}.`,
      });
    }
  }

  if (ctx.claimedGender && result.gender) {
    const a = ctx.claimedGender.trim().toLowerCase();
    const b = result.gender.trim().toLowerCase();
    if (a && b && a !== b) {
      out.push({
        code: "gender_mismatch",
        severity: "warn",
        message: `Code decodes to ${result.gender} but the listing says ${ctx.claimedGender}.`,
      });
    }
  }

  if (ctx.claimedStyleCode && result.styleCode) {
    const a = ctx.claimedStyleCode.replace(/\s+/g, "").toUpperCase();
    const b = result.styleCode.replace(/\s+/g, "").toUpperCase();
    if (a && b && a !== b) {
      out.push({
        code: "style_code_mismatch",
        severity: "warn",
        message: `Code decodes style ${result.styleCode} but the listing claims ${ctx.claimedStyleCode}.`,
      });
    }
  }

  const rank: Record<InconsistencySeverity, number> = { flag: 0, warn: 1, info: 2 };
  return out.sort((x, y) => rank[x.severity] - rank[y.severity]);
}

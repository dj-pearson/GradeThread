// US-2246: the learned style-code → product index.
//
// No vendor sells a style-code database — every brand runs a private code
// namespace — but the market confirms codes for us constantly. US-1528 already
// searches live listings for a transcribed code and then discards what it found.
// This module keeps it, so the SECOND copy of a garment is identified from our own
// history instead of another model call.
//
// ── WHAT AN OBSERVATION IS AND IS NOT ──────────────────────────────────────────
//
// A row says "listings carrying this code were titled X". That is EVIDENCE, and
// weak evidence at one sighting: sellers copy each other's titles, and a code
// typed into a title is not a code read off a tag. So:
//
//   * confidence is derived from seen_count and CAPPED below a verified
//     brand_style_codes decoder hit (LEARNED_CONFIDENCE_CAP). A learned row may
//     hint; it can never overrule a decoder or a research identification.
//   * nothing here writes a brand. The brand is the anchor, not the output.
//   * only public listing text is stored — title + itemWebUrl. Never a seller id,
//     a buyer, or a price (00503).
//
// Pure normalize/score/precedence logic, so every rule above is unit-testable
// without eBay or the database.

import { supabaseAdmin } from "./supabase.ts";

/** Never let a learned hint reach the confidence of a verified decoder hit. */
export const LEARNED_CONFIDENCE_CAP = 0.55;

/** One confirmation is a coincidence; the curve rewards repetition, slowly. */
export const LEARNED_CONFIDENCE_BASE = 0.3;

/**
 * Comparable form of a style code: uppercased, every non-alphanumeric dropped.
 * "lw7d-vcs" and "LW7D VCS" are the same code; the raw form is kept separately
 * for display. Returns "" for anything with no alphanumerics to compare.
 */
export function normalizeStyleCode(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Confidence for a learned observation. Rises with independent confirmations and
 * flattens at the cap, so no amount of repetition promotes market chatter to the
 * standing of a decoder spec.
 */
export function learnedConfidence(seenCount: number): number {
  const n = Math.max(1, Math.floor(seenCount));
  const value = LEARNED_CONFIDENCE_BASE + 0.05 * (n - 1);
  return Math.min(LEARNED_CONFIDENCE_CAP, Math.round(value * 100) / 100);
}

export type ObservationSource = "market_verify" | "own_sale" | "admin";

export interface StyleCodeObservation {
  brandKey: string;
  styleCodeNorm: string;
  styleCodeRaw: string;
  productTitle: string;
  source: ObservationSource;
  evidenceUrl: string | null;
  seenCount: number;
}

/** Injectable writer — the real one is the 00503 RPC. Exists for tests. */
export type ObservationWriter = (
  o: Omit<StyleCodeObservation, "seenCount">,
) => Promise<void>;

const defaultWriter: ObservationWriter = async (o) => {
  const { error } = await supabaseAdmin.rpc("record_style_code_observation", {
    p_brand_key: o.brandKey,
    p_style_code_norm: o.styleCodeNorm,
    p_style_code_raw: o.styleCodeRaw,
    p_product_title: o.productTitle,
    p_source: o.source,
    p_evidence_url: o.evidenceUrl,
  });
  if (error) throw error;
};

/** A title long enough to name a product and short enough to be one. */
function usableTitle(title: string): boolean {
  const t = title.trim();
  return t.length >= 8 && t.length <= 200;
}

/**
 * Record what the market called a style code. Fire-and-forget: never throws, so
 * a failed write cannot break the identification pass that produced it.
 *
 * Titles are capped per call (MAX_TITLES_PER_OBSERVATION) — one search returning
 * ten near-identical titles is one piece of evidence, not ten.
 */
export const MAX_TITLES_PER_OBSERVATION = 3;

export async function recordStyleCodeObservations(args: {
  brandKey: string;
  styleCodeRaw: string | null;
  titles: readonly { title: string; url?: string | null }[];
  source?: ObservationSource;
  write?: ObservationWriter;
}): Promise<number> {
  const styleCodeNorm = normalizeStyleCode(args.styleCodeRaw);
  // A code needs some length to be an identity: two characters match everything.
  if (styleCodeNorm.length < 4) return 0;

  const write = args.write ?? defaultWriter;
  const seen = new Set<string>();
  let written = 0;
  for (const candidate of args.titles) {
    if (written >= MAX_TITLES_PER_OBSERVATION) break;
    const title = candidate.title.trim();
    if (!usableTitle(title)) continue;
    const dedupeKey = title.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    try {
      await write({
        brandKey: args.brandKey,
        styleCodeNorm,
        styleCodeRaw: (args.styleCodeRaw ?? "").trim(),
        productTitle: title,
        source: args.source ?? "market_verify",
        evidenceUrl: candidate.url?.trim() || null,
      });
      written++;
    } catch (err) {
      console.error(
        "[StyleCodes] observation write failed (ignored):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return written;
}

// ── Reading it back ─────────────────────────────────────────────────────────

export interface LearnedStyle {
  /** The most-confirmed product title for this code. */
  productTitle: string;
  seenCount: number;
  /** Capped confidence — see learnedConfidence(). */
  confidence: number;
  evidenceUrl: string | null;
}

/**
 * Pick the winning observation for a code. The most-confirmed title wins; a tie
 * yields NOTHING, because two equally-attested titles for one code means we do
 * not actually know which product it is. Pure.
 */
export function pickLearnedStyle(
  rows: readonly {
    product_title: string;
    seen_count: number;
    evidence_url: string | null;
  }[],
): LearnedStyle | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => b.seen_count - a.seen_count);
  const top = sorted[0]!;
  if (sorted.length > 1 && sorted[1]!.seen_count === top.seen_count) return null;
  return {
    productTitle: top.product_title,
    seenCount: top.seen_count,
    confidence: learnedConfidence(top.seen_count),
    evidenceUrl: top.evidence_url,
  };
}

// Listing-title noise that never names a product. Deliberately narrow: it strips
// condition/size/gender chatter and leaves model numbers alone, because "501" and
// "90" ARE the product.
const TITLE_NOISE = new Set([
  "nwt", "nwot", "euc", "vguc", "guc", "new", "used", "worn", "excellent",
  "condition", "size", "sz", "mens", "men", "mens'", "womens", "women",
  "unisex", "ladies", "kids", "youth", "boys", "girls",
  "xs", "s", "m", "l", "xl", "xxl", "xxxl", "small", "medium", "large",
  "free", "ship", "shipping", "nib", "rare", "vtg", "authentic", "genuine",
]);

const MAX_STYLE_NAME_WORDS = 6;

/**
 * Reduce a listing title to something usable as a style name: drop the brand, the
 * code itself, and listing chatter, then keep the first few remaining words.
 *
 * Returns null when fewer than two meaningful words survive — a one-word remnant
 * is not an identification, and offering it as one would be worse than silence.
 */
export function styleNameFromTitle(
  title: string,
  brand: string | null | undefined,
  styleCodeRaw: string | null | undefined,
): string | null {
  const codeNorm = normalizeStyleCode(styleCodeRaw);
  const brandTokens = new Set(
    (brand ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const kept: string[] = [];
  for (const rawToken of title.split(/\s+/)) {
    const bare = rawToken.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!bare) continue;
    const lower = bare.toLowerCase();
    if (brandTokens.has(lower)) continue;
    if (TITLE_NOISE.has(lower)) continue;
    if (codeNorm && normalizeStyleCode(bare) === codeNorm) continue;
    // Size shapes that TITLE_NOISE can't enumerate (32x34, W32, 10.5).
    if (/^\d{1,3}x\d{1,3}$/i.test(bare)) continue;
    if (/^[wl]\d{1,3}$/i.test(bare)) continue;
    kept.push(bare);
    if (kept.length >= MAX_STYLE_NAME_WORDS) break;
  }
  if (kept.length < 2) return null;
  return kept.join(" ");
}

/**
 * Look up what a style code has turned out to be. Brand-scoped when a brand is
 * known (codes collide across namespaces), falling back to the code alone.
 * Returns null on any DB error: a lookup gap must never block extraction.
 */
export async function lookupLearnedStyle(
  brandKey: string,
  styleCodeRaw: string | null | undefined,
): Promise<LearnedStyle | null> {
  const styleCodeNorm = normalizeStyleCode(styleCodeRaw);
  if (styleCodeNorm.length < 4) return null;
  try {
    let query = supabaseAdmin
      .from("style_code_observations")
      .select("product_title, seen_count, evidence_url")
      .eq("style_code_norm", styleCodeNorm)
      .order("seen_count", { ascending: false })
      .limit(5);
    if (brandKey) query = query.eq("brand_key", brandKey);
    const { data, error } = await query;
    if (error) throw error;
    return pickLearnedStyle(
      (data ?? []) as Array<
        { product_title: string; seen_count: number; evidence_url: string | null }
      >,
    );
  } catch (err) {
    console.error(
      "[StyleCodes] learned lookup failed (ignored):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

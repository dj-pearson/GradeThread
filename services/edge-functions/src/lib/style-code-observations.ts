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

import { decodeTagCode } from "./brand-decoders.ts";
import {
  pickStyleCodeName,
  type StyleCodeNameRow,
} from "./style-code-names.ts";
import { supabaseAdmin } from "./supabase.ts";

/** Never let a learned hint reach the confidence of a verified decoder hit. */
export const LEARNED_CONFIDENCE_CAP = 0.55;

/** Below this length a code is not an identity: two characters match anything.
 *  US-2690 exported it so the sweep applies the SAME floor as the read and
 *  write paths rather than a second copy of the number. */
export const MIN_STYLE_CODE_LENGTH = 4;

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
 * US-2714: the ONE key a code should be filed under, whatever spelling arrived.
 *
 * normalizeStyleCode only strips punctuation and case, so the four spellings of
 * a Lululemon garment — W6AMYS, LW6AMYS, W6AMYSP60417, LW6AMYSP60417 — became
 * four rows that never met. A consensus needs three agreeing titles per key, so
 * splitting one garment four ways can leave every fragment under the threshold
 * and yield no name from evidence that would have been enough.
 *
 * The decoder already knows the answer: a spec's `canonicalFrom` names the
 * groups that concatenate to the code's canonical spelling. This asks it, and
 * falls back to plain normalization when no decoder fires — which is every
 * brand that has no canonicalFrom, i.e. everything but Lululemon today.
 *
 * No database read: decodeTagCode falls back to DEFAULT_DECODER_SPECS when no
 * pack specs are supplied, and decoder-seed-parity_test.ts is what keeps those
 * honest against the seeded rows.
 */
export function canonicalStyleCode(
  brandKey: string | null | undefined,
  raw: string | null | undefined,
): string {
  const fallback = normalizeStyleCode(raw);
  const code = (raw ?? "").trim();
  if (!brandKey || !code) return fallback;
  // BOTH forms, and both are needed — a regression the sweep's own test caught.
  // The 2019+ pattern requires a literal "." that normalizeStyleCode strips, so
  // the trimmed raw has to be tried first; but a punctuated transcription like
  // "lw7d-vcs" matches no anchored pattern until the punctuation is gone, and
  // trying only the raw form made it split from "LW7DVCS" — two keys for one
  // code, which is the exact failure this function exists to remove.
  const hit = decodeTagCode(brandKey, code) ?? decodeTagCode(brandKey, fallback);
  return hit?.canonicalCode ? normalizeStyleCode(hit.canonicalCode) : fallback;
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

/** US-2783 added "discovery": a code the brand-first crawl FOUND, as opposed to
 *  one the sweep verified after somebody had already met it. Same evidence
 *  quality, different act, and the index is worth less if both arrive stamped
 *  market_verify. Must stay in step with the 00646 CHECK constraint. */
export type ObservationSource =
  | "market_verify"
  | "own_sale"
  | "admin"
  | "discovery";

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
  // US-2714: file it under the CANONICAL spelling, not the transcribed one.
  const styleCodeNorm = canonicalStyleCode(args.brandKey, args.styleCodeRaw);
  // A code needs some length to be an identity: two characters match everything.
  if (styleCodeNorm.length < MIN_STYLE_CODE_LENGTH) return 0;

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
  /**
   * US-2691: a RESOLVED name from 00628 — already a product name rather than a
   * listing title. When this is set the caller must use it AS IS: running it
   * through styleNameFromTitle would trim words off an answer that was already
   * the answer.
   */
  resolvedName?: string;
  /** Which 00628 source won. Provenance for the UI and the logs. */
  resolvedSource?: string;
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
 * US-2691: the resolved name for a code from 00628, precedence applied.
 * Returns null when no source has answered yet, or on any DB error.
 */
async function lookupResolvedName(
  brandKey: string,
  styleCodeNorm: string,
): Promise<LearnedStyle | null> {
  try {
    let query = supabaseAdmin
      .from("style_code_names")
      .select("name, source, supporting, confidence, evidence_url, rejected_at")
      .eq("style_code_norm", styleCodeNorm)
      .is("rejected_at", null);
    if (brandKey) query = query.eq("brand_key", brandKey);
    const { data, error } = await query;
    if (error) throw error;
    const pick = pickStyleCodeName((data ?? []) as StyleCodeNameRow[]);
    if (!pick) return null;
    return {
      productTitle: pick.name,
      resolvedName: pick.name,
      resolvedSource: pick.source,
      seenCount: pick.supporting,
      confidence: pick.confidence,
      evidenceUrl: pick.evidenceUrl,
    };
  } catch (err) {
    console.error(
      "[StyleCodes] resolved-name lookup failed (ignored):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
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
  // US-2714: ask under the same canonical spelling the write path files under.
  const styleCodeNorm = canonicalStyleCode(brandKey, styleCodeRaw);
  if (styleCodeNorm.length < MIN_STYLE_CODE_LENGTH) return null;

  // US-2691: a RESOLVED name wins outright. The observation scan below is what
  // runs before any source has answered for this code, and it reads back one
  // seller's title trimmed by regex — strictly worse than any 00628 row.
  const resolved = await lookupResolvedName(brandKey, styleCodeNorm);
  if (resolved) return resolved;

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

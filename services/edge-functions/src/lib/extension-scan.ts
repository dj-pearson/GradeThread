// US-2237: the search-page triage scan — PURE half.
//
// Extracted out of routes/public-grading.ts so the decision logic can be
// type-checked and unit-tested WITHOUT the route's dependency graph (hono,
// supabase, the eBay client). That graph is what made this logic effectively
// untestable outside CI; the repo already keeps its decision math in lib/ for
// exactly this reason (condition-discrepancy, price-fairness, scout-decision).
//
// The route keeps the I/O: rate limiting, the category lookup, and the eBay comp
// fetch. Everything below is a pure function of what it hands back.
//
// ── WHAT THE SCAN IS ─────────────────────────────────────────────────────────
//
// The extension's overlay reads ONE listing, after a click, on a detail page.
// The choice between twelve listings happens a screen earlier, on the results
// grid, where it showed nothing.
//
// This makes the grid readable WITHOUT a Vision call per card. Grading 24 cards
// would be 24 Vision calls per scroll. Instead it uses only the two signals
// already printed on the card — the seller's CLAIMED condition and the asking
// price — and answers a narrower, honest question: "for what the seller SAYS it
// is, is this price high or low?"
//
// It is NOT a grade, and the response shape enforces that: no photo is fetched,
// so there is no overallScore/gradeTier/confidence field for a client to render.
// A number on a result card that a shopper read as a GradeThread grade would be
// the worst possible outcome of this feature.

import { claimedConditionToGrade } from "./condition-discrepancy.ts";
import { type FairBand, type FairnessVerdict, parsePriceCents, priceFairness } from "./price-fairness.ts";
import { type CompStats, gradeToConditionId } from "./repricing.ts";

/** Cards accepted in one scan request. The client caps too; this is the authority. */
export const MAX_SCAN_CARDS = 24;

/**
 * Distinct claimed-condition buckets we'll spend an eBay Browse call on. Real
 * grids cluster into 2-3 (a "used" bulk plus a few NWT); the cap bounds the
 * worst case where a page happens to span every condition tier.
 */
export const MAX_SCAN_COMP_BUCKETS = 3;

/** Fewer than this many photos on a result card means no read could be confident. */
export const SCAN_THIN_PHOTO_FLOOR = 3;

export const SCAN_DISCLAIMER =
  "Based on the seller's stated condition and asking price only — no photos were analysed. " +
  "Open a listing for a GradeThread condition read.";

export interface ScanCardInput {
  /** Caller-assigned id echoed back so the client can match rows to DOM nodes
   *  without relying on array order. */
  key: string;
  title: string;
  priceText: string;
  conditionText: string;
  photoCount: number | null;
}

export interface ScanCardResult {
  key: string;
  /** The SELLER's claimed condition on our 1-10 scale, or null when the card
   *  didn't print one / we don't recognise it. Never our own read. */
  claimedGrade: number | null;
  priceCents: number | null;
  fairness: FairnessVerdict;
  deltaPct: number | null;
  /** true when the card shows too few photos to support any confident read. */
  thinPhotos: boolean;
}

/**
 * Validate + cap the scan body. Cards missing a key are dropped rather than
 * failing the request: one malformed card on a 24-card grid should degrade that
 * card, not blank the whole page.
 */
export function parseScanBody(
  body: unknown,
): { ok: true; cards: ScanCardInput[]; query: string; brand: string } | { ok: false; error: string } {
  const b = (body ?? {}) as { cards?: unknown; query?: unknown; brand?: unknown };
  if (!Array.isArray(b.cards)) return { ok: false, error: "Provide a cards array." };
  const cards: ScanCardInput[] = [];
  for (const raw of b.cards) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key.trim().slice(0, 200) : "";
    if (!key) continue;
    const photoCount = typeof r.photoCount === "number" && Number.isFinite(r.photoCount)
      ? Math.max(0, Math.min(99, Math.round(r.photoCount)))
      : null;
    cards.push({
      key,
      title: typeof r.title === "string" ? r.title.trim().slice(0, 200) : "",
      priceText: typeof r.priceText === "string" ? r.priceText.trim().slice(0, 40) : "",
      conditionText: typeof r.conditionText === "string" ? r.conditionText.trim().slice(0, 60) : "",
      photoCount,
    });
    if (cards.length >= MAX_SCAN_CARDS) break;
  }
  if (cards.length === 0) return { ok: false, error: "Provide at least one card." };
  return {
    ok: true,
    cards,
    query: typeof b.query === "string" ? b.query.trim().slice(0, 200) : "",
    brand: typeof b.brand === "string" ? b.brand.trim().slice(0, 80) : "",
  };
}

/**
 * Bucket cards by the eBay conditionId their claimed condition maps to. This is
 * what makes the endpoint affordable: comps are fetched once per BUCKET, and
 * real grids collapse to two or three.
 *
 * A card whose condition we can't read is NOT dropped — only eBay reliably
 * prints a condition on the result card, so dropping them would make scan mode
 * an eBay-only feature. It buckets under gradeToConditionId(null) ("Used", the
 * safe default) and its per-card result keeps claimedGrade:null, so the caller
 * can say "vs typical used" instead of implying the seller claimed anything.
 *
 * Buckets come back ordered by size so the MAX_SCAN_COMP_BUCKETS cap spends the
 * comp calls on the conditions covering the most cards.
 */
export function bucketScanCards(
  cards: ScanCardInput[],
  marketplace: string | null,
): Array<{ conditionId: string; keys: string[] }> {
  const byCondition = new Map<string, string[]>();
  for (const card of cards) {
    const claimed = claimedConditionToGrade(card.conditionText, marketplace);
    const conditionId = gradeToConditionId(claimed);
    const entry = byCondition.get(conditionId);
    if (entry) entry.push(card.key);
    else byCondition.set(conditionId, [card.key]);
  }
  return Array.from(byCondition, ([conditionId, keys]) => ({ conditionId, keys }))
    .sort((a, b) => b.keys.length - a.keys.length);
}

/** The comp distribution one condition bucket is priced against (stats + currency). */
export type ScanCompStats = CompStats & { currency: string };

/**
 * Turn one bucket's comp stats into a fair band AT a specific claimed grade.
 *
 * INJECTED rather than imported: the real implementation is valueRangeFromStats
 * (lib/condition-value.ts), which pulls in the eBay client and with it the whole
 * network graph. Taking it as a parameter — the same shape ai-extract.ts uses
 * for its fetcher — keeps this module dependency-light enough to type-check and
 * unit-test on its own, which is the entire reason it was extracted.
 *
 * Returns null when the comps are too thin to price honestly.
 */
export type BandBuilder = (stats: ScanCompStats, claimedGrade: number | null) => FairBand | null;

/**
 * Assemble the per-card verdicts from the (already fetched) per-bucket comp
 * stats. This is why a 24-card scan costs three network calls instead of 24.
 *
 * Stats are shared per condition bucket but the band is positioned PER CARD, so
 * two cards in the same "Used" bucket that claim "very good" and "fair" get
 * different bands off one eBay call. A band the builder declines to produce
 * (thin comps) yields 'unknown' rather than a fabricated verdict.
 */
export function scanCardResults(
  cards: ScanCardInput[],
  marketplace: string | null,
  statsByKey: Map<string, ScanCompStats>,
  buildBand: BandBuilder,
): ScanCardResult[] {
  return cards.map((card) => {
    const claimedGrade = claimedConditionToGrade(card.conditionText, marketplace);
    const priceCents = parsePriceCents(card.priceText);
    const stats = statsByKey.get(card.key);
    const band = stats ? buildBand(stats, claimedGrade) : null;
    const fairness = priceFairness(priceCents, band);
    return {
      key: card.key,
      claimedGrade,
      priceCents,
      fairness: fairness.verdict,
      deltaPct: fairness.deltaPct,
      thinPhotos: card.photoCount != null && card.photoCount < SCAN_THIN_PHOTO_FLOOR,
    };
  });
}

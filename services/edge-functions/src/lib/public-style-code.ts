// US-2747: what the public style-code lookup answers, and what it refuses to.
//
// A reseller holding a garment types the code off its tag. This turns that
// string into either an answer with its provenance, or an honest blank — and
// the blank is the common case for a long time, because the index fills at the
// speed of the market sweep rather than the speed of wanting it to be full.
//
// ── WHY THE SHAPE IS THIS SHAPE ─────────────────────────────────────────────
//
// It carries WHERE the name came from, not just the name. That is the whole
// difference between this and a copied list: a reseller can see that a name was
// confirmed by eleven listings, or corrected by the person holding the garment,
// and decide how much to trust it. A bare name is worth less and is not ours.
//
// `indexable` is computed HERE rather than in the renderer, so the page and the
// sitemap cannot disagree about which URLs exist — a sitemapped URL that
// renders noindex is the specific contradiction that gets a whole section
// ignored (US-2748).
//
// Pure shaping, so the rules are testable without the database.

import { type DecodeResult } from "./brand-decoders.ts";
import {
  type NameSource,
  type ResolvedStyleCodeName,
} from "./style-code-names.ts";

/** The brand this surface answers for today.
 *
 *  Codes collide across brand namespaces, and the URL a reseller lands on
 *  carries only a code — so serving every brand from one code needs a rule for
 *  who wins a collision, which is a product decision rather than a code change.
 *  Lululemon is the one brand with a decoder, so it is the one brand where a
 *  bare code is unambiguous enough to answer. Widening this is US-2750's
 *  question, not a constant to quietly edit. */
export const PUBLIC_LOOKUP_BRAND_KEY = "lululemon";
export const PUBLIC_LOOKUP_BRAND = "Lululemon";

export interface PublicStyleCode {
  /** The canonical style number. This is the URL. */
  code: string;
  /** Exactly what the visitor typed, echoed so the page can say so. */
  requested: string;
  /** False when `requested` normalizes to something other than `code` — the
   *  route redirects rather than serving the same answer at two URLs. */
  canonical: boolean;
  brand: string;
  /** The resolved product name, or null when nothing has answered yet. */
  name: string | null;
  /** Which source won. Null alongside a null name. */
  source: NameSource | null;
  /** How many independent confirmations stand behind it. */
  supporting: number | null;
  evidenceUrl: string | null;
  /** What the code itself grounds, independent of any name: gender, and the
   *  season and year where the generation carries them. Present even when the
   *  name is not, which is why an unnamed code is still worth a page. */
  decoded: {
    gender: string | null;
    season: string | null;
    year: string | null;
    decoderKind: string;
  } | null;
  /** Indexable ONLY with a resolved name. See the header. */
  indexable: boolean;
}

/**
 * Shape the answer. Pure: the caller does the reads.
 *
 * `resolved` is null when no unrejected style_code_names row exists, which is
 * the honest blank rather than a guess.
 */
export function publicStyleCode(args: {
  requested: string;
  canonicalCode: string;
  resolved: ResolvedStyleCodeName | null;
  decode: DecodeResult | null;
}): PublicStyleCode {
  const { requested, canonicalCode, resolved, decode } = args;
  const name = resolved?.name?.trim() || null;
  return {
    code: canonicalCode,
    requested,
    canonical: normalizeRequested(requested) === canonicalCode,
    brand: PUBLIC_LOOKUP_BRAND,
    name,
    source: name ? resolved!.source : null,
    supporting: name ? resolved!.supporting : null,
    evidenceUrl: name ? resolved!.evidenceUrl : null,
    decoded: decode
      ? {
        gender: decode.gender ?? null,
        season: decode.season ?? null,
        year: decode.year ?? null,
        decoderKind: decode.decoderKind,
      }
      : null,
    // A page with no name has nothing a search result could usefully show, and
    // thousands of them is thin content that costs the whole domain rather than
    // just this section.
    indexable: name !== null,
  };
}

// ── US-2749: what a visitor may submit, and when the crowd has an answer ────

/** Comparable form of a submitted name: lowercased, punctuation collapsed.
 *  "Scuba Oversized Half-Zip" and "scuba oversized half zip" are one answer,
 *  and counting them apart would mean nobody ever reaches the bar. */
export function normalizeSubmittedName(raw: string): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The longest a product name can plausibly be. Past this it is a sentence, a
 *  listing title, or someone pasting the page. */
const MAX_SUBMITTED_NAME = 80;

/**
 * Is this worth recording? Returns null when it is, or the reason it is not.
 *
 * Deliberately strict about SHAPE and silent about intent: this is an
 * unauthenticated endpoint, so the only defences that hold are ones that do not
 * depend on knowing who is calling.
 */
export function submissionRefusal(name: string): string | null {
  const trimmed = (name ?? "").trim();
  if (trimmed.length < 3) return "That is too short to be a product name";
  if (trimmed.length > MAX_SUBMITTED_NAME) {
    return "That is longer than a product name";
  }
  // A product name is at least two words — one word is a category ("Hoodie"),
  // the same bar the seller-correction trigger applies.
  if (trimmed.split(/\s+/).filter(Boolean).length < 2) {
    return "A product name is at least two words";
  }
  // A link is never a product name, and a submission box that accepts one is a
  // link-spam target the moment it is discovered.
  if (/https?:\/\/|www\.|\.(com|net|org|io|co)\b/i.test(trimmed)) {
    return "Please give the product name only, without a link";
  }
  if (normalizeSubmittedName(trimmed).length < 3) {
    return "That is not a product name";
  }
  return null;
}

export interface SubmittedNameRow {
  name: string;
  name_norm: string;
  submissions: number;
}

/**
 * The name the crowd agrees on for one code, or null.
 *
 * Null in three cases, all of them honest: nobody reached the corroboration
 * bar, or two names reached it equally — two equally-attested answers for one
 * garment is not an answer — or there is nothing to pick from. Pure.
 */
export function pickSubmittedName(
  rows: readonly SubmittedNameRow[],
  minSubmissions: number,
): SubmittedNameRow | null {
  const eligible = rows.filter((r) => r.submissions >= minSubmissions);
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort((a, b) => b.submissions - a.submissions);
  const top = sorted[0]!;
  if (sorted.length > 1 && sorted[1]!.submissions === top.submissions) return null;
  return top;
}

/** A style_code_names row as the sitemap read returns it. */
export interface SitemapCandidateRow {
  style_code_norm: string;
  updated_at?: string | null;
  name?: string | null;
  rejected_at?: string | null;
}

/**
 * The codes that belong in sitemap-style-codes.xml.
 *
 * Exported and pure so it can be driven by the SAME fixtures as
 * publicStyleCode, which is the only way to know the two agree. A URL listed
 * here whose page renders noindex is the specific contradiction that gets a
 * whole section ignored, and it cannot be caught by reading either half alone.
 *
 * One entry per CODE, not per row: several sources can name one garment and a
 * sitemap wants URLs. The newest row wins the lastmod because that is when the
 * answer last changed.
 */
export function indexableCodes(
  rows: readonly SitemapCandidateRow[],
): Array<{ code: string; updated_at: string | null }> {
  const newest = new Map<string, string | null>();
  for (const row of rows) {
    // The SAME two conditions publicStyleCode applies: not rejected, and an
    // actual name. `name` is optional on this shape because the sitemap query
    // need not select it — when it is absent the row's existence is the claim,
    // and pickStyleCodeName has already dropped the blanks upstream.
    if (row.rejected_at) continue;
    if (row.name !== undefined && !(row.name ?? "").trim()) continue;
    const code = row.style_code_norm;
    if (!code) continue;
    const prior = newest.get(code);
    const at = row.updated_at ?? null;
    if (prior === undefined || (at !== null && (prior === null || at > prior))) {
      newest.set(code, at);
    }
  }
  return [...newest.entries()].map(([code, updated_at]) => ({ code, updated_at }));
}

/** Uppercase + strip punctuation, matching normalizeStyleCode. Kept local so
 *  this module stays free of the supabase import chain. */
function normalizeRequested(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** How a source reads to a reseller who has never seen our vocabulary. */
export function sourceLabel(source: NameSource | null): string | null {
  switch (source) {
    case "official":
      return "Lululemon's own product name";
    case "admin":
      return "Confirmed by GradeThread";
    case "seller":
      return "Corrected by a seller holding the garment";
    case "consensus":
      return "Agreed across marketplace listings";
    default:
      return null;
  }
}

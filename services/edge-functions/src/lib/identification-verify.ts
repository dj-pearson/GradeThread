// US-1528: eBay Browse cross-reference for the research-tier identification
// (US-1527). After extract proposes a named style, we search live eBay
// listings for "brand + style_code" / "brand + identified_style" and score
// AGREEMENT between the top result titles and the proposed identification —
// cheap token overlap, no extra AI call. High agreement upgrades the ID to
// "Verified on eBay" (and boosts the stored confidence); ZERO hits demotes it;
// hits that disagree just leave it unverified. Recurring title tokens are
// harvested as market_title_keywords (colorways, fabric tech, fit descriptors)
// for title SEO (US-1529).
//
// Runs in the extract endpoint's BACKGROUND enrichment block (alongside
// runEbayAspectsPhase) — the foreground Add flow pays no latency, and every
// failure degrades silently (the ID simply stays unverified). Uses the
// app-level (client-credentials) Browse token; when eBay app creds are not
// configured, the token request throws and we skip.

import type { ResearchIdentification } from "./ai-extract.ts";
import { searchBrowseComps } from "./ebay-client.ts";
import { supabaseAdmin } from "./supabase.ts";

/** Fraction of the style's tokens a title must contain to count as agreeing. */
export const TITLE_AGREE_TOKEN_FRACTION = 0.6;
/** Fraction of titles that must agree for the identification to verify. */
export const VERIFY_MIN_AGREEMENT = 0.5;
/** Confidence boost on verification / demotion on zero market hits. */
export const VERIFY_CONFIDENCE_DELTA = 0.2;
/** A harvested keyword must appear in at least this fraction of titles. */
const KEYWORD_MIN_TITLE_FRACTION = 0.4;
const MAX_HARVESTED_KEYWORDS = 8;

// Generic listing-title noise that says nothing about WHICH product this is.
const TITLE_STOPWORDS = new Set([
  "the", "and", "for", "with", "new", "nwt", "nwot", "euc", "vguc", "guc",
  "mens", "men", "womens", "women", "unisex", "ladies", "kids",
  "size", "sz", "small", "medium", "large", "xlarge", "xsmall",
  "authentic", "genuine", "rare", "vintage", "euc",
  "black", "white", "blue", "navy", "gray", "grey", "green", "red", "brown",
  "pink", "purple", "beige", "tan", "orange", "yellow", "cream", "olive",
]);

/** Lowercase alphanumeric tokens; keeps numbers ("501") and codes ("lw7dvcs"). */
export function tokenizeTitle(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function isSizeishToken(t: string): boolean {
  if (/^(x{0,3}[sml]|xs|xl|xxl|xxxl)$/.test(t)) return true;
  // Bare 1–2 digit numbers are almost always sizes in listing titles. Longer
  // digit runs (501, 511) are legitimate style identifiers — keep those.
  if (/^\d{1,2}$/.test(t)) return true;
  return false;
}

export interface AgreementScore {
  /** Fraction of titles agreeing with the identification (0 when no titles). */
  score: number;
  /** Recurring non-noise tokens across titles — colorways, fabric tech, fit. */
  keywords: string[];
}

/**
 * Pure token-overlap agreement between the proposed identification and live
 * listing titles. A title "agrees" when it contains most of the style's
 * tokens; keywords are tokens recurring across titles that are NOT already
 * part of the brand/style (i.e. what the market adds: colorway names, fabric
 * tech, fit descriptors).
 */
export function scoreTitleAgreement(args: {
  brand: string | null;
  identifiedStyle: string;
  titles: string[];
}): AgreementScore {
  const titles = args.titles.filter((t) => t.trim() !== "");
  if (titles.length === 0) return { score: 0, keywords: [] };

  const brandTokens = new Set(tokenizeTitle(args.brand ?? ""));
  const styleTokens = tokenizeTitle(args.identifiedStyle).filter(
    (t) => !TITLE_STOPWORDS.has(t) && !brandTokens.has(t),
  );
  if (styleTokens.length === 0) return { score: 0, keywords: [] };

  let agreeing = 0;
  const tokenTitleCounts = new Map<string, number>();
  for (const title of titles) {
    const tokens = new Set(tokenizeTitle(title));
    const matched = styleTokens.filter((t) => tokens.has(t)).length;
    if (matched / styleTokens.length >= TITLE_AGREE_TOKEN_FRACTION) agreeing++;
    for (const t of tokens) {
      tokenTitleCounts.set(t, (tokenTitleCounts.get(t) ?? 0) + 1);
    }
  }

  const styleTokenSet = new Set(styleTokens);
  const minCount = Math.max(2, Math.ceil(titles.length * KEYWORD_MIN_TITLE_FRACTION));
  const keywords = [...tokenTitleCounts.entries()]
    .filter(([t, n]) =>
      n >= minCount &&
      !TITLE_STOPWORDS.has(t) &&
      !brandTokens.has(t) &&
      !styleTokenSet.has(t) &&
      !isSizeishToken(t)
    )
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_HARVESTED_KEYWORDS)
    .map(([t]) => t);

  return { score: agreeing / titles.length, keywords };
}

export interface VerificationDecision {
  /** true = "Verified on eBay"; false = unverified (default / refuted). */
  verified: boolean;
  /** The identification confidence after the market adjustment. */
  adjustedConfidence: number;
  /** Harvested market title keywords (empty when unverified with no signal). */
  keywords: string[];
}

/**
 * Pure decision: how the market evidence adjusts the identification.
 * - agreement ≥ VERIFY_MIN_AGREEMENT → verified, confidence boosted;
 * - ZERO market hits for a supposedly-known product → demoted, unverified;
 * - hits that disagree → unverified, confidence untouched (the search may
 *   simply have been noisy — absence of agreement is not refutation).
 */
export function decideVerification(args: {
  research: Pick<ResearchIdentification, "confidence">;
  titlesSearched: number;
  agreement: AgreementScore;
}): VerificationDecision {
  const base = args.research.confidence;
  if (args.titlesSearched === 0) {
    return {
      verified: false,
      adjustedConfidence: Math.max(0.05, base - VERIFY_CONFIDENCE_DELTA),
      keywords: [],
    };
  }
  if (args.agreement.score >= VERIFY_MIN_AGREEMENT) {
    return {
      verified: true,
      adjustedConfidence: Math.min(0.95, base + VERIFY_CONFIDENCE_DELTA),
      keywords: args.agreement.keywords,
    };
  }
  return { verified: false, adjustedConfidence: base, keywords: args.agreement.keywords };
}

// Injectable Browse seam so tests exercise the full verify flow with fixture
// titles instead of the live API.
export const _browse = {
  search: async (q: string, brand: string | null): Promise<string[]> => {
    const res = await searchBrowseComps({
      q,
      brand: brand ?? undefined,
      limit: 10,
    });
    return (res.items ?? []).map((i) => i.title).filter((t) => t !== "");
  },
};

/**
 * Background verification step: search Browse for the identification, decide,
 * and persist onto the item — attributes.identification_verified ("true" /
 * "false") + attributes.market_title_keywords, and the adjusted confidence on
 * ai_field_sources.style when the style came from research. Tenant-scoped;
 * every failure is swallowed (caller logs).
 */
export async function verifyIdentificationAgainstMarket(args: {
  userId: string;
  itemId: string;
  brand: string | null;
  styleCode: string | null;
  research: ResearchIdentification;
}): Promise<void> {
  const { userId, itemId, brand, styleCode, research } = args;
  const identifiedStyle = research.identifiedStyle;
  if (!identifiedStyle) return;

  // Two anchored queries: the hard code (when US-1526 read one) and the named
  // style. Dedupe titles across both.
  const queries: string[] = [];
  if (styleCode) queries.push(`${brand ?? ""} ${styleCode}`.trim());
  queries.push(`${brand ?? ""} ${identifiedStyle}`.trim());

  const titles = new Set<string>();
  for (const q of queries) {
    try {
      for (const t of await _browse.search(q, brand)) titles.add(t);
    } catch {
      // No app creds / quota / network — this query contributes nothing.
    }
  }

  const agreement = scoreTitleAgreement({
    brand,
    identifiedStyle,
    titles: [...titles],
  });
  const decision = decideVerification({
    research,
    titlesSearched: titles.size,
    agreement,
  });

  // Persist onto the OWNED item. Direct-set (not gap-fill): these two keys are
  // exclusively market-verification outputs, never user-entered.
  const { data: item } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id, attributes, ai_field_sources")
    .eq("id", itemId)
    .eq("user_id", userId)
    .single();
  if (!item || (item as { user_id: string }).user_id !== userId) return;

  const attributes = {
    ...(((item as { attributes?: unknown }).attributes as
      | Record<string, string | string[]>
      | null) ?? {}),
    identification_verified: decision.verified ? "true" : "false",
    market_title_keywords: decision.keywords,
  };

  const aiSources =
    (((item as { ai_field_sources?: unknown }).ai_field_sources as Record<
      string,
      unknown
    > | null) ?? {});
  const styleSource = aiSources.style as
    | { source?: string; confidence?: number }
    | undefined;
  if (styleSource?.source === "research") {
    aiSources.style = {
      ...styleSource,
      confidence: decision.adjustedConfidence,
      market_verified: decision.verified,
    };
  }

  await supabaseAdmin
    .from("inventory_items")
    .update({ attributes, ai_field_sources: aiSources })
    .eq("id", itemId)
    .eq("user_id", userId);
}

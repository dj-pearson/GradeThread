// US-2945: keywords for Promoted Listings Advanced.
//
// FlipDesk could create a CPC campaign and an ad group and then had no way to
// put a keyword in either. A CPC campaign with no keyword management is a
// campaign spending on whatever eBay decides to match, which is the one
// difference between Advanced and Standard: Standard is a percentage of the
// sale, Advanced is a bid per click, and a bid you cannot aim is a bid you
// cannot control.
//
// ── THE NEGATIVE KEYWORD IS THE FEATURE ─────────────────────────────────────
//
// Adding keywords spends money. Adding NEGATIVE keywords stops spending it, and
// it is the half a seller can act on immediately, because the data for it —
// search terms with clicks and no sales — is already in `ebay_search_terms`
// from US-2683. That is why `negativeKeywordCandidates` lives here as a pure
// function rather than as a UI filter.
//
// Auth and transport are ebay-marketing's `marketingFetch`; this module reuses
// it rather than re-deriving the Content-Language header that eBay error 25709
// is about.
//
// TENANT SCOPING: every function takes a userId and runs under that seller's own
// token. Ids come from the caller and are not ownership-checked here (US-268).

import { marketingFetch } from "./ebay-marketing.ts";

export type KeywordStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";
export type MatchType = "EXACT" | "PHRASE" | "BROAD";

export interface Keyword {
  keywordId: string;
  text: string;
  matchType: MatchType | null;
  status: KeywordStatus | null;
  /** The bid for this keyword, in cents. Null when it inherits the ad group's. */
  bidCents: number | null;
}

interface RawKeyword {
  keywordId?: string;
  keywordText?: string;
  keyword?: string;
  matchType?: string;
  keywordStatus?: string;
  status?: string;
  bid?: { value?: string; currency?: string };
}

/** Flatten eBay's keyword shape. Pure — unit-tested. */
export function normalizeKeyword(raw: RawKeyword): Keyword {
  const bidValue = raw.bid?.value != null ? Number(raw.bid.value) : Number.NaN;
  return {
    keywordId: raw.keywordId ?? "",
    text: raw.keywordText ?? raw.keyword ?? "",
    matchType: (raw.matchType as MatchType) ?? null,
    status: (raw.keywordStatus ?? raw.status) as KeywordStatus ?? null,
    bidCents: Number.isFinite(bidValue) ? Math.round(bidValue * 100) : null,
  };
}

/** Every keyword on one ad group. */
export async function listKeywords(
  userId: string,
  campaignId: string,
  adGroupId: string,
): Promise<Keyword[]> {
  const { body } = await marketingFetch<{ keywords?: RawKeyword[] }>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/keyword` +
      `?ad_group_ids=${encodeURIComponent(adGroupId)}&limit=500`,
  );
  return (body.keywords ?? []).map(normalizeKeyword).filter((k) => k.keywordId);
}

export interface CreateKeywordInput {
  text: string;
  matchType: MatchType;
  /** Bid in cents. Omitted, the keyword inherits the ad group's default bid. */
  bidCents?: number | null;
}

/** Add one keyword. Returns eBay's id. */
export async function createKeyword(
  userId: string,
  campaignId: string,
  adGroupId: string,
  input: CreateKeywordInput,
): Promise<string> {
  const { body, location } = await marketingFetch<{ keywordId?: string }>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/keyword`,
    {
      method: "POST",
      body: JSON.stringify({
        adGroupId,
        keywordText: input.text,
        matchType: input.matchType,
        ...(input.bidCents != null
          ? { bid: { value: (input.bidCents / 100).toFixed(2), currency: "USD" } }
          : {}),
      }),
    },
  );
  const id = body.keywordId ?? idFromLocation(location);
  if (!id) {
    // A 2xx with no id would otherwise be reported as a created keyword the
    // seller can never edit or delete — the same silent-success shape the
    // return-evidence upload guards against.
    throw new Error("eBay accepted the keyword but returned no keywordId");
  }
  return id;
}

/** Change a keyword's bid or status. */
export async function updateKeyword(
  userId: string,
  campaignId: string,
  keywordId: string,
  patch: { bidCents?: number | null; status?: KeywordStatus },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.bidCents != null) {
    body.bid = { value: (patch.bidCents / 100).toFixed(2), currency: "USD" };
  }
  if (patch.status) body.keywordStatus = patch.status;
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/keyword/${
      encodeURIComponent(keywordId)
    }`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export interface NegativeKeyword {
  negativeKeywordId: string;
  text: string;
  matchType: MatchType | null;
  status: KeywordStatus | null;
}

interface RawNegativeKeyword {
  negativeKeywordId?: string;
  negativeKeywordText?: string;
  negativeKeywordMatchType?: string;
  negativeKeywordStatus?: string;
}

export function normalizeNegativeKeyword(raw: RawNegativeKeyword): NegativeKeyword {
  return {
    negativeKeywordId: raw.negativeKeywordId ?? "",
    text: raw.negativeKeywordText ?? "",
    matchType: (raw.negativeKeywordMatchType as MatchType) ?? null,
    status: (raw.negativeKeywordStatus as KeywordStatus) ?? null,
  };
}

export async function listNegativeKeywords(
  userId: string,
  campaignId: string,
): Promise<NegativeKeyword[]> {
  const { body } = await marketingFetch<{ negativeKeywords?: RawNegativeKeyword[] }>(
    userId,
    `/sell/marketing/v1/negative_keyword?campaign_ids=${encodeURIComponent(campaignId)}&limit=500`,
  );
  return (body.negativeKeywords ?? []).map(normalizeNegativeKeyword).filter((k) =>
    k.negativeKeywordId
  );
}

/** Stop paying for a search term. */
export async function createNegativeKeyword(
  userId: string,
  campaignId: string,
  adGroupId: string,
  text: string,
  matchType: MatchType = "PHRASE",
): Promise<string> {
  const { body, location } = await marketingFetch<{ negativeKeywordId?: string }>(
    userId,
    "/sell/marketing/v1/negative_keyword",
    {
      method: "POST",
      body: JSON.stringify({
        campaignId,
        adGroupId,
        negativeKeywordText: text,
        negativeKeywordMatchType: matchType,
      }),
    },
  );
  const id = body.negativeKeywordId ?? idFromLocation(location);
  if (!id) throw new Error("eBay accepted the negative keyword but returned no id");
  return id;
}

/** eBay's own keyword suggestions for an ad group. */
export async function suggestKeywords(
  userId: string,
  campaignId: string,
  adGroupId: string,
): Promise<string[]> {
  const { body } = await marketingFetch<{
    keywords?: Array<{ keywordText?: string; keyword?: string }>;
  }>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/suggest_keywords` +
      `?ad_group_id=${encodeURIComponent(adGroupId)}`,
  );
  return (body.keywords ?? [])
    .map((k) => k.keywordText ?? k.keyword ?? "")
    .filter((t) => t.length > 0);
}

/** eBay returns the new resource's id in a Location header on some creates. */
function idFromLocation(location: string | null): string | null {
  if (!location) return null;
  const parts = location.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

// ── Negative-keyword candidates ─────────────────────────────────────

export interface SearchTermPerformance {
  term: string;
  impressions: number;
  clicks: number;
  attributedSales: number;
}

export interface NegativeCandidate {
  term: string;
  clicks: number;
  impressions: number;
  /** Why it is a candidate, in the seller's words. */
  reason: string;
}

/**
 * Minimum clicks before a term with no sales is worth calling a waste.
 *
 * Three clicks and no sale is not evidence — plenty of items sell on the fourth
 * click. This is the number that stops the panel recommending a seller block
 * their own best future search term on a slow week.
 */
export const MIN_WASTED_CLICKS = 8;

/**
 * Which search terms are spending clicks and returning nothing. Pure.
 *
 * Reads the seller's OWN reported terms (`ebay_search_terms`, US-2683), which
 * is the only ground truth here — comp-mined vocabulary is other sellers
 * writing, and a term nobody has actually clicked on cannot be wasting money.
 *
 * Ordered by clicks descending: the most expensive waste first, because a
 * seller is going to block three of these and stop reading.
 */
export function negativeKeywordCandidates(
  terms: SearchTermPerformance[],
  existingNegatives: string[] = [],
  minClicks: number = MIN_WASTED_CLICKS,
): NegativeCandidate[] {
  const blocked = new Set(existingNegatives.map((t) => t.trim().toLowerCase()));
  return terms
    .filter((t) => t.attributedSales === 0)
    .filter((t) => t.clicks >= minClicks)
    .filter((t) => !blocked.has(t.term.trim().toLowerCase()))
    .sort((a, b) => b.clicks - a.clicks)
    .map((t) => ({
      term: t.term,
      clicks: t.clicks,
      impressions: t.impressions,
      reason: `${t.clicks} clicks and no sales.`,
    }));
}

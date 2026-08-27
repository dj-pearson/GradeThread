// eBay Promoted Listings (Marketing API) — US-561.
//
// The sell.marketing OAuth scope has been granted since the first eBay
// integration but went entirely unused. Promoted Listings is eBay's biggest
// seller-side visibility lever: a Cost-Per-Sale ad campaign attaches a bid
// percentage (the "ad rate") to a listing, and the seller is charged that
// percentage of the sale price ONLY when the item sells through the ad. Because
// there's no up-front cost, FlipDesk attaches a category-suggested ad rate by
// default at publish; the seller can adjust the rate (listings.promo_rate_pct)
// or opt out per listing (listings.promo_opt_out).
//
// Everything here is BEST-EFFORT: a Marketing API failure must NEVER fail the
// publish itself (the listing is already live on eBay), so the publish-time
// helper swallows errors and records a non-blocking 'failed' status instead.
//
// We reuse the user-token resolver + host helpers from ebay-client.ts but roll
// our own thin authed fetch here (fetchAuthed is private to that module) so the
// Marketing surface stays self-contained.

import { supabaseAdmin } from "./supabase.ts";
import {
  apiHost,
  ebayResilientFetch,
  getMarketplaceId,
  getUserAccessToken,
  localeForMarketplace,
} from "./ebay-client.ts";

const EBAY_TIMEOUT_MS = 20_000;

// Bounds on a bid percentage. eBay accepts 2%–100%; we cap the upper end far
// lower so a fat-fingered rate can't quietly hand eBay a fifth of every sale.
export const MIN_AD_RATE_PCT = 2;
export const MAX_AD_RATE_PCT = 20;

// One shared campaign per seller holds all of their FlipDesk-created ads.
const CAMPAIGN_NAME = "FlipDesk Promoted Listings";

// US-1979 (AC1): the FALLBACK, no longer the primary.
//
// The comment here used to read "eBay exposes no synchronous suggested bid per
// leaf endpoint, so this is our recommendation, not eBay's". That was wrong, and
// instructively so: eBay's suggestion is per-LISTING, not per-LEAF-CATEGORY, so
// looking for a category endpoint found nothing. The Recommendation API's
// findListingRecommendations returns marketing.ad.bidPercentages with
// basis: TRENDING — the average ad rate of listings that recently SOLD in the same
// category — which is exactly the number this map was guessing at.
//
// The map stays as the fallback, because the real rate is not always available:
// the Recommendation API covers only the CPS funding model and only EBAY_US /
// EBAY_GB / EBAY_DE / EBAY_AU, and a listing can come back with no bidPercentages
// at all. A stale guess beats failing to suggest anything.
const HIGHER_DEMAND_CATEGORIES: Record<string, number> = {
  "15709": 11, // Athletic Shoes / Sneakers — very high competition
  "169291": 11, // Women's Bags & Handbags
  "11483": 10, // Coats, Jackets & Vests (men's)
  "63862": 10, // Coats, Jackets & Vests (women's)
};

function clampRate(pct: number): number {
  if (!Number.isFinite(pct)) return MIN_AD_RATE_PCT;
  return Math.min(MAX_AD_RATE_PCT, Math.max(MIN_AD_RATE_PCT, pct));
}

// US-1979 (AC1): eBay's OWN suggested ad rate for a listing.
//
// findListingRecommendations returns, per listing, the TRENDING bid percentage —
// the average ad rate of listings that recently SOLD in the same category. That is
// real marketplace data, and it is what suggestedAdRateForCategory's hardcoded map
// was approximating.
//
// Marketplace/model limits are eBay's, not ours: the Recommendation API applies
// only to CPS general-strategy campaigns and only on EBAY_US / EBAY_GB / EBAY_DE /
// EBAY_AU. Outside those, and for any listing eBay returns no bidPercentages for,
// the caller falls back to the category heuristic — hence `null` rather than a
// throw. A suggestion is an assist; failing to suggest must never block the ad.
const RECO_MARKETPLACES = new Set(["EBAY_US", "EBAY_GB", "EBAY_DE", "EBAY_AU"]);

export function recommendationApiSupported(marketplaceId: string): boolean {
  return RECO_MARKETPLACES.has(marketplaceId);
}

interface ListingRecommendationResponse {
  listingRecommendations?: Array<{
    listingId?: string;
    marketing?: {
      ad?: {
        promoteWithAd?: string;
        bidPercentages?: Array<{ basis?: string; value?: string }>;
      };
    };
  }>;
}

/**
 * eBay's trending ad rate for each listing, as a percentage. Missing entries mean
 * eBay had no suggestion for that listing — the caller keeps its fallback.
 */
export async function fetchTrendingAdRates(
  userId: string,
  listingIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (listingIds.length === 0) return out;
  if (!recommendationApiSupported(getMarketplaceId())) return out;
  try {
    const { body } = await marketingFetch<ListingRecommendationResponse>(
      userId,
      // Same host + the hardened fetch (US-1966) as the Marketing calls; only the
      // path differs. Scope is sell.inventory, which the connection already grants.
      `/sell/recommendation/v1/find?filter=recommendationTypes:%7BAD%7D`,
      {
        method: "POST",
        // eBay caps this at 500 listing ids per call.
        body: JSON.stringify({ listingIds: listingIds.slice(0, 500) }),
      },
    );
    for (const rec of body.listingRecommendations ?? []) {
      if (!rec.listingId) continue;
      // Only the TRENDING basis is a real observation (what recently-sold
      // comparable listings actually bid). Take it explicitly rather than [0], so
      // a future basis eBay adds can't silently become "the suggestion".
      const trending = (rec.marketing?.ad?.bidPercentages ?? []).find(
        (b) => b.basis === "TRENDING",
      );
      const pct = Number(trending?.value);
      if (Number.isFinite(pct) && pct > 0) out.set(rec.listingId, clampRate(pct));
    }
  } catch (_err) {
    // Unsupported marketplace, no ad scope, eBay hiccup — the caller's category
    // fallback stands. Never let a suggestion failure break the ad path.
  }
  return out;
}

/**
 * Suggested ad rate (bid percentage) for a category — the FALLBACK for when eBay
 * has no trending rate for the listing (see fetchTrendingAdRates). Pure +
 * unit-testable. Falls back to the EBAY_DEFAULT_AD_RATE env baseline (or 8%) for
 * any category not in the higher-demand set, then clamps to [MIN, MAX].
 */
export function suggestedAdRateForCategory(categoryId?: string | null): number {
  const envBase = Number(Deno.env.get("EBAY_DEFAULT_AD_RATE") ?? "");
  const base = Number.isFinite(envBase) && envBase > 0 ? envBase : 8;
  const specific = categoryId ? HIGHER_DEMAND_CATEGORIES[categoryId] : undefined;
  return clampRate(specific ?? base);
}

/**
 * Resolve the effective ad rate to attach at publish. Pure. Returns null when
 * the listing shouldn't be promoted.
 *
 * Promotion is off by default, opt-in per seller (migration 00432):
 *   - A legacy explicit opt-out (optOut=true) always wins → no promotion.
 *   - Otherwise the tri-state per-listing override decides: promoteOverride if
 *     set (true/false), else the seller default (defaultPromote), else — for
 *     legacy callers that pass neither signal — the old "promote" behavior.
 * Rate precedence when promoting: the listing's chosen rate → the seller's
 * default rate → the category suggestion. All clamped to [MIN, MAX].
 */
export function resolvePublishAdRate(args: {
  optOut: boolean | null | undefined;
  chosenRatePct: number | null | undefined;
  categoryId?: string | null;
  // 00432 tri-state + seller defaults. Omit to keep the legacy promote-unless-
  // opted-out behavior (any caller that hasn't migrated).
  promoteOverride?: boolean | null;
  defaultPromote?: boolean | null;
  defaultRatePct?: number | null;
}): number | null {
  if (args.optOut) return null;

  const promote =
    args.promoteOverride != null
      ? args.promoteOverride
      : args.defaultPromote != null
        ? args.defaultPromote
        : true; // legacy default: promote unless opted out
  if (!promote) return null;

  if (args.chosenRatePct != null && args.chosenRatePct > 0) {
    return clampRate(args.chosenRatePct);
  }
  if (args.defaultRatePct != null && args.defaultRatePct > 0) {
    return clampRate(args.defaultRatePct);
  }
  return suggestedAdRateForCategory(args.categoryId);
}

// eBay wants the bid percentage as a string with at most one decimal place.
function formatBidPercentage(pct: number): string {
  return clampRate(pct).toFixed(1);
}

interface MarketingError extends Error {
  status: number;
  ebayErrorIds?: number[];
}

// US-2945: exported so lib/ebay-keywords.ts reuses this exact call shape rather
// than re-deriving the Content-Language header eBay error 25709 is about.
export async function marketingFetch<T>(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<{ body: T; location: string | null }> {
  const token = await getUserAccessToken(userId);
  const locale = localeForMarketplace();
  // US-1966: route through the shared resilient fetch (breaker + retry +
  // Retry-After) AND send Content-Language + Accept-Language — the Marketing
  // POSTs (campaign/promotion creates) omitted Content-Language, a known cause
  // of eBay error 25709. Content-Type/Accept-Language mirror the main Sell path.
  const res = await ebayResilientFetch(
    `${apiHost()}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": locale,
        "Content-Language": locale,
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        ...(init?.headers ?? {}),
      },
    },
    { timeoutMs: EBAY_TIMEOUT_MS, label: `Marketing ${init?.method ?? "GET"} ${path}` },
  );
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `eBay Marketing ${init?.method ?? "GET"} ${path} failed (${res.status}): ${
        text.slice(0, 400)
      }`,
    ) as MarketingError;
    err.status = res.status;
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ errorId?: number }> };
      if (Array.isArray(parsed.errors)) {
        err.ebayErrorIds = parsed.errors
          .map((e) => e.errorId)
          .filter((id): id is number => typeof id === "number");
      }
    } catch {
      // Non-JSON error body — leave ebayErrorIds undefined.
    }
    throw err;
  }
  const location = res.headers.get("location");
  const raw = await res.text();
  return { body: (raw ? JSON.parse(raw) : {}) as T, location };
}

// ── Campaign management ─────────────────────────────────────────────

interface CampaignSummary {
  campaignId?: string;
  campaignName?: string;
  campaignStatus?: string;
}

/**
 * Find-or-create the seller's single COST_PER_SALE Promoted Listings campaign,
 * returning its campaignId. Caches the id on marketplace_connections so we
 * don't round-trip eBay's "find by name" on every publish. Tenant-safe: the
 * connection read/write is keyed on `userId` (the workspace owner).
 */
export async function ensureAdCampaign(userId: string): Promise<string> {
  // 1. Cache hit on the connection.
  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("ebay_campaign_id")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cached = (conn as { ebay_campaign_id: string | null } | null)
    ?.ebay_campaign_id;
  if (cached) return cached;

  // 2. Look the campaign up by name (it may already exist on the eBay account
  //    from a prior connection or a manual setup).
  let campaignId: string | null = null;
  try {
    const { body } = await marketingFetch<{ campaigns?: CampaignSummary[] }>(
      userId,
      `/sell/marketing/v1/ad_campaign?campaign_name=${
        encodeURIComponent(CAMPAIGN_NAME)
      }`,
    );
    const match = (body.campaigns ?? []).find(
      (cmp) =>
        cmp.campaignName === CAMPAIGN_NAME &&
        cmp.campaignStatus !== "ENDED" &&
        !!cmp.campaignId,
    );
    if (match?.campaignId) campaignId = match.campaignId;
  } catch (err) {
    // A 404 means "no campaign by that name" on some marketplaces; fall through
    // to create. Anything else is logged but still falls through to a create
    // attempt (which surfaces the real error to the caller if it also fails).
    console.warn(
      "[ebay-marketing] campaign lookup failed (will try create):",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 3. Create a new COST_PER_SALE campaign running indefinitely.
  if (!campaignId) {
    const { body, location } = await marketingFetch<{ campaignId?: string }>(
      userId,
      `/sell/marketing/v1/ad_campaign`,
      {
        method: "POST",
        body: JSON.stringify({
          campaignName: CAMPAIGN_NAME,
          marketplaceId: getMarketplaceId(),
          fundingStrategy: { fundingModel: "COST_PER_SALE" },
          // eBay requires a start date; "now" makes it active immediately.
          startDate: new Date().toISOString(),
        }),
      },
    );
    // create returns 201 with the id in the Location header (and sometimes the
    // body). Prefer the body, fall back to parsing the trailing path segment.
    campaignId = body.campaignId ??
      (location ? location.split("/").filter(Boolean).pop() ?? null : null);
    if (!campaignId) {
      throw new Error(
        "eBay ad_campaign create succeeded but returned no campaignId.",
      );
    }
  }

  // 4. Cache on the connection for next time.
  await supabaseAdmin
    .from("marketplace_connections")
    .update({ ebay_campaign_id: campaignId })
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true);

  return campaignId;
}

// ── US-1447: Promoted Listings ADVANCED (Cost-Per-Click) ────────────
//
// CPC / Priority campaigns give keyword-bid + ad-group control beyond the flat
// COST_PER_SALE model above. A CPC campaign REQUIRES an ad group (which carries
// the default max-CPC bid); ads are created under it. We cache both ids on the
// connection so we don't re-resolve them per promote. Modeled from the Sell
// Marketing docs and mirrors ensureAdCampaign — NOT live-eBay tested on this
// host; a bad payload fails as an eBay 4xx (surfaced), never silent corruption.

const CPC_CAMPAIGN_NAME = "FlipDesk Priority (CPC)";
const CPC_AD_GROUP_NAME = "FlipDesk CPC Ad Group";
// Conservative default max-CPC bid (marketplace currency). eBay's per-listing
// suggestMaxCpc is a separate call the promote UI can layer on later; this is a
// safe floor so a CPC ad can be created without a suggestion round-trip.
const DEFAULT_MAX_CPC = "0.10";

function marketplaceCurrency(): string {
  // EBAY_US → USD; extend as more marketplaces are enabled. Kept local so a new
  // marketplace can't silently mis-currency a bid.
  const mp = getMarketplaceId();
  if (mp === "EBAY_GB") return "GBP";
  if (mp === "EBAY_DE" || mp === "EBAY_AT" || mp === "EBAY_FR" || mp === "EBAY_IT" || mp === "EBAY_ES") return "EUR";
  if (mp === "EBAY_CA") return "CAD";
  if (mp === "EBAY_AU") return "AUD";
  return "USD";
}

/**
 * Find-or-create the seller's single Cost-Per-Click (Priority) campaign + its
 * default ad group, returning both ids (cached on the connection). Mirrors
 * ensureAdCampaign; tenant-safe (keyed on the workspace owner `userId`).
 */
export async function ensureCpcCampaign(
  userId: string,
): Promise<{ campaignId: string; adGroupId: string }> {
  const { data: conn } = await supabaseAdmin
    .from("marketplace_connections")
    .select("ebay_cpc_campaign_id, ebay_cpc_ad_group_id")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .order("is_primary", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const cachedCampaign = (conn as { ebay_cpc_campaign_id: string | null } | null)
    ?.ebay_cpc_campaign_id;
  const cachedAdGroup = (conn as { ebay_cpc_ad_group_id: string | null } | null)
    ?.ebay_cpc_ad_group_id;
  if (cachedCampaign && cachedAdGroup) {
    return { campaignId: cachedCampaign, adGroupId: cachedAdGroup };
  }

  let campaignId: string | null = cachedCampaign ?? null;
  if (!campaignId) {
    // Reuse an existing CPC campaign by name if present.
    try {
      const { body } = await marketingFetch<{ campaigns?: CampaignSummary[] }>(
        userId,
        `/sell/marketing/v1/ad_campaign?campaign_name=${encodeURIComponent(CPC_CAMPAIGN_NAME)}`,
      );
      const match = (body.campaigns ?? []).find(
        (cmp) =>
          cmp.campaignName === CPC_CAMPAIGN_NAME &&
          cmp.campaignStatus !== "ENDED" &&
          !!cmp.campaignId,
      );
      if (match?.campaignId) campaignId = match.campaignId;
    } catch (err) {
      console.warn(
        "[ebay-marketing] CPC campaign lookup failed (will try create):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (!campaignId) {
    const { body, location } = await marketingFetch<{ campaignId?: string }>(
      userId,
      `/sell/marketing/v1/ad_campaign`,
      {
        method: "POST",
        body: JSON.stringify({
          campaignName: CPC_CAMPAIGN_NAME,
          marketplaceId: getMarketplaceId(),
          // Minimal, well-documented CPC payload. Smart-targeting specifics
          // (campaignTargetType / auto keyword targeting) are layered in chunk 2
          // once verifiable — don't ship a guessed field that could 4xx the create.
          fundingStrategy: { fundingModel: "COST_PER_CLICK" },
          startDate: new Date().toISOString(),
        }),
      },
    );
    campaignId =
      body.campaignId ??
      (location ? location.split("/").filter(Boolean).pop() ?? null : null);
    if (!campaignId) {
      throw new Error("eBay CPC ad_campaign create returned no campaignId.");
    }
  }

  // Ad group (holds the default max-CPC bid). Find-or-create.
  let adGroupId: string | null = cachedAdGroup ?? null;
  if (!adGroupId) {
    try {
      const { body } = await marketingFetch<{
        adGroups?: Array<{ adGroupId?: string; name?: string; adGroupStatus?: string }>;
      }>(userId, `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad_group`);
      const match = (body.adGroups ?? []).find(
        (g) => g.adGroupStatus !== "ENDED" && !!g.adGroupId,
      );
      if (match?.adGroupId) adGroupId = match.adGroupId;
    } catch {
      // fall through to create
    }
  }
  if (!adGroupId) {
    const { body, location } = await marketingFetch<{ adGroupId?: string }>(
      userId,
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/ad_group`,
      {
        method: "POST",
        body: JSON.stringify({
          name: CPC_AD_GROUP_NAME,
          defaultBid: { currency: marketplaceCurrency(), value: DEFAULT_MAX_CPC },
          adGroupStatus: "RUNNING",
        }),
      },
    );
    adGroupId =
      body.adGroupId ??
      (location ? location.split("/").filter(Boolean).pop() ?? null : null);
    if (!adGroupId) {
      throw new Error("eBay CPC ad_group create returned no adGroupId.");
    }
  }

  await supabaseAdmin
    .from("marketplace_connections")
    .update({
      ebay_cpc_campaign_id: campaignId,
      ebay_cpc_ad_group_id: adGroupId,
    })
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true);

  return { campaignId, adGroupId };
}

// ── US-1447 chunk 2: Smart Targeting (campaignTargetingType=SMART, maxCpc) ──
//
// Smart campaigns are CPC campaigns where eBay auto-manages targeting; the
// seller only sets a campaign-level maxCpc ceiling. suggestMaxCpc is called
// BEFORE campaign creation with the listings you plan to include and returns
// eBay's recommended ceiling (per the priority-strategy campaign flow docs).
// Same disclaimer as the CPS/CPC code above: modeled from the Sell Marketing
// docs, NOT live-eBay tested on this host — a bad payload fails as a surfaced
// eBay 4xx, never silent corruption.

const SMART_CAMPAIGN_NAME = "FlipDesk Smart Targeting";

/**
 * eBay's suggested max cost-per-click for a smart campaign covering the given
 * listings. Best-effort: null on any failure (caller falls back to the
 * conservative default). Tolerant of the response shape (maxCpc vs
 * suggestedMaxCpc envelopes).
 */
export async function suggestMaxCpc(
  userId: string,
  listingIds: string[],
): Promise<{ value: string; currency: string } | null> {
  try {
    const { body } = await marketingFetch<{
      maxCpc?: { value?: string; currency?: string };
      suggestedMaxCpc?: { value?: string; currency?: string };
    }>(userId, `/sell/marketing/v1/ad_campaign/suggest_max_cpc`, {
      method: "POST",
      body: JSON.stringify({
        marketplaceId: getMarketplaceId(),
        listingIds,
      }),
    });
    const amount = body.maxCpc ?? body.suggestedMaxCpc;
    if (amount?.value && Number.isFinite(Number(amount.value))) {
      return {
        value: amount.value,
        currency: amount.currency ?? marketplaceCurrency(),
      };
    }
    return null;
  } catch (err) {
    console.warn(
      "[ebay-marketing] suggestMaxCpc failed (falling back to default):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Find-or-create the seller's Smart Targeting campaign. Smart campaigns carry
 * the max-CPC ceiling at CAMPAIGN level and have no ad groups (eBay
 * auto-targets). Resolved by name on each attach — smart promotion is
 * per-listing opt-in, so the extra GET is cheap and avoids a schema change.
 */
export async function ensureSmartCampaign(
  userId: string,
  maxCpc: { value: string; currency: string },
): Promise<string> {
  try {
    const { body } = await marketingFetch<{ campaigns?: CampaignSummary[] }>(
      userId,
      `/sell/marketing/v1/ad_campaign?campaign_name=${encodeURIComponent(SMART_CAMPAIGN_NAME)}`,
    );
    const match = (body.campaigns ?? []).find(
      (cmp) =>
        cmp.campaignName === SMART_CAMPAIGN_NAME &&
        cmp.campaignStatus !== "ENDED" &&
        !!cmp.campaignId,
    );
    if (match?.campaignId) return match.campaignId;
  } catch (err) {
    console.warn(
      "[ebay-marketing] smart campaign lookup failed (will try create):",
      err instanceof Error ? err.message : String(err),
    );
  }

  const { body, location } = await marketingFetch<{ campaignId?: string }>(
    userId,
    `/sell/marketing/v1/ad_campaign`,
    {
      method: "POST",
      body: JSON.stringify({
        campaignName: SMART_CAMPAIGN_NAME,
        marketplaceId: getMarketplaceId(),
        fundingStrategy: { fundingModel: "COST_PER_CLICK" },
        campaignTargetingType: "SMART",
        maxCpc: { currency: maxCpc.currency, value: maxCpc.value },
        startDate: new Date().toISOString(),
      }),
    },
  );
  const campaignId =
    body.campaignId ??
    (location ? location.split("/").filter(Boolean).pop() ?? null : null);
  if (!campaignId) {
    throw new Error("eBay smart ad_campaign create returned no campaignId.");
  }
  return campaignId;
}

/**
 * Create an ad for a live listing under the Smart Targeting campaign. No
 * adGroupId — smart campaigns have none; eBay handles targeting/bidding under
 * the campaign maxCpc. Non-fatal null on failure (listing is already live).
 */
export async function createSmartAdForListing(
  userId: string,
  campaignId: string,
  listingId: string,
): Promise<{ adId: string } | null> {
  try {
    const { body } = await marketingFetch<CreateAdsResponse>(
      userId,
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/create_ads_by_listing_id`,
      {
        method: "POST",
        body: JSON.stringify({ listingIds: [listingId] }),
      },
    );
    const first = body.responses?.[0];
    if (first?.adId) return { adId: first.adId };
    return null;
  } catch (err) {
    console.warn(
      "[ebay-marketing] createSmartAdForListing failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Create a CPC ad for a live listing under the seller's CPC ad group. The bid is
 * the ad group's defaultBid (max CPC). Returns the adId, or null on ineligible /
 * failure (non-fatal — the listing is already live).
 */
export async function createCpcAdForListing(
  userId: string,
  campaignId: string,
  adGroupId: string,
  listingId: string,
): Promise<{ adId: string } | null> {
  try {
    const { body } = await marketingFetch<CreateAdsResponse>(
      userId,
      `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/create_ads_by_listing_id`,
      {
        method: "POST",
        body: JSON.stringify({ listingIds: [listingId], adGroupId }),
      },
    );
    const first = body.responses?.[0];
    if (first?.adId) return { adId: first.adId };
    return null;
  } catch (err) {
    console.warn(
      "[ebay-marketing] createCpcAdForListing failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

// ── Ad creation ─────────────────────────────────────────────────────

interface CreateAdsResponse {
  responses?: Array<{
    listingId?: string;
    adId?: string;
    statusCode?: number;
    errors?: Array<{ errorId?: number; message?: string }>;
  }>;
}

/**
 * Create (or adopt an existing) Promoted Listings ad for a live listingId in
 * the seller's campaign at the given bid percentage. Returns the adId, or null
 * if eBay couldn't create the ad (e.g. listing ineligible). Never throws — the
 * listing is already live, so promotion failure is non-fatal.
 */
export async function createAdForListing(
  userId: string,
  campaignId: string,
  listingId: string,
  bidPercentagePct: number,
): Promise<{ adId: string } | null> {
  try {
    const { body } = await marketingFetch<CreateAdsResponse>(
      userId,
      `/sell/marketing/v1/ad_campaign/${
        encodeURIComponent(campaignId)
      }/create_ads_by_listing_id`,
      {
        method: "POST",
        body: JSON.stringify({
          listingIds: [listingId],
          bidPercentage: formatBidPercentage(bidPercentagePct),
        }),
      },
    );
    const resp = (body.responses ?? []).find((r) => r.listingId === listingId) ??
      body.responses?.[0];
    if (resp?.adId) return { adId: resp.adId };

    // An "ad already exists" response (errorId 35073 on the bulk endpoint) means
    // the listing is already promoted — adopt the existing ad's id.
    const existing = await getAdForListing(userId, campaignId, listingId);
    if (existing?.adId) return { adId: existing.adId };

    console.warn(
      `[ebay-marketing] create ad for listing ${listingId} returned no adId:`,
      JSON.stringify(resp ?? {}).slice(0, 300),
    );
    return null;
  } catch (err) {
    console.warn(
      `[ebay-marketing] createAdForListing(${listingId}) failed:`,
      err instanceof Error ? err.message : String(err),
    );
    // Last-ditch: maybe the ad exists despite the error.
    const existing = await getAdForListing(userId, campaignId, listingId).catch(
      () => null,
    );
    return existing?.adId ? { adId: existing.adId } : null;
  }
}

interface AdSummary {
  adId?: string;
  listingId?: string;
  bidPercentage?: string;
  adStatus?: string;
}

/** Read a single listing's ad (status + bid) from its campaign, or null. */
export async function getAdForListing(
  userId: string,
  campaignId: string,
  listingId: string,
): Promise<{ adId: string; bidPercentage: number | null; status: string | null } | null> {
  const { body } = await marketingFetch<{ ads?: AdSummary[] }>(
    userId,
    `/sell/marketing/v1/ad_campaign/${
      encodeURIComponent(campaignId)
    }/ad?listing_ids=${encodeURIComponent(listingId)}`,
  );
  const ad = (body.ads ?? []).find((a) => a.listingId === listingId && a.adId);
  if (!ad?.adId) return null;
  const bid = ad.bidPercentage != null ? Number(ad.bidPercentage) : null;
  return {
    adId: ad.adId,
    bidPercentage: Number.isFinite(bid) ? bid : null,
    status: ad.adStatus ?? null,
  };
}

// ── Per-listing promotion management (US-1044) ──────────────────────
// Change an existing ad's bid, or remove the ad entirely (opt out). These are
// the pieces missing for seller-facing promoted controls — create/get already
// existed.

/** Update the bid percentage on a listing's existing ad. Returns the clamped rate. */
export async function updateAdRateForListing(
  userId: string,
  campaignId: string,
  listingId: string,
  bidPercentagePct: number,
): Promise<number> {
  const rate = clampRate(bidPercentagePct);
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/ad_campaign/${
      encodeURIComponent(campaignId)
    }/bulk_update_ads_bid_by_listing_id`,
    {
      method: "POST",
      body: JSON.stringify({
        requests: [{ listingId, bidPercentage: formatBidPercentage(rate) }],
      }),
    },
  );
  return rate;
}

/** Remove a listing's ad (opt out of Promoted Listings). Idempotent: a
 * not-found ad is treated as already-removed. */
export async function removeAdForListing(
  userId: string,
  campaignId: string,
  listingId: string,
): Promise<void> {
  try {
    await marketingFetch<unknown>(
      userId,
      `/sell/marketing/v1/ad_campaign/${
        encodeURIComponent(campaignId)
      }/bulk_delete_ads_by_listing_id`,
      { method: "POST", body: JSON.stringify({ listingIds: [listingId] }) },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/\(404\)|not found|no ad/i.test(msg)) throw err;
  }
}

// ── Publish-time helper ─────────────────────────────────────────────

export interface AttachPromotionResult {
  campaignId: string;
  adId: string;
  ratePct: number;
  status: "active";
}

/**
 * Attach a Promoted Listings ad to a freshly-published listing and persist the
 * eBay handles + status onto the listings row. BEST-EFFORT: returns null (and
 * records promo_status='failed' on the row when listingRowId is known) on any
 * failure, never throws — the listing is already live.
 *
 * Tenant-safe: every eBay call runs as `userId` (workspace owner) and the
 * listings update is keyed on a row id that the caller already owner-verified.
 */
export async function attachPromotionAtPublish(args: {
  userId: string;
  listingRowId: string | null;
  ebayListingId: string;
  ratePct: number;
  // US-1447: 'cps' (default, Cost-Per-Sale bid %), 'cpc' (Cost-Per-Click /
  // Priority — bid is the CPC ad group's max-CPC), or 'smart' (Smart
  // Targeting — eBay auto-targets under a campaign-level max-CPC seeded from
  // suggestMaxCpc). ratePct only applies to 'cps'.
  mode?: "cps" | "cpc" | "smart";
}): Promise<AttachPromotionResult | null> {
  const { userId, listingRowId, ebayListingId, ratePct } = args;
  const mode = args.mode ?? "cps";
  try {
    if (mode === "smart") {
      // eBay's suggested ceiling for THIS listing; conservative default when
      // the suggestion call fails (same floor the CPC ad group uses).
      const maxCpc = (await suggestMaxCpc(userId, [ebayListingId])) ?? {
        value: DEFAULT_MAX_CPC,
        currency: marketplaceCurrency(),
      };
      const campaignId = await ensureSmartCampaign(userId, maxCpc);
      const ad = await createSmartAdForListing(userId, campaignId, ebayListingId);
      if (!ad) {
        await markPromoStatus(listingRowId, "failed", { campaignId });
        return null;
      }
      if (listingRowId) {
        await supabaseAdmin
          .from("listings")
          .update({
            promo_campaign_id: campaignId,
            promo_ad_id: ad.adId,
            // Smart bids are eBay-managed under the campaign maxCpc → no %.
            promo_rate_pct: null,
            promo_status: "active",
            promo_synced_at: new Date().toISOString(),
          })
          .eq("id", listingRowId);
      }
      return { campaignId, adId: ad.adId, ratePct: 0, status: "active" };
    }
    if (mode === "cpc") {
      const { campaignId, adGroupId } = await ensureCpcCampaign(userId);
      const ad = await createCpcAdForListing(
        userId,
        campaignId,
        adGroupId,
        ebayListingId,
      );
      if (!ad) {
        await markPromoStatus(listingRowId, "failed", { campaignId });
        return null;
      }
      if (listingRowId) {
        await supabaseAdmin
          .from("listings")
          .update({
            promo_campaign_id: campaignId,
            promo_ad_id: ad.adId,
            // CPC bid is the ad group's max-CPC, not a percentage → clear the %.
            promo_rate_pct: null,
            promo_status: "active",
            promo_synced_at: new Date().toISOString(),
          })
          .eq("id", listingRowId);
      }
      return { campaignId, adId: ad.adId, ratePct: 0, status: "active" };
    }

    const campaignId = await ensureAdCampaign(userId);
    const ad = await createAdForListing(
      userId,
      campaignId,
      ebayListingId,
      ratePct,
    );
    if (!ad) {
      await markPromoStatus(listingRowId, "failed", { campaignId });
      return null;
    }
    if (listingRowId) {
      await supabaseAdmin
        .from("listings")
        .update({
          promo_campaign_id: campaignId,
          promo_ad_id: ad.adId,
          promo_rate_pct: clampRate(ratePct),
          promo_status: "active",
          promo_synced_at: new Date().toISOString(),
        })
        .eq("id", listingRowId);
    }
    return {
      campaignId,
      adId: ad.adId,
      ratePct: clampRate(ratePct),
      status: "active",
    };
  } catch (err) {
    console.warn(
      "[ebay-marketing] attachPromotionAtPublish failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
    await markPromoStatus(listingRowId, "failed", {});
    return null;
  }
}

async function markPromoStatus(
  listingRowId: string | null,
  status: string,
  extra: { campaignId?: string },
): Promise<void> {
  if (!listingRowId) return;
  try {
    await supabaseAdmin
      .from("listings")
      .update({
        promo_status: status,
        ...(extra.campaignId ? { promo_campaign_id: extra.campaignId } : {}),
        promo_synced_at: new Date().toISOString(),
      })
      .eq("id", listingRowId);
  } catch (err) {
    console.warn(
      "[ebay-marketing] markPromoStatus write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Post-publish performance sync ───────────────────────────────────

export interface PromotedSyncResult {
  scanned: number;
  updated: number;
}

/**
 * Refresh the live ad status + bid for a single owner's promoted listings. Reads
 * each promoted listing's ad from its campaign and writes the latest adStatus /
 * bid percentage back, so the seller sees current Promoted Listings state after
 * publish. Tenant-scoped to `userId`. Best-effort per row; a single failing
 * lookup doesn't abort the rest.
 */
export async function syncPromotedListingsForOwner(
  userId: string,
  limit = 200,
): Promise<PromotedSyncResult> {
  const { data: rows } = await supabaseAdmin
    .from("listings")
    .select("id, platform_listing_id, promo_campaign_id")
    .eq("user_id", userId)
    .eq("platform", "ebay")
    .not("promo_ad_id", "is", null)
    .order("promo_synced_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  const promoted = (rows ?? []) as Array<{
    id: string;
    platform_listing_id: string | null;
    promo_campaign_id: string | null;
  }>;
  let updated = 0;
  for (const row of promoted) {
    if (!row.platform_listing_id || !row.promo_campaign_id) continue;
    try {
      const ad = await getAdForListing(
        userId,
        row.promo_campaign_id,
        row.platform_listing_id,
      );
      const patch: Record<string, unknown> = {
        promo_synced_at: new Date().toISOString(),
      };
      if (ad) {
        // eBay's adStatus (RUNNING/PAUSED/ENDED…) is the live truth; mirror it.
        if (ad.status) patch.promo_status = ad.status;
        if (ad.bidPercentage != null) patch.promo_rate_pct = ad.bidPercentage;
      } else {
        // The ad disappeared on eBay (deleted/ended) — reflect that locally.
        patch.promo_status = "ended";
      }
      await supabaseAdmin.from("listings").update(patch).eq("id", row.id);
      updated++;
    } catch (err) {
      console.warn(
        `[ebay-marketing] promoted sync for listing ${row.id} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { scanned: promoted.length, updated };
}

// ── Promotions overview (US-1044) ───────────────────────────────────
//
// A read-only roll-up of the seller's promoted listings for the management
// surface. eBay's per-ad endpoint exposes ad status + bid percentage but NOT
// click/impression metrics — those require an async ad-report task (generate →
// poll → download CSV), which is out of scope for a synchronous overview. So we
// surface what we reliably hold locally: each ad's live status, its bid %, and —
// because Promoted Listings is Cost-Per-Sale — the accrued ad fee, which eBay
// charges ONLY on a sale attributed to the ad. A listing with a non-zero ad fee
// therefore had an attributed sale, so the attributed-sale count is derived from
// that honestly (no fabricated click metrics).

export interface PromotedListingRow {
  id: string;
  listing_title: string | null;
  listing_url: string | null;
  listing_price: number | null;
  listing_status: string | null;
  promo_status: string | null;
  promo_rate_pct: number | null;
  promo_ad_fees_cents: number | null;
  promo_synced_at: string | null;
}

export interface PromotedOverviewSummary {
  total: number;
  active: number;
  ad_fees_cents: number;
  attributed_sales: number;
}

// Our publish path writes promo_status 'active'; the performance sync echoes
// eBay's adStatus (RUNNING/PAUSED/ENDED…). Treat active/RUNNING as live.
export function isPromoActive(status: string | null | undefined): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return s === "ACTIVE" || s === "RUNNING";
}

/**
 * Aggregate a list of promoted listings into the overview totals. Pure +
 * unit-tested. attributed_sales counts rows that accrued an ad fee, since eBay's
 * Cost-Per-Sale model only charges the ad rate on an attributed sale.
 */
export function summarizePromotedListings(
  rows: PromotedListingRow[],
): PromotedOverviewSummary {
  let active = 0;
  let adFeesCents = 0;
  let attributed = 0;
  for (const r of rows) {
    if (isPromoActive(r.promo_status)) active++;
    const fee = r.promo_ad_fees_cents ?? 0;
    if (Number.isFinite(fee) && fee > 0) {
      adFeesCents += fee;
      attributed++;
    }
  }
  return {
    total: rows.length,
    active,
    ad_fees_cents: adFeesCents,
    attributed_sales: attributed,
  };
}

// ── Markdown / Sale events (US-1045, Promotions Manager) ────────────
//
// A price-drop on eBay can be a silent Revise (no buyer signal) OR an
// item_price_markdown promotion: eBay shows a strike-through "Sale" price, a
// SALE badge, and notifies watchers. This is the missing Marketing client the
// pricing automation needs to push a real Sale event instead of a bare revise.
// A markdown is an OVERLAY, not a price change — ending the promotion restores
// the original price automatically (US-1045 AC3 revertibility), so we only need
// to track the promotion id to be able to end it.

// Markdown percent bounds: eBay requires a meaningful discount; cap the top so a
// fat-fingered drop can't gut a price.
export const MIN_MARKDOWN_PCT = 5;
export const MAX_MARKDOWN_PCT = 70;

export function clampMarkdownPct(pct: number): number {
  if (!Number.isFinite(pct)) return MIN_MARKDOWN_PCT;
  return Math.min(MAX_MARKDOWN_PCT, Math.max(MIN_MARKDOWN_PCT, pct));
}

export interface MarkdownSaleInput {
  ebayListingId: string;
  percentOff: number;
  name?: string;
  startDate?: string; // ISO; omitted → starts now (RUNNING)
  endDate?: string; // ISO; omitted → open-ended until ended
}

interface MarkdownPromotionBody {
  name: string;
  marketplaceId: string;
  promotionStatus: "RUNNING" | "SCHEDULED";
  applyDiscountToAllInventory: false;
  inventoryCriterion: {
    inventoryCriterionType: "INVENTORY_BY_VALUE";
    listingIds: string[];
  };
  discountRules: Array<{
    discountBenefit: { percentageOffItem: string };
    ruleOrder: number;
  }>;
  startDate?: string;
  endDate?: string;
}

// Build the item_price_markdown_promotion request body. Pure + unit-tested.
export function buildMarkdownPromotionBody(
  args: MarkdownSaleInput,
): MarkdownPromotionBody {
  const pct = clampMarkdownPct(args.percentOff);
  const body: MarkdownPromotionBody = {
    name: (args.name ?? `FlipDesk Sale ${args.ebayListingId}`).slice(0, 90),
    marketplaceId: getMarketplaceId(),
    // SCHEDULED if a future start was given, else start immediately.
    promotionStatus: args.startDate ? "SCHEDULED" : "RUNNING",
    applyDiscountToAllInventory: false,
    inventoryCriterion: {
      inventoryCriterionType: "INVENTORY_BY_VALUE",
      listingIds: [args.ebayListingId],
    },
    discountRules: [
      { discountBenefit: { percentageOffItem: pct.toFixed(1) }, ruleOrder: 1 },
    ],
  };
  if (args.startDate) body.startDate = args.startDate;
  if (args.endDate) body.endDate = args.endDate;
  return body;
}

// Extract the promotion id from the create response's Location header
// (…/item_price_markdown_promotion/{id}). Pure + unit-tested.
export function promotionIdFromLocation(location: string | null): string | null {
  if (!location) return null;
  const seg = location.split("?")[0].split("/").filter(Boolean).pop();
  return seg ?? null;
}

// Create a markdown Sale on a single listing. Returns the new promotion id.
export async function createMarkdownSale(
  userId: string,
  args: MarkdownSaleInput,
): Promise<string | null> {
  const { body: respBody, location } = await marketingFetch<
    { promotionId?: string }
  >(userId, `/sell/marketing/v1/item_price_markdown_promotion`, {
    method: "POST",
    body: JSON.stringify(buildMarkdownPromotionBody(args)),
  });
  return respBody?.promotionId ?? promotionIdFromLocation(location);
}

// Update an existing markdown Sale in place (e.g. deepen the discount or change
// the end date). eBay's PUT replaces the whole promotion, so we rebuild the body
// from the input — the promotion id stays in the URL, so watchers keep the same
// Sale rather than seeing it end + restart.
export async function updateMarkdownSale(
  userId: string,
  promotionId: string,
  args: MarkdownSaleInput,
): Promise<void> {
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/item_price_markdown_promotion/${
      encodeURIComponent(promotionId)
    }`,
    { method: "PUT", body: JSON.stringify(buildMarkdownPromotionBody(args)) },
  );
}

// End (delete) a markdown Sale — restores the listing's original price.
export async function endMarkdownSale(
  userId: string,
  promotionId: string,
): Promise<void> {
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/item_price_markdown_promotion/${
      encodeURIComponent(promotionId)
    }`,
    { method: "DELETE" },
  );
}

// ── US-1448: Promotions Manager item promotions ─────────────────────
//
// Beyond markdown sales, eBay's item_promotion covers ORDER_DISCOUNT (spend $X
// get Y off the order), VOLUME_DISCOUNT (buy N get a discount) and CODED_COUPON.
// Chunk 1 is the READ side — list the seller's existing item promotions so
// FlipDesk surfaces them. The WRITE side (typed body builders + create/update/
// delete wrappers) is chunk 2 below; see its header for what's still gated on a
// live-eBay smoke test before it's wired to a mutating route.

export interface EbayItemPromotion {
  promotionId: string;
  name: string | null;
  promotionType: string | null; // ORDER_DISCOUNT | VOLUME_DISCOUNT | CODED_COUPON | MARKDOWN_SALE
  promotionStatus: string | null; // RUNNING | SCHEDULED | ENDED | PAUSED
  startDate: string | null;
  endDate: string | null;
}

interface ItemPromotionListResponse {
  promotions?: Array<{
    promotionId?: string;
    name?: string;
    promotionType?: string;
    promotionStatus?: string;
    startDate?: string;
    endDate?: string;
  }>;
}

/** List the seller's item promotions (Promotions Manager) for this marketplace. */
export async function getItemPromotions(
  userId: string,
  limit = 100,
): Promise<EbayItemPromotion[]> {
  const qs = new URLSearchParams({
    marketplace_id: getMarketplaceId(),
    limit: String(limit),
  });
  const { body } = await marketingFetch<ItemPromotionListResponse>(
    userId,
    `/sell/marketing/v1/item_promotion?${qs.toString()}`,
  );
  return (body.promotions ?? [])
    .filter((p) => p.promotionId)
    .map((p) => ({
      promotionId: p.promotionId as string,
      name: p.name ?? null,
      promotionType: p.promotionType ?? null,
      promotionStatus: p.promotionStatus ?? null,
      startDate: p.startDate ?? null,
      endDate: p.endDate ?? null,
    }));
}

// US-1979 (AC2): read ONE promotion in full.
//
// WHY THIS HAS TO EXIST BEFORE ANY EDIT UI. getItemPromotions above is a LIST call
// and returns summaries — id, name, type, status, dates. It does NOT return the
// listings the promotion targets, its discount percent, its minSpend, its buy
// quantity or its coupon code. And updateItemPromotion is a PUT, which REPLACES the
// whole promotion.
//
// So an edit form prefilled from the list shape would send back a body missing
// everything the list omits: the seller opens "edit", changes the name, saves — and
// silently wipes the promotion's targeting and its discount. There is no undo, and
// the promotion keeps its id, so it looks like it worked.
//
// This is the round-trip that makes editing safe: read the full promotion, let the
// seller change one field, PUT the whole thing back intact.
export interface EbayItemPromotionDetail extends EbayItemPromotion {
  listingIds: string[];
  percentOff: number | null;
  minSpend: { value: string; currency: string } | null;
  buyQuantity: number | null;
  couponCode: string | null;
  promotionImageUrl: string | null;
  priority: string | null;
}

interface ItemPromotionDetailResponse {
  promotionId?: string;
  name?: string;
  promotionType?: string;
  promotionStatus?: string;
  startDate?: string;
  endDate?: string;
  promotionImageUrl?: string;
  priority?: string;
  couponConfiguration?: { couponCode?: string };
  inventoryCriterion?: { listingIds?: string[] };
  discountRules?: Array<{
    discountBenefit?: { percentageOffOrder?: string; percentageOffItem?: string };
    discountSpecification?: {
      minAmount?: { value?: string; currency?: string };
      numberOfItems?: number;
    };
  }>;
}

export async function getItemPromotion(
  userId: string,
  promotionId: string,
): Promise<EbayItemPromotionDetail> {
  const { body } = await marketingFetch<ItemPromotionDetailResponse>(
    userId,
    `/sell/marketing/v1/item_promotion/${encodeURIComponent(promotionId)}`,
  );
  // Mirror-image of buildItemPromotionBody, so a read→write round-trip is lossless.
  const rule = body.discountRules?.[0];
  const pctRaw = rule?.discountBenefit?.percentageOffOrder ??
    rule?.discountBenefit?.percentageOffItem ?? null;
  const pct = pctRaw !== null && pctRaw !== undefined ? Number(pctRaw) : null;
  const min = rule?.discountSpecification?.minAmount;
  return {
    promotionId: body.promotionId ?? promotionId,
    name: body.name ?? null,
    promotionType: body.promotionType ?? null,
    promotionStatus: body.promotionStatus ?? null,
    startDate: body.startDate ?? null,
    endDate: body.endDate ?? null,
    listingIds: body.inventoryCriterion?.listingIds ?? [],
    percentOff: pct !== null && Number.isFinite(pct) ? pct : null,
    minSpend: min?.value && min?.currency
      ? { value: min.value, currency: min.currency }
      : null,
    buyQuantity: rule?.discountSpecification?.numberOfItems ?? null,
    couponCode: body.couponConfiguration?.couponCode ?? null,
    promotionImageUrl: body.promotionImageUrl ?? null,
    priority: body.priority ?? null,
  };
}

// Read a markdown Sale's current status (for reconciliation).
export async function getMarkdownSale(
  userId: string,
  promotionId: string,
): Promise<{ promotionStatus?: string; name?: string }> {
  const { body } = await marketingFetch<
    { promotionStatus?: string; name?: string }
  >(
    userId,
    `/sell/marketing/v1/item_price_markdown_promotion/${
      encodeURIComponent(promotionId)
    }`,
  );
  return body;
}

// ── US-1448 chunk 2: create/update item promotions ──────────────────
//
// The WRITE side chunk-1 deferred. Pure, correct-by-construction body-builders
// (like buildMarkdownPromotionBody) + thin POST/PUT wrappers, following eBay's
// documented ItemPromotion schema. Per the docs:
//   • ORDER_DISCOUNT → percentage/amount off the ORDER once a spend threshold is
//     met (discountSpecification.minAmount); REQUIRES a promotionImageUrl.
//   • VOLUME_DISCOUNT → percentage off each item once N are bought
//     (discountSpecification.numberOfItems); NO promotionImageUrl.
//   • CODED_COUPON → percentage off item with a unique 8–15 alphanumeric coupon
//     code (couponConfiguration); REQUIRES a promotionImageUrl.
// The builder ENFORCES those required inputs so a caller can't emit a body eBay
// would 4xx. ⚠️ Not yet wired to a mutating route / the aging auto-coupon
// pipeline (AC2) — that needs a live-eBay smoke test + a promotion-image source.

export type ItemPromotionType =
  | "ORDER_DISCOUNT"
  | "VOLUME_DISCOUNT"
  | "CODED_COUPON";

export interface ItemPromotionInput {
  type: ItemPromotionType;
  name: string;
  /** Listings the promotion targets (INVENTORY_BY_VALUE). */
  listingIds: string[];
  /** Discount percent; clamped to the shared markdown bounds (5–70). */
  percentOff: number;
  /** ORDER_DISCOUNT: minimum order spend that unlocks the discount. Required. */
  minSpend?: { value: string; currency: string };
  /** VOLUME_DISCOUNT: quantity that unlocks the per-item discount (buy N; ≥2). */
  buyQuantity?: number;
  /** Required by eBay for ORDER_DISCOUNT + CODED_COUPON (not VOLUME_DISCOUNT). */
  promotionImageUrl?: string;
  /** CODED_COUPON: 8–15 alphanumeric code, unique across eBay. Required. */
  couponCode?: string;
  startDate?: string;
  endDate?: string;
  priority?: string;
}

const COUPON_CODE_RE = /^[A-Za-z0-9]{8,15}$/;

/** US-1448: generate a coupon code satisfying eBay's 8-15 alphanumeric rule.
 *  "FD" prefix + 10 random uppercase alphanumerics — 36^10 space makes
 *  collisions with other sellers' codes vanishingly unlikely. */
export function generateCouponCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "FD";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

/** Build an item_promotion request body per type. Pure + unit-tested; throws a
 *  clear error when a type's eBay-required input is missing. */
export function buildItemPromotionBody(
  input: ItemPromotionInput,
): Record<string, unknown> {
  const name = input.name.trim();
  if (!name) throw new Error("Item promotion requires a name.");
  if (input.listingIds.length === 0) {
    throw new Error("Item promotion requires at least one listing.");
  }
  const pct = clampMarkdownPct(input.percentOff).toFixed(1);

  const needsImage = input.type === "ORDER_DISCOUNT" ||
    input.type === "CODED_COUPON";
  if (needsImage && !input.promotionImageUrl) {
    throw new Error(`${input.type} requires a promotionImageUrl.`);
  }
  if (
    input.type === "CODED_COUPON" &&
    (!input.couponCode || !COUPON_CODE_RE.test(input.couponCode))
  ) {
    throw new Error(
      "CODED_COUPON requires an 8–15 character alphanumeric couponCode.",
    );
  }

  // Order discounts take a percentage off the whole order; item + coupon
  // discounts take it off each qualifying item.
  const discountBenefit = input.type === "ORDER_DISCOUNT"
    ? { percentageOffOrder: pct }
    : { percentageOffItem: pct };

  const discountSpecification: Record<string, unknown> = {};
  if (input.type === "ORDER_DISCOUNT") {
    if (!input.minSpend) {
      throw new Error("ORDER_DISCOUNT requires a minSpend threshold.");
    }
    discountSpecification.minAmount = input.minSpend;
  } else if (input.type === "VOLUME_DISCOUNT") {
    discountSpecification.numberOfItems = Math.max(2, input.buyQuantity ?? 2);
  }

  const body: Record<string, unknown> = {
    name: name.slice(0, 90),
    marketplaceId: getMarketplaceId(),
    promotionType: input.type,
    promotionStatus: input.startDate ? "SCHEDULED" : "RUNNING",
    applyDiscountToAllInventory: false,
    inventoryCriterion: {
      inventoryCriterionType: "INVENTORY_BY_VALUE",
      listingIds: input.listingIds,
    },
    discountRules: [{ discountBenefit, discountSpecification, ruleOrder: 1 }],
    priority: input.priority ?? "1",
  };
  if (needsImage) body.promotionImageUrl = input.promotionImageUrl;
  if (input.type === "CODED_COUPON") {
    body.couponConfiguration = {
      couponType: "PUBLIC_CODED_COUPON",
      couponCode: input.couponCode,
    };
  }
  if (input.startDate) body.startDate = input.startDate;
  if (input.endDate) body.endDate = input.endDate;
  return body;
}

/** Create a Promotions Manager item promotion. Returns the new promotion id. */
export async function createItemPromotion(
  userId: string,
  input: ItemPromotionInput,
): Promise<string | null> {
  const { body, location } = await marketingFetch<{ promotionId?: string }>(
    userId,
    `/sell/marketing/v1/item_promotion`,
    { method: "POST", body: JSON.stringify(buildItemPromotionBody(input)) },
  );
  return body?.promotionId ?? promotionIdFromLocation(location);
}

/** Update an existing item promotion in place (eBay PUT replaces the whole
 *  promotion; the id stays in the URL so watchers keep the same promotion). */
export async function updateItemPromotion(
  userId: string,
  promotionId: string,
  input: ItemPromotionInput,
): Promise<void> {
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/item_promotion/${encodeURIComponent(promotionId)}`,
    { method: "PUT", body: JSON.stringify(buildItemPromotionBody(input)) },
  );
}

/** End (delete) an item promotion. Analog of endMarkdownSale. */
export async function deleteItemPromotion(
  userId: string,
  promotionId: string,
): Promise<void> {
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/item_promotion/${encodeURIComponent(promotionId)}`,
    { method: "DELETE" },
  );
}

// ── US-2683: the Promoted Listings report transport ────────────────────────
//
// The three eBay calls behind the search-term ingest. They live HERE because
// this module owns the authed Marketing fetch and the campaign state, and they
// are REGISTERED into ebay-ad-reports.ts rather than imported by it — that
// keeps the parsing and the add/remove verdict, which is where the real logic
// is, unit-testable without an eBay account.

import {
  type AdReportType,
  registerAdReportTransport,
} from "./ebay-ad-reports.ts";

/** ISO date, N days back from now, as eBay's report window wants it. */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
}

registerAdReportTransport({
  createTask: async (userId, reportType: AdReportType, windowDays) => {
    try {
      const campaignId = await cpcCampaignIdFor(userId);
      if (!campaignId) return { unavailable: true as const, reason: "no CPC campaign" };

      const { location } = await marketingFetch<unknown>(
        userId,
        "/sell/marketing/v1/ad_report_task",
        {
          method: "POST",
          body: JSON.stringify({
            campaignIds: [campaignId],
            reportType,
            dateFrom: isoDaysAgo(windowDays),
            dateTo: isoDaysAgo(0),
            reportFormat: "TSV_GZIP",
            marketplaceId: getMarketplaceId(),
          }),
        },
      );
      // eBay returns the task id in the Location header, not the body.
      const taskId = (location ?? "").split("/").filter(Boolean).pop() ?? "";
      if (!taskId) return { unavailable: true as const, reason: "no task id returned" };
      return { taskId };
    } catch (err) {
      // A 400 here is the ordinary answer for an account eBay does not expose
      // this report type on, so it is "unavailable" rather than "failed".
      return {
        unavailable: true as const,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  },

  taskStatus: async (userId, taskId) => {
    const { body } = await marketingFetch<{
      reportTaskStatus?: string;
      reportId?: string;
      reportTaskStatusReason?: string;
    }>(userId, `/sell/marketing/v1/ad_report_task/${encodeURIComponent(taskId)}`);

    const state = (body.reportTaskStatus ?? "").toUpperCase();
    if (state === "SUCCESS" && body.reportId) {
      return { state: "done" as const, reportId: body.reportId };
    }
    if (state === "FAILED") {
      return {
        state: "failed" as const,
        reason: body.reportTaskStatusReason ?? "eBay reported FAILED with no reason",
      };
    }
    return { state: "pending" as const };
  },

  download: async (userId, reportId) => {
    const { body } = await marketingFetch<string>(
      userId,
      `/sell/marketing/v1/ad_report/${encodeURIComponent(reportId)}`,
    );
    return typeof body === "string" ? body : JSON.stringify(body);
  },
});

/** The seller's CPC campaign id, or null. Read, never created, on this path. */
async function cpcCampaignIdFor(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("marketplace_connections")
    .select("ebay_cpc_campaign_id")
    .eq("user_id", userId)
    .eq("marketplace", "ebay")
    .eq("is_active", true)
    .maybeSingle();
  const id = (data as { ebay_cpc_campaign_id?: string | null } | null)?.ebay_cpc_campaign_id;
  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

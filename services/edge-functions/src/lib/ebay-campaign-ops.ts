// US-2946 / US-2947 / US-2948: the parts of an eBay ad campaign FlipDesk could
// not touch.
//
// It could CREATE a campaign and it could set one ad rate at a time. It could
// not ask eBay which listings to promote, could not pause or end what it had
// started, and could not change a hundred ad rates without a hundred calls.
// A seller who started a campaign here had to finish it in Seller Hub.
//
// Three groups, one module, because they are the same API surface with the same
// auth and the same failure shapes:
//
//   • SUGGESTIONS (US-2946)  — eBay's own view of what to promote, at what
//                              budget and bid. Proposals, never applied.
//   • LIFECYCLE   (US-2947)  — pause, resume, end, clone.
//   • BULK        (US-2948)  — create ads and change bids in batches.
//
// ── PARTIAL FAILURE IS REPORTED PER LISTING, NEVER AGGREGATED ───────────────
//
// eBay's bulk endpoints answer with a per-listing status and happily return 200
// while rejecting half the batch. Collapsing that into `{ ok: true }` is the
// silent-success shape this codebase keeps running into: the seller believes a
// hundred items are promoted and forty are not, with nothing to tell them which.
//
// Auth and transport are ebay-marketing's marketingFetch.
//
// TENANT SCOPING: every function takes a userId and runs under that seller's own
// token; campaign ids come from the caller, which must resolve them from the
// seller's own connection rather than from a request body (US-268).

import { marketingFetch } from "./ebay-marketing.ts";

// ── Suggestions (US-2946) ───────────────────────────────────────────

export interface SuggestedItem {
  listingId: string;
  /** eBay's suggested ad rate, in percent. Null when it offers none. */
  suggestedBidPercentage: number | null;
}

interface RawSuggestedItem {
  listingId?: string;
  suggestedBidPercentage?: string | number;
  bidPercentage?: string | number;
}

function pctOf(raw: string | number | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function normalizeSuggestedItem(raw: RawSuggestedItem): SuggestedItem {
  return {
    listingId: raw.listingId ?? "",
    suggestedBidPercentage: pctOf(raw.suggestedBidPercentage ?? raw.bidPercentage),
  };
}

/** Which of the seller's listings eBay thinks are worth promoting. */
export async function suggestItems(
  userId: string,
  campaignId: string,
  limit = 200,
): Promise<SuggestedItem[]> {
  const { body } = await marketingFetch<{ suggestedAds?: RawSuggestedItem[] }>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/suggest_items` +
      `?limit=${Math.min(Math.max(limit, 1), 500)}`,
  );
  return (body.suggestedAds ?? []).map(normalizeSuggestedItem).filter((s) => s.listingId);
}

export interface BudgetSuggestion {
  /** eBay's suggested DAILY budget, in cents. Null when it offers none. */
  dailyBudgetCents: number | null;
  currency: string | null;
}

export async function suggestBudget(
  userId: string,
  campaignId: string,
): Promise<BudgetSuggestion> {
  const { body } = await marketingFetch<{
    suggestedBudget?: { value?: string; currency?: string };
  }>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/suggest_budget`,
  );
  const value = body.suggestedBudget?.value != null ? Number(body.suggestedBudget.value) : NaN;
  return {
    dailyBudgetCents: Number.isFinite(value) ? Math.round(value * 100) : null,
    currency: body.suggestedBudget?.currency ?? null,
  };
}

export interface BidSuggestion {
  keyword: string;
  /** Suggested bid, in cents. Null when eBay offers none for the term. */
  bidCents: number | null;
}

export async function suggestBids(
  userId: string,
  campaignId: string,
  adGroupId: string,
): Promise<BidSuggestion[]> {
  const { body } = await marketingFetch<{
    suggestedBids?: Array<{ keyword?: string; bid?: { value?: string } }>;
  }>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/suggest_bids` +
      `?ad_group_id=${encodeURIComponent(adGroupId)}`,
  );
  return (body.suggestedBids ?? []).map((b) => {
    const value = b.bid?.value != null ? Number(b.bid.value) : NaN;
    return {
      keyword: b.keyword ?? "",
      bidCents: Number.isFinite(value) ? Math.round(value * 100) : null,
    };
  }).filter((b) => b.keyword);
}

// ── Lifecycle (US-2947) ─────────────────────────────────────────────

export type CampaignAction = "pause" | "resume" | "end" | "clone";

/**
 * eBay error ids and phrases meaning "the campaign is already in that state".
 *
 * Treated as success by the routes, for the reason every already-resolved
 * branch in this codebase exists: a seller pressing Pause on a paused campaign
 * should see it paused, not a 502.
 */
export function isCampaignAlreadyInState(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e?.status === 404) return true;
  return /already\s+(paused|running|ended|resumed)|invalid\s+campaign\s+status/i.test(
    e?.message ?? "",
  );
}

export async function pauseCampaign(userId: string, campaignId: string): Promise<void> {
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/pause`,
    { method: "POST" },
  );
}

export async function resumeCampaign(userId: string, campaignId: string): Promise<void> {
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/resume`,
    { method: "POST" },
  );
}

export async function endCampaign(userId: string, campaignId: string): Promise<void> {
  await marketingFetch<unknown>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/end`,
    { method: "POST" },
  );
}

/** Clone a campaign's settings into a new one. Returns the new id. */
export async function cloneCampaign(
  userId: string,
  campaignId: string,
  name: string,
): Promise<string | null> {
  const { body, location } = await marketingFetch<{ campaignId?: string }>(
    userId,
    `/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/clone`,
    { method: "POST", body: JSON.stringify({ campaignName: name }) },
  );
  if (body.campaignId) return body.campaignId;
  if (!location) return null;
  const parts = location.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

// ── Bulk ads (US-2948) ──────────────────────────────────────────────

/** eBay's per-listing answer, kept per listing rather than aggregated. */
export interface BulkAdResult {
  listingId: string;
  ok: boolean;
  /** eBay's own words when it refused. Null on success. */
  error: string | null;
  adId: string | null;
}

interface RawBulkResponse {
  responses?: Array<{
    listingId?: string;
    adId?: string;
    statusCode?: number;
    errors?: Array<{ message?: string; longMessage?: string }>;
  }>;
}

/**
 * Flatten eBay's bulk response into one row per listing. Pure.
 *
 * A response eBay returns for a listing that was NOT in the request is dropped,
 * and a listing in the request that eBay says nothing about is reported as a
 * failure with a stated reason. Both directions matter: silently inventing a
 * success for an unmentioned listing is exactly the lie this shape prevents.
 */
export function normalizeBulkResponse(
  requestedListingIds: string[],
  raw: RawBulkResponse,
): BulkAdResult[] {
  const byId = new Map<string, BulkAdResult>();
  for (const r of raw.responses ?? []) {
    if (!r.listingId) continue;
    const failed = (r.statusCode != null && r.statusCode >= 400) ||
      (r.errors?.length ?? 0) > 0;
    byId.set(r.listingId, {
      listingId: r.listingId,
      ok: !failed,
      error: failed
        ? (r.errors?.[0]?.longMessage ?? r.errors?.[0]?.message ??
          `eBay returned status ${r.statusCode}`)
        : null,
      adId: r.adId ?? null,
    });
  }
  return requestedListingIds.map((id) =>
    byId.get(id) ?? {
      listingId: id,
      ok: false,
      error: "eBay did not answer for this listing.",
      adId: null,
    }
  );
}

/** eBay's documented ceiling for one bulk call. */
export const BULK_AD_BATCH_SIZE = 500;

/** Chunk a list into batches eBay will accept. Pure. */
export function batched<T>(items: T[], size: number = BULK_AD_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function bulkCreateAdsByListingId(
  userId: string,
  campaignId: string,
  listingIds: string[],
  bidPercentage: number,
): Promise<BulkAdResult[]> {
  const out: BulkAdResult[] = [];
  for (const chunk of batched(listingIds)) {
    const { body } = await marketingFetch<RawBulkResponse>(
      userId,
      `/sell/marketing/v1/ad_campaign/${
        encodeURIComponent(campaignId)
      }/bulk_create_ads_by_listing_id`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: chunk.map((listingId) => ({
            listingId,
            bidPercentage: bidPercentage.toFixed(1),
          })),
        }),
      },
    );
    out.push(...normalizeBulkResponse(chunk, body));
  }
  return out;
}

export async function bulkUpdateAdRateByListingId(
  userId: string,
  campaignId: string,
  listingIds: string[],
  bidPercentage: number,
): Promise<BulkAdResult[]> {
  const out: BulkAdResult[] = [];
  for (const chunk of batched(listingIds)) {
    const { body } = await marketingFetch<RawBulkResponse>(
      userId,
      `/sell/marketing/v1/ad_campaign/${
        encodeURIComponent(campaignId)
      }/bulk_update_ads_bid_by_listing_id`,
      {
        method: "POST",
        body: JSON.stringify({
          requests: chunk.map((listingId) => ({
            listingId,
            bidPercentage: bidPercentage.toFixed(1),
          })),
        }),
      },
    );
    out.push(...normalizeBulkResponse(chunk, body));
  }
  return out;
}

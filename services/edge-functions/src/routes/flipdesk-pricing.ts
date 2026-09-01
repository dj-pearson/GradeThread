import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { capBodyArray } from "../lib/validation.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { getSetting } from "../lib/system-settings.ts";
import { createMarkdownSale } from "../lib/ebay-marketing.ts";
import {
  isEbayConfigured,
  searchBrowseComps,
  suggestCategories,
  updateOfferPrice,
} from "../lib/ebay-client.ts";
import {
  computeSuggestion,
  gradeToConditionId,
  type ReasonCode,
  type RepriceSuggestion as EngineSuggestion,
} from "../lib/repricing.ts";
import {
  computeFloorCents,
  DEFAULT_MARGIN_FLOOR_PCT,
} from "../lib/automation-rules.ts";
import {
  evaluatePerformance,
  type PerformanceSignalCode,
  sellSimilarEligible,
} from "../lib/performance-signals.ts";
import { valueAtGrade } from "../lib/condition-value.ts";
import { forecastSellThrough } from "../lib/sell-through.ts";
import {
  assembleRecommendation,
  recommendGradeBandedPrice,
} from "../lib/grade-band-pricing.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import {
  type PricingOutcome,
  registerRepricer,
  type RepriceApplyResult,
  type RepriceRow,
} from "../lib/reprice-port.ts";
import {
  decideNewPriceCents,
  isDue,
  type ListingFacts,
  normalizeRuleInput,
  ruleMatchesListing,
  ruleMayReprice,
} from "../lib/repricing-rules.ts";

// Condition-aware dynamic repricing. The scan pulls condition-matched comps per
// active eBay listing and writes one actionable suggestion per listing. Every
// query is tenant-scoped: listings/items carry no user_id, so we join through
// inventory_items.user_id and stamp the owning user_id on each suggestion row
// (US-268).

export const flipdeskPricingRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

// Bound per-call work: each listing costs one eBay Browse request.
const DEFAULT_SCAN_LIMIT = 25;
const MAX_SCAN_LIMIT = 50;
const CRON_SCAN_LIMIT = 200;
// US-962: bulk match-to-comp reprice. Each item costs one eBay Browse call in
// preview, so cap a single selection the same way the scan is capped.
const MAX_BULK_REPRICE = 50;

// Reason codes that are worth surfacing as a nudge. OK / NO_COMPS are not.
const ACTIONABLE: ReasonCode[] = ["UNDERPRICED", "OVERPRICED", "STALE"];

interface ListingJoinRow {
  id: string;
  inventory_item_id: string;
  listing_price: number;
  listed_at: string;
  watchers: number;
  views: number;
  watchers_count: number;
  impressions_7d: number;
  click_through_rate: number | null;
  platform_offer_id: string | null;
  platform_category_id: string | null;
  listing_title: string | null;
  inventory_items: {
    user_id: string;
    ebay_category_id: string | null;
    grade_value: number | null;
    brand: string | null;
    size: string | null;
    title: string | null;
    // US-962: cost basis for the margin floor on bulk reprice.
    acquired_price: number | null;
  };
}

// Columns the repricing engine needs off a listing + its item, shared by the
// scan and the bulk match-to-comp flow (US-962).
const REPRICE_LISTING_COLUMNS =
  "id, inventory_item_id, listing_price, listed_at, watchers, views, watchers_count, impressions_7d, click_through_rate, platform_offer_id, platform_category_id, listing_title, " +
  "inventory_items!inner(user_id, ebay_category_id, grade_value, brand, size, title, acquired_price)";

interface ScanResult {
  scanned: number;
  actionable: number;
  skipped_no_category: number;
  errors: number;
}

function daysSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * Run the condition-aware repricing engine for one listing: pull
 * condition-matched comps and position a suggested price by grade. Returns null
 * when the listing has no category to comp against. Shared by the scan and the
 * bulk match-to-comp reprice (US-962) so both price off the same engine.
 */
async function computeListingSuggestion(
  listing: ListingJoinRow,
): Promise<EngineSuggestion | null> {
  const item = listing.inventory_items;
  const categoryId = listing.platform_category_id ?? item.ebay_category_id;
  if (!categoryId) return null;

  const comps = await searchBrowseComps({
    categoryId,
    q: item.brand ?? item.title ?? undefined,
    brand: item.brand ?? undefined,
    size: item.size ?? undefined,
    conditionId: gradeToConditionId(item.grade_value),
  });

  return computeSuggestion({
    currentPriceCents: Math.round(listing.listing_price * 100),
    gradeValue: item.grade_value,
    stats: comps.stats,
    listingAgeDays: daysSince(listing.listed_at),
    // watchers_count is the fresh analytics watcher total (US-151);
    // listing.watchers is the legacy listings-pull value — prefer the former.
    watchers: listing.watchers_count ?? listing.watchers ?? 0,
    views: listing.views ?? 0,
    // US-565: feed engagement signals so a watched-but-unsold listing earns
    // a markdown nudge even before the 30-day age gate.
    impressions: listing.impressions_7d ?? 0,
    clickThroughRate: listing.click_through_rate ?? null,
  });
}

/**
 * Scan active eBay listings (all, or one owner's), recompute condition-matched
 * suggestions, and upsert the actionable ones / clear the rest.
 */
async function scanListings(
  ownerId: string | null,
  limit: number,
): Promise<ScanResult> {
  const result: ScanResult = {
    scanned: 0,
    actionable: 0,
    skipped_no_category: 0,
    errors: 0,
  };

  let q = supabaseAdmin
    .from("listings")
    .select(REPRICE_LISTING_COLUMNS)
    .eq("platform", "ebay")
    .eq("listing_status", "active")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (ownerId) q = q.eq("inventory_items.user_id", ownerId);

  const { data, error } = await q;
  if (error) {
    console.error("[repricing] listing scan query failed:", error.message);
    return result;
  }

  const listings = (data ?? []) as unknown as ListingJoinRow[];
  for (const listing of listings) {
    result.scanned++;
    const item = listing.inventory_items;

    try {
      const suggestion = await computeListingSuggestion(listing);
      if (!suggestion) {
        result.skipped_no_category++;
        continue;
      }

      if (ACTIONABLE.includes(suggestion.reasonCode)) {
        result.actionable++;
        await supabaseAdmin.from("repricing_suggestions").upsert(
          {
            user_id: item.user_id,
            inventory_item_id: listing.inventory_item_id,
            listing_id: listing.id,
            current_price_cents: Math.round(listing.listing_price * 100),
            suggested_price_cents: suggestion.suggestedPriceCents,
            comp_median_cents: suggestion.compMedianCents,
            comp_count: suggestion.compCount,
            condition_id: gradeToConditionId(item.grade_value),
            reason_code: suggestion.reasonCode,
            message: suggestion.message,
            confidence: suggestion.confidence,
            status: "pending",
            applied_at: null,
            dismissed_at: null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "listing_id" },
        );
      } else {
        // No longer actionable — drop any stale suggestion so the feed is clean.
        await supabaseAdmin
          .from("repricing_suggestions")
          .delete()
          .eq("listing_id", listing.id);
      }
    } catch (err) {
      result.errors++;
      console.error(
        "[repricing] comp/compute failed for listing",
        listing.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return result;
}

// ── POST /scan ────────────────────────────────────────────────────
flipdeskPricingRoutes.post("/scan", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  let body: { limit?: number } = {};
  try {
    body = (await c.req.json()) as { limit?: number };
  } catch {
    body = {};
  }
  const limit = Math.min(
    Math.max(Number(body.limit) || DEFAULT_SCAN_LIMIT, 1),
    MAX_SCAN_LIMIT,
  );
  const result = await scanListings(ownerId, limit);
  return c.json(result);
});

// ── GET /suggestions ──────────────────────────────────────────────
// US-623: condition-aware sell-through forecast for a candidate price. Given an
// item identity + grade + price, returns how likely + how fast it sells at that
// price (from the condition-matched comp range). Powers the composer's "list at
// $X → ~N% sell in D days" hint. Best-effort: degrades to unknown rather than
// erroring so the composer never breaks on a comp hiccup.
flipdeskPricingRoutes.post("/forecast", async (c) => {
  let body: { categoryId?: unknown; brand?: unknown; q?: unknown; grade?: unknown; priceCents?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const brand = typeof body.brand === "string" ? body.brand.trim() : undefined;
  const q = typeof body.q === "string" ? body.q.trim() : undefined;
  const grade = typeof body.grade === "number" ? body.grade : null;
  const priceCents = typeof body.priceCents === "number" ? Math.round(body.priceCents) : 0;
  let categoryId = typeof body.categoryId === "string" ? body.categoryId.trim() : "";

  if (priceCents <= 0 || (!brand && !q && !categoryId)) {
    return c.json({ forecast: { sellThroughPct: 0, daysLow: 0, daysHigh: 0, label: "unknown", sampleSize: 0 }, value: null });
  }

  try {
    if (!categoryId) {
      const cats = await suggestCategories([brand, q].filter(Boolean).join(" ").trim());
      categoryId = cats[0]?.categoryId ?? "";
    }
    if (!categoryId) {
      return c.json({ forecast: { sellThroughPct: 0, daysLow: 0, daysHigh: 0, label: "unknown", sampleSize: 0 }, value: null });
    }
    const value = await valueAtGrade({ categoryId, q, brand }, grade);
    const forecast = forecastSellThrough(value, priceCents);
    return c.json({ forecast, value });
  } catch {
    // Never break the composer on a comp/taxonomy hiccup — degrade to unknown.
    return c.json({ forecast: { sellThroughPct: 0, daysLow: 0, daysHigh: 0, label: "unknown", sampleSize: 0 }, value: null });
  }
});

// ── POST /price ───────────────────────────────────────────────────
// US-594: sold-comp, grade-banded price RECOMMENDATION. Unlike /forecast (which
// scores a price the user already picked off active asks), this RECOMMENDS a
// price from realized sales — eBay Marketplace Insights → the seller's own
// private sales — positioned by the item's grade, with sell-through velocity and
// the comp set + confidence that back it. Falls back to active asks only when no
// sold data exists, flagged soldBacked=false so the UI can say so. The private-
// sales comp set is tenant-scoped to the workspace owner (US-268).
flipdeskPricingRoutes.post("/price", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { categoryId?: unknown; brand?: unknown; q?: unknown; size?: unknown; grade?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const brand = typeof body.brand === "string" ? body.brand.trim() : undefined;
  const q = typeof body.q === "string" ? body.q.trim() : undefined;
  const size = typeof body.size === "string" ? body.size.trim() : undefined;
  const grade = typeof body.grade === "number" ? body.grade : null;
  let categoryId = typeof body.categoryId === "string" ? body.categoryId.trim() : "";

  if (!brand && !q && !categoryId) {
    return jsonError(c, 400, "Provide at least a brand, query, or categoryId.");
  }

  try {
    if (!categoryId) {
      const cats = await suggestCategories([brand, q].filter(Boolean).join(" ").trim());
      categoryId = cats[0]?.categoryId ?? "";
    }
    if (!categoryId) {
      return c.json({ recommendation: assembleRecommendation({ realized: null, activeValue: null, gradeValue: grade }) });
    }
    const recommendation = await recommendGradeBandedPrice(
      { ownerId, categoryId, q, brand, size, conditionId: gradeToConditionId(grade) },
      grade,
    );
    return c.json({ recommendation });
  } catch {
    // Never break the composer on a comp/taxonomy hiccup — degrade to insufficient.
    return c.json({ recommendation: assembleRecommendation({ realized: null, activeValue: null, gradeValue: grade }) });
  }
});

flipdeskPricingRoutes.get("/suggestions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("repricing_suggestions")
    .select(
      "id, inventory_item_id, listing_id, current_price_cents, suggested_price_cents, comp_median_cents, comp_count, condition_id, reason_code, message, confidence, status, updated_at, " +
        "inventory_items!inner(title, brand, grade_value, grade_label), listings!inner(listing_status, listing_url)",
    )
    .eq("user_id", ownerId)
    .eq("status", "pending")
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) return failSafe(c, 500, "Couldn't load repricing suggestions.", error, "repricing.list");
  return c.json({ suggestions: data ?? [] });
});

// ── GET /performance ──────────────────────────────────────────────
// US-565: post-publish performance feedback loop. Reads the engagement snapshot
// the getTrafficReport sync writes per active eBay listing and returns one
// actionable suggestion per listing that needs attention ("low CTR → fix
// title/photo", "watched but unsold → drop price / enable Best Offer", "no
// traffic → promote"). Tenant-scoped via inventory_items.user_id (US-268).
interface PerfRow {
  id: string;
  inventory_item_id: string;
  listing_title: string | null;
  listing_url: string | null;
  listed_at: string;
  views_total: number;
  watchers_count: number;
  impressions_7d: number;
  click_through_rate: number | null;
  best_offer_enabled: boolean;
  inventory_items: { user_id: string; title: string | null };
}

flipdeskPricingRoutes.get("/performance", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, listing_title, listing_url, listed_at, views_total, watchers_count, impressions_7d, click_through_rate, best_offer_enabled, " +
        "inventory_items!inner(user_id, title)",
    )
    .eq("platform", "ebay")
    .eq("listing_status", "active")
    .eq("inventory_items.user_id", ownerId)
    .limit(1000);
  if (error) {
    return failSafe(c, 500, "Couldn't load listing performance.", error, "performance.list");
  }

  const rows = (data ?? []) as unknown as PerfRow[];

  // US-1899: photo counts per inventory item, for the "too few photos" nudge.
  // Tenant-scoped through inventory_items.user_id (defence in depth on top of
  // the item ids already being the owner's, since they come from the owner-
  // scoped listings query above).
  const itemIds = [...new Set(rows.map((r) => r.inventory_item_id))];
  const photoCount = new Map<string, number>();
  if (itemIds.length > 0) {
    const { data: photoRows } = await supabaseAdmin
      .from("item_photos")
      .select("inventory_item_id, inventory_items!inner(user_id)")
      .eq("inventory_items.user_id", ownerId)
      .in("inventory_item_id", itemIds);
    for (const p of (photoRows ?? []) as Array<{ inventory_item_id: string }>) {
      photoCount.set(
        p.inventory_item_id,
        (photoCount.get(p.inventory_item_id) ?? 0) + 1,
      );
    }
  }

  const suggestions = rows
    .map((r) => {
      // Build the metrics once so evaluatePerformance and the US-1899
      // Sell-Similar gate read the exact same snapshot (single source).
      const metrics = {
        impressions: r.impressions_7d ?? 0,
        views: r.views_total ?? 0,
        watchers: r.watchers_count ?? 0,
        clickThroughRate: r.click_through_rate,
        listingAgeDays: daysSince(r.listed_at),
        hasBestOffer: r.best_offer_enabled === true,
        photoCount: photoCount.get(r.inventory_item_id) ?? 0,
      };
      return {
        row: r,
        suggestion: evaluatePerformance(metrics),
        sellSimilar: sellSimilarEligible(metrics),
      };
    })
    .filter((x) => x.suggestion.code !== "HEALTHY")
    .map(({ row, suggestion, sellSimilar }) => ({
      listing_id: row.id,
      inventory_item_id: row.inventory_item_id,
      title: row.listing_title || row.inventory_items?.title || "Untitled item",
      listing_url: row.listing_url,
      code: suggestion.code as PerformanceSignalCode,
      title_text: suggestion.title,
      message: suggestion.message,
      suggests_price_drop: suggestion.suggestsPriceDrop,
      suggests_best_offer: suggestion.suggestsBestOffer,
      suggests_content_fix: suggestion.suggestsContentFix,
      // US-1899: manual last-resort hint — 90+ days of total zero-engagement.
      sell_similar_eligible: sellSimilar,
    }));

  return c.json({ suggestions });
});

// ── POST /suggestions/:id/apply ───────────────────────────────────
flipdeskPricingRoutes.post("/suggestions/:id/apply", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const outcome = await applyPriceSuggestion(ownerId, c.req.param("id"));
  return c.json(outcome.body, outcome.status as 200);
});

// ── POST /suggestions/:id/dismiss ─────────────────────────────────
flipdeskPricingRoutes.post("/suggestions/:id/dismiss", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const outcome = await dismissPriceSuggestion(ownerId, c.req.param("id"));
  return c.json(outcome.body, outcome.status as 200);
});

// ══════════════════════════════════════════════════════════════════
// Bulk match-to-comp reprice (US-962)
// ══════════════════════════════════════════════════════════════════
// Reprice a SELECTION of listings to their condition-matched comp in one action,
// with a dry-run preview. Preview computes a suggested price per listing off the
// same engine the scan uses; apply pushes to eBay (where an offer exists) and
// writes the local price, never below the cost-basis margin floor. Every query
// is tenant-scoped through inventory_items.user_id (US-268).

type BulkSkipReason = "no_comps" | "below_margin_floor";

interface RepricePreviewRow {
  listing_id: string;
  inventory_item_id: string;
  title: string;
  current_price_cents: number;
  suggested_price_cents: number;
  delta_cents: number;
  comp_count: number;
  comp_median_cents: number | null;
  reason_code: ReasonCode;
  margin_floor_cents: number | null;
  // null = appliable; otherwise why it's excluded from the apply.
  skip: BulkSkipReason | null;
}

function parseListingIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.length > 0 && !ids.includes(v)) ids.push(v);
  }
  return ids.slice(0, MAX_BULK_REPRICE);
}

// Tenant-scoped fetch of the caller's active eBay listings by id — the !inner
// join on inventory_items.user_id is the ownership gate (US-268).
async function loadOwnedRepriceListings(
  ownerId: string,
  listingIds: string[],
): Promise<ListingJoinRow[]> {
  if (listingIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(REPRICE_LISTING_COLUMNS)
    .eq("platform", "ebay")
    .eq("inventory_items.user_id", ownerId)
    .in("id", listingIds);
  if (error) {
    console.error("[repricing] bulk listing fetch failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as ListingJoinRow[];
}

async function buildPreviewRow(
  listing: ListingJoinRow,
): Promise<RepricePreviewRow> {
  const item = listing.inventory_items;
  const currentCents = Math.round(listing.listing_price * 100);
  const floorCents = computeFloorCents(
    item.acquired_price,
    DEFAULT_MARGIN_FLOOR_PCT,
  );
  const base = {
    listing_id: listing.id,
    inventory_item_id: listing.inventory_item_id,
    title: listing.listing_title || item.title || "Untitled item",
    current_price_cents: currentCents,
    margin_floor_cents: floorCents,
  };

  let suggestion: EngineSuggestion | null = null;
  try {
    suggestion = await computeListingSuggestion(listing);
  } catch (err) {
    console.error(
      "[repricing] bulk preview comp failed for listing",
      listing.id,
      err instanceof Error ? err.message : String(err),
    );
  }

  // No category, comp hiccup, or too few comps → can't price; skip it.
  if (!suggestion || suggestion.reasonCode === "NO_COMPS") {
    return {
      ...base,
      suggested_price_cents: currentCents,
      delta_cents: 0,
      comp_count: suggestion?.compCount ?? 0,
      comp_median_cents: suggestion?.compMedianCents ?? null,
      reason_code: "NO_COMPS",
      skip: "no_comps",
    };
  }

  const suggested = suggestion.suggestedPriceCents;
  const belowFloor = floorCents != null && suggested < floorCents;
  return {
    ...base,
    suggested_price_cents: suggested,
    delta_cents: suggested - currentCents,
    comp_count: suggestion.compCount,
    comp_median_cents: suggestion.compMedianCents,
    reason_code: suggestion.reasonCode,
    skip: belowFloor ? "below_margin_floor" : null,
  };
}

// ── POST /reprice/preview ─────────────────────────────────────────
// Dry run: returns current → suggested per selected listing, marking which are
// skipped (no comps / below the margin floor). No writes.
flipdeskPricingRoutes.post("/reprice/preview", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  let body: { listingIds?: unknown };
  try {
    body = (await c.req.json()) as { listingIds?: unknown };
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const requestedCount = Array.isArray(body.listingIds)
    ? body.listingIds.filter((v) => typeof v === "string" && v.length > 0).length
    : 0;
  const listingIds = parseListingIds(body.listingIds);
  if (listingIds.length === 0) {
    return jsonError(c, 400, "Provide at least one listingId.");
  }

  const outcome = await previewRepriceFor(ownerId, listingIds);
  // Tell the UI when we trimmed an oversized selection to the per-call cap.
  return c.json(
    { ...outcome.body, capped: requestedCount > listingIds.length },
    outcome.status as 200,
  );
});

// ── POST /reprice/apply ───────────────────────────────────────────
// Apply confirmed per-item prices: push to eBay (where an offer exists) then
// persist the local price, re-validating ownership + the margin floor server-
// side so a client can never write below the floor.
flipdeskPricingRoutes.post("/reprice/apply", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { items?: unknown };
  try {
    body = (await c.req.json()) as { items?: unknown };
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  // Cap the input array before iterating so an oversized body can't force an
  // unbounded loop (US-1944). The valid set is still capped to
  // MAX_BULK_REPRICE below; MAX_BODY_ARRAY (500) leaves ample room for that.
  const rawItems = capBodyArray(body.items);
  const requested: Array<{ listingId: string; priceCents: number }> = [];
  for (const r of rawItems) {
    if (!r || typeof r !== "object") continue;
    const listingId = (r as { listing_id?: unknown }).listing_id;
    const priceCents = (r as { price_cents?: unknown }).price_cents;
    if (
      typeof listingId === "string" &&
      typeof priceCents === "number" &&
      Number.isFinite(priceCents) &&
      priceCents > 0 &&
      !requested.some((x) => x.listingId === listingId)
    ) {
      requested.push({ listingId, priceCents: Math.round(priceCents) });
    }
  }
  const capped = requested.slice(0, MAX_BULK_REPRICE);
  if (capped.length === 0) {
    return jsonError(c, 400, "No valid items to apply.");
  }

  const outcome = await applyRepriceFor(ownerId, capped);
  return c.json(outcome.body, outcome.status as 200);
});

// ── Cron: scan every owner's active listings ──────────────────────
// Lives OUTSIDE /api/admin and /api/flipdesk so no user-JWT middleware
// intercepts it; mounted in main.ts as POST /api/jobs/reprice-scan and gated by
// the X-Internal-Job-Secret header (same pattern as the GSC sync cron).
export async function handleRepriceScanCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  // US-507: repricing kill-switch — skip the scan (no-op) when disabled.
  if (!(await isFeatureEnabled("repricing"))) {
    return c.json({ ok: true, skipped: true, reason: "feature_disabled" });
  }
  // US-503: a scan fans out one eBay Browse call per listing and can run long;
  // a 10-min lease keeps an overlapping tick from re-scanning + double-writing
  // suggestions. The eBay breaker (US-499) also backs off during an outage.
  const lock = await acquireJobLock("reprice-scan", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await scanListings(null, CRON_SCAN_LIMIT);
    return c.json({ ok: true, ...result });
  } finally {
    await lock.release();
  }
}

// ══════════════════════════════════════════════════════════════════
// Repricing automation rules (US-672)
// ══════════════════════════════════════════════════════════════════

const RULE_COLUMNS =
  "id, name, enabled, inventory_item_id, filter_brand, filter_category_id, " +
  "min_age_days, drop_pct, interval_days, floor_price_cents, " +
  "auto_accept_confidence, override_manual, last_run_at, created_at, updated_at";

interface RuleRow {
  id: string;
  enabled: boolean;
  inventory_item_id: string | null;
  filter_brand: string | null;
  filter_category_id: string | null;
  min_age_days: number;
  drop_pct: number;
  interval_days: number;
  floor_price_cents: number | null;
  auto_accept_confidence: number | null;
  /** US-9205: may this rule move a seller-set price? */
  override_manual: boolean;
}

interface RuleListingRow {
  id: string;
  inventory_item_id: string;
  listing_price: number;
  /** US-9205: who set the current price; "seller" is protected by default. */
  price_set_by: string | null;
  listed_at: string;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  platform_category_id: string | null;
  platform_fields: { markdown_promotion_id?: unknown } | null;
  inventory_items: {
    user_id: string;
    brand: string | null;
    ebay_category_id: string | null;
  };
}

export interface RuleRunResult {
  rules_evaluated: number;
  listings_scanned: number;
  applied: number;
  skipped: number;
  errors: number;
  actions: Array<{
    listing_id: string;
    inventory_item_id: string;
    old_price_cents: number;
    new_price_cents: number;
    reason: string;
    ebay_synced: boolean;
  }>;
}

async function touchRules(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabaseAdmin
    .from("repricing_rules")
    .update({ last_run_at: new Date().toISOString() })
    .in("id", ids);
}

/**
 * Evaluate one owner's enabled rules against their active eBay listings and
 * apply due markdowns. Push to eBay FIRST (US-467) — a failed remote update
 * skips the listing rather than desyncing local vs eBay. First matching, due
 * rule wins per listing (≤ 1 action/listing/run). Every change is logged to
 * repricing_actions.
 */
async function runRulesForOwner(ownerId: string): Promise<RuleRunResult> {
  const result: RuleRunResult = {
    rules_evaluated: 0,
    listings_scanned: 0,
    applied: 0,
    skipped: 0,
    errors: 0,
    actions: [],
  };

  // US-1045: when enabled (default off), a due price drop is pushed as an eBay
  // markdown Sale event (strike-through price + SALE badge + watcher alert)
  // instead of a silent base-price revise. Global toggle via system_settings.
  const useSaleEvents = await getSetting<boolean>(
    "repricing.use_sale_events",
    false,
  );

  const { data: ruleRows } = await supabaseAdmin
    .from("repricing_rules")
    .select(RULE_COLUMNS)
    .eq("user_id", ownerId)
    .eq("enabled", true)
    .order("created_at", { ascending: true });
  const rules = (ruleRows ?? []) as unknown as RuleRow[];
  result.rules_evaluated = rules.length;
  if (rules.length === 0) return result;

  const { data: listingRows } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, listing_price, price_set_by, listed_at, platform_offer_id, platform_listing_id, platform_category_id, platform_fields, " +
        "inventory_items!inner(user_id, brand, ebay_category_id)",
    )
    .eq("platform", "ebay")
    .eq("listing_status", "active")
    .eq("inventory_items.user_id", ownerId)
    .limit(CRON_SCAN_LIMIT);
  const listings = (listingRows ?? []) as unknown as RuleListingRow[];
  result.listings_scanned = listings.length;
  if (listings.length === 0) {
    await touchRules(rules.map((r) => r.id));
    return result;
  }
  const listingIds = listings.map((l) => l.id);

  // Latest action per listing (interval anchor).
  const { data: actionRows } = await supabaseAdmin
    .from("repricing_actions")
    .select("listing_id, created_at")
    .eq("user_id", ownerId)
    .in("listing_id", listingIds)
    .order("created_at", { ascending: false });
  const lastActionByListing = new Map<string, string>();
  for (const a of (actionRows ?? []) as Array<{ listing_id: string; created_at: string }>) {
    if (!lastActionByListing.has(a.listing_id)) {
      lastActionByListing.set(a.listing_id, a.created_at);
    }
  }

  // Pending comp suggestions (for auto-accept).
  const { data: sugRows } = await supabaseAdmin
    .from("repricing_suggestions")
    .select("listing_id, suggested_price_cents, confidence")
    .eq("user_id", ownerId)
    .eq("status", "pending")
    .in("listing_id", listingIds);
  const suggestionByListing = new Map<
    string,
    { suggestedPriceCents: number; confidence: number | null }
  >();
  for (
    const s of (sugRows ?? []) as Array<
      { listing_id: string; suggested_price_cents: number; confidence: number | null }
    >
  ) {
    suggestionByListing.set(s.listing_id, {
      suggestedPriceCents: s.suggested_price_cents,
      confidence: s.confidence,
    });
  }

  const now = new Date();
  for (const listing of listings) {
    const item = listing.inventory_items;
    const facts: ListingFacts = {
      inventoryItemId: listing.inventory_item_id,
      brand: item.brand,
      categoryId: listing.platform_category_id ?? item.ebay_category_id,
      ageDays: daysSince(listing.listed_at),
    };

    // US-9205 AC4: a seller-set price is off limits to a rule that does not
    // say it may move one. Checked inside the match so a second, permitted
    // rule can still take the listing.
    const rule = rules.find(
      (r) =>
        ruleMatchesListing(r, facts) &&
        ruleMayReprice(r, listing) &&
        isDue(
          lastActionByListing.get(listing.id) ?? null,
          listing.listed_at,
          r.interval_days,
          now,
        ),
    );
    if (!rule) {
      result.skipped++;
      continue;
    }

    const currentCents = Math.round(listing.listing_price * 100);
    const decision = decideNewPriceCents({
      currentCents,
      dropPct: rule.drop_pct,
      floorCents: rule.floor_price_cents,
      autoAcceptConfidence: rule.auto_accept_confidence,
      suggestion: suggestionByListing.get(listing.id) ?? null,
    });
    if (!decision) {
      result.skipped++;
      continue;
    }

    const newDollars = decision.newCents / 100;
    const offerId = listing.platform_offer_id;
    const hasLiveOffer = Boolean(offerId) && isEbayConfigured();

    // Sale-event mode: push a markdown promotion at the rule's drop % and leave
    // the base price untouched (markdown is an overlay). Only when the toggle is
    // on, the listing is live on eBay, and it doesn't already have a Sale.
    const alreadyOnSale = typeof listing.platform_fields?.markdown_promotion_id ===
      "string";
    const saleMode = useSaleEvents &&
      isEbayConfigured() &&
      Boolean(listing.platform_listing_id) &&
      !alreadyOnSale;

    if (saleMode) {
      try {
        const promotionId = await createMarkdownSale(ownerId, {
          ebayListingId: listing.platform_listing_id!,
          percentOff: rule.drop_pct,
        });
        const pf = {
          ...(listing.platform_fields ?? {}),
          markdown_promotion_id: promotionId,
          markdown_pct: rule.drop_pct,
        };
        await supabaseAdmin
          .from("listings")
          .update({ platform_fields: pf } as never)
          .eq("id", listing.id);
      } catch (err) {
        result.errors++;
        console.error(
          "[repricing-rules] createMarkdownSale failed for",
          listing.id,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
    } else {
      if (hasLiveOffer) {
        try {
          await updateOfferPrice(ownerId, offerId!, newDollars);
        } catch (err) {
          result.errors++;
          console.error(
            "[repricing-rules] updateOfferPrice failed for",
            listing.id,
            err instanceof Error ? err.message : String(err),
          );
          continue;
        }
      }

      const { error: updErr } = await supabaseAdmin
        .from("listings")
        .update({ listing_price: newDollars, price_is_estimated: false, price_set_by: "rule" })
        .eq("id", listing.id);
      if (updErr) {
        result.errors++;
        continue;
      }
    }

    if (decision.reason === "auto_accept") {
      await supabaseAdmin
        .from("repricing_suggestions")
        .update({ status: "applied", applied_at: now.toISOString() })
        .eq("listing_id", listing.id)
        .eq("user_id", ownerId);
    }

    const ebaySynced = saleMode || hasLiveOffer;
    await supabaseAdmin.from("repricing_actions").insert({
      user_id: ownerId,
      rule_id: rule.id,
      listing_id: listing.id,
      inventory_item_id: listing.inventory_item_id,
      old_price_cents: currentCents,
      new_price_cents: decision.newCents,
      reason: decision.reason,
      ebay_synced: ebaySynced,
    });

    result.applied++;
    result.actions.push({
      listing_id: listing.id,
      inventory_item_id: listing.inventory_item_id,
      old_price_cents: currentCents,
      new_price_cents: decision.newCents,
      reason: decision.reason,
      ebay_synced: ebaySynced,
    });
  }

  await touchRules(rules.map((r) => r.id));
  return result;
}

// ── GET /rules ────────────────────────────────────────────────────
flipdeskPricingRoutes.get("/rules", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("repricing_rules")
    .select(RULE_COLUMNS)
    .eq("user_id", ownerId)
    .order("created_at", { ascending: true });
  if (error) return failSafe(c, 500, "Couldn't load repricing rules.", error, "repricing.rules.list");
  return c.json({ rules: data ?? [] });
});

// ── POST /rules ───────────────────────────────────────────────────
flipdeskPricingRoutes.post("/rules", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const norm = normalizeRuleInput(body);
  if (!norm.ok) return jsonError(c, 400, norm.error);
  const { data, error } = await supabaseAdmin
    .from("repricing_rules")
    .insert({ ...norm.value, user_id: ownerId })
    .select(RULE_COLUMNS)
    .single();
  if (error || !data) return failSafe(c, 500, "Couldn't create the rule.", error, "repricing.rules.create");
  return c.json({ rule: data }, 201);
});

// ── PUT /rules/:id ────────────────────────────────────────────────
flipdeskPricingRoutes.put("/rules/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const norm = normalizeRuleInput(body);
  if (!norm.ok) return jsonError(c, 400, norm.error);
  // Scoped by id AND user_id — never trust the id alone (US-268).
  const { data, error } = await supabaseAdmin
    .from("repricing_rules")
    .update(norm.value)
    .eq("id", id)
    .eq("user_id", ownerId)
    .select(RULE_COLUMNS)
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't update the rule.", error, "repricing.rules.update");
  if (!data) return jsonError(c, 404, "Rule not found");
  return c.json({ rule: data });
});

// ── DELETE /rules/:id ─────────────────────────────────────────────
flipdeskPricingRoutes.delete("/rules/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  const { data: existing } = await supabaseAdmin
    .from("repricing_rules")
    .select("id")
    .eq("id", id)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!existing) return jsonError(c, 404, "Rule not found");
  const { error } = await supabaseAdmin
    .from("repricing_rules")
    .delete()
    .eq("id", id)
    .eq("user_id", ownerId);
  if (error) return failSafe(c, 500, "Couldn't delete the rule.", error, "repricing.rules.delete");
  return c.json({ ok: true });
});

// ── GET /rules/actions ────────────────────────────────────────────
// Recent automatic price changes, for the "applied changes" feed.
flipdeskPricingRoutes.get("/rules/actions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("repricing_actions")
    .select(
      "id, rule_id, listing_id, inventory_item_id, old_price_cents, new_price_cents, reason, ebay_synced, created_at, " +
        "inventory_items(title, brand)",
    )
    .eq("user_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return failSafe(c, 500, "Couldn't load applied changes.", error, "repricing.rules.actions");
  return c.json({ actions: data ?? [] });
});

// ── POST /rules/run ───────────────────────────────────────────────
// On-demand run of the caller's rules (so the user sees automation work now
// instead of waiting for the daily cron).
flipdeskPricingRoutes.post("/rules/run", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!(await isFeatureEnabled("repricing"))) {
    return c.json({ ok: false, skipped: true, reason: "feature_disabled" });
  }
  const result = await runRulesForOwner(ownerId);
  return c.json({ ok: true, ...result });
});

// ── Cron: run every owner's rules ─────────────────────────────────
// Mounted in main.ts as POST /api/jobs/reprice-rules, gated by
// X-Internal-Job-Secret (same pattern as the reprice-scan cron).
export async function handleRepriceRulesCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!(await isFeatureEnabled("repricing"))) {
    return c.json({ ok: true, skipped: true, reason: "feature_disabled" });
  }
  const lock = await acquireJobLock("reprice-rules", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const { data: ownerRows } = await supabaseAdmin
      .from("repricing_rules")
      .select("user_id")
      .eq("enabled", true);
    const owners = Array.from(
      new Set((ownerRows ?? []).map((r) => (r as { user_id: string }).user_id)),
    );
    let applied = 0;
    let ownersRun = 0;
    for (const ownerId of owners) {
      try {
        const r = await runRulesForOwner(ownerId);
        applied += r.applied;
        ownersRun++;
      } catch (err) {
        console.error(
          "[repricing-rules] owner run failed",
          ownerId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return c.json({ ok: true, owners_run: ownersRun, applied });
  } finally {
    await lock.release();
  }
}

// ── US-9117: the four pricing bodies, as functions ─────────────────────────
//
// The HTTP handlers below call these, and lib/reprice-port.ts registers them so
// the connector's reprice tools run the SAME code rather than a second
// implementation. Sliced verbatim out of the handlers; the only rewrites were
// the context reads and the response builders.
//
// ⚠ THE ORDER IN applyReprice IS THE MONEY RULE (US-467): push to eBay FIRST,
// write the local price only if that succeeded. A local write after a failed
// remote update leaves the seller's price disagreeing with the live listing and
// nothing surfaces it.

const json = (
  body: Record<string, unknown>,
  status = 200,
): PricingOutcome => ({ status, body });

const jsonErrorOutcome = (status: number, message: string): PricingOutcome =>
  json({ error: message }, status);

export async function applyPriceSuggestion(
  ownerId: string,
  id: string,
): Promise<PricingOutcome> {
    
  const { data: suggestion } = await supabaseAdmin
    .from("repricing_suggestions")
    .select("id, user_id, listing_id, suggested_price_cents, current_price_cents")
    .eq("id", id)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!suggestion) return json({ error: "Suggestion not found" }, 404);

  const dollars = (suggestion as { suggested_price_cents: number }).suggested_price_cents / 100;
  const listingId = (suggestion as { listing_id: string }).listing_id;

  // Tenant isolation (US-268): don't trust listing_id from the request —
  // re-verify ownership through the parent inventory_item (inner join + user_id
  // filter) so the subsequent update-by-id is provably scoped to this tenant,
  // not just relying on the suggestion-creation invariant. (US-1485: migration
  // 00146 added a trigger-maintained `listings.user_id`, so a direct
  // `.eq("user_id", ownerId)` is also valid for trigger-covered rows; the parent
  // join is kept here since it also holds for any row predating the backfill.)
  const { data: listing } = await supabaseAdmin
    .from("listings")
    .select("id, listing_price, platform_offer_id, inventory_items!inner(user_id)")
    .eq("id", listingId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  if (!listing) return json({ error: "Listing not found" }, 404);

  const offerId = (listing as { platform_offer_id: string | null }).platform_offer_id;
  const hasLiveOffer = Boolean(offerId) && isEbayConfigured();

  // US-9117: read the old price BEFORE the update overwrites it. Prefer the
  // listing's live price; fall back to the price the suggestion was computed
  // against, which is the number the seller was actually shown.
  const listingPrice = (listing as { listing_price: number | null }).listing_price;
  const suggestedFrom = (suggestion as { current_price_cents: number | null })
    .current_price_cents;
  const oldDollars = typeof listingPrice === "number"
    ? listingPrice
    : typeof suggestedFrom === "number"
    ? suggestedFrom / 100
    : null;

  // US-467: push to eBay FIRST. If the remote update fails we must NOT update
  // the local price (which would silently desync local vs eBay) and must NOT
  // mark the suggestion applied — leave it 'pending' so it stays in the list
  // and is retryable, and so the next local<->eBay reconcile doesn't mask the
  // failed apply (local still equals eBay's current price).
  if (hasLiveOffer) {
    try {
      await updateOfferPrice(ownerId, offerId!, dollars);
    } catch (err) {
      const ebayError = err instanceof Error ? err.message : String(err);
      console.error(
        "[repricing] updateOfferPrice failed — suggestion left pending:",
        ebayError,
      );
      return json(
        {
          applied: false,
          ebay_synced: false,
          error: "Couldn't update the price on eBay — left unapplied so you can retry.",
          ebay_error: ebayError,
        },
        502,
      );
    }
  }

  // Remote update succeeded (or there is no live offer to push) — persist the
  // new price locally and mark the suggestion applied.
  const { error: updErr } = await supabaseAdmin
    .from("listings")
    .update({ listing_price: dollars, price_is_estimated: false })
    .eq("id", listingId);
  if (updErr) {
    console.error(`[${"repricing.apply"}] `, updErr);
    return json({ error: "Couldn't save the new price." }, 500);
  }

  await supabaseAdmin
    .from("repricing_suggestions")
    .update({ status: "applied", applied_at: new Date().toISOString() })
    .eq("id", id);

  // The old price travels with the answer. Every caller that has to say "was X,
  // now Y" -- the dashboard row, the connector's audit trail -- otherwise has to
  // go back and read a price this function has already overwritten.
  return json({
    applied: true,
    old_price: oldDollars,
    new_price: dollars,
    ebay_synced: hasLiveOffer,
  });
}

export async function dismissPriceSuggestion(
  ownerId: string,
  id: string,
): Promise<PricingOutcome> {
      const { data, error } = await supabaseAdmin
    .from("repricing_suggestions")
    .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", ownerId)
    .select("id")
    .maybeSingle();
  if (error) {
    console.error(`[${"repricing.dismiss"}] `, error);
    return json({ error: "Couldn't dismiss the suggestion." }, 500);
  }
  if (!data) return jsonErrorOutcome(404, "Suggestion not found");
  return json({ dismissed: true });
}

async function previewRepriceFor(
  ownerId: string,
  listingIds: string[],
): Promise<PricingOutcome> {
  const listings = await loadOwnedRepriceListings(ownerId, listingIds);
  const items: RepricePreviewRow[] = [];
  for (const listing of listings) {
    items.push(await buildPreviewRow(listing));
  }
  return json({ items });
}

async function applyRepriceFor(
  ownerId: string,
  capped: Array<{ listingId: string; priceCents: number }>,
): Promise<PricingOutcome> {
  const listings = await loadOwnedRepriceListings(
    ownerId,
    capped.map((r) => r.listingId),
  );
  const byId = new Map<string, ListingJoinRow>();
  for (const l of listings) byId.set(l.id, l);

  let applied = 0;
  let ebaySynced = 0;
  const skipped: Array<{ listing_id: string; reason: BulkSkipReason | "not_found" }> = [];
  const errors: Array<{ listing_id: string; message: string }> = [];
  const now = new Date().toISOString();

  for (const req of capped) {
    const listing = byId.get(req.listingId);
    if (!listing) {
      skipped.push({ listing_id: req.listingId, reason: "not_found" });
      continue;
    }
    const floor = computeFloorCents(
      listing.inventory_items.acquired_price,
      DEFAULT_MARGIN_FLOOR_PCT,
    );
    if (floor != null && req.priceCents < floor) {
      skipped.push({ listing_id: req.listingId, reason: "below_margin_floor" });
      continue;
    }

    const dollars = req.priceCents / 100;
    const offerId = listing.platform_offer_id;
    const hasLiveOffer = Boolean(offerId) && isEbayConfigured();

    // Push to eBay FIRST (US-467): a failed remote update must not desync the
    // local price, so skip the local write and surface it as a retryable error.
    if (hasLiveOffer) {
      try {
        await updateOfferPrice(ownerId, offerId!, dollars);
      } catch (err) {
        errors.push({
          listing_id: req.listingId,
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    const { error: updErr } = await supabaseAdmin
      .from("listings")
      .update({ listing_price: dollars, price_is_estimated: false })
      .eq("id", req.listingId);
    if (updErr) {
      errors.push({ listing_id: req.listingId, message: updErr.message });
      continue;
    }

    // Clear any pending comp suggestion for this listing so the nudges feed
    // doesn't re-surface a price the user just acted on.
    await supabaseAdmin
      .from("repricing_suggestions")
      .update({ status: "applied", applied_at: now })
      .eq("listing_id", req.listingId)
      .eq("user_id", ownerId);

    applied++;
    if (hasLiveOffer) ebaySynced++;
  }

  return json({ applied, ebay_synced: ebaySynced, skipped, errors });
}

// The port adapters. Registered at module load; main.ts imports this module, so
// any request that can reach a tool has already run this.
registerRepricer({
  preview: async (ownerId, listingIds) => {
    const ids = parseListingIds(listingIds);
    const outcome = await previewRepriceFor(ownerId, ids);
    return {
      items: (outcome.body.items ?? []) as RepriceRow[],
      capped: listingIds.length > ids.length,
    };
  },
  apply: async (ownerId, items) => {
    // Normalised the same way the route normalises a request body: positive
    // integers only, first occurrence of a listing id wins, capped.
    const requested: Array<{ listingId: string; priceCents: number }> = [];
    for (const r of items) {
      if (
        typeof r.listing_id === "string" &&
        Number.isFinite(r.price_cents) &&
        r.price_cents > 0 &&
        !requested.some((x) => x.listingId === r.listing_id)
      ) {
        requested.push({ listingId: r.listing_id, priceCents: Math.round(r.price_cents) });
      }
    }
    const outcome = await applyRepriceFor(ownerId, requested.slice(0, MAX_BULK_REPRICE));
    return outcome.body as unknown as RepriceApplyResult;
  },
  applySuggestion: applyPriceSuggestion,
  dismissSuggestion: dismissPriceSuggestion,
});


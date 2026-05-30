import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  isEbayConfigured,
  searchBrowseComps,
  updateOfferPrice,
} from "../lib/ebay-client.ts";
import {
  computeSuggestion,
  gradeToConditionId,
  type ReasonCode,
} from "../lib/repricing.ts";

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

// Reason codes that are worth surfacing as a nudge. OK / NO_COMPS are not.
const ACTIONABLE: ReasonCode[] = ["UNDERPRICED", "OVERPRICED", "STALE"];

interface ListingJoinRow {
  id: string;
  inventory_item_id: string;
  listing_price: number;
  listed_at: string;
  watchers: number;
  views: number;
  platform_offer_id: string | null;
  platform_category_id: string | null;
  inventory_items: {
    user_id: string;
    ebay_category_id: string | null;
    grade_value: number | null;
    brand: string | null;
    size: string | null;
    title: string | null;
  };
}

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
    .select(
      "id, inventory_item_id, listing_price, listed_at, watchers, views, platform_offer_id, platform_category_id, " +
        "inventory_items!inner(user_id, ebay_category_id, grade_value, brand, size, title)",
    )
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
    const categoryId = listing.platform_category_id ?? item.ebay_category_id;
    if (!categoryId) {
      result.skipped_no_category++;
      continue;
    }

    try {
      const comps = await searchBrowseComps({
        categoryId,
        q: item.brand ?? item.title ?? undefined,
        brand: item.brand ?? undefined,
        size: item.size ?? undefined,
        conditionId: gradeToConditionId(item.grade_value),
      });

      const suggestion = computeSuggestion({
        currentPriceCents: Math.round(listing.listing_price * 100),
        gradeValue: item.grade_value,
        stats: comps.stats,
        listingAgeDays: daysSince(listing.listed_at),
        watchers: listing.watchers ?? 0,
        views: listing.views ?? 0,
      });

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
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ suggestions: data ?? [] });
});

// ── POST /suggestions/:id/apply ───────────────────────────────────
flipdeskPricingRoutes.post("/suggestions/:id/apply", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");

  const { data: suggestion } = await supabaseAdmin
    .from("repricing_suggestions")
    .select("id, user_id, listing_id, suggested_price_cents")
    .eq("id", id)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!suggestion) return c.json({ error: "Suggestion not found" }, 404);

  const dollars = (suggestion as { suggested_price_cents: number }).suggested_price_cents / 100;
  const listingId = (suggestion as { listing_id: string }).listing_id;

  // The listing is owned (suggestion.user_id === owner), so updating it by id
  // is tenant-safe.
  const { data: listing } = await supabaseAdmin
    .from("listings")
    .select("id, platform_offer_id")
    .eq("id", listingId)
    .maybeSingle();
  if (!listing) return c.json({ error: "Listing not found" }, 404);

  const { error: updErr } = await supabaseAdmin
    .from("listings")
    .update({ listing_price: dollars, price_is_estimated: false })
    .eq("id", listingId);
  if (updErr) return c.json({ error: updErr.message }, 500);

  // Push the new price to eBay if this is a live offer.
  let ebaySynced = false;
  let ebayError: string | null = null;
  const offerId = (listing as { platform_offer_id: string | null }).platform_offer_id;
  if (offerId && isEbayConfigured()) {
    try {
      await updateOfferPrice(ownerId, offerId, dollars);
      ebaySynced = true;
    } catch (err) {
      ebayError = err instanceof Error ? err.message : String(err);
      console.error("[repricing] updateOfferPrice failed:", ebayError);
    }
  }

  await supabaseAdmin
    .from("repricing_suggestions")
    .update({ status: "applied", applied_at: new Date().toISOString() })
    .eq("id", id);

  return c.json({ applied: true, new_price: dollars, ebay_synced: ebaySynced, ebay_error: ebayError });
});

// ── POST /suggestions/:id/dismiss ─────────────────────────────────
flipdeskPricingRoutes.post("/suggestions/:id/dismiss", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("repricing_suggestions")
    .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", ownerId)
    .select("id")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Suggestion not found" }, 404);
  return c.json({ dismissed: true });
});

// ── Cron: scan every owner's active listings ──────────────────────
// Lives OUTSIDE /api/admin and /api/flipdesk so no user-JWT middleware
// intercepts it; mounted in main.ts as POST /api/jobs/reprice-scan and gated by
// the X-Internal-Job-Secret header (same pattern as the GSC sync cron).
export async function handleRepriceScanCron(c: Context): Promise<Response> {
  const expected = Deno.env.get("FLIPDESK_INTERNAL_JOB_SECRET");
  const provided = c.req.header("X-Internal-Job-Secret");
  if (!expected || provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const result = await scanListings(null, CRON_SCAN_LIMIT);
  return c.json({ ok: true, ...result });
}

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
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
} from "../lib/repricing.ts";
import { valueAtGrade } from "../lib/condition-value.ts";
import { forecastSellThrough } from "../lib/sell-through.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import {
  decideNewPriceCents,
  isDue,
  type ListingFacts,
  normalizeRuleInput,
  ruleMatchesListing,
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

  const offerId = (listing as { platform_offer_id: string | null }).platform_offer_id;
  const hasLiveOffer = Boolean(offerId) && isEbayConfigured();

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
      return c.json(
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
  if (updErr) return failSafe(c, 500, "Couldn't save the new price.", updErr, "repricing.apply");

  await supabaseAdmin
    .from("repricing_suggestions")
    .update({ status: "applied", applied_at: new Date().toISOString() })
    .eq("id", id);

  return c.json({ applied: true, new_price: dollars, ebay_synced: hasLiveOffer });
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
  if (error) return failSafe(c, 500, "Couldn't dismiss the suggestion.", error, "repricing.dismiss");
  if (!data) return jsonError(c, 404, "Suggestion not found");
  return c.json({ dismissed: true });
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
  "auto_accept_confidence, last_run_at, created_at, updated_at";

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
}

interface RuleListingRow {
  id: string;
  inventory_item_id: string;
  listing_price: number;
  listed_at: string;
  platform_offer_id: string | null;
  platform_category_id: string | null;
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
      "id, inventory_item_id, listing_price, listed_at, platform_offer_id, platform_category_id, " +
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

    const rule = rules.find(
      (r) =>
        ruleMatchesListing(r, facts) &&
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
      .update({ listing_price: newDollars, price_is_estimated: false })
      .eq("id", listing.id);
    if (updErr) {
      result.errors++;
      continue;
    }

    if (decision.reason === "auto_accept") {
      await supabaseAdmin
        .from("repricing_suggestions")
        .update({ status: "applied", applied_at: now.toISOString() })
        .eq("listing_id", listing.id)
        .eq("user_id", ownerId);
    }

    await supabaseAdmin.from("repricing_actions").insert({
      user_id: ownerId,
      rule_id: rule.id,
      listing_id: listing.id,
      inventory_item_id: listing.inventory_item_id,
      old_price_cents: currentCents,
      new_price_cents: decision.newCents,
      reason: decision.reason,
      ebay_synced: hasLiveOffer,
    });

    result.applied++;
    result.actions.push({
      listing_id: listing.id,
      inventory_item_id: listing.inventory_item_id,
      old_price_cents: currentCents,
      new_price_cents: decision.newCents,
      reason: decision.reason,
      ebay_synced: hasLiveOffer,
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

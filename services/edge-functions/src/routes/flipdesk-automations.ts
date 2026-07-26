import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import {
  isEbayConfigured,
  updateOfferPrice,
  withdrawOffer,
} from "../lib/ebay-client.ts";
import {
  createItemPromotion,
  generateCouponCode,
} from "../lib/ebay-marketing.ts";
import { filterListablePhotos } from "../lib/item-photo-storage.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import { featureAllowedForUser, requireFlipdesk } from "../lib/plan-gate.ts";
import { resyncItemListedStatus } from "../lib/active-listings.ts";
import {
  type AutomationAction,
  type AutomationFacts,
  type AutomationScope,
  type AutomationTrigger,
  isCooledDown,
  normalizeAutomationInput,
  planAction,
  type PlannedAction,
  scopeMatches,
  triggerMatches,
  type ViewWindow,
} from "../lib/automation-rules.ts";

// Price-drop and promo scheduler (US-150). User-defined rules over active
// eBay listings: trigger (days listed / no views / low watchers) + action
// (price drop %, promo rate %, end listing) + scope (all, or a US-143 filter).
// The hourly cron applies due actions through the same code paths the manual
// endpoints use (updateOfferPrice / withdrawOffer — push to eBay FIRST per
// US-467 so a failed remote update never desyncs local state). The promo-rate
// action is local-first: eBay's Marketing API push is deferred, same precedent
// as US-141's promote action.
//
// US-268: listings/items carry no user_id of their own here — every query
// joins through inventory_items.user_id, and action rows are stamped with the
// owning user_id.

export const flipdeskAutomationsRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

const RULE_COLUMNS =
  "id, name, trigger_json, action_json, scope_json, is_active, last_run_at, created_at, updated_at";

// Bound per-owner work; end_listing/price_drop cost one eBay call per action.
const OWNER_LISTING_LIMIT = 500;

interface AutomationRuleRow {
  id: string;
  name: string;
  trigger_json: AutomationTrigger;
  action_json: AutomationAction;
  scope_json: AutomationScope;
  is_active: boolean;
  last_run_at: string | null;
  created_at: string;
}

interface AutomationListingRow {
  id: string;
  inventory_item_id: string;
  listing_price: number;
  listed_at: string;
  watchers: number | null;
  views: number | null;
  last_metrics_synced_at: string | null;
  platform_offer_id: string | null;
  platform_listing_id: string | null;
  promo_rate_pct: number | null;
  inventory_items: {
    user_id: string;
    title: string | null;
    brand: string | null;
    size: string | null;
    item_category: string | null;
    garment_category: string | null;
    acquired_price: number | null;
    target_price: number | null;
    status: string | null;
    grade_value: number | null;
    updated_at: string | null;
    exclude_from_automations: boolean;
    sources: { name: string | null } | null;
  };
}

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function listingFacts(
  l: AutomationListingRow,
  viewWindows: Map<string, ViewWindow[]>,
): AutomationFacts {
  const item = l.inventory_items;
  return {
    ageDays: daysSince(l.listed_at),
    views: l.views ?? 0,
    metricsSyncedDaysAgo: l.last_metrics_synced_at
      ? daysSince(l.last_metrics_synced_at)
      : null,
    recentViewWindows: viewWindows.get(l.id) ?? [],
    watchers: l.watchers ?? 0,
    brand: item.brand,
    category: item.item_category ?? item.garment_category,
    size: item.size,
    sourceName: item.sources?.name ?? null,
    cost: item.acquired_price,
    targetPrice: item.target_price,
    status: item.status,
    grade: item.grade_value,
    daysInStatus: item.updated_at ? daysSince(item.updated_at) : null,
  };
}

async function loadOwnerListings(
  ownerId: string,
): Promise<AutomationListingRow[]> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, listing_price, listed_at, watchers, views, last_metrics_synced_at, platform_offer_id, platform_listing_id, promo_rate_pct, " +
        "inventory_items!inner(user_id, title, brand, size, item_category, garment_category, acquired_price, target_price, status, grade_value, updated_at, exclude_from_automations, sources(name))",
    )
    .eq("platform", "ebay")
    .eq("listing_status", "active")
    .eq("inventory_items.user_id", ownerId)
    .limit(OWNER_LISTING_LIMIT);
  if (error) {
    console.error("[automations] listing query failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as AutomationListingRow[];
}

/**
 * US-2155: per-listing traffic readings for the no_views_in_days trigger.
 *
 * Only fetched when at least one active rule actually asks for it (see
 * maxViewWindowDays) — the common all-aging ruleset pays nothing. The lookback
 * is the widest window any rule needs, so one query serves every rule.
 */
async function loadViewWindows(
  ownerId: string,
  listingIds: string[],
  lookbackDays: number,
): Promise<Map<string, ViewWindow[]>> {
  const map = new Map<string, ViewWindow[]>();
  if (listingIds.length === 0) return map;
  const since = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data, error } = await supabaseAdmin
    .from("listing_metrics")
    .select("listing_id, metric_date, views")
    .eq("user_id", ownerId)
    .in("listing_id", listingIds)
    .gte("metric_date", since)
    .order("metric_date", { ascending: false });
  if (error) {
    // Fail open: an empty map degrades to the lifetime-counter fallback rather
    // than silently firing price drops on listings we know nothing about.
    console.error("[automations] listing_metrics query failed:", error.message);
    return map;
  }
  for (
    const row of (data ?? []) as Array<
      { listing_id: string; metric_date: string; views: number | null }
    >
  ) {
    const list = map.get(row.listing_id) ?? [];
    list.push({
      daysAgo: daysSince(row.metric_date),
      views: row.views ?? 0,
    });
    map.set(row.listing_id, list);
  }
  return map;
}

/** Widest no_views_in_days window across the active rules, or 0 if none use it. */
function maxViewWindowDays(rules: AutomationRuleRow[]): number {
  let max = 0;
  for (const r of rules) {
    if (r.trigger_json.type === "no_views_in_days") {
      max = Math.max(max, r.trigger_json.days);
    }
  }
  return max;
}

/** Latest action timestamp per "<ruleId>:<listingId>" — the cooldown anchor. */
async function loadLastActionMap(
  ownerId: string,
  listingIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (listingIds.length === 0) return map;
  const { data } = await supabaseAdmin
    .from("flipdesk_automation_actions")
    .select("rule_id, listing_id, created_at")
    .eq("user_id", ownerId)
    .in("listing_id", listingIds)
    .order("created_at", { ascending: false })
    .limit(2000);
  for (
    const a of (data ?? []) as Array<
      { rule_id: string; listing_id: string | null; created_at: string }
    >
  ) {
    if (!a.listing_id) continue;
    const key = `${a.rule_id}:${a.listing_id}`;
    if (!map.has(key)) map.set(key, a.created_at);
  }
  return map;
}

export interface AutomationMatch {
  rule_id: string;
  rule_name: string;
  listing_id: string;
  inventory_item_id: string;
  title: string | null;
  action_type: AutomationAction["type"];
  current_price_cents: number;
  new_price_cents: number | null;
  current_promo_rate_pct: number | null;
  new_promo_rate_pct: number | null;
  floored: boolean;
}

function describeMatch(
  rule: AutomationRuleRow,
  listing: AutomationListingRow,
  planned: PlannedAction,
): AutomationMatch {
  return {
    rule_id: rule.id,
    rule_name: rule.name,
    listing_id: listing.id,
    inventory_item_id: listing.inventory_item_id,
    title: listing.inventory_items.title,
    action_type: rule.action_json.type,
    current_price_cents: Math.round(listing.listing_price * 100),
    new_price_cents: planned.kind === "price_drop" ? planned.newCents : null,
    current_promo_rate_pct: listing.promo_rate_pct,
    new_promo_rate_pct: planned.kind === "set_promo_rate" ? planned.newRatePct : null,
    floored: planned.kind === "price_drop" ? planned.floored : false,
  };
}

/**
 * Evaluate `rules` (in creation order) against one owner's active eBay
 * listings. First matching, cooled-down rule wins per listing — at most one
 * action per listing per run, so stacked rules can't compound markdowns in a
 * single pass. Returns the planned matches; applies nothing.
 */
async function evaluateRules(
  ownerId: string,
  rules: AutomationRuleRow[],
  listings: AutomationListingRow[],
): Promise<
  Array<{
    rule: AutomationRuleRow;
    listing: AutomationListingRow;
    planned: PlannedAction;
  }>
> {
  const matches: Array<{
    rule: AutomationRuleRow;
    listing: AutomationListingRow;
    planned: PlannedAction;
  }> = [];
  if (rules.length === 0 || listings.length === 0) return matches;
  const listingIds = listings.map((l) => l.id);
  const lookbackDays = maxViewWindowDays(rules);
  const [lastAction, viewWindows] = await Promise.all([
    loadLastActionMap(ownerId, listingIds),
    lookbackDays > 0
      ? loadViewWindows(ownerId, listingIds, lookbackDays)
      : Promise.resolve(new Map<string, ViewWindow[]>()),
  ]);
  const now = new Date();
  for (const listing of listings) {
    if (listing.inventory_items.exclude_from_automations) continue;
    const facts = listingFacts(listing, viewWindows);
    for (const rule of rules) {
      if (!scopeMatches(rule.scope_json, facts)) continue;
      if (!triggerMatches(rule.trigger_json, facts)) continue;
      if (
        !isCooledDown(
          lastAction.get(`${rule.id}:${listing.id}`) ?? null,
          rule.trigger_json.cooldown_days,
          now,
        )
      ) continue;
      const planned = planAction(rule.action_json, {
        currentCents: Math.round(listing.listing_price * 100),
        costBasisDollars: listing.inventory_items.acquired_price,
        currentPromoRatePct: listing.promo_rate_pct,
      });
      if (!planned) continue;
      matches.push({ rule, listing, planned });
      break; // first matching rule wins for this listing
    }
  }
  return matches;
}

export interface AutomationRunResult {
  rules_evaluated: number;
  listings_scanned: number;
  applied: number;
  errors: number;
}

/** Apply one planned action. Returns false when the eBay push failed (skipped). */
// US-1454: an end-listing automation only counts as "applied" when BOTH local
// writes succeed — mark the listing ended and return the item to 'drafted'. The
// eBay withdraw runs FIRST (US-467), so if a local write then fails we must NOT
// record a successful automation-action; otherwise a listing ended on eBay but
// still active locally is silently logged as applied. Returning false on either
// write error aborts the action exactly like the price_drop/set_promo_rate
// branches do on their write errors.
export function endListingWritesApplied(
  ...writeErrors: Array<{ message?: string } | null | undefined>
): boolean {
  return writeErrors.every((e) => !e);
}

async function applyMatch(
  ownerId: string,
  m: { rule: AutomationRuleRow; listing: AutomationListingRow; planned: PlannedAction },
): Promise<boolean> {
  const { rule, listing, planned } = m;
  const offerId = listing.platform_offer_id;
  const hasLiveOffer = Boolean(offerId) && isEbayConfigured();
  const currentCents = Math.round(listing.listing_price * 100);

  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  let ebaySynced = false;

  if (planned.kind === "price_drop") {
    const newDollars = planned.newCents / 100;
    if (hasLiveOffer) {
      try {
        await updateOfferPrice(ownerId, offerId!, newDollars);
        ebaySynced = true;
      } catch (err) {
        console.error(
          "[automations] updateOfferPrice failed for",
          listing.id,
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    }
    const { error } = await supabaseAdmin
      .from("listings")
      .update({ listing_price: newDollars, price_is_estimated: false })
      .eq("id", listing.id);
    if (error) return false;
    before = { price_cents: currentCents };
    after = { price_cents: planned.newCents, floored: planned.floored };
  } else if (planned.kind === "set_promo_rate") {
    // Local-first — no eBay Marketing API client yet (see module header).
    const { error } = await supabaseAdmin
      .from("listings")
      .update({ promo_rate_pct: planned.newRatePct })
      .eq("id", listing.id);
    if (error) return false;
    before = { promo_rate_pct: listing.promo_rate_pct };
    after = { promo_rate_pct: planned.newRatePct };
  } else if (planned.kind === "create_coupon") {
    // US-1448: aged-inventory coded coupon. Requires a LIVE eBay listing id
    // and a public cover photo (eBay mandates a promotion image for
    // CODED_COUPON). Any missing prerequisite or eBay failure skips the
    // action (returns false) — the cooldown retries on a later run.
    const liveListingId = listing.platform_listing_id;
    if (!liveListingId || !isEbayConfigured()) return false;
    const { data: photoRows } = await supabaseAdmin
      .from("item_photos")
      .select("photo_url, photo_type, sort_order")
      .eq("inventory_item_id", listing.inventory_item_id)
      .order("sort_order", { ascending: true })
      .limit(10);
    const cover = filterListablePhotos(
      (photoRows ?? []) as Array<{
        photo_url: string | null;
        photo_type: string | null;
      }>,
    ).find((pht) => !!pht.photo_url)?.photo_url;
    if (!cover) return false;
    const couponCode = generateCouponCode();
    try {
      const promotionId = await createItemPromotion(ownerId, {
        type: "CODED_COUPON",
        name: `FlipDesk ${planned.discountPct}% coupon ${couponCode}`,
        listingIds: [liveListingId],
        percentOff: planned.discountPct,
        promotionImageUrl: cover,
        couponCode,
        startDate: new Date().toISOString(),
      });
      if (!promotionId) return false;
      before = {};
      after = {
        promotion_id: promotionId,
        coupon_code: couponCode,
        discount_pct: planned.discountPct,
      };
      ebaySynced = true;
    } catch (err) {
      console.error(
        "[automations] createItemPromotion failed for",
        listing.id,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  } else {
    if (hasLiveOffer) {
      try {
        await withdrawOffer(ownerId, offerId!);
        ebaySynced = true;
      } catch (err) {
        console.error(
          "[automations] withdrawOffer failed for",
          listing.id,
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    }
    const { error: endErr } = await supabaseAdmin
      .from("listings")
      .update({ listing_status: "ended", is_active: false })
      .eq("id", listing.id);
    // Back to drafted so the user can relist — same as the manual end-early.
    // US-2179: only once nothing is live anywhere, so ending the eBay listing of
    // a cross-listed item neither frees an activeListings cap slot the seller is
    // still using nor files a still-selling item under Drafts. Also tenant-scopes
    // the item write, which the bare .eq("id", …) here did not (US-268).
    const itemErr = await resyncItemListedStatus(
      listing.inventory_item_id,
      ownerId,
    );
    // US-1454: don't record a successful action if the local writes failed — the
    // eBay offer is already withdrawn, so a false "applied" hides the desync.
    if (!endListingWritesApplied(endErr, itemErr)) {
      console.error(
        "[automations] end_listing local write failed for",
        listing.id,
        (endErr ?? itemErr)?.message,
      );
      return false;
    }
    before = { listing_status: "active", price_cents: currentCents };
    after = { listing_status: "ended" };
  }

  await supabaseAdmin.from("flipdesk_automation_actions").insert({
    rule_id: rule.id,
    user_id: ownerId,
    listing_id: listing.id,
    inventory_item_id: listing.inventory_item_id,
    action_type: rule.action_json.type,
    before_json: before,
    after_json: after,
    ebay_synced: ebaySynced,
  });
  return true;
}

async function runRulesForOwner(ownerId: string): Promise<AutomationRunResult> {
  const { data: ruleRows } = await supabaseAdmin
    .from("flipdesk_automation_rules")
    .select(RULE_COLUMNS)
    .eq("user_id", ownerId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  const rules = (ruleRows ?? []) as unknown as AutomationRuleRow[];
  const result: AutomationRunResult = {
    rules_evaluated: rules.length,
    listings_scanned: 0,
    applied: 0,
    errors: 0,
  };
  if (rules.length === 0) return result;

  const listings = await loadOwnerListings(ownerId);
  result.listings_scanned = listings.length;

  const matches = await evaluateRules(ownerId, rules, listings);
  for (const m of matches) {
    const ok = await applyMatch(ownerId, m);
    if (ok) result.applied++;
    else result.errors++;
  }

  await supabaseAdmin
    .from("flipdesk_automation_rules")
    .update({ last_run_at: new Date().toISOString() })
    .in("id", rules.map((r) => r.id));
  return result;
}

// ── GET /rules ────────────────────────────────────────────────────
flipdeskAutomationsRoutes.get("/rules", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("flipdesk_automation_rules")
    .select(RULE_COLUMNS)
    .eq("user_id", ownerId)
    .order("created_at", { ascending: true });
  if (error) return failSafe(c, 500, "Couldn't load automation rules.", error, "automations.list");
  return c.json({ rules: data ?? [] });
});

// ── POST /rules ───────────────────────────────────────────────────
flipdeskAutomationsRoutes.post("/rules", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  // Scheduled price-drop/promo/end rules are a Pro+ feature (US-208).
  const gate = await requireFlipdesk(c, { feature: "scheduledActions", userId: ownerId });
  if (gate) return gate;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const norm = normalizeAutomationInput(body);
  if (!norm.ok) return jsonError(c, 400, norm.error);
  const { data, error } = await supabaseAdmin
    .from("flipdesk_automation_rules")
    .insert({ ...norm.value, user_id: ownerId })
    .select(RULE_COLUMNS)
    .single();
  if (error || !data) return failSafe(c, 500, "Couldn't create the rule.", error, "automations.create");
  return c.json({ rule: data }, 201);
});

// ── PUT /rules/:id ────────────────────────────────────────────────
flipdeskAutomationsRoutes.put("/rules/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const gate = await requireFlipdesk(c, { feature: "scheduledActions", userId: ownerId });
  if (gate) return gate;
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const norm = normalizeAutomationInput(body);
  if (!norm.ok) return jsonError(c, 400, norm.error);
  // Scoped by id AND user_id — never trust the id alone (US-268).
  const { data, error } = await supabaseAdmin
    .from("flipdesk_automation_rules")
    .update(norm.value)
    .eq("id", id)
    .eq("user_id", ownerId)
    .select(RULE_COLUMNS)
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't update the rule.", error, "automations.update");
  if (!data) return jsonError(c, 404, "Rule not found");
  return c.json({ rule: data });
});

// ── PATCH /rules/:id ──────────────────────────────────────────────
// Minimal partial update — currently only the `is_active` toggle (US-1267).
// Unlike the full-replace PUT, this writes ONLY the supplied field, so toggling
// a rule's enablement can't clobber a concurrent edit to its trigger/action/
// scope (whoever wrote those fields last keeps them) nor server-managed columns
// (last_run_at). Returns the full freshly-read rule so the client re-syncs to
// server truth. Scoped by id AND user_id — never trust the id alone (US-268).
flipdeskAutomationsRoutes.patch("/rules/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  // iOS sends camelCase encoded to snake_case (`is_active`); accept either.
  const patch: { is_active?: boolean } = {};
  const rec = (body ?? {}) as Record<string, unknown>;
  const rawActive = "is_active" in rec ? rec.is_active : rec.isActive;
  if (rawActive !== undefined) {
    if (typeof rawActive !== "boolean") {
      return jsonError(c, 400, "is_active must be a boolean");
    }
    patch.is_active = rawActive;
  }
  if (Object.keys(patch).length === 0) {
    return jsonError(c, 400, "No supported fields to update");
  }
  const { data, error } = await supabaseAdmin
    .from("flipdesk_automation_rules")
    .update(patch)
    .eq("id", id)
    .eq("user_id", ownerId)
    .select(RULE_COLUMNS)
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't update the rule.", error, "automations.patch");
  if (!data) return jsonError(c, 404, "Rule not found");
  return c.json({ rule: data });
});

// ── DELETE /rules/:id ─────────────────────────────────────────────
flipdeskAutomationsRoutes.delete("/rules/:id", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("flipdesk_automation_rules")
    .delete()
    .eq("id", id)
    .eq("user_id", ownerId)
    .select("id")
    .maybeSingle();
  if (error) return failSafe(c, 500, "Couldn't delete the rule.", error, "automations.delete");
  if (!data) return jsonError(c, 404, "Rule not found");
  return c.json({ ok: true });
});

// ── POST /rules/:id/dry-run ───────────────────────────────────────
// Which listings WOULD this rule touch right now, and with what before/after —
// applies nothing. Evaluates only the requested rule (other rules don't
// compete), but exclusions, cooldowns, and the margin floor all apply.
flipdeskAutomationsRoutes.post("/rules/:id/dry-run", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  const { data: ruleRow } = await supabaseAdmin
    .from("flipdesk_automation_rules")
    .select(RULE_COLUMNS)
    .eq("id", id)
    .eq("user_id", ownerId)
    .maybeSingle();
  if (!ruleRow) return jsonError(c, 404, "Rule not found");
  const rule = ruleRow as unknown as AutomationRuleRow;
  const listings = await loadOwnerListings(ownerId);
  const matches = await evaluateRules(ownerId, [rule], listings);
  return c.json({
    dry_run: true,
    listings_scanned: listings.length,
    affected: matches.map((m) => describeMatch(m.rule, m.listing, m.planned)),
  });
});

// ── GET /rules/:id/actions ────────────────────────────────────────
// Per-rule activity log: the last 50 actions taken (before/after + timestamp).
flipdeskAutomationsRoutes.get("/rules/:id/actions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const id = c.req.param("id");
  const { data, error } = await supabaseAdmin
    .from("flipdesk_automation_actions")
    .select(
      "id, rule_id, listing_id, inventory_item_id, action_type, before_json, after_json, ebay_synced, created_at, " +
        "inventory_items(title, brand)",
    )
    .eq("user_id", ownerId)
    .eq("rule_id", id)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return failSafe(c, 500, "Couldn't load the activity log.", error, "automations.actions");
  return c.json({ actions: data ?? [] });
});

// ── POST /run ─────────────────────────────────────────────────────
// On-demand run of the caller's active rules, so automation is verifiable
// immediately instead of waiting for the hourly cron.
flipdeskAutomationsRoutes.post("/run", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const gate = await requireFlipdesk(c, { feature: "scheduledActions", userId: ownerId });
  if (gate) return gate;
  // Shares the repricing kill-switch — same domain (automated price changes).
  if (!(await isFeatureEnabled("repricing"))) {
    return c.json({ ok: false, skipped: true, reason: "feature_disabled" });
  }
  const result = await runRulesForOwner(ownerId);
  return c.json({ ok: true, ...result });
});

// ── Cron: hourly, every owner's active rules ──────────────────────
// Mounted in main.ts as POST /api/jobs/automation-rules, gated by
// X-Internal-Job-Secret (same pattern as reprice-rules).
export async function handleAutomationRulesCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (!(await isFeatureEnabled("repricing"))) {
    return c.json({ ok: true, skipped: true, reason: "feature_disabled" });
  }
  const lock = await acquireJobLock("automation-rules", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const { data: ownerRows } = await supabaseAdmin
      .from("flipdesk_automation_rules")
      .select("user_id")
      .eq("is_active", true);
    const owners = Array.from(
      new Set((ownerRows ?? []).map((r) => (r as { user_id: string }).user_id)),
    );
    let applied = 0;
    let ownersRun = 0;
    let ownersSkippedPlan = 0;
    for (const ownerId of owners) {
      // Don't grandfather a paid feature: if the owner has since dropped below
      // the plan that grants scheduledActions (downgrade / cancel / paused /
      // expired trial), skip their rules instead of running them for free.
      if (!(await featureAllowedForUser(ownerId, "scheduledActions"))) {
        ownersSkippedPlan++;
        continue;
      }
      try {
        const r = await runRulesForOwner(ownerId);
        applied += r.applied;
        ownersRun++;
      } catch (err) {
        console.error(
          "[automations] owner run failed",
          ownerId,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return c.json({
      ok: true,
      owners_run: ownersRun,
      owners_skipped_plan: ownersSkippedPlan,
      applied,
    });
  } finally {
    await lock.release();
  }
}

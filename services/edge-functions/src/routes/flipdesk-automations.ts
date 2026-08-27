import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import {
  isEbayConfigured,
  isNegotiationScopeAvailable,
  isNoEbayConnectionError,
  isOfferAlreadyEndedError,
  sendOfferToInterestedBuyers,
  updateOfferPrice,
  withdrawOffer,
} from "../lib/ebay-client.ts";
import {
  type CrossPushDraft,
  crossPushPlatform,
  ensureCrossListingGroup,
} from "../lib/cross-push.ts";
import type { CrossListingPlatform } from "../lib/marketplace-adapters/index.ts";
import type { StoredPlatformVariant } from "../lib/cross-listing-fields.ts";
import { notifyUser } from "../lib/notify.ts";
import { getBestOffers, respondToBestOffer } from "../lib/ebay-trading.ts";
import {
  claimMarketplaceEvent,
  notifyOfferResponded,
  releaseMarketplaceEvent,
} from "../lib/marketplace-event-notify.ts";
import {
  decideReturnRule,
  type ReturnRuleDecision,
  type ReturnRuleFacts,
} from "../lib/return-rules.ts";
import {
  decideReturn,
  issueReturnRefund,
} from "../lib/ebay-postorder.ts";
import {
  markPostSaleCaseClosed,
  updatePostSaleCaseState,
} from "../lib/post-sale-store.ts";
import { writeSystemAuditLog } from "../lib/audit-log.ts";
import { selectMarkdownItems } from "../lib/markdown-rules.ts";
import { loadMarkdownCandidates } from "../lib/markdown-candidates.ts";
import {
  createMarkdownSale,
  getItemPromotions,
  updateMarkdownSale,
} from "../lib/ebay-marketing.ts";
import { recordOfferResponse, recordOffers } from "../lib/offer-store.ts";
import {
  decideOffer,
  describeOfferOutcome,
  type OfferDecision,
} from "../lib/offer-rules.ts";
import {
  createAdForListing,
  createItemPromotion,
  ensureAdCampaign,
  generateCouponCode,
  getAdForListing,
  updateAdRateForListing,
} from "../lib/ebay-marketing.ts";
import { filterListablePhotos } from "../lib/item-photo-storage.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import { featureAllowedForUser, requireFlipdesk } from "../lib/plan-gate.ts";
import {
  markItemListed,
  resyncItemListedStatus,
} from "../lib/active-listings.ts";
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
// action (US-2232) pushes the Promoted Listings bid to eBay's Marketing API
// first (ensureAdCampaign → create/updateAdRateForListing) and only records the
// local promo_rate_pct once the marketplace accepted it; a listing with no live
// eBay ad is skipped, not written local-only.
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
  // US-2156 fact columns — all already stored, all read straight off the row.
  compliance_violation_count: number | null;
  price_range_low_cents: number | null;
  price_range_high_cents: number | null;
  draft_id: string | null;
  // US-1507: which eBay account owns this listing. A multi-store seller's
  // watcher offer must go out under the owning connection or eBay rejects the
  // foreign listing; null/legacy rows fall back to the primary connection.
  marketplace_connection_id: string | null;
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

/**
 * The owner-wide facts the US-2156 triggers need that don't live on the listing
 * row. Each is loaded ONLY when an active rule asks for it (see needsX below),
 * so the common all-aging ruleset still pays for nothing.
 */
interface OwnerFactBundle {
  /** eBay item id → days since the most recent offer landed on it. */
  offerDaysByItemExternalId: Map<string, number>;
  /** eBay item id → days since the most recent return opened on it. */
  returnDaysByItemExternalId: Map<string, number>;
  /** inventory_item_id → days since its grade report was created. */
  gradeDaysByItemId: Map<string, number>;
  /** draft_id (cross-listing group) → platforms that already have a row. */
  platformsByGroupId: Map<string, string[]>;
  /** US-1967: may this owner send offers to watchers at all? */
  watcherOffersAvailable: boolean;
}

function emptyFactBundle(): OwnerFactBundle {
  return {
    offerDaysByItemExternalId: new Map(),
    returnDaysByItemExternalId: new Map(),
    gradeDaysByItemId: new Map(),
    platformsByGroupId: new Map(),
    watcherOffersAvailable: false,
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
  bundle: OwnerFactBundle,
): AutomationFacts {
  const item = l.inventory_items;
  const itemExternalId = l.platform_listing_id;
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
    // ── US-2156 ─────────────────────────────────────────────────
    offerReceivedDaysAgo: itemExternalId
      ? bundle.offerDaysByItemExternalId.get(itemExternalId) ?? null
      : null,
    returnOpenedDaysAgo: itemExternalId
      ? bundle.returnDaysByItemExternalId.get(itemExternalId) ?? null
      : null,
    complianceViolations: l.compliance_violation_count ?? 0,
    gradeCompletedDaysAgo: bundle.gradeDaysByItemId.get(l.inventory_item_id) ??
      null,
    priceCents: Math.round(l.listing_price * 100),
    compLowCents: l.price_range_low_cents,
    compHighCents: l.price_range_high_cents,
  };
}

async function loadOwnerListings(
  ownerId: string,
): Promise<AutomationListingRow[]> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, listing_price, listed_at, watchers, views, last_metrics_synced_at, platform_offer_id, platform_listing_id, promo_rate_pct, " +
        "compliance_violation_count, price_range_low_cents, price_range_high_cents, draft_id, marketplace_connection_id, " +
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

// ── US-2156 fact loading ──────────────────────────────────────────
//
// Same shape as maxViewWindowDays above: ask the ruleset what it needs, load
// only that. A ruleset with no offer_received rule never queries the event
// ledger; a ruleset with no crosslist_to action never queries sibling rows.

/** Widest lookback (in days) any rule of `type` asks for; 0 when none do. */
export function maxTriggerWindowDays(
  rules: Array<{ trigger_json: AutomationTrigger }>,
  type: "offer_received" | "return_opened" | "grade_completed",
): number {
  let max = 0;
  for (const r of rules) {
    if (r.trigger_json.type === type) {
      max = Math.max(max, r.trigger_json.days);
    }
  }
  return max;
}

/** Does any rule act with `type`? */
export function usesAction(
  rules: Array<{ action_json: AutomationAction }>,
  type: AutomationAction["type"],
): boolean {
  return rules.some((r) => r.action_json.type === type);
}

/**
 * Marketplace-event ledger lookups for the offer_received / return_opened
 * triggers (00508). Keyed by the eBay item id, which is what
 * listings.platform_listing_id holds, so the join needs no extra query.
 *
 * Tenant-scoped on user_id (US-268 — the service-role client bypasses RLS).
 * Fails open to an EMPTY map: absent evidence means the trigger doesn't fire,
 * which is the safe direction for a rule that can drop prices.
 */
async function loadEventDaysByItem(
  ownerId: string,
  sourceKind: "offer" | "return",
  lookbackDays: number,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("marketplace_event_notifications")
    .select("item_external_id, created_at")
    .eq("user_id", ownerId)
    .eq("source_kind", sourceKind)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) {
    console.error(
      `[automations] ${sourceKind} event query failed:`,
      error.message,
    );
    return map;
  }
  for (
    const row of (data ?? []) as Array<
      { item_external_id: string | null; created_at: string }
    >
  ) {
    const id = row.item_external_id;
    if (!id) continue;
    // Rows arrive newest-first, so the first one wins — that's the most recent
    // event for the item, which is what "days ago" means.
    if (!map.has(id)) map.set(id, daysSince(row.created_at));
  }
  return map;
}

/**
 * Days since each item's grade report was created, for the grade_completed
 * trigger. Reads grade_reports through inventory_items.grade_report_id — the
 * link the grading flow already writes — rather than re-deriving it.
 */
async function loadGradeDaysByItem(
  ownerId: string,
  itemIds: string[],
  lookbackDays: number,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (itemIds.length === 0) return map;
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("inventory_items")
    .select("id, grade_reports!inner(created_at)")
    .eq("user_id", ownerId)
    .in("id", itemIds)
    .gte("grade_reports.created_at", since);
  if (error) {
    console.error("[automations] grade report query failed:", error.message);
    return map;
  }
  for (
    const row of (data ?? []) as unknown as Array<
      { id: string; grade_reports: { created_at: string } | null }
    >
  ) {
    const created = row.grade_reports?.created_at;
    if (created) map.set(row.id, daysSince(created));
  }
  return map;
}

/**
 * Which platforms each cross-listing group already has a row on, so a
 * crosslist_to action can no-op instead of minting a duplicate sibling every
 * hour. Grouped by listings.draft_id (the US-149 group key), falling back to
 * the listing's own id when it isn't in a group yet.
 */
async function loadPlatformsByGroup(
  ownerId: string,
  groupIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (groupIds.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("draft_id, platform, inventory_items!inner(user_id)")
    .eq("inventory_items.user_id", ownerId)
    .in("draft_id", groupIds)
    .limit(2000);
  if (error) {
    console.error("[automations] sibling platform query failed:", error.message);
    return map;
  }
  for (
    const row of (data ?? []) as unknown as Array<
      { draft_id: string | null; platform: string | null }
    >
  ) {
    if (!row.draft_id || !row.platform) continue;
    const list = map.get(row.draft_id) ?? [];
    if (!list.includes(row.platform)) list.push(row.platform);
    map.set(row.draft_id, list);
  }
  return map;
}

/**
 * US-1967 capability for send_offer_to_watchers: the deployment must request
 * the sell.negotiation scope AND this connection must not have 403'd on it.
 * Reads the same two inputs /negotiation/capabilities does, and never calls
 * eBay.
 */
async function loadWatcherOfferAvailability(ownerId: string): Promise<boolean> {
  if (!isNegotiationScopeAvailable() || !isEbayConfigured()) return false;
  try {
    // The column is `marketplace`, NOT `platform` (00008) — supabaseAdmin is
    // untyped, so a wrong name is a silent 42703 that reads as "no row" rather
    // than a compile error. supabase-js reports it in `error`, not by throwing,
    // so check it explicitly: the catch below only covers a transport throw.
    const { data, error } = await supabaseAdmin
      .from("marketplace_connections")
      .select("negotiation_access_denied")
      .eq("user_id", ownerId)
      .eq("marketplace", "ebay")
      .eq("is_active", true)
      // A seller may hold more than one eBay connection (US-671); without this
      // maybeSingle() errors on the second row and the gate silently opens.
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(
        "[automations] negotiation capability read failed:",
        error.message,
      );
      return false;
    }
    return (data as { negotiation_access_denied: boolean | null } | null)
      ?.negotiation_access_denied !== true;
  } catch (err) {
    console.warn(
      "[automations] negotiation capability read failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Load exactly the extra facts this ruleset asks for — nothing more. */
async function loadOwnerFacts(
  ownerId: string,
  rules: AutomationRuleRow[],
  listings: AutomationListingRow[],
): Promise<OwnerFactBundle> {
  const bundle = emptyFactBundle();
  const offerDays = maxTriggerWindowDays(rules, "offer_received");
  const returnDays = maxTriggerWindowDays(rules, "return_opened");
  const gradeDays = maxTriggerWindowDays(rules, "grade_completed");
  const needsPlatforms = usesAction(rules, "crosslist_to");
  const needsWatcherOffers = usesAction(rules, "send_offer_to_watchers");

  const [offers, returns, grades, platforms, watcherOffers] = await Promise.all([
    offerDays > 0
      ? loadEventDaysByItem(ownerId, "offer", offerDays)
      : Promise.resolve(new Map<string, number>()),
    returnDays > 0
      ? loadEventDaysByItem(ownerId, "return", returnDays)
      : Promise.resolve(new Map<string, number>()),
    gradeDays > 0
      ? loadGradeDaysByItem(
        ownerId,
        listings.map((l) => l.inventory_item_id),
        gradeDays,
      )
      : Promise.resolve(new Map<string, number>()),
    needsPlatforms
      ? loadPlatformsByGroup(
        ownerId,
        listings.map((l) => l.draft_id ?? l.id),
      )
      : Promise.resolve(new Map<string, string[]>()),
    needsWatcherOffers
      ? loadWatcherOfferAvailability(ownerId)
      : Promise.resolve(false),
  ]);

  bundle.offerDaysByItemExternalId = offers;
  bundle.returnDaysByItemExternalId = returns;
  bundle.gradeDaysByItemId = grades;
  bundle.platformsByGroupId = platforms;
  bundle.watcherOffersAvailable = watcherOffers;
  return bundle;
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
  /**
   * US-2156: one plain-English line describing what the non-price actions would
   * do. The price/promo columns say nothing about a crosslist or a notify, and
   * a dry run that shows a matched listing with no visible effect reads as a
   * bug. Null for the price/promo/coupon/end actions the columns already cover.
   */
  effect: string | null;
}

/** Human-readable effect for the US-2156 actions; null when the columns say it. */
export function describePlannedEffect(planned: PlannedAction): string | null {
  switch (planned.kind) {
    case "relist":
      return "End the listing and return the item to Drafts to relist";
    case "crosslist":
      return `Cross-list to ${planned.platform}`;
    case "send_watcher_offer":
      return `Offer watchers ${planned.discountPct}% off`;
    case "advance_status":
      return `Move the item to ${planned.status}`;
    case "notify":
      return `Notify: ${planned.message}`;
    default:
      return null;
  }
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
    effect: describePlannedEffect(planned),
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
  const [lastAction, viewWindows, bundle] = await Promise.all([
    loadLastActionMap(ownerId, listingIds),
    lookbackDays > 0
      ? loadViewWindows(ownerId, listingIds, lookbackDays)
      : Promise.resolve(new Map<string, ViewWindow[]>()),
    loadOwnerFacts(ownerId, rules, listings),
  ]);
  const now = new Date();
  for (const listing of listings) {
    if (listing.inventory_items.exclude_from_automations) continue;
    const facts = listingFacts(listing, viewWindows, bundle);
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
        currentStatus: listing.inventory_items.status,
        existingPlatforms: bundle.platformsByGroupId.get(
          listing.draft_id ?? listing.id,
        ) ?? [],
        watcherOffersAvailable: bundle.watcherOffersAvailable,
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

/**
 * US-2388: what an automation's end/relist should do when `withdrawOffer`
 * throws. Two outcomes, not three, because the automation has only two moves:
 * reconcile the local row, or leave it alone so the next tick retries.
 *
 * `"already_ended"` — eBay refuses the withdraw because the listing is not in a
 * live state. The end is effectively already done, so writing it locally is
 * reconciliation. Not reconciling is what left rows stuck "active" forever.
 *
 * `"retry"` — a transient 429/5xx, or a disconnected account (US-1506), where
 * the live state is UNKNOWN. Both must leave the row active: ending it locally
 * while it is still live on eBay is an oversell, and unlike a stuck row that is
 * not recoverable by a later tick.
 *
 * The disconnected case is preempted rather than left to
 * `isOfferAlreadyEndedError`. It does not currently match that helper's message
 * regex, so this is belt-and-braces — but the helper's own comment says callers
 * must preempt it, and the two other end paths do. A classifier that agrees
 * with its siblings only by accident is one regex edit away from an oversell.
 *
 * Exported so the decision is unit-testable without an HTTP round trip or a
 * live eBay account, the same reason `endListingWritesApplied` is exported.
 */
export function classifyWithdrawFailure(
  err: unknown,
): "already_ended" | "retry" {
  if (isNoEbayConnectionError(err)) return "retry";
  return isOfferAlreadyEndedError(err) ? "already_ended" : "retry";
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

// US-2232: a set_promo_rate action must reach eBay Promoted Listings before it
// is recorded. It is only pushable when the listing has a live eBay id AND the
// eBay client is configured; otherwise the action is SKIPPED (return false in
// applyMatch) rather than written local-only and counted as applied.
export function promoRatePushable(
  liveListingId: string | null | undefined,
  ebayConfigured: boolean,
): boolean {
  return Boolean(liveListingId) && ebayConfigured;
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
    // US-2232: push the new Promoted Listings bid to eBay FIRST (US-467), then
    // record local state — so a rule can never report an "applied" promo rate
    // that never reached the marketplace. A listing with no live eBay id (or a
    // disconnected account) is SKIPPED (return false) and retried next run,
    // rather than written local-only and counted as done.
    const liveListingId = listing.platform_listing_id;
    if (!liveListingId || !promoRatePushable(liveListingId, isEbayConfigured())) {
      return false;
    }
    try {
      const campaignId = await ensureAdCampaign(ownerId);
      const existingAd = await getAdForListing(ownerId, campaignId, liveListingId);
      if (existingAd) {
        await updateAdRateForListing(
          ownerId,
          campaignId,
          liveListingId,
          planned.newRatePct,
        );
      } else {
        const created = await createAdForListing(
          ownerId,
          campaignId,
          liveListingId,
          planned.newRatePct,
        );
        if (!created) return false; // could not promote → skip, retry later
      }
      ebaySynced = true;
    } catch (err) {
      console.error(
        "[automations] set promo rate failed for",
        listing.id,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
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
      .select("photo_url, photo_type, photo_role, sort_order")
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
  } else if (planned.kind === "advance_status") {
    // US-2156: local-only, so nothing to push. planAction already refused the
    // no-op (item already in that status) and the validator already refused a
    // status an automation may not write (AUTOMATION_SETTABLE_STATUSES).
    const { error } = await supabaseAdmin
      .from("inventory_items")
      .update({ status: planned.status })
      .eq("id", listing.inventory_item_id)
      .eq("user_id", ownerId); // US-268: never act on an id alone
    if (error) {
      console.error(
        "[automations] advance_status failed for",
        listing.inventory_item_id,
        error.message,
      );
      return false;
    }
    before = { status: listing.inventory_items.status };
    after = { status: planned.status };
  } else if (planned.kind === "notify") {
    // US-2156: the escape hatch for triggers whose right answer is a human
    // decision, not a price change. Type 'system' because the seller explicitly
    // built this rule — it is not one of the marketplace categories they can
    // mute, and muting it would silently disable a rule they created.
    // notifyUser never throws (best-effort, logs and swallows).
    await notifyUser(ownerId, {
      type: "system",
      title: rule.name,
      message: planned.message,
      link: `/dashboard/flipdesk/item/${listing.inventory_item_id}`,
    });
    before = {};
    after = { message: planned.message };
  } else if (planned.kind === "send_watcher_offer") {
    // US-2156 + US-1967: only reachable when the deployment holds the
    // sell.negotiation scope and this connection hasn't 403'd on it —
    // planAction returns null otherwise, so an unlicensed seller never gets a
    // run of guaranteed failures. Needs a LIVE eBay listing id (the offer is
    // sent to that listing's watchers).
    const liveListingId = listing.platform_listing_id;
    if (!liveListingId || !isEbayConfigured()) return false;
    try {
      await sendOfferToInterestedBuyers(
        ownerId,
        {
          listingIds: [liveListingId],
          message: rule.name,
          discountPercentage: String(planned.discountPct),
        },
        // US-1507: send under the account that owns this listing, not whichever
        // connection happens to be primary — eBay rejects a foreign listing.
        listing.marketplace_connection_id ?? undefined,
      );
      ebaySynced = true;
    } catch (err) {
      console.error(
        "[automations] sendOfferToInterestedBuyers failed for",
        listing.id,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
    before = { price_cents: currentCents };
    after = { discount_pct: planned.discountPct };
  } else if (planned.kind === "crosslist") {
    // US-2156: fan the item out to a second marketplace through the SAME path a
    // human cross-push uses (lib/cross-push.ts), so a rule can never create a
    // sibling the manual flow wouldn't. No AI variant is generated here — the
    // stored one is reused when present, else the sibling copies the draft.
    const groupId = await ensureCrossListingGroup(
      ownerId,
      listing.id,
      listing.draft_id,
    );
    if (!groupId) return false;
    const { data: draftRow } = await supabaseAdmin
      .from("listings")
      .select(
        "id, inventory_item_id, platform, listing_title, listing_description, primary_photo_id, platform_fields",
      )
      .eq("id", listing.id)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (!draftRow) return false;
    const draft = draftRow as unknown as CrossPushDraft & {
      platform_fields: Record<string, StoredPlatformVariant> | null;
    };
    const { result } = await crossPushPlatform({
      ownerId,
      draft,
      groupId,
      platform: planned.platform as CrossListingPlatform,
      price: listing.listing_price,
      variant: draft.platform_fields?.[planned.platform],
    });
    if (!result.ok) {
      console.error(
        "[automations] crosslist to",
        planned.platform,
        "failed for",
        listing.id,
        result.error,
      );
      return false;
    }
    // US-2179: keep the item's status and the activeListings accounting
    // truthful after a successful publish, exactly like the manual cross-push
    // does. No cap GATE is needed here (unlike the manual path): the rule only
    // ever runs against listings that are already ACTIVE on eBay, so the item is
    // already live and already occupies its slot — the cap counts live items,
    // not listing rows, so fanning out to a second channel adds nothing. This
    // call is what closes the one desync case, where the eBay listing is active
    // but the item's status drifted off 'listed'.
    await markItemListed(listing.inventory_item_id, ownerId);
    ebaySynced = planned.platform === "ebay";
    before = {};
    after = {
      platform: planned.platform,
      platform_listing_id: result.platformListingId ?? null,
      listing_url: result.listingUrl ?? null,
    };
  } else if (planned.kind === "end_listing" || planned.kind === "relist") {
    // US-2156: `relist` and `end_listing` share the withdraw + local-end path.
    // They differ in what happens AFTER: a relist tells the seller the item is
    // back in the drafting queue and ready to re-push, an end_listing is the
    // silent "stop selling this".
    //
    // A relist deliberately does NOT auto-republish. Re-publishing without a
    // human would spend a fresh marketplace insertion fee and re-consume an
    // activeListings cap slot on a listing nobody re-approved — and there is no
    // undo on an automated bulk action (US-2172). Ending and handing it back is
    // the reversible half.
    const isRelist = planned.kind === "relist";
    if (hasLiveOffer) {
      try {
        await withdrawOffer(ownerId, offerId!);
        ebaySynced = true;
      } catch (err) {
        // US-2388: classify the throw instead of treating every failure as
        // fatal. This branch used to `return false` on ANY error, so a listing
        // eBay had ALREADY ended — seller ended it there, eBay pulled it for a
        // policy issue, or a prior tick already withdrew it — left the local row
        // stuck "active" forever, on a schedule, with no way for the rule to
        // ever recover. Every other end/relist path already classified it
        // (flipdesk-listings.ts, lib/cross-listings.ts, the manual eBay end
        // route); this route was the one that did not.
        if (classifyWithdrawFailure(err) === "already_ended") {
          // Not live upstream, so the END is effectively already done and the
          // local writes below are reconciliation, not a lie. ebaySynced stays
          // FALSE: the audit row must say we did not touch eBay this run, or a
          // reader can't tell a real withdraw from a reconciliation.
          console.warn(
            "[automations] offer already ended upstream, reconciling locally for",
            listing.id,
            err instanceof Error ? err.message : String(err),
          );
        } else {
          // Transient (429/5xx) or a disconnected account: the live state is
          // UNKNOWN. Bailing leaves the row active so the rule retries, which
          // is the safe direction — ending it locally while it is still live on
          // eBay is an oversell (US-1506).
          console.error(
            "[automations] withdrawOffer failed for",
            listing.id,
            err instanceof Error ? err.message : String(err),
          );
          return false;
        }
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
    after = { listing_status: "ended", relist: isRelist };
    if (isRelist) {
      // Best-effort — the listing IS ended either way, so a failed notice must
      // not turn a completed relist into a reported error.
      await notifyUser(ownerId, {
        type: "item_status_change",
        title: rule.name,
        message:
          `"${listing.inventory_items.title ?? "Your item"}" was ended and is back in Drafts, ready to relist.`,
        link: `/dashboard/flipdesk/item/${listing.inventory_item_id}`,
      });
    }
  } else {
    // Exhaustive by construction: every PlannedAction kind has a branch above.
    // A new kind that reaches here is a wiring bug, and the ONLY safe thing to
    // do is nothing — the alternative (falling through to the end-listing arm,
    // which is what the pre-US-2156 `else` did) would end a live listing for a
    // rule that asked for something else entirely.
    console.error(
      "[automations] unhandled planned action kind",
      (planned as { kind: string }).kind,
      "for rule",
      rule.id,
    );
    return false;
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

  // US-2236: the offer rules run FIRST and independently of the listing pass.
  // First because an accepted offer ends the listing, and spending the hour's
  // price-drop on a listing that is about to sell is wasted; independently
  // because a failure in either half must not stop the other — they share a
  // rule table and nothing else.
  try {
    const offerRun = await runOfferRulesForOwner(ownerId, rules);
    result.applied += offerRun.accepted + offerRun.countered + offerRun.declined;
    result.errors += offerRun.errors;
  } catch (err) {
    result.errors++;
    console.error(
      "[automations] offer rules failed",
      ownerId,
      err instanceof Error ? err.message : String(err),
    );
  }

  // US-2938: returns next, and BEFORE the listing pass — approving a return can
  // put stock back, and a price drop computed against an item that is coming
  // home is spent on the wrong number. Independent of both neighbours for the
  // same reason the offer half is: they share a rule table and nothing else.
  try {
    const returnRun = await runReturnRulesForOwner(ownerId, rules);
    result.applied += returnRun.approved + returnRun.refunded_keep;
    result.errors += returnRun.errors;
  } catch (err) {
    result.errors++;
    console.error(
      "[automations] return rules failed",
      ownerId,
      err instanceof Error ? err.message : String(err),
    );
  }

  // US-2950: the markdown schedule, after the offer and return rules and before
  // the listing pass. After those two because an accepted offer or an approved
  // return changes which items are still worth discounting; before the price
  // pass because a markdown sale and a per-listing price drop on the same item
  // are two discounts nobody asked to stack.
  try {
    const markdownRun = await runMarkdownRulesForOwner(ownerId, rules);
    result.applied += markdownRun.sales_updated;
    result.errors += markdownRun.errors;
  } catch (err) {
    result.errors++;
    console.error(
      "[automations] markdown rules failed",
      ownerId,
      err instanceof Error ? err.message : String(err),
    );
  }

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
// ── US-2236 AC1: answer incoming Best Offers against the seller's thresholds ──
//
// Runs inside the SAME hourly automation-rules cron rather than as a new job:
// same lock, same plan gate, same cadence, no cron-registry entry to keep in
// sync across five documents. What it does NOT share is the listing planner —
// the evaluation unit here is an offer, not a listing, and one listing can
// carry several open offers with different right answers. See lib/offer-rules
// .ts for why that made this its own module.

interface OfferContext {
  listPrice: number | null;
  itemCost: number | null;
  connectionId: string | undefined;
}

/**
 * List price, acquisition cost and owning connection for each eBay item id.
 *
 * TENANT-SCOPED by `listings.user_id` AND by the parent item's `user_id`, even
 * though the offers already came from this seller's own eBay account. The
 * offers arrive from an external API, so their item ids are effectively
 * untrusted input into a service-role query — the US-268 rule is that an id
 * from outside never selects a row without an ownership predicate, and "eBay
 * told us" is outside.
 */
async function loadOfferContext(
  ownerId: string,
  itemIds: string[],
): Promise<Map<string, OfferContext>> {
  const out = new Map<string, OfferContext>();
  if (itemIds.length === 0) return out;
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "platform_listing_id, listing_price, marketplace_connection_id, inventory_items!inner(user_id, acquired_price)",
    )
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .in("platform_listing_id", itemIds)
    .eq("inventory_items.user_id", ownerId);
  type Row = {
    platform_listing_id: string | null;
    listing_price: number | null;
    marketplace_connection_id: string | null;
    // PostgREST returns a to-one embed as an object; supabase-js types it as an
    // array. Accept either (same shape as the /negotiation/offers reader).
    inventory_items:
      | { acquired_price: number | null }
      | { acquired_price: number | null }[]
      | null;
  };
  for (const r of (data ?? []) as unknown as Row[]) {
    if (!r.platform_listing_id) continue;
    const inv = Array.isArray(r.inventory_items) ? r.inventory_items[0] : r.inventory_items;
    out.set(r.platform_listing_id, {
      listPrice: typeof r.listing_price === "number" ? r.listing_price : null,
      itemCost: typeof inv?.acquired_price === "number" ? inv.acquired_price : null,
      connectionId: r.marketplace_connection_id ?? undefined,
    });
  }
  return out;
}

export interface OfferRunResult {
  offers_seen: number;
  accepted: number;
  /** US-2940: offers answered with a counter rather than a yes or a no. */
  countered: number;
  declined: number;
  skipped: number;
  errors: number;
}

/**
 * Apply every active offer_threshold rule to this owner's open Best Offers.
 *
 * ONE RULE WINS PER OFFER — the first active one that produces a decision. Two
 * rules disagreeing about the same offer is a configuration the seller can see
 * and fix; resolving it by "most aggressive wins" or by running both would mean
 * an offer gets accepted AND declined, and the second call fails against eBay
 * with a stale-offer error that looks like a bug.
 */
export async function runOfferRulesForOwner(
  ownerId: string,
  rules: AutomationRuleRow[],
): Promise<OfferRunResult> {
  const result: OfferRunResult = {
    offers_seen: 0,
    accepted: 0,
    countered: 0,
    declined: 0,
    skipped: 0,
    errors: 0,
  };
  const offerRules = rules.filter((r) => r.trigger_json?.type === "offer_threshold");
  if (offerRules.length === 0) return result;
  if (!isEbayConfigured()) return result;

  let offers;
  try {
    offers = await getBestOffers(ownerId);
  } catch (err) {
    // No connection is the common case for a seller who wrote a rule before
    // connecting eBay — not an error worth counting or logging loudly.
    if (!isNoEbayConnectionError(err)) {
      console.error(
        "[automations:offers] getBestOffers failed",
        ownerId,
        err instanceof Error ? err.message : String(err),
      );
      result.errors++;
    }
    return result;
  }
  // Only offers still awaiting an answer. eBay's GetBestOffers is asked for
  // Active, but the status is re-checked here so a widened query upstream can
  // never turn this into a responder that answers settled offers.
  const open = offers.filter((o) => (o.status ?? "Active") === "Active");
  result.offers_seen = open.length;
  if (open.length === 0) return result;

  const ctx = await loadOfferContext(
    ownerId,
    [...new Set(open.map((o) => o.itemId).filter(Boolean))],
  );

  for (const offer of open) {
    const c = ctx.get(offer.itemId);
    // No local listing row means no asking price and no ownership proof. Both
    // are reasons not to act, and the decision function would skip anyway.
    if (!c) {
      result.skipped++;
      continue;
    }

    let decision: OfferDecision = "skip";
    let copy = "";
    let counterPrice: number | undefined;
    let firedRule: AutomationRuleRow | null = null;
    for (const rule of offerRules) {
      const t = rule.trigger_json as Extract<
        AutomationTrigger,
        { type: "offer_threshold" }
      >;
      const outcome = decideOffer({
        acceptAtPct: t.accept_at_pct,
        declineBelowPct: t.decline_below_pct,
        marginFloorPct: t.margin_floor_pct,
        counterAtPct: t.counter_at_pct ?? null,
      }, {
        offerPrice: offer.price,
        listPrice: c.listPrice,
        itemCost: c.itemCost,
      });
      if (outcome.decision !== "skip") {
        decision = outcome.decision;
        copy = describeOfferOutcome(outcome);
        counterPrice = outcome.counterPrice;
        firedRule = rule;
        break;
      }
    }

    if (decision === "skip" || !firedRule) {
      result.skipped++;
      continue;
    }

    // IDEMPOTENCY, and it has to come before the eBay call rather than after.
    // The cron can overlap a manual response, a retry, or its own previous run;
    // claiming the (offer, action) pair first means a duplicate attempt does
    // nothing instead of racing eBay and logging a stale-offer failure that
    // reads like a defect.
    const fresh = await claimMarketplaceEvent(
      ownerId,
      "offer",
      offer.bestOfferId,
      `auto:${decision}`,
      "offer_auto_responded",
      offer.itemId,
    );
    if (!fresh) {
      result.skipped++;
      continue;
    }

    try {
      await respondToBestOffer(ownerId, {
        itemId: offer.itemId,
        bestOfferId: offer.bestOfferId,
        action: decision === "accept"
          ? "Accept"
          : decision === "counter"
          ? "Counter"
          : "Decline",
        // US-2940: the price comes from the decision, not from the runner. One
        // number, computed once, so what the seller previewed and what eBay
        // receives cannot differ.
        counterPrice: decision === "counter" ? counterPrice : undefined,
      }, c.connectionId);
      if (decision === "accept") result.accepted++;
      else if (decision === "counter") result.countered++;
      else result.declined++;
      // US-2939: record the outcome AND the rule that made it, so the offer
      // analytics can tell an automated answer from a human one. Best-effort —
      // eBay has already been told, and a bookkeeping failure must not look
      // like the response failed.
      await recordOfferResponse(
        ownerId,
        offer.bestOfferId,
        decision === "accept"
          ? "accepted"
          : decision === "counter"
          ? "countered"
          : "declined",
        {
          ruleId: firedRule.id,
          amountCents: counterPrice != null ? Math.round(counterPrice * 100) : null,
        },
      );
      if (decision === "counter" && counterPrice != null) {
        // Our counter is its OWN event, not a property of the bid it answered.
        // The conversion figures divide by both.
        await recordOffers(ownerId, [{
          direction: "counter_sent",
          externalOfferId: offer.bestOfferId,
          itemExternalId: offer.itemId,
          amountCents: Math.round(counterPrice * 100),
          state: "Countered",
          ruleId: firedRule.id,
        }]);
      }
      // Always tell the seller, through the SAME notifier the manual response
      // uses — in-app, email and push, honouring their preferences. An
      // automation that answers a buyer without saying so is indistinguishable
      // from the buyer walking away. `copy` is logged rather than sent because
      // the shared notifier owns the wording; a second phrasing here would
      // drift from the one the manual path sends.
      console.log(`[automations:offers] ${ownerId} ${offer.bestOfferId}: ${copy}`);
      await notifyOfferResponded(
        ownerId,
        offer.itemTitle,
        decision === "accept" ? "accepted" : decision === "counter" ? "countered" : "declined",
      );
    } catch (err) {
      result.errors++;
      console.error(
        "[automations:offers] respond failed",
        ownerId,
        offer.bestOfferId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return result;
}

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


// ── US-2938: the return rules runner ────────────────────────────────
//
// The return-shaped sibling of runOfferRulesForOwner, and it lives beside it
// for the same reason: the evaluation unit is a RETURN, not a listing, so the
// listing planner cannot express it. Same hourly cron, same lock, same plan
// gate, no new job.
//
// Order matters, and this runs AFTER the offer rules and BEFORE the listing
// pass. Offers first because an accepted offer ends a listing; returns before
// the price pass because approving a return can put stock back and a price drop
// computed against an item that is coming home is spent on the wrong number.

export interface ReturnRunResult {
  returns_seen: number;
  approved: number;
  refunded_keep: number;
  skipped: number;
  errors: number;
}

/**
 * Answer the returns this owner's rules cover.
 *
 * Reads the STORED cases (marketplace_post_sale_cases) rather than calling
 * eBay: the sweep already refreshed them, the order total is already resolved
 * through the linked sale, and a cron that re-hits Post-Order once an hour per
 * seller buys nothing but call quota.
 */
export async function runReturnRulesForOwner(
  ownerId: string,
  rules: AutomationRuleRow[],
): Promise<ReturnRunResult> {
  const result: ReturnRunResult = {
    returns_seen: 0,
    approved: 0,
    refunded_keep: 0,
    skipped: 0,
    errors: 0,
  };
  const returnRules = rules.filter((r) => r.trigger_json?.type === "return_threshold");
  if (returnRules.length === 0) return result;
  if (!isEbayConfigured()) return result;

  const open = await loadOpenReturnFacts(ownerId);
  result.returns_seen = open.length;
  if (open.length === 0) return result;

  for (const ret of open) {
    let decision: ReturnRuleDecision = "skip";
    let copy = "";
    for (const rule of returnRules) {
      const t = rule.trigger_json as Extract<
        AutomationTrigger,
        { type: "return_threshold" }
      >;
      const outcome = decideReturnRule({
        approveAtOrBelowCents: t.approve_at_or_below_cents,
        refundWithoutReturnAtOrBelowCents: t.refund_without_return_at_or_below_cents,
      }, ret);
      if (outcome.decision !== "skip") {
        decision = outcome.decision;
        copy = outcome.reason;
        break;
      }
    }
    if (decision === "skip") {
      result.skipped++;
      continue;
    }

    // IDEMPOTENCY BEFORE THE EBAY CALL, exactly as the offer runner does it. The
    // cron can overlap a manual decision, a retry, or its own previous run;
    // claiming the (return, action) pair first means a duplicate attempt does
    // nothing instead of racing eBay and logging a stale-return failure that
    // reads like a defect.
    const fresh = await claimMarketplaceEvent(
      ownerId,
      "return",
      ret.externalId,
      `auto:${decision}`,
      "return_auto_answered",
      null,
    );
    if (!fresh) {
      result.skipped++;
      continue;
    }

    try {
      if (decision === "approve") {
        await decideReturn(ownerId, ret.externalId, "APPROVE");
        await updatePostSaleCaseState(ownerId, "return", ret.externalId, {
          state: "RETURN_APPROVED",
        });
        result.approved++;
      } else {
        // Refund and let the buyer keep it. Two eBay calls in sequence and the
        // ORDER is load-bearing: approve first, because eBay rejects a refund
        // on a return it has not been told to expect.
        await decideReturn(ownerId, ret.externalId, "APPROVE");
        await issueReturnRefund(ownerId, ret.externalId);
        await markPostSaleCaseClosed(ownerId, "return", ret.externalId, "auto_refunded");
        result.refunded_keep++;
      }
      console.log(`[automations:returns] ${ownerId} ${ret.externalId}: ${copy}`);
      await writeAutomationAudit(ownerId, ret.externalId, decision, copy);
    } catch (err) {
      result.errors++;
      // Hand the claim back so the next run retries, same as the offer runner.
      await releaseMarketplaceEvent(ownerId, "return", ret.externalId, `auto:${decision}`);
      console.error(
        "[automations:returns] failed",
        ownerId,
        ret.externalId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return result;
}

/**
 * The open returns this owner has, with the order total resolved through the
 * linked sale.
 *
 * Owner-scoped (US-268). A return with no linked sale has no order total, and
 * decideReturnRule skips it rather than treating unknown as zero.
 */
async function loadOpenReturnFacts(
  ownerId: string,
): Promise<Array<ReturnRuleFacts & { externalId: string }>> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .select("external_id, reason, state, sale_id")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .eq("case_type", "return")
    .is("closed_at", null)
    .limit(RETURN_RULE_SCAN_CAP);
  if (error) {
    console.error("[automations:returns] load failed", ownerId, error.message);
    return [];
  }
  const rows = (data ?? []) as unknown as Array<{
    external_id: string;
    reason: string | null;
    state: string | null;
    sale_id: string | null;
  }>;
  if (rows.length === 0) return [];

  const saleIds = [...new Set(rows.map((r) => r.sale_id).filter(Boolean))] as string[];
  const totalBySale = new Map<string, number>();
  if (saleIds.length > 0) {
    const { data: sales } = await supabaseAdmin
      .from("sales")
      .select("id, sale_price")
      .eq("user_id", ownerId)
      .in("id", saleIds);
    for (
      const s of (sales ?? []) as unknown as Array<{ id: string; sale_price: number | null }>
    ) {
      if (s.sale_price != null && Number.isFinite(Number(s.sale_price))) {
        totalBySale.set(s.id, Math.round(Number(s.sale_price) * 100));
      }
    }
  }
  return rows.map((r) => ({
    externalId: r.external_id,
    reason: r.reason,
    state: r.state,
    orderTotalCents: r.sale_id ? (totalBySale.get(r.sale_id) ?? null) : null,
  }));
}

const RETURN_RULE_SCAN_CAP = 200;

/**
 * Every auto-action names the rule that fired, in the audit log.
 *
 * A SYSTEM row: no human pressed anything, and attributing it to the seller
 * would make the log say they approved a return they never saw. Best-effort —
 * a missing audit row must not undo a refund already sent to a buyer.
 */
async function writeAutomationAudit(
  ownerId: string,
  returnId: string,
  decision: ReturnRuleDecision,
  copy: string,
): Promise<void> {
  try {
    await writeSystemAuditLog({
      action: `ebay.return.auto_${decision}`,
      targetType: "ebay_return",
      targetId: returnId,
      details: { owner_user_id: ownerId, reason: copy },
    });
  } catch (err) {
    console.error(
      "[automations:returns] audit write failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── US-2950: the markdown runner ────────────────────────────────────
//
// The third sibling of runOfferRulesForOwner and runReturnRulesForOwner. The
// evaluation unit here is a SET rather than a listing: eBay applies one
// percentage across every item in a markdown sale, which is why the listing
// planner cannot express it and why this is not a price_drop_pct action.
//
// ── ONE SALE PER RULE, UPDATED — NOT A NEW SALE EVERY HOUR ──────────────────
//
// The cron runs hourly. Creating a sale each time would leave a seller with
// twenty-four overlapping promotions a day, and eBay would apply the deepest.
// So the runner finds the sale it created before by NAME and updates it, and
// only creates when there is none.

export interface MarkdownRunResult {
  rules_run: number;
  items_included: number;
  sales_updated: number;
  errors: number;
}

/** The name we give our own sales, so a later run can find and update them. */
export function markdownSaleName(ruleId: string): string {
  return `FlipDesk auto ${ruleId.slice(0, 8)}`;
}

export async function runMarkdownRulesForOwner(
  ownerId: string,
  rules: AutomationRuleRow[],
): Promise<MarkdownRunResult> {
  const result: MarkdownRunResult = {
    rules_run: 0,
    items_included: 0,
    sales_updated: 0,
    errors: 0,
  };
  const markdownRules = rules.filter((r) => r.trigger_json?.type === "markdown_schedule");
  if (markdownRules.length === 0) return result;
  if (!isEbayConfigured()) return result;

  const candidates = await loadMarkdownCandidates(ownerId);
  if (candidates.length === 0) return result;

  // Read the seller's existing promotions ONCE, not per rule.
  let existing: Awaited<ReturnType<typeof getItemPromotions>> = [];
  try {
    existing = await getItemPromotions(ownerId);
  } catch (err) {
    // A promotions read failure means we cannot tell a new sale from an update,
    // and creating one blind is how a seller ends up with duplicates. Stop.
    console.error(
      "[automations:markdown] could not read existing promotions",
      ownerId,
      err instanceof Error ? err.message : String(err),
    );
    result.errors++;
    return result;
  }

  for (const rule of markdownRules) {
    const t = rule.trigger_json as Extract<
      AutomationTrigger,
      { type: "markdown_schedule" }
    >;
    result.rules_run++;
    const selection = selectMarkdownItems({
      minDaysListed: t.min_days_listed,
      markdownPct: t.markdown_pct,
      marginFloorPct: t.margin_floor_pct,
      minGrade: t.min_grade,
    }, candidates);
    result.items_included += selection.included.length;
    // An empty set is not an error and must not create an empty sale — eBay
    // rejects one, and a seller with nothing old enough yet is the normal case
    // for a rule that has just been switched on.
    if (selection.included.length === 0) continue;

    // eBay's promotion takes ITS OWN listing ids, not ours. Resolve the local
    // ids the selector returned; a listing with no eBay id is not live and
    // cannot be in a sale, so it drops out here rather than 400ing the batch.
    const platformIds = await platformListingIdsFor(
      ownerId,
      selection.included.map((i) => i.listingId),
    );
    if (platformIds.length === 0) continue;

    const name = markdownSaleName(rule.id);
    const match = existing.find((p) => p.name === name);
    try {
      if (match) {
        await updateMarkdownSale(ownerId, match.promotionId, {
          name,
          percentOff: t.markdown_pct,
          ebayListingId: platformIds[0]!,
          additionalListingIds: platformIds.slice(1),
        });
      } else {
        await createMarkdownSale(ownerId, {
          name,
          percentOff: t.markdown_pct,
          ebayListingId: platformIds[0]!,
          additionalListingIds: platformIds.slice(1),
        });
      }
      result.sales_updated++;
      await writeSystemAuditLog({
        action: "ebay.markdown.auto_schedule",
        targetType: "flipdesk_automation_rule",
        targetId: rule.id,
        details: {
          owner_user_id: ownerId,
          items: selection.included.length,
          excluded: selection.excluded.length,
          markdown_pct: t.markdown_pct,
          exposure_cents: selection.exposureCents,
        },
      });
    } catch (err) {
      result.errors++;
      console.error(
        "[automations:markdown] sale write failed",
        ownerId,
        rule.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return result;
}

/**
 * Local listing ids to eBay listing ids, owner-scoped.
 *
 * A listing with no platform id is not live on eBay and cannot be in a sale, so
 * it is dropped rather than sent — eBay 400s the whole batch on one bad id, and
 * losing the entire sale to one unpublished draft is the wrong trade.
 */
async function platformListingIdsFor(
  ownerId: string,
  listingIds: string[],
): Promise<string[]> {
  if (listingIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("platform_listing_id")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .in("id", listingIds);
  if (error) {
    console.error("[automations:markdown] listing id resolve failed:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Array<{ platform_listing_id: string | null }>)
    .map((r) => r.platform_listing_id)
    .filter((id): id is string => !!id);
}

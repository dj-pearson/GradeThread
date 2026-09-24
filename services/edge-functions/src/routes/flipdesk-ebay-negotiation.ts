// eBay routes: Best Offer negotiation (including the deliberate scope-gated 501s) and buyer messages.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { dryRunOfferRule, normalizeThresholdPct } from "../lib/offer-rules.ts";
import { summarizeOffers } from "../lib/offer-analytics.ts";
import { loadActiveOfferRule } from "../lib/offer-rule-lookup.ts";
import { OFFER_COOLDOWN_DAYS, totalDiscountExposureCents } from "../lib/offer-candidates.ts";
import { loadRankedOfferCandidates } from "../lib/offer-candidates-load.ts";
import {
  incomingOfferToInput,
  buyerKey,
  loadBuyerHistory,
  loadOffers,
  loadListPricesByItemId,
  recordOfferResponse,
  recordOffers,
} from "../lib/offer-store.ts";
import { filterEbayPhotos } from "../lib/item-photo-storage.ts";
import {
  isEbayConfigured,
  isNegotiationScopeAvailable,
  findEligibleNegotiationItems,
  getBrowseItemByLegacyId,
  sendOfferToInterestedBuyers,
} from "../lib/ebay-client.ts";
import { reconcileAutoAcceptWithRule } from "../lib/best-offer.ts";
import { enrichEligibleItems, type EligibleEnrichment } from "../lib/negotiation-enrich.ts";
import { sourcingCosts } from "../lib/sourcing-target.ts";
import {
  DEFAULT_SOURCING_GRADING_CENTS,
  DEFAULT_SOURCING_SHIPPING_CENTS,
} from "../lib/scout-decision.ts";
import {
  getBestOffers,
  respondToBestOffer,
  getMemberMessages,
  replyToMemberMessage,
  type BestOfferAction,
} from "../lib/ebay-trading.ts";
import { ebayFailureDetail } from "../lib/ebay-error-map.ts";
import {
  COUNTER_REFUSAL_COPY,
  isEbayId,
  parseCounterQuantity,
  parseReplyBody,
  parseSendOfferBody,
  priceToCents,
  SELLER_RESPONSE_MAX,
  sendGroupsRecordingEach,
  storedOfferClosedReason,
  validateCounter,
} from "../lib/offer-limits.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import {
  claimMarketplaceEvent,
  notifyOfferResponded,
  type OfferAction,
} from "../lib/marketplace-event-notify.ts";
import { type EbayEnv, ebayPublicPhotoUrl } from "./flipdesk-ebay-shared.ts";


export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// GET /negotiation/threshold-conflicts — US-2944.
//
// Which listings have an eBay auto-accept sitting BELOW the active rule's
// number. eBay wins the race, so each of these is a live hole: an offer in the
// gap gets taken at a price the rule would have refused, and the seller's
// margin floor never gets a vote.
//
// Reports both numbers. "There is a conflict" with no figures is a warning a
// seller cannot act on.
flipdeskEbayRoutes.get("/negotiation/threshold-conflicts", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const rule = await loadActiveOfferRule(ownerId);
    if (!rule || rule.acceptAtPct == null) {
      return c.json({ rule: null, conflicts: [] });
    }
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select(
        "id, listing_title, listing_price, best_offer_auto_accept_cents, platform_listing_id, " +
          "inventory_items!inner(user_id, acquired_price)",
      )
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .eq("best_offer_enabled", true)
      .not("best_offer_auto_accept_cents", "is", null)
      .eq("inventory_items.user_id", ownerId)
      .limit(500);
    if (error) throw new Error(error.message);

    const conflicts = ((data ?? []) as unknown as Array<{
      id: string;
      listing_title: string | null;
      listing_price: number | null;
      best_offer_auto_accept_cents: number | null;
      platform_listing_id: string | null;
      inventory_items:
        | { acquired_price: number | null }
        | { acquired_price: number | null }[]
        | null;
    }>)
      .map((row) => {
        const inv = Array.isArray(row.inventory_items)
          ? row.inventory_items[0]
          : row.inventory_items;
        const priceCents = row.listing_price != null
          ? Math.round(Number(row.listing_price) * 100)
          : 0;
        const reconciled = reconcileAutoAcceptWithRule({
          priceCents,
          sellerAcceptCents: row.best_offer_auto_accept_cents,
          ruleAcceptAtPct: rule.acceptAtPct,
          ruleMarginFloorPct: rule.marginFloorPct,
          itemCostCents: typeof inv?.acquired_price === "number"
            ? Math.round(inv.acquired_price * 100)
            : null,
        });
        return { row, reconciled };
      })
      // `matched` and `no_rule` are agreement, not conflict. Only a price the
      // reconciler actually moved is worth telling the seller about.
      .filter(({ reconciled }) =>
        reconciled.reason === "raised_to_rule" ||
        reconciled.reason === "raised_to_margin_floor" ||
        reconciled.reason === "dropped_no_valid_price"
      )
      .map(({ row, reconciled }) => ({
        listing_id: row.id,
        title: row.listing_title,
        platform_listing_id: row.platform_listing_id,
        stored_auto_accept_cents: row.best_offer_auto_accept_cents,
        rule_auto_accept_cents: reconciled.autoAcceptCents,
        reason: reconciled.reason,
      }));

    return c.json({
      rule: {
        id: rule.id,
        accept_at_pct: rule.acceptAtPct,
        margin_floor_pct: rule.marginFloorPct,
      },
      conflicts,
    });
  } catch (err) {
    return failSafe(
      c,
      500,
      "Couldn't check your offer thresholds.",
      err,
      "ebay.offers.threshold_conflicts",
    );
  }
});

// POST /negotiation/threshold-conflicts/reconcile — US-2944. One action.
//
// Writes the rule's number onto every conflicting listing locally. It does NOT
// push to eBay here: the next publish or revise carries it, and firing a bulk
// revise from a "fix this" button would be a large, slow, rate-limited side
// effect the seller did not ask for.
flipdeskEbayRoutes.post("/negotiation/threshold-conflicts/reconcile", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { listing_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const ids = Array.isArray(body.listing_ids)
    ? body.listing_ids.filter((x): x is string => typeof x === "string").slice(0, 500)
    : [];
  if (ids.length === 0) return c.json({ error: "listing_ids is required." }, 400);

  try {
    const rule = await loadActiveOfferRule(ownerId);
    if (!rule || rule.acceptAtPct == null) {
      return c.json({ error: "No active offer rule to reconcile against." }, 409);
    }
    const { data, error } = await supabaseAdmin
      .from("listings")
      .select(
        "id, listing_price, best_offer_auto_accept_cents, " +
          "inventory_items!inner(user_id, acquired_price)",
      )
      // Owner-scoped BEFORE the id filter, so a listing id from another tenant
      // in the request body resolves to nothing rather than being updated.
      .eq("user_id", ownerId)
      .in("id", ids)
      .eq("inventory_items.user_id", ownerId);
    if (error) throw new Error(error.message);

    let updated = 0;
    for (
      const row of (data ?? []) as unknown as Array<{
        id: string;
        listing_price: number | null;
        best_offer_auto_accept_cents: number | null;
        inventory_items:
          | { acquired_price: number | null }
          | { acquired_price: number | null }[]
          | null;
      }>
    ) {
      const inv = Array.isArray(row.inventory_items)
        ? row.inventory_items[0]
        : row.inventory_items;
      const reconciled = reconcileAutoAcceptWithRule({
        priceCents: row.listing_price != null ? Math.round(Number(row.listing_price) * 100) : 0,
        sellerAcceptCents: row.best_offer_auto_accept_cents,
        ruleAcceptAtPct: rule.acceptAtPct,
        ruleMarginFloorPct: rule.marginFloorPct,
        itemCostCents: typeof inv?.acquired_price === "number"
          ? Math.round(inv.acquired_price * 100)
          : null,
      });
      if (reconciled.reason === "matched" || reconciled.reason === "no_rule") continue;
      const { error: writeError } = await supabaseAdmin
        .from("listings")
        .update({ best_offer_auto_accept_cents: reconciled.autoAcceptCents })
        .eq("id", row.id)
        .eq("user_id", ownerId);
      if (writeError) {
        console.error("[ebay.offers.reconcile] write:", writeError.message);
        continue;
      }
      updated++;
    }
    await writeAuditLog(c, {
      action: "ebay.offer_thresholds.reconcile",
      targetType: "flipdesk_automation_rule",
      targetId: rule.id,
      details: { requested: ids.length, updated },
    });
    return c.json({ ok: true, updated });
  } catch (err) {
    return failSafe(c, 500, "Couldn't reconcile the thresholds.", err, "ebay.offers.reconcile");
  }
});

// GET /negotiation/analytics — US-2942. What discount depth actually converts.
//
// Every reseller guesses at this. "Send 10% off" is folklore; nobody measures
// whether 10% converts worse than 20%, because nobody has the data. Once offers
// are stored it is arithmetic — and if 12% converts as well as 20%, every 20%
// offer that seller has ever sent gave away eight points for nothing.
//
// The two DIRECTIONS are reported separately and never pooled. An unprompted
// discount to a watcher and a counter to someone who already bid are different
// acts, and the counters' much higher accept rate would flatter the sends.
flipdeskEbayRoutes.get("/negotiation/analytics", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const days = Math.min(Math.max(Number(c.req.query("days")) || 180, 7), 730);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    const [sent, counters] = await Promise.all([
      loadOffers(ownerId, { direction: "offer_sent", sinceIso, limit: 1000 }),
      loadOffers(ownerId, { direction: "counter_sent", sinceIso, limit: 1000 }),
    ]);
    const toAnalytics = (rows: Awaited<ReturnType<typeof loadOffers>>) =>
      rows.map((o) => ({
        amountCents: o.amountCents,
        listPriceCents: o.listPriceCents,
        response: o.response,
        createdAt: o.createdAt,
        respondedAt: o.respondedAt,
      }));
    return c.json({
      days,
      sentOffers: summarizeOffers(toAnalytics(sent)),
      counters: summarizeOffers(toAnalytics(counters)),
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't build the offer analytics.", err, "ebay.offers.analytics");
  }
});

// POST /negotiation/rule-dry-run — US-2940. What an offer rule WOULD have done.
//
// Reads the STORED offers, which is the only reason this is possible: before
// US-2939 there was no history to run a rule against, so a seller enabling an
// auto-counter was guessing. Reads only — no eBay call, no write, no rule
// created.
//
// body { accept_at_pct?, counter_at_pct?, decline_below_pct?, margin_floor_pct?, days? }
flipdeskEbayRoutes.post("/negotiation/rule-dry-run", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    accept_at_pct?: unknown;
    counter_at_pct?: unknown;
    decline_below_pct?: unknown;
    margin_floor_pct?: unknown;
    days?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const cfg = {
    acceptAtPct: normalizeThresholdPct(body.accept_at_pct),
    declineBelowPct: normalizeThresholdPct(body.decline_below_pct),
    counterAtPct: normalizeThresholdPct(body.counter_at_pct),
    marginFloorPct: normalizeThresholdPct(body.margin_floor_pct) ?? 10,
  };
  if (cfg.acceptAtPct == null && cfg.declineBelowPct == null && cfg.counterAtPct == null) {
    return c.json({ error: "Set an auto-accept, auto-counter or auto-decline threshold." }, 400);
  }
  const days = Math.min(Math.max(Number(body.days) || 30, 1), 180);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const stored = await loadOffers(ownerId, {
      direction: "received",
      sinceIso,
      limit: 300,
    });
    // The acquisition cost per item, so the preview applies the margin floor
    // the same way the runner does. Owner-scoped through the parent item.
    const itemIds = [...new Set(stored.map((o) => o.itemExternalId).filter(Boolean))] as string[];
    const costByItemId = new Map<string, number>();
    if (itemIds.length > 0) {
      const { data: rows } = await supabaseAdmin
        .from("listings")
        .select("platform_listing_id, inventory_items!inner(user_id, acquired_price)")
        .eq("platform", "ebay")
        .in("platform_listing_id", itemIds)
        .eq("inventory_items.user_id", ownerId);
      for (
        const r of (rows ?? []) as unknown as Array<{
          platform_listing_id: string | null;
          inventory_items:
            | { acquired_price: number | null }
            | { acquired_price: number | null }[]
            | null;
        }>
      ) {
        const inv = Array.isArray(r.inventory_items) ? r.inventory_items[0] : r.inventory_items;
        if (r.platform_listing_id && typeof inv?.acquired_price === "number") {
          costByItemId.set(r.platform_listing_id, inv.acquired_price);
        }
      }
    }

    return c.json({
      days,
      ...dryRunOfferRule(
        cfg,
        stored.map((o) => ({
          externalOfferId: o.externalOfferId,
          offerPrice: o.amountCents == null ? null : o.amountCents / 100,
          // The SNAPSHOT price, not today's. Running the preview against the
          // current ask would score a rule on prices these offers never saw.
          listPrice: o.listPriceCents == null ? null : o.listPriceCents / 100,
          itemCost: o.itemExternalId ? (costByItemId.get(o.itemExternalId) ?? null) : null,
        })),
      ),
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't run the preview.", err, "ebay.offers.dry_run");
  }
});

// ── US-673: Best offers + send-offer + buyer messages ───────────────
//
// All of these operate against the caller's OWN eBay account: the token is
// resolved from the workspace owner's connection (getUserAccessToken), so a
// caller can only ever read/respond to offers + messages on their own listings.
// No cross-tenant id is accepted from the body for reads, and respond/reply act
// against the caller's eBay account — there is no way to target another tenant.

// US-1507: map eBay platform listing ids → the local listing's connection id so
// negotiation mutations run under the account that owns each listing. Ids with
// no local row (created outside GradeThread) or a legacy null connection map to
// undefined → the primary connection, the pre-1507 behavior. Tenant-scoped.
async function connectionIdsByPlatformListingId(
  userId: string,
  platformListingIds: string[],
): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  if (platformListingIds.length === 0) return out;
  const { data } = await supabaseAdmin
    .from("listings")
    .select("platform_listing_id, marketplace_connection_id")
    .eq("user_id", userId)
    .eq("platform", "ebay")
    .in("platform_listing_id", platformListingIds);
  for (
    const row of (data ?? []) as Array<{
      platform_listing_id: string | null;
      marketplace_connection_id: string | null;
    }>
  ) {
    if (row.platform_listing_id) {
      out.set(row.platform_listing_id, row.marketplace_connection_id ?? undefined);
    }
  }
  return out;
}

type OfferCostRow = {
  platform_listing_id: string | null;
  listing_price: number | null;
  // PostgREST returns a to-one embed as an object, but supabase-js types it
  // as an array — accept either.
  inventory_items:
    | { acquired_price: number | null; grade_value: number | null }
    | { acquired_price: number | null; grade_value: number | null }[]
    | null;
};

// US-2236 AC2 / US-2816: the cost, grade and asking price behind each offer.
// Scoped twice (US-268): the listing's own user_id, and the owner-verified
// parent item. acquired_price is numeric(10,2) dollars, matching eBay's offer
// price units.
async function loadOfferCostRows(userId: string, itemIds: string[]): Promise<OfferCostRow[]> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "platform_listing_id, listing_price, inventory_items!inner(user_id, acquired_price, grade_value)",
    )
    .eq("user_id", userId)
    .eq("platform", "ebay")
    .in("platform_listing_id", itemIds)
    .eq("inventory_items.user_id", userId);
  return (data ?? []) as unknown as OfferCostRow[];
}

// GET /negotiation/offers — incoming best offers across the seller's listings.
flipdeskEbayRoutes.get("/negotiation/offers", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const offers = await getBestOffers(userId);
    // US-2236 AC2: attach the item's acquisition cost so the counter UI can show
    // the resulting margin (a counter below break-even is otherwise invisible).
    // US-2816: this used to assert that the returned itemIds are necessarily
    // the seller's own listings. They are not - GetBestOffers also returns
    // offers this account SENT on OTHER people's listings, which is how a
    // seller came to be emailed their own $12 bid with an Accept button.
    // getBestOffers now drops those, so what arrives here is inbound only.
    // The cost lookup is still tenant-scoped via the
    // owner-verified parent (inventory_items.user_id — the loadListingOwned
    // pattern, US-268) as defence in depth. acquired_price is numeric(10,2)
    // dollars, matching the eBay offer/counter price units.
    const itemIds = [...new Set(offers.map((o) => o.itemId).filter(Boolean))];
    // OM-14: the three reads below are independent, so they run together
    // rather than one after another behind the eBay call. The listing price
    // rides on the cost query instead of a second read of the same rows.
    const [costRows, buyerHistory, sourcing] = await Promise.all([
      itemIds.length === 0 ? Promise.resolve([]) : loadOfferCostRows(userId, itemIds),
      // US-2941: what this seller already knows about the buyer.
      loadBuyerHistory(
        userId,
        offers.map((o) => o.buyerUsername).filter((b): b is string => !!b),
        // The offers on screen right now are not "prior" — counting them would
        // tell every first-time buyer they had offered before.
        offers.map((o) => o.bestOfferId),
      ),
      // US-3194: the two costs the margin on this screen used to ignore. Postage
      // and the grading fee come from the seller's own sourcing settings (00770),
      // read once for the whole page rather than per offer — they are the
      // seller's standing figures for a garment, not facts about one listing.
      sourcingCosts(userId),
    ]);
    const costByItemId = new Map<string, number>();
    const gradedItemIds = new Set<string>();
    // US-2939: the asking price at the time of the offer, from the local record.
    const listPrices = new Map<string, number>();
    for (const r of costRows) {
      const inv = Array.isArray(r.inventory_items) ? r.inventory_items[0] : r.inventory_items;
      if (!r.platform_listing_id) continue;
      if (typeof inv?.acquired_price === "number") {
        costByItemId.set(r.platform_listing_id, inv.acquired_price);
      }
      // US-3194: whether this item was actually graded decides whether the
      // grading fee belongs in the net figure at all. An ungraded item that
      // was charged one would show a smaller net than the sale really makes.
      if (typeof inv?.grade_value === "number") gradedItemIds.add(r.platform_listing_id);
      const price = r.listing_price == null ? Number.NaN : Number(r.listing_price);
      if (Number.isFinite(price)) listPrices.set(r.platform_listing_id, Math.round(price * 100));
    }
    // Record what this read saw, so a seller who never leaves the Offers page
    // still builds the history the analytics is computed from. OFF the response
    // path (OM-14): every open tab polls this every 90s, and the seller should
    // not wait on an upsert of eBay's raw payload to see their offers.
    void recordOffers(
      userId,
      offers.map((o) => incomingOfferToInput(o, listPrices.get(o.itemId))),
    ).catch((err) => console.error("[flipdesk-ebay] recordOffers (offers poll):", err));
    const shippingCost = (sourcing.shippingCents ?? DEFAULT_SOURCING_SHIPPING_CENTS) / 100;
    const gradingCost = (sourcing.gradingCents ?? DEFAULT_SOURCING_GRADING_CENTS) / 100;
    const enriched = offers.map((o) => {
      const key = buyerKey(o.buyerUsername);
      return {
        ...o,
        itemCost: costByItemId.get(o.itemId) ?? null,
        shippingCost,
        gradingCost: gradedItemIds.has(o.itemId) ? gradingCost : null,
        listPriceCents: listPrices.get(o.itemId) ?? null,
        buyerHistory: key ? (buyerHistory.get(key) ?? null) : null,
      };
    });
    return c.json({ offers: enriched });
  } catch (err) {
    console.error("[flipdesk-ebay] getBestOffers failed:", err);
    return c.json({ error: "Couldn't load best offers from eBay." }, 502);
  }
});

// POST /negotiation/offers/:bestOfferId/respond — accept / decline / counter.
// Body: { item_id, action, counter_price?, counter_quantity?, message? }
//
// OM-03: refuses before calling eBay when the stored copy says the offer is
// finished, when a counter is not between the bid and the asking price, when
// the quantity is not a positive whole number, or when the note is past eBay's
// SellerResponse cap. Each of those used to come back from eBay as a generic
// 502. Every response that does go out is recorded in the audit log with the
// member who pressed it.
flipdeskEbayRoutes.post("/negotiation/offers/:bestOfferId/respond", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const bestOfferId = c.req.param("bestOfferId");
  let body: {
    item_id?: unknown;
    action?: unknown;
    counter_price?: unknown;
    counter_quantity?: unknown;
    message?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  const action = body.action as BestOfferAction;
  if (!itemId) return c.json({ error: "item_id is required" }, 400);
  if (!isEbayId(itemId) || !isEbayId(bestOfferId)) {
    return c.json({ error: "That offer or item id isn't one eBay would send.", code: "invalid_id" }, 400);
  }
  if (action !== "Accept" && action !== "Decline" && action !== "Counter") {
    return c.json({ error: "action must be Accept, Decline, or Counter" }, 400);
  }
  const sellerMessage = typeof body.message === "string" ? body.message.trim() : "";
  if (sellerMessage.length > SELLER_RESPONSE_MAX) {
    return c.json({
      error: `The note can be at most ${SELLER_RESPONSE_MAX} characters.`,
      code: "message_too_long",
      max: SELLER_RESPONSE_MAX,
    }, 400);
  }
  // Only a counter carries a quantity; an accept or decline ignores the field.
  const counterQuantity = action === "Counter" ? parseCounterQuantity(body.counter_quantity) : 1;
  if (counterQuantity == null) {
    return c.json({
      error: "counter_quantity must be a whole number of 1 or more",
      code: "invalid_quantity",
    }, 400);
  }
  let counterCents: number | null = null;
  if (action === "Counter") {
    counterCents = priceToCents(body.counter_price);
    if (counterCents == null) {
      return c.json({ error: "counter_price must be a positive number" }, 400);
    }
  }
  try {
    // The stored copy of this offer, owner-scoped (US-268). It answers two
    // things without an eBay call: whether the offer is already over, and what
    // the bid and the asking price were for the counter bounds.
    const { data: stored } = await supabaseAdmin
      .from("marketplace_offers")
      .select("state, expires_at, amount_cents, list_price_cents")
      .eq("user_id", userId)
      .eq("platform", "ebay")
      .eq("direction", "received")
      .eq("external_offer_id", bestOfferId)
      .maybeSingle();
    const storedRow = stored as {
      state: string | null;
      expires_at: string | null;
      amount_cents: number | null;
      list_price_cents: number | null;
    } | null;
    if (storedOfferClosedReason(storedRow)) {
      return c.json({ error: OFFER_NOT_OPEN_COPY, code: "offer_not_open" }, 409);
    }
    if (action === "Counter") {
      let listCents = storedRow?.list_price_cents ?? null;
      if (listCents == null) {
        listCents = (await loadListPricesByItemId(userId, [itemId])).get(itemId) ?? null;
      }
      const verdict = validateCounter({
        offerCents: storedRow?.amount_cents ?? null,
        listCents,
        counterCents,
      });
      if (!verdict.ok) {
        return c.json({
          error: COUNTER_REFUSAL_COPY[verdict.reason],
          code: "counter_out_of_range",
          reason: verdict.reason,
        }, 400);
      }
    }
    const counterPrice = counterCents != null ? counterCents / 100 : undefined;

    // US-1507: respond via the connection that owns this listing when a local
    // row records it; unknown/legacy listings keep the primary connection.
    const connByListing = await connectionIdsByPlatformListingId(userId, [itemId]);
    await respondToBestOffer(userId, {
      itemId,
      bestOfferId,
      action,
      counterPrice,
      counterQuantity,
      sellerMessage: sellerMessage || undefined,
    }, connByListing.get(itemId));
    // US-1055: notify the owner that this offer was accepted/declined/countered.
    // Useful for workspace teams (a member may have responded) and for an audit
    // trail across devices. Deduped per (offer, action) so a retry can't double-
    // notify; tenant-scoped to the workspace owner. Best-effort — fire-and-forget.
    const responded: OfferAction =
      action === "Accept" ? "accepted" : action === "Decline" ? "declined" : "countered";
    // US-2939: record the outcome the moment we make it, rather than inferring
    // it later from a state eBay will have dropped. A countered offer also
    // becomes a row of its OWN — our counter is a distinct event from the bid
    // it answered, and the conversion figures divide by both.
    await recordOfferResponse(userId, bestOfferId, responded, {
      amountCents: counterCents,
    });
    if (action === "Counter" && counterCents != null) {
      await recordOffers(userId, [{
        direction: "counter_sent",
        externalOfferId: bestOfferId,
        itemExternalId: itemId,
        amountCents: counterCents,
        state: "Countered",
      }]);
    }
    // A binding sale or an irreversible decline, possibly by a workspace
    // member acting on the owner's store. writeAuditLog records the member who
    // pressed it (c.get("userId")), not the owner.
    await writeAuditLog(c, {
      action: "ebay.offer.respond",
      targetType: "ebay_best_offer",
      targetId: bestOfferId,
      details: { bestOfferId, itemId, action, counter_cents: counterCents },
    });
    void (async () => {
      const fresh = await claimMarketplaceEvent(
        userId,
        "offer",
        bestOfferId,
        `responded:${responded}`,
        "offer_responded",
      );
      if (fresh) await notifyOfferResponded(userId, null, responded);
    })();
    return c.json({ ok: true, best_offer_id: bestOfferId, action });
  } catch (err) {
    console.error("[flipdesk-ebay] respondToBestOffer failed:", err);
    // US-1510: an offer that was accepted/declined/expired elsewhere (buyer
    // retracted, another device responded, timer ran out) is a STALE-VIEW
    // problem, not a server failure — return a machine-readable 409 so the
    // client can show "no longer open" and refresh its inbox.
    if (isBestOfferNotOpenError(err)) {
      return c.json({ error: OFFER_NOT_OPEN_COPY, code: "offer_not_open" }, 409);
    }
    // US-1511: human-readable detail only (raw Trading blob stays in the log).
    return c.json({
      error: "eBay rejected the best-offer response.",
      detail:
        "eBay couldn't apply this response. Refresh the offers list and try again.",
    }, 502);
  }
});

const OFFER_NOT_OPEN_COPY =
  "This offer is no longer open. It may have expired or already been answered.";

// US-1510: Trading's RespondToBestOffer failure LongMessages for an offer that
// isn't actionable anymore. Message-based (the XML error ids aren't parsed onto
// the thrown error), so match the stable phrasings conservatively.
function isBestOfferNotOpenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no longer|expired|already (been )?(accepted|declined|countered|responded)|not (a )?valid best offer|invalid best offer|best offer .*(ended|closed)/i
    .test(msg);
}

// US-1510: the sell.negotiation scope is deliberately absent from the production
// consent (see getScopes in ebay-client.ts) — every /sell/negotiation call 403s
// there. Gate the send-offer surfaces on a distinct machine-readable code so
// clients can render "Not available yet" instead of round-tripping into a
// guaranteed failure. The feature reactivates automatically once the scope is
// re-added (US-1421) — this check reads the live scope list, not a flag.
const NEGOTIATION_UNAVAILABLE = {
  error:
    "Sending offers to interested buyers isn't available yet on this eBay connection.",
  code: "feature_unavailable" as const,
};

// US-1421: when the DEPLOYMENT requests the scope but THIS token still 403s,
// the token predates the grant — a re-consent fixes it, so the client gets a
// distinct code (and the connection is flagged, mirroring
// analytics_access_denied) instead of the dead-end "feature unavailable".
const NEGOTIATION_RECONNECT = {
  error:
    "Your eBay authorization predates the send-offers permission. Reconnect your eBay account to enable it.",
  code: "reconnect_required" as const,
};

// Pure body pick for a scope-403 — exported for tests.
export function negotiationScope403Body(deploymentHasScope: boolean) {
  return deploymentHasScope ? NEGOTIATION_RECONNECT : NEGOTIATION_UNAVAILABLE;
}

// US-1967 DECISION: sell.negotiation stays UNLICENSED on the production keyset
// (eBay gates it behind extra contracts, and requesting it fails the whole
// consent screen — see getScopes in ebay-client.ts). So send-offer is DEFERRED,
// not shipped-broken: clients must be able to learn the capability is off
// BEFORE rendering an entry point, rather than discovering it from a 501 after
// the seller taps. That's what this pure resolver + /negotiation/capabilities
// exist for. Re-licensing needs no client change — add the scope to EBAY_SCOPES
// and every gated surface reappears on its own.
export interface NegotiationCapability {
  send_offer_available: boolean;
  /** Machine-readable reason when unavailable; null when the feature works. */
  code: "feature_unavailable" | "reconnect_required" | null;
  /** Honest, seller-facing copy for the disabled state; null when available. */
  detail: string | null;
}

/**
 * Pure capability resolution — exported for tests.
 * - deployment lacks the scope  → permanently unavailable; nothing the seller
 *   can do, so the copy must NOT suggest reconnecting (that's the US-1967 bug:
 *   a misleading "reconnect" prompt for an unfixable state).
 * - deployment has it but THIS token 403'd → the token predates the grant, so a
 *   re-consent genuinely fixes it.
 */
export function negotiationCapability(
  deploymentHasScope: boolean,
  connectionDenied: boolean,
): NegotiationCapability {
  if (!deploymentHasScope) {
    return {
      send_offer_available: false,
      code: NEGOTIATION_UNAVAILABLE.code,
      detail: NEGOTIATION_UNAVAILABLE.error,
    };
  }
  if (connectionDenied) {
    return {
      send_offer_available: false,
      code: NEGOTIATION_RECONNECT.code,
      detail: NEGOTIATION_RECONNECT.error,
    };
  }
  return { send_offer_available: true, code: null, detail: null };
}

// GET /negotiation/capabilities — can this connection send offers to buyers?
// Cheap by design: reads the deployment scope list + the connection's sticky
// denial flag, and NEVER calls eBay — clients hit it on every inbox open to
// decide whether to render the send-offer entry point at all.
flipdeskEbayRoutes.get("/negotiation/capabilities", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let denied = false;
  try {
    // US-268: service role bypasses RLS — scope to the tenant explicitly.
    const { data } = await supabaseAdmin
      .from("marketplace_connections")
      .select("negotiation_access_denied")
      .eq("user_id", userId)
      .eq("marketplace", "ebay")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    denied = (data as { negotiation_access_denied: boolean | null } | null)
      ?.negotiation_access_denied === true;
  } catch (err) {
    // A flag-read hiccup must not fabricate availability — fall back to the
    // deployment-level answer, which is the one that matters in production.
    console.warn("[flipdesk-ebay] negotiation capability flag read failed:", err);
  }
  return c.json(negotiationCapability(isNegotiationScopeAvailable(), denied));
});

// US-1421: persist the per-connection denial (tenant-scoped; service role
// bypasses RLS — US-268). Best-effort: the 501 must reach the client even if
// the flag write hiccups.
async function markNegotiationDenied(userId: string, denied: boolean): Promise<void> {
  try {
    let q = supabaseAdmin
      .from("marketplace_connections")
      .update({ negotiation_access_denied: denied })
      .eq("user_id", userId)
      .eq("marketplace", "ebay");
    // Clearing is conditional so the common success path writes nothing.
    if (!denied) q = q.eq("negotiation_access_denied", true);
    await q;
  } catch (err) {
    console.warn("[flipdesk-ebay] negotiation_access_denied update failed:", err);
  }
}

// A runtime 403 from /sell/negotiation means THIS connection's token lacks the
// scope even though the deployment requests it (e.g. consented before the scope
// was added) — same client treatment as the deployment-level gate.
function isScopeForbidden(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 403;
}

// GET /negotiation/eligible — listings eligible for a send-offer-to-buyers.
flipdeskEbayRoutes.get("/negotiation/eligible", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  if (!isNegotiationScopeAvailable()) {
    return c.json(NEGOTIATION_UNAVAILABLE, 501);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const eligible = await findEligibleNegotiationItems(userId);
    const listingIds = eligible.map((it) => it.listingId);

    // Join eBay's eligible listingIds to local listings (by platform_listing_id)
    // for this tenant only (US-268: service-role bypasses RLS, so scope on
    // user_id) to recover the seller's real title, price and condition.
    const localByListingId = new Map<string, EligibleEnrichment>();
    if (listingIds.length > 0) {
      const { data: listingRows } = await supabaseAdmin
        .from("listings")
        .select(
          "inventory_item_id, platform_listing_id, listing_title, listing_price, ebay_condition",
        )
        .eq("user_id", userId)
        .eq("platform", "ebay")
        .in("platform_listing_id", listingIds);
      const rows = (listingRows ?? []) as Array<{
        inventory_item_id: string;
        platform_listing_id: string | null;
        listing_title: string | null;
        listing_price: number | null;
        ebay_condition: string | null;
      }>;

      // Thumbnail: first photo (by sort_order) for each matched item.
      const itemIds = Array.from(
        new Set(rows.map((r) => r.inventory_item_id).filter(Boolean)),
      );
      const imageByItemId = new Map<string, string | null>();
      if (itemIds.length > 0) {
        const { data: photoRows } = await supabaseAdmin
          .from("item_photos")
          .select("inventory_item_id, storage_path, photo_url, photo_type, photo_role, sort_order")
          .in("inventory_item_id", itemIds)
          .order("sort_order", { ascending: true });
        for (
          // US-1549: skip 'internal' photos so a reference shot (price tag)
          // never becomes the representative image.
          const p of filterEbayPhotos(
            (photoRows ?? []) as Array<{
              inventory_item_id: string;
              storage_path: string | null;
              photo_url: string | null;
              photo_type: string | null;
              sort_order: number;
            }>,
          )
        ) {
          // Keep only the first (lowest sort_order) photo per item.
          if (imageByItemId.has(p.inventory_item_id)) continue;
          imageByItemId.set(p.inventory_item_id, ebayPublicPhotoUrl(p));
        }
      }

      for (const r of rows) {
        if (!r.platform_listing_id) continue;
        localByListingId.set(r.platform_listing_id, {
          title: r.listing_title,
          price: r.listing_price,
          currency: "USD",
          imageUrl: imageByItemId.get(r.inventory_item_id) ?? null,
          condition: r.ebay_condition,
        });
      }
    }

    // Fall back to a Browse lookup for any eligible listing with no local row.
    const browseByListingId = new Map<string, EligibleEnrichment>();
    const unresolved = listingIds.filter((id) => !localByListingId.has(id));
    if (unresolved.length > 0) {
      const lookups = await Promise.all(
        unresolved.map((id) => getBrowseItemByLegacyId(id)),
      );
      unresolved.forEach((id, i) => {
        const b = lookups[i];
        if (b) browseByListingId.set(id, b);
      });
    }

    const items = enrichEligibleItems(eligible, localByListingId, browseByListingId);
    // US-1421: the scope works on this token — clear any stale denial flag.
    await markNegotiationDenied(userId, false);
    return c.json({ items });
  } catch (err) {
    console.error("[flipdesk-ebay] findEligibleNegotiationItems failed:", err);
    // US-1510/US-1421: a token without the scope. When the deployment DOES
    // request it, this token predates the grant → flag the connection +
    // tell the client to reconnect; otherwise it's the deployment-level gate.
    if (isScopeForbidden(err)) {
      await markNegotiationDenied(userId, true);
      return c.json(negotiationScope403Body(isNegotiationScopeAvailable()), 501);
    }
    return c.json({ error: "Couldn't load eligible listings from eBay." }, 502);
  }
});

// GET /negotiation/send-offer-today — US-2943. The morning list.
//
// find_eligible_items is on-demand, and the whole value of send-offer is that
// it reaches people ALREADY watching an item who have not pulled the trigger.
// A list nobody thinks to open is a feature that does not exist.
//
// A PROPOSAL. Nothing sends from here; the seller picks and presses, and the
// exposure figure below tells them the largest number that can come out of it.
//
// When the restricted scope is missing this returns 200 with a typed
// `unavailable` reason and the MARKDOWN FALLBACK in the same response, rather
// than a bare 501 — a seller who cannot send offers can still put those exact
// items in a sale, and making them go and find that out separately is how the
// feature reads as broken rather than as gated.
flipdeskEbayRoutes.get("/negotiation/send-offer-today", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const discountPct = Math.min(Math.max(Number(c.req.query("discount_pct")) || 10, 1), 60);

  const unavailable = (detail: string) =>
    c.json({
      available: false,
      detail,
      // The fallback, offered here rather than somewhere the seller has to go
      // and look for it.
      fallback: {
        kind: "markdown_sale",
        detail:
          "You can still put these items in a markdown sale, which reaches the same watchers.",
        href: "/dashboard/flipdesk/promotions",
      },
      candidates: [],
      suppressed: [],
    });

  if (!isNegotiationScopeAvailable()) {
    return unavailable(NEGOTIATION_UNAVAILABLE.error);
  }

  try {
    // The SAME assembly the daily digest uses. A digest that counted a
    // different set from the page it links to is worse than no digest — the
    // seller clicks through and the number does not match.
    const ranked = await loadRankedOfferCandidates(userId);
    await markNegotiationDenied(userId, false);
    return c.json({
      available: true,
      cooldownDays: OFFER_COOLDOWN_DAYS,
      discountPct,
      ...ranked,
      exposureCents: totalDiscountExposureCents(ranked.candidates, discountPct),
    });
  } catch (err) {
    if (isScopeForbidden(err)) {
      await markNegotiationDenied(userId, true);
      return unavailable(negotiationScope403Body(isNegotiationScopeAvailable()).error);
    }
    return failSafe(
      c,
      502,
      "Couldn't load today's offer candidates.",
      err,
      "ebay.offers.send_today",
    );
  }
});

// POST /negotiation/send-offer — send a discount offer to interested buyers.
// Body: { listing_ids: string[], discount_percentage: number | string, message? }
//
// OM-02: the discount is a whole number from 1 to 60 (a numeric 15 used to be
// silently dropped), the ids are de-duplicated and capped, and each account's
// group is recorded the moment it goes out. A partial send answers 200 with the
// ids that went and the ids that did not, so a retry resends only the failures.
flipdeskEbayRoutes.post("/negotiation/send-offer", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  if (!isNegotiationScopeAvailable()) {
    return c.json(NEGOTIATION_UNAVAILABLE, 501);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { listing_ids?: unknown; discount_percentage?: unknown; message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseSendOfferBody(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error, code: parsed.code, max: parsed.max }, 400);
  }
  const { listingIds, discountPct, message } = parsed.value;
  try {
    // US-1507: group listings by their owning connection and send one offer batch
    // per account — a mixed multi-store selection otherwise pushes every offer
    // through the primary token and eBay rejects the foreign listings.
    const connByListing = await connectionIdsByPlatformListingId(userId, listingIds);
    const groups = new Map<string | undefined, string[]>();
    for (const id of listingIds) {
      const key = connByListing.get(id);
      groups.set(key, [...(groups.get(key) ?? []), id]);
    }
    const listPrices = await loadListPricesByItemId(userId, listingIds);
    // US-2939/US-2943: record what went out. This is what powers the discount
    // curve AND the cooldown — without it tomorrow's list offers the same
    // watchers the same discount, which teaches them to wait.
    //
    // The offer id is eBay's listing id: send-offer answers with no per-offer
    // id of its own, and the unique key is (offer id, direction), so a re-send
    // after the cooldown updates the row rather than making a second one. That
    // is a known limit and it is why `lastOfferedAt` reads created_at.
    const result = await sendGroupsRecordingEach(
      groups,
      (connectionId, ids) =>
        sendOfferToInterestedBuyers(userId, {
          listingIds: ids,
          discountPercentage: String(discountPct),
          message,
        }, connectionId),
      async (ids) => {
        await recordOffers(
          userId,
          ids.map((id) => {
            const listCents = listPrices.get(id) ?? null;
            return {
              direction: "offer_sent" as const,
              externalOfferId: id,
              itemExternalId: id,
              listPriceCents: listCents,
              amountCents: listCents != null
                ? Math.round(listCents * (1 - discountPct / 100))
                : null,
              state: "Sent",
            };
          }),
        );
      },
    );

    if (result.sent.length === 0) {
      const first = result.failed[0]?.error;
      console.error("[flipdesk-ebay] sendOfferToInterestedBuyers failed:", first);
      // US-1510/US-1421: pre-scope token → flag + reconnect vs deployment gate.
      if (isScopeForbidden(first)) {
        await markNegotiationDenied(userId, true);
        return c.json(negotiationScope403Body(isNegotiationScopeAvailable()), 501);
      }
      // US-1511: mapped/human detail only — the raw blob stays in the log above.
      return c.json({
        error: "eBay rejected the offer.",
        detail: sendOfferFailureDetail(first),
      }, 502);
    }

    // US-1421: offers went out — the scope works; clear any stale denial flag.
    await markNegotiationDenied(userId, false);
    await writeAuditLog(c, {
      action: "ebay.offer.send",
      targetType: "ebay_listing",
      details: {
        listing_ids: result.sent,
        discount_pct: discountPct,
        count: result.sent.length,
        failed_count: result.failed.reduce((n, f) => n + f.ids.length, 0),
      },
    });
    return c.json({
      ok: result.failed.length === 0,
      count: result.sent.length,
      sent: result.sent,
      failed: result.failed.map((f) => {
        console.error("[flipdesk-ebay] sendOfferToInterestedBuyers group failed:", f.error);
        return { ids: f.ids, detail: sendOfferFailureDetail(f.error) };
      }),
    });
  } catch (err) {
    console.error("[flipdesk-ebay] send-offer failed:", err);
    return failSafe(c, 500, "Couldn't send the offer.", err, "ebay.offers.send");
  }
});

function sendOfferFailureDetail(err: unknown): string {
  return ebayFailureDetail(
    err,
    "eBay declined to send this offer. The listing may no longer be eligible. Refresh and try again.",
  );
}

// GET /messages — buyer member-message inbox (last 30 days).
flipdeskEbayRoutes.get("/messages", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const messages = await getMemberMessages(userId);
    return c.json({ messages });
  } catch (err) {
    console.error("[flipdesk-ebay] getMemberMessages failed:", err);
    return c.json({ error: "Couldn't load messages from eBay." }, 502);
  }
});

// POST /messages/:messageId/reply — reply to a buyer message.
// Body: { item_id, recipient_id, body }
//
// OM-01: ids are bounded to what eBay sends, the body to eBay's 2000-character
// cap, the reply goes out under the account that owns the listing (US-1507),
// the failure detail is human text rather than the raw Trading XML, and the
// send is recorded in the audit log without its text.
flipdeskEbayRoutes.post("/messages/:messageId/reply", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { item_id?: unknown; recipient_id?: unknown; body?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseReplyBody(c.req.param("messageId"), body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error, code: parsed.code, max: parsed.max }, 400);
  }
  const { messageId, itemId, recipientId, text } = parsed.value;
  try {
    const connByListing = await connectionIdsByPlatformListingId(userId, [itemId]);
    await replyToMemberMessage(userId, {
      itemId,
      parentMessageId: messageId,
      recipientId,
      body: text,
    }, connByListing.get(itemId));
    await writeAuditLog(c, {
      action: "ebay.message.reply",
      targetType: "ebay_member_message",
      targetId: messageId,
      // The length, never the text: a buyer conversation is not audit data.
      details: { messageId, itemId, length: text.length },
    });
    return c.json({ ok: true, message_id: messageId });
  } catch (err) {
    console.error("[flipdesk-ebay] replyToMemberMessage failed:", err);
    return c.json({
      error: "eBay rejected the reply.",
      detail: replyFailureDetail(err),
    }, 502);
  }
});

/**
 * OM-01: what a failed reply tells the browser. Exported for tests.
 *
 * The Trading error carries up to 300 characters of raw XML, which used to go
 * straight into a toast and into Sentry. ebayFailureDetail only ever returns a
 * mapped message or the generic below.
 */
export function replyFailureDetail(err: unknown): string {
  return ebayFailureDetail(
    err,
    "eBay couldn't send this reply. Refresh the inbox and try again.",
  );
}

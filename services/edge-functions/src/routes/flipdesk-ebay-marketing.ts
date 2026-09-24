// eBay routes: promotions, Promoted Listings, campaigns, keywords and the promoted-sync job.
//
// Split out of flipdesk-ebay.ts, which mounts this router at /api/flipdesk/ebay
// alongside its siblings. The local router keeps the name flipdeskEbayRoutes so
// every handler below is byte-for-byte the text it had before the split.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { DEFAULT_OFFER_MARGIN_FLOOR_PCT } from "../lib/offer-rules.ts";
import {
  createKeyword,
  createNegativeKeyword,
  listKeywords,
  listNegativeKeywords,
  type MatchType,
  negativeKeywordCandidates,
  suggestKeywords,
  updateKeyword,
} from "../lib/ebay-keywords.ts";
import {
  ensureCpcCampaign,
  findCpcCampaign,
  recommendationApiSupported,
} from "../lib/ebay-marketing.ts";
import { loadSearchTerms } from "../lib/ebay-ad-reports.ts";
import { computeLift, loadPromotions, recordPromotions } from "../lib/promotion-store.ts";
import { describeStack, evaluateStack } from "../lib/discount-stack.ts";
import { describeExclusion, selectMarkdownItems } from "../lib/markdown-rules.ts";
import {
  createEmailCampaign,
  emailCampaignReport,
  isStoreRequiredError,
  listEmailCampaigns,
  sendEmailCampaign,
} from "../lib/ebay-email-campaigns.ts";
import { loadMarkdownCandidates } from "../lib/markdown-candidates.ts";
import {
  type BulkAdResult,
  bulkCreateAdsByListingId,
  bulkUpdateAdRateByListingId,
  cloneCampaign,
  endCampaign,
  isCampaignAlreadyInState,
  pauseCampaign,
  resumeCampaign,
  suggestBids,
  suggestBudget,
  suggestItems,
} from "../lib/ebay-campaign-ops.ts";
import {
  getMarketplaceId,
  isAnalyticsAccessDenied,
  isEbayConfigured,
  isAlreadyDeletedError,
} from "../lib/ebay-client.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { failSafe } from "../lib/http-errors.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { refuseBelowRole } from "../lib/marketplace-admin-guard.ts";
import {
  createAdForListing,
  ensureAdCampaign,
  getAdForListing,
  getItemPromotions,
  getItemPromotion,
  buildItemPromotionBody,
  createItemPromotion,
  updateItemPromotion,
  deleteItemPromotion,
  type ItemPromotionInput,
  type PromotedListingRow,
  removeAdForListing,
  suggestedAdRateForCategory,
  fetchTrendingAdRates,
  summarizePromotedListings,
  syncPromotedListingsForOwner,
  updateAdRateForListing,
} from "../lib/ebay-marketing.ts";
import { type EbayEnv } from "./flipdesk-ebay-shared.ts";


export const flipdeskEbayRoutes = new Hono<EbayEnv>();

// US-1448 chunk 1: list the seller's eBay Promotions Manager item promotions
// (order discounts, volume discounts, coupons, sale events) so FlipDesk surfaces
// them. Read-only, tenant-scoped; no-access 403 → { access:false }.
flipdeskEbayRoutes.get("/promotions", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!ownerId) return c.json({ error: "Sign-in required" }, 401);
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const promotions = await getItemPromotions(ownerId);
    return c.json({ access: true, promotions });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false });
    console.error("[flipdesk-ebay] /promotions failed:", err);
    return c.json({ error: "Could not load eBay promotions." }, 502);
  }
});

// US-1979 (AC2): item_promotion CRUD.
//
// updateItemPromotion and deleteItemPromotion had ZERO route references — built,
// tested, and unreachable. createItemPromotion existed but only as an automation
// side-effect (flipdesk-automations.ts), never as something a seller could drive.
// So a seller could not create an order/volume/coupon promo on purpose, and could
// never edit or end one they had.
//
// TENANT MODEL — worth stating, because it differs from the refund route next door
// and the difference is not laziness. A refund has a LOCAL mirror (sales), so that
// route proves ownership against our own DB before calling eBay. An item promotion
// has NO local mirror: it exists only on eBay, under the seller's own account,
// reachable only through that seller's own token. There is nothing to check it
// against, and the token-scoping is a real boundary (eBay will not let this
// seller's token touch another seller's promotion), not an assumption about an
// external system's error codes. That is the same posture as the GET above.
//
// Validation is delegated to buildItemPromotionBody, which already enforces eBay's
// per-type rules (ORDER_DISCOUNT needs minSpend + an image, VOLUME_DISCOUNT needs
// buyQuantity, CODED_COUPON needs an 8-15 alphanumeric code) and throws. Those
// throws are the seller's mistake, so they surface as 400, not 502 — re-deriving
// the same rules here would be a second copy to drift.
const ITEM_PROMOTION_TYPES = new Set(["ORDER_DISCOUNT", "VOLUME_DISCOUNT", "CODED_COUPON"]);

function parseItemPromotionInput(raw: unknown): ItemPromotionInput | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "A promotion body is required." };
  const b = raw as Record<string, unknown>;
  const type = typeof b.type === "string" ? b.type.toUpperCase() : "";
  if (!ITEM_PROMOTION_TYPES.has(type)) {
    return { error: "type must be ORDER_DISCOUNT, VOLUME_DISCOUNT or CODED_COUPON." };
  }
  const listingIds = Array.isArray(b.listing_ids)
    ? b.listing_ids.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const percentOff = Number(b.percent_off);
  if (!Number.isFinite(percentOff)) return { error: "percent_off must be a number." };

  const input: ItemPromotionInput = {
    type: type as ItemPromotionInput["type"],
    name: typeof b.name === "string" ? b.name : "",
    listingIds,
    percentOff,
  };
  if (b.min_spend && typeof b.min_spend === "object") {
    const m = b.min_spend as { value?: unknown; currency?: unknown };
    if (typeof m.value === "string" && typeof m.currency === "string") {
      input.minSpend = { value: m.value, currency: m.currency };
    }
  }
  if (Number.isFinite(Number(b.buy_quantity))) input.buyQuantity = Number(b.buy_quantity);
  if (typeof b.promotion_image_url === "string") input.promotionImageUrl = b.promotion_image_url;
  if (typeof b.coupon_code === "string") input.couponCode = b.coupon_code;
  if (typeof b.start_date === "string") input.startDate = b.start_date;
  if (typeof b.end_date === "string") input.endDate = b.end_date;
  if (typeof b.priority === "string") input.priority = b.priority;
  return input;
}

flipdeskEbayRoutes.post("/promotions", async (c) => {
  // MP-02: spends or ends something on the owner's eBay account.
  const roleRefused = refuseBelowRole(c, c.get("workspaceRole"), "listing_manager");
  if (roleRefused) return roleRefused;
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  let raw: unknown;
  try { raw = await c.req.json(); } catch { raw = null; }
  const parsed = parseItemPromotionInput(raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const invalid = validateItemPromotion(parsed);
  if (invalid) return c.json({ error: invalid }, 400);

  let promotionId: string | null;
  try {
    promotionId = await createItemPromotion(ownerId, parsed);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the promotion.", err, "ebay.promotions.create");
  }
  await writeAuditLog(c, {
    action: "ebay.promotion.create",
    targetType: "ebay_promotion",
    targetId: promotionId ?? "unknown",
    details: { type: parsed.type, listings: parsed.listingIds.length, percent_off: parsed.percentOff },
  });
  return c.json({ ok: true, promotion_id: promotionId });
});

flipdeskEbayRoutes.put("/promotions/:promotionId", async (c) => {
  // MP-02: spends or ends something on the owner's eBay account.
  const roleRefused = refuseBelowRole(c, c.get("workspaceRole"), "listing_manager");
  if (roleRefused) return roleRefused;
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const promotionId = c.req.param("promotionId");
  let raw: unknown;
  try { raw = await c.req.json(); } catch { raw = null; }
  const parsed = parseItemPromotionInput(raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const invalid = validateItemPromotion(parsed);
  if (invalid) return c.json({ error: invalid }, 400);

  try {
    // eBay's PUT replaces the whole promotion but keeps the id, so watchers stay
    // attached — hence a full body here rather than a patch.
    await updateItemPromotion(ownerId, promotionId, parsed);
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the promotion update.", err, "ebay.promotions.update");
  }
  await writeAuditLog(c, {
    action: "ebay.promotion.update",
    targetType: "ebay_promotion",
    targetId: promotionId,
    details: { type: parsed.type, listings: parsed.listingIds.length, percent_off: parsed.percentOff },
  });
  return c.json({ ok: true, promotion_id: promotionId });
});

flipdeskEbayRoutes.delete("/promotions/:promotionId", async (c) => {
  // MP-02: spends or ends something on the owner's eBay account.
  const roleRefused = refuseBelowRole(c, c.get("workspaceRole"), "listing_manager");
  if (roleRefused) return roleRefused;
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const promotionId = c.req.param("promotionId");
  try {
    await deleteItemPromotion(ownerId, promotionId);
  } catch (err) {
    // Already gone is the desired end state — reconcile rather than error.
    if (!isAlreadyDeletedError(err) && !/\b404\b/.test(String(err))) {
      return failSafe(c, 502, "eBay rejected the promotion delete.", err, "ebay.promotions.delete");
    }
  }
  await writeAuditLog(c, {
    action: "ebay.promotion.delete",
    targetType: "ebay_promotion",
    targetId: promotionId,
    details: {},
  });
  return c.json({ ok: true });
});

// Validate by RUNNING the real builder rather than by re-deriving its rules or
// pattern-matching its error text.
//
// buildItemPromotionBody already encodes eBay's per-type requirements
// (ORDER_DISCOUNT needs minSpend + an image, CODED_COUPON needs an 8-15
// alphanumeric code, ...) and throws on violation. Calling it up front means a
// throw is DEFINITIONALLY the seller's input problem → 400, with the builder's own
// message. The alternative — letting it throw inside createItemPromotion and
// sniffing the message to tell "bad input" from "eBay said no" — was the first cut
// here and is wrong twice over: it couples the route to error-string wording, and
// a rule added to the builder later silently starts 502-ing instead of 400-ing.
// The builder is pure, so running it twice costs nothing.
function validateItemPromotion(input: ItemPromotionInput): string | null {
  try {
    buildItemPromotionBody(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Invalid promotion.";
  }
}

// ── Store follower campaigns (US-2953) ──────────────────────────────
//
// A seller with an eBay Store has an audience they already own and pay nothing
// to reach, and FlipDesk could not send to it.
//
// A SEND IS ALWAYS A HUMAN ACTION. No automation rule reaches these routes and
// there is no scheduled sender — a mailing list is the one asset here that a
// mistake destroys permanently. A rule that emails followers weekly because a
// threshold drifted does not produce a bad campaign, it produces unfollows.

// GET /marketing/email-campaigns — the seller's campaigns and their results.
flipdeskEbayRoutes.get("/marketing/email-campaigns", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json({ available: true, campaigns: await listEmailCampaigns(ownerId) });
  } catch (err) {
    if (isStoreRequiredError(err)) {
      // Detected, not assumed. A seller who subscribes tomorrow sees the
      // feature appear with no code change.
      return c.json({
        available: false,
        detail: "Emailing your followers needs an eBay Store subscription.",
        campaigns: [],
      });
    }
    return failSafe(c, 502, "Couldn't load your eBay campaigns.", err, "ebay.email.list");
  }
});

// POST /marketing/email-campaigns — create a DRAFT. Sending is separate.
//
// body { name, subject, listing_ids }  (LOCAL listing ids)
flipdeskEbayRoutes.post("/marketing/email-campaigns", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { name?: unknown; subject?: unknown; listing_ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!name || !subject) return c.json({ error: "name and subject are required." }, 400);
  const requested = Array.isArray(body.listing_ids)
    ? body.listing_ids.filter((x): x is string => typeof x === "string").slice(0, 200)
    : [];
  if (requested.length === 0) {
    return c.json({ error: "Pick at least one listing to feature." }, 400);
  }

  try {
    // LOCAL ids in, eBay ids out, owner-scoped — the same boundary the bulk ad
    // route uses, and for the same reason: an eBay item id is readable off any
    // public listing page.
    const { data: owned } = await supabaseAdmin
      .from("listings")
      .select("id, platform_listing_id")
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .in("id", requested);
    const platformIds = ((owned ?? []) as unknown as Array<{
      id: string;
      platform_listing_id: string | null;
    }>)
      .map((r) => r.platform_listing_id)
      .filter((id): id is string => !!id);
    if (platformIds.length === 0) {
      return c.json({ error: "None of those listings are live on eBay." }, 409);
    }

    const campaignId = await createEmailCampaign(ownerId, {
      name,
      subject,
      listingIds: platformIds,
    });
    await writeAuditLog(c, {
      action: "ebay.email_campaign.create",
      targetType: "ebay_email_campaign",
      targetId: campaignId,
      details: { name, listings: platformIds.length },
    });
    return c.json({ ok: true, campaign_id: campaignId, listings: platformIds.length });
  } catch (err) {
    if (isStoreRequiredError(err)) {
      return c.json({ error: "Emailing your followers needs an eBay Store subscription." }, 409);
    }
    return failSafe(c, 502, "eBay rejected the campaign.", err, "ebay.email.create");
  }
});

// POST /marketing/email-campaigns/:id/send — the explicit human action.
flipdeskEbayRoutes.post("/marketing/email-campaigns/:id/send", async (c) => {
  // MP-02: spends or ends something on the owner's eBay account.
  const roleRefused = refuseBelowRole(c, c.get("workspaceRole"), "admin");
  if (roleRefused) return roleRefused;
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const campaignId = c.req.param("id");
  try {
    await sendEmailCampaign(ownerId, campaignId);
    await writeAuditLog(c, {
      action: "ebay.email_campaign.send",
      targetType: "ebay_email_campaign",
      targetId: campaignId,
      details: {},
    });
    return c.json({ ok: true });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the send.", err, "ebay.email.send");
  }
});

// GET /marketing/email-campaigns/:id/report — opens and clicks, after the send.
flipdeskEbayRoutes.get("/marketing/email-campaigns/:id/report", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    return c.json(await emailCampaignReport(ownerId, c.req.param("id")));
  } catch (err) {
    // A campaign that has not gone out yet has no report, which is a state and
    // not a failure.
    console.warn("[ebay.email.report]", err instanceof Error ? err.message : String(err));
    return c.json({ opens: null, clicks: null, recipients: null });
  }
});

// POST /promotions/markdown-dry-run — US-2950. What the rule WOULD discount.
//
// The rule marks items down without asking, so a seller who cannot see the item
// list and the total discount before enabling it is being asked to trust a
// number they typed against stock they have not looked at.
//
// Reads only. No eBay call, no write, no rule created. The EXCLUSIONS are
// returned with their reasons too — "why is this item not in my sale" is the
// question a seller asks second, and it is invisible if only the hits are listed.
//
// body { min_days_listed, markdown_pct, margin_floor_pct?, min_grade? }
flipdeskEbayRoutes.post("/promotions/markdown-dry-run", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: {
    min_days_listed?: unknown;
    markdown_pct?: unknown;
    margin_floor_pct?: unknown;
    min_grade?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const markdownPct = Math.trunc(Number(body.markdown_pct) || 0);
  if (!(markdownPct > 0)) return c.json({ error: "Set a markdown percentage." }, 400);
  const cfg = {
    minDaysListed: Math.max(1, Math.trunc(Number(body.min_days_listed) || 45)),
    markdownPct,
    marginFloorPct: Math.max(
      0,
      Math.trunc(Number(body.margin_floor_pct) || DEFAULT_OFFER_MARGIN_FLOOR_PCT),
    ),
  };
  const minGradeRaw = body.min_grade;
  const minGrade = minGradeRaw == null || minGradeRaw === "" ? null : Number(minGradeRaw);
  if (minGrade != null && (!Number.isFinite(minGrade) || minGrade < 1 || minGrade > 10)) {
    return c.json({ error: "The minimum grade must be between 1 and 10." }, 400);
  }

  try {
    const candidates = await loadMarkdownCandidates(ownerId);
    const selection = selectMarkdownItems(
      {
        minDaysListed: cfg.minDaysListed,
        markdownPct: cfg.markdownPct,
        marginFloorPct: cfg.marginFloorPct,
        minGrade,
      },
      candidates,
    );
    return c.json({
      scanned: candidates.length,
      included: selection.included.map((i) => ({
        listing_id: i.listingId,
        title: i.title,
        price_cents: i.priceCents,
        days_listed: i.daysListed,
        grade: i.grade,
      })),
      excluded: selection.excluded.map((e) => ({
        listing_id: e.item.listingId,
        title: e.item.title,
        reason: e.reason,
        detail: describeExclusion(e.reason),
      })),
      exposure_cents: selection.exposureCents,
    });
  } catch (err) {
    return failSafe(c, 500, "Couldn't run the preview.", err, "ebay.promotions.markdown_dry_run");
  }
});

// GET /promotions/performance — US-2949. Did the sale actually sell more?
//
// "This sale made $840" is not a finding; the items would have sold something
// without it. What is reported is units and revenue DURING the promotion
// against the same window BEFORE it, and BOTH windows are returned so a seller
// can see what was compared rather than trust a lift figure with no denominator.
//
// A promotion too new or too short to have a comparable window reports no lift
// at all rather than a number driven entirely by which afternoon it ran.
//
// Local tables only — no eBay call on page load.
flipdeskEbayRoutes.get("/promotions/performance", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const promotions = await loadPromotions(ownerId, 50);
    if (promotions.length === 0) return c.json({ promotions: [] });

    // One sales read covering every promotion window, rather than one per
    // promotion. The oldest window start bounds it.
    const earliest = promotions
      .map((p) => (p.startsAt ? Date.parse(p.startsAt) : Number.NaN))
      .filter((t) => Number.isFinite(t))
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    const sinceMs = Number.isFinite(earliest)
      ? earliest - 90 * 86_400_000
      : Date.now() - 180 * 86_400_000;
    const { data: salesRows, error: salesErr } = await supabaseAdmin
      .from("sales")
      .select("sale_date, sale_price")
      .eq("user_id", ownerId)
      .gte("sale_date", new Date(sinceMs).toISOString())
      .limit(5000);
    // MP-11: an unread sales table would report every promotion as -100%.
    if (salesErr) throw salesErr;
    const sales = ((salesRows ?? []) as unknown as Array<{
      sale_date: string | null;
      sale_price: number | null;
    }>)
      .filter((r) => r.sale_date && r.sale_price != null)
      .map((r) => ({
        soldAt: r.sale_date!,
        priceCents: Math.round(Number(r.sale_price) * 100),
      }));

    return c.json({
      promotions: promotions.map((promo) => ({
        id: promo.id,
        external_promotion_id: promo.externalPromotionId,
        name: promo.name,
        promotion_type: promo.promotionType,
        status: promo.status,
        discount_pct: promo.discountPct,
        starts_at: promo.startsAt,
        ends_at: promo.endsAt,
        item_count: promo.itemCount,
        reported_units: promo.reportedUnits,
        reported_revenue_cents: promo.reportedRevenueCents,
        // NOT the seller's whole catalogue: this compares total sales in the
        // two windows, which is the honest available comparison when we do not
        // store which items were in the promotion. Said in the response so the
        // UI can say it too.
        comparison_basis: "all_sales_in_window",
        lift: computeLift(promo.startsAt, promo.endsAt, sales),
      })),
    });
  } catch (err) {
    return failSafe(
      c,
      500,
      "Couldn't work out how your promotions did.",
      err,
      "ebay.promotions.performance",
    );
  }
});

// POST /promotions/sync — US-2949. Pull the seller's promotions into the record.
flipdeskEbayRoutes.post("/promotions/sync", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const promos = await getItemPromotions(ownerId);
    const stored = await recordPromotions(
      ownerId,
      promos.map((p) => ({
        externalPromotionId: p.promotionId,
        promotionType: p.promotionType ?? null,
        name: p.name ?? null,
        status: p.promotionStatus ?? null,
        startsAt: p.startDate ?? null,
        endsAt: p.endDate ?? null,
        raw: p,
      })),
    );
    return c.json({ ok: true, stored });
  } catch (err) {
    return failSafe(c, 502, "Couldn't read your eBay promotions.", err, "ebay.promotions.sync");
  }
});

// GET /promotions/stack-check — US-2951. What an item leaves at once every
// discount stacks.
//
// A markdown sale, a coupon and an accepted offer can all apply to one garment
// and nothing added them up. This REPORTS; it removes nothing. Silently pulling
// an item out of a promotion the seller built is a bigger surprise than the
// discount was.
//
// An item with no recorded cost is reported as UNCHECKED, not as safe.
flipdeskEbayRoutes.get("/promotions/stack-check", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const marginFloorPct = Math.min(
    Math.max(Number(c.req.query("margin_floor_pct")) || DEFAULT_OFFER_MARGIN_FLOOR_PCT, 0),
    100,
  );
  try {
    // The active markdown percentage, if the seller is running one. eBay's
    // promotion object carries it; a seller in no sale simply has none.
    const promotions = await loadPromotions(ownerId, 50);
    const running = promotions.filter((p) => (p.status ?? "").toUpperCase() === "RUNNING");
    const markdownPct = running
      .filter((p) => (p.promotionType ?? "").toUpperCase().includes("MARKDOWN"))
      .map((p) => p.discountPct ?? 0)
      .reduce((a, b) => Math.max(a, b), 0) || null;
    const couponPct = running
      .filter((p) => (p.promotionType ?? "").toUpperCase().includes("COUPON"))
      .map((p) => p.discountPct ?? 0)
      .reduce((a, b) => Math.max(a, b), 0) || null;

    const { data: rows, error: rowsErr } = await supabaseAdmin
      .from("listings")
      .select(
        "id, listing_title, listing_price, best_offer_auto_accept_cents, " +
          "inventory_items!inner(user_id, acquired_price)",
      )
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .eq("listing_status", "active")
      .eq("inventory_items.user_id", ownerId)
      .limit(1000);
    // MP-11: an unread listings table is not "no discount breaches".
    if (rowsErr) throw rowsErr;

    const results = ((rows ?? []) as unknown as Array<{
      id: string;
      listing_title: string | null;
      listing_price: number | null;
      best_offer_auto_accept_cents: number | null;
      inventory_items:
        | { acquired_price: number | null }
        | { acquired_price: number | null }[]
        | null;
    }>).map((row) => {
      const inv = Array.isArray(row.inventory_items)
        ? row.inventory_items[0]
        : row.inventory_items;
      const verdict = evaluateStack({
        priceCents: row.listing_price != null ? Math.round(Number(row.listing_price) * 100) : null,
        costCents: typeof inv?.acquired_price === "number"
          ? Math.round(inv.acquired_price * 100)
          : null,
        // No per-listing postage exists: shipping_cost is on SALES (00008) and
        // is recorded after the fact, while a live listing carries only a
        // shipping POLICY id. Null UNDER-reports the stack, which is the safe
        // direction for a warning - it can miss a breach, never invent one.
        shippingCostCents: null,
        markdownPct,
        couponPct,
        autoAcceptCents: row.best_offer_auto_accept_cents,
        marginFloorPct,
      });
      return {
        listing_id: row.id,
        title: row.listing_title,
        worst_case_cents: verdict.worstCaseCents,
        floor_cents: verdict.floorCents,
        breaches: verdict.breaches,
        unchecked: verdict.unchecked,
        detail: describeStack(verdict),
      };
    });

    return c.json({
      margin_floor_pct: marginFloorPct,
      markdown_pct: markdownPct,
      coupon_pct: couponPct,
      breaching: results.filter((r) => r.breaches),
      // Reported separately and never folded into "safe": an item we could not
      // check is not an item we checked and cleared.
      unchecked: results.filter((r) => r.unchecked).length,
      checked: results.filter((r) => !r.unchecked).length,
    });
  } catch (err) {
    return failSafe(
      c,
      500,
      "Couldn't check your discounts.",
      err,
      "ebay.promotions.stack_check",
    );
  }
});

// US-1979 (AC2): GET /promotions/:promotionId — the FULL promotion.
//
// The list endpoint above returns summaries only (id/name/type/status/dates). An
// edit UI must read the whole promotion first, because updateItemPromotion is a PUT
// that REPLACES it: prefilling an edit form from the list shape would send back a
// body with no listings, no percent, no minSpend and no coupon code, silently
// wiping the promotion's targeting and discount while it keeps its id and looks
// like it saved. This is the read that makes the PUT safe.
//
// Registered AFTER the literal GET /promotions/performance and
// /promotions/stack-check above: Hono serves the first match, and ahead of them
// this route took "performance" and "stack-check" as promotion ids.
// ebay-promotions-route-order_test.ts holds the order.
flipdeskEbayRoutes.get("/promotions/:promotionId", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  try {
    const promotion = await getItemPromotion(ownerId, c.req.param("promotionId"));
    return c.json({ promotion });
  } catch (err) {
    if (isAnalyticsAccessDenied(err)) return c.json({ access: false }, 403);
    return failSafe(c, 502, "Couldn't load that promotion.", err, "ebay.promotions.get_one");
  }
});

// ── Campaign suggestions, lifecycle and bulk ads (US-2946/47/48) ────
//
// FlipDesk could create a campaign and set one ad rate at a time. It could not
// ask eBay what to promote, could not stop what it had started, and could not
// change a hundred rates without a hundred calls — so a seller who started a
// campaign here had to finish it in Seller Hub.
//
// The campaign id is always resolved from the seller's own connection through
// findCpcCampaign (reads) or ensureCpcCampaign (explicit writes); it is never
// taken from the request (US-268).

// GET /marketing/suggestions — eBay's view, joined to ours.
//
// Ranked by MARGIN AFTER THE AD FEE, not by eBay's own order, and the response
// says which ordering it used. eBay ranks by what it expects to sell; a seller
// cares what is left afterwards, and those are not the same list.
flipdeskEbayRoutes.get("/marketing/suggestions", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!recommendationApiSupported(getMarketplaceId())) {
    // Honest and specific: this marketplace has no suggestion API, which is not
    // the same as "you have nothing worth promoting".
    return c.json({
      supported: false,
      detail: "eBay does not offer promotion suggestions on this marketplace.",
      items: [],
    });
  }
  try {
    // MP-03: find, never create. A GET must not start a campaign on eBay.
    const found = await findCpcCampaign(ownerId);
    if (!found) {
      return c.json({
        supported: true,
        campaign: null,
        ordering: "margin_after_ad_fee",
        items: [],
      });
    }
    const { campaignId, adGroupId } = found;
    const [items, budget, bids] = await Promise.all([
      suggestItems(ownerId, campaignId),
      suggestBudget(ownerId, campaignId).catch(() => ({
        dailyBudgetCents: null,
        currency: null,
      })),
      adGroupId
        ? suggestBids(ownerId, campaignId, adGroupId).catch(() => [])
        : Promise.resolve([]),
    ]);
    if (items.length === 0) {
      return c.json({
        supported: true,
        campaign: { campaignId },
        ordering: "margin_after_ad_fee",
        items: [],
        budget,
        bids,
      });
    }

    // The local economics. Scoped through the owner-verified parent item, the
    // loadListingOwned pattern.
    const listingIds = items.map((i) => i.listingId);
    const { data: rows } = await supabaseAdmin
      .from("listings")
      .select(
        "platform_listing_id, listing_title, listing_price, listed_at, " +
          "inventory_items!inner(user_id, acquired_price)",
      )
      .eq("platform", "ebay")
      .in("platform_listing_id", listingIds)
      .eq("inventory_items.user_id", ownerId);
    const localById = new Map(
      ((rows ?? []) as unknown as Array<{
        platform_listing_id: string | null;
        listing_title: string | null;
        listing_price: number | null;
        listed_at: string | null;
        inventory_items:
          | { acquired_price: number | null }
          | { acquired_price: number | null }[]
          | null;
      }>).filter((r) => r.platform_listing_id).map((r) => [r.platform_listing_id!, r]),
    );

    const nowMs = Date.now();
    const enriched = items.map((it) => {
      const local = localById.get(it.listingId);
      const inv = Array.isArray(local?.inventory_items)
        ? local?.inventory_items[0]
        : local?.inventory_items;
      const priceCents = local?.listing_price != null
        ? Math.round(Number(local.listing_price) * 100)
        : null;
      const costCents = typeof inv?.acquired_price === "number"
        ? Math.round(inv.acquired_price * 100)
        : null;
      const rate = it.suggestedBidPercentage;
      const adFeeCents = priceCents != null && rate != null
        ? Math.round(priceCents * (rate / 100))
        : null;
      // Null, not zero, when the cost is unknown — an item with no cost basis
      // has an unknown margin, and ranking it as if it were free puts the
      // things we know least about at the top of a spending list.
      const marginAfterAdFeeCents = priceCents != null && costCents != null && adFeeCents != null
        ? priceCents - costCents - adFeeCents
        : null;
      const listedAt = local?.listed_at ? Date.parse(local.listed_at) : Number.NaN;
      return {
        listing_id: it.listingId,
        title: local?.listing_title ?? null,
        suggested_bid_percentage: rate,
        price_cents: priceCents,
        cost_cents: costCents,
        ad_fee_cents: adFeeCents,
        margin_after_ad_fee_cents: marginAfterAdFeeCents,
        days_listed: Number.isFinite(listedAt)
          ? Math.floor((nowMs - listedAt) / 86_400_000)
          : null,
      };
    }).sort((a, b) => {
      const am = a.margin_after_ad_fee_cents;
      const bm = b.margin_after_ad_fee_cents;
      if (am == null && bm == null) return 0;
      if (am == null) return 1;
      if (bm == null) return -1;
      return bm - am;
    });

    return c.json({
      supported: true,
      campaign: { campaignId },
      ordering: "margin_after_ad_fee",
      items: enriched,
      budget,
      bids,
    });
  } catch (err) {
    return failSafe(
      c,
      502,
      "Couldn't load eBay's promotion suggestions.",
      err,
      "ebay.marketing.suggestions",
    );
  }
});

// POST /marketing/campaign/:action — start | pause | resume | end | clone.
//
// MP-03: `start` is the only action that creates a campaign. The others act on
// the campaign that already exists and answer 404 when there is none, rather
// than creating one just to pause or end it.
//
// An already-in-that-state answer is success: a seller pressing Pause on a
// paused campaign should see it paused, not a 502.
flipdeskEbayRoutes.post("/marketing/campaign/:action", async (c) => {
  // MP-02: spends or ends something on the owner's eBay account.
  const roleRefused = refuseBelowRole(c, c.get("workspaceRole"), "admin");
  if (roleRefused) return roleRefused;
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const action = c.req.param("action");
  if (
    action !== "start" && action !== "pause" && action !== "resume" &&
    action !== "end" && action !== "clone"
  ) {
    return c.json({ error: "action must be start, pause, resume, end or clone." }, 400);
  }
  let body: { name?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    if (action === "start") {
      const { campaignId } = await ensureCpcCampaign(ownerId);
      await writeAuditLog(c, {
        action: "ebay.marketing.campaign.start",
        targetType: "ebay_ad_campaign",
        targetId: campaignId,
        details: {},
      });
      return c.json({ ok: true, campaign_id: campaignId });
    }
    const found = await findCpcCampaign(ownerId);
    if (!found) {
      return c.json({ error: "There is no cost-per-click campaign to change." }, 404);
    }
    const { campaignId } = found;
    let clonedId: string | null = null;
    try {
      if (action === "pause") await pauseCampaign(ownerId, campaignId);
      else if (action === "resume") await resumeCampaign(ownerId, campaignId);
      else if (action === "end") await endCampaign(ownerId, campaignId);
      else {
        clonedId = await cloneCampaign(
          ownerId,
          campaignId,
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : `FlipDesk ${new Date().toISOString().slice(0, 10)}`,
        );
      }
    } catch (err) {
      if (!isCampaignAlreadyInState(err)) throw err;
    }

    // ENDING CLEARS THE CACHED IDS. ensureCpcCampaign short-circuits on
    // marketplace_connections.ebay_cpc_campaign_id, so leaving a dead id there
    // means every later ad create is aimed at a campaign that no longer exists.
    if (action === "end") {
      const { error } = await supabaseAdmin
        .from("marketplace_connections")
        .update({ ebay_cpc_campaign_id: null, ebay_cpc_ad_group_id: null })
        .eq("user_id", ownerId)
        .eq("marketplace", "ebay");
      if (error) console.error("[ebay.marketing.campaign.end] cache clear:", error.message);
    }

    await writeAuditLog(c, {
      action: `ebay.marketing.campaign.${action}`,
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { cloned_campaign_id: clonedId },
    });
    return c.json({ ok: true, campaign_id: campaignId, cloned_campaign_id: clonedId });
  } catch (err) {
    return failSafe(
      c,
      502,
      "eBay rejected the campaign change.",
      err,
      `ebay.marketing.campaign.${action}`,
    );
  }
});

// POST /marketing/ads/bulk — body { listing_ids, bid_percentage, mode? }
//
// PER-LISTING RESULTS, never one aggregate ok. eBay's bulk endpoints return 200
// while rejecting half the batch, and reporting that as success is how a seller
// comes to believe a hundred items are promoted when forty are not.
flipdeskEbayRoutes.post("/marketing/ads/bulk", async (c) => {
  // MP-02: spends or ends something on the owner's eBay account.
  const roleRefused = refuseBelowRole(c, c.get("workspaceRole"), "listing_manager");
  if (roleRefused) return roleRefused;
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { listing_ids?: unknown; bid_percentage?: unknown; mode?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const requested = Array.isArray(body.listing_ids)
    ? body.listing_ids.filter((x): x is string => typeof x === "string")
    : [];
  if (requested.length === 0) {
    return c.json({ error: "listing_ids must be a non-empty array." }, 400);
  }
  const bid = Number(body.bid_percentage);
  if (!Number.isFinite(bid) || bid <= 0 || bid > 100) {
    return c.json({ error: "bid_percentage must be between 0 and 100." }, 400);
  }
  const mode = body.mode === "update" ? "update" : "create";

  try {
    // TENANT SCOPE, and the reason the body carries LOCAL listing ids rather
    // than eBay ones: the local id resolves through a row we own, so an id
    // belonging to another seller resolves to NOTHING. Taking eBay's own item
    // id here would mean trusting an identifier the caller could have read off
    // any public listing page.
    //
    // A foreign or unpublished id is REJECTED BY NAME rather than silently
    // dropped — a silent drop reports a smaller success than the caller asked
    // for and says nothing about why.
    const { data: owned } = await supabaseAdmin
      .from("listings")
      .select("id, platform_listing_id")
      .eq("user_id", ownerId)
      .eq("platform", "ebay")
      .in("id", requested);
    const platformById = new Map(
      ((owned ?? []) as unknown as Array<{ id: string; platform_listing_id: string | null }>)
        .filter((r) => r.platform_listing_id)
        .map((r) => [r.id, r.platform_listing_id!]),
    );
    const unresolved = requested.filter((id) => !platformById.has(id));
    if (unresolved.length > 0) {
      return c.json(
        {
          error: "Some listings can't be promoted.",
          detail:
            `${unresolved.length} of them either aren't yours or aren't live on eBay yet.`,
        },
        unresolved.length === requested.length ? 403 : 409,
      );
    }
    const platformIds = requested.map((id) => platformById.get(id)!);

    const { campaignId } = await ensureCpcCampaign(ownerId);
    const results: BulkAdResult[] = mode === "update"
      ? await bulkUpdateAdRateByListingId(ownerId, campaignId, platformIds, bid)
      : await bulkCreateAdsByListingId(ownerId, campaignId, platformIds, bid);
    const failed = results.filter((r) => !r.ok);
    await writeAuditLog(c, {
      action: `ebay.marketing.ads.bulk_${mode}`,
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { requested: requested.length, failed: failed.length, bid_percentage: bid },
    });
    return c.json({
      ok: failed.length === 0,
      campaign_id: campaignId,
      succeeded: results.length - failed.length,
      failed: failed.length,
      results,
    });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the bulk change.", err, "ebay.marketing.ads.bulk");
  }
});

// ── Promoted Listings Advanced keywords (US-2945) ───────────────────
//
// FlipDesk could create a CPC campaign and an ad group and then had no way to
// put a keyword in either. A bid you cannot aim is a bid you cannot control,
// and that aim is the only difference between Advanced and Standard.
//
// Every route resolves the seller's own campaign from the connection (the reads
// and PATCH through findCpcCampaign, which never creates; the adds through
// ensureCpcCampaign), so a campaign id is never taken from the request (US-268).

// GET /marketing/keywords — the seller's keywords, plus the negative-keyword
// candidates their own reported search terms already prove.
flipdeskEbayRoutes.get("/marketing/keywords", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    // MP-03: find, never create.
    const found = await findCpcCampaign(ownerId);
    if (!found) {
      return c.json({
        campaign: null,
        campaignId: null,
        adGroupId: null,
        keywords: [],
        negatives: [],
        negativeCandidates: [],
      });
    }
    const { campaignId, adGroupId } = found;
    const [keywords, negatives, terms] = await Promise.all([
      adGroupId ? listKeywords(ownerId, campaignId, adGroupId) : Promise.resolve([]),
      listNegativeKeywords(ownerId, campaignId),
      loadSearchTerms(ownerId, { limit: 500 }),
    ]);
    return c.json({
      campaign: { campaignId },
      campaignId,
      adGroupId,
      keywords,
      negatives,
      // Computed here rather than in the UI: it is the half a seller can act on
      // today, and the rule for what counts as waste is one number the page and
      // the test have to agree about.
      negativeCandidates: negativeKeywordCandidates(
        terms.map((t) => ({
          term: t.term,
          impressions: t.impressions,
          clicks: t.clicks,
          attributedSales: t.attributedSales,
        })),
        negatives.map((n) => n.text),
      ),
    });
  } catch (err) {
    return failSafe(c, 502, "Couldn't load your eBay keywords.", err, "ebay.marketing.keywords");
  }
});

// GET /marketing/keywords/suggestions — eBay's own suggestions.
flipdeskEbayRoutes.get("/marketing/keywords/suggestions", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    // MP-03: find, never create.
    const found = await findCpcCampaign(ownerId);
    if (!found?.adGroupId) return c.json({ campaign: null, suggestions: [] });
    return c.json({
      campaign: { campaignId: found.campaignId },
      suggestions: await suggestKeywords(ownerId, found.campaignId, found.adGroupId),
    });
  } catch (err) {
    // A marketplace or account without suggestions is a normal state, not an
    // outage: report none rather than an error the seller cannot act on.
    console.warn(
      "[ebay.marketing.keyword_suggestions]",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ suggestions: [] });
  }
});

// POST /marketing/keywords — body { text, match_type?, bid_cents? }
flipdeskEbayRoutes.post("/marketing/keywords", async (c) => {
  // MP-02: spends or ends something on the owner's eBay account.
  const roleRefused = refuseBelowRole(c, c.get("workspaceRole"), "listing_manager");
  if (roleRefused) return roleRefused;
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { text?: unknown; match_type?: unknown; bid_cents?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required." }, 400);
  const matchType = normalizeMatchType(body.match_type);
  const bidCents = Number.isFinite(Number(body.bid_cents)) && Number(body.bid_cents) > 0
    ? Math.round(Number(body.bid_cents))
    : null;
  try {
    const { campaignId, adGroupId } = await ensureCpcCampaign(ownerId);
    const keywordId = await createKeyword(ownerId, campaignId, adGroupId, {
      text,
      matchType,
      bidCents,
    });
    await writeAuditLog(c, {
      action: "ebay.marketing.keyword.create",
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { keyword_id: keywordId, text, match_type: matchType, bid_cents: bidCents },
    });
    return c.json({ ok: true, keyword_id: keywordId });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the keyword.", err, "ebay.marketing.keyword.create");
  }
});

// PATCH /marketing/keywords/:keywordId — body { bid_cents?, status? }
flipdeskEbayRoutes.patch("/marketing/keywords/:keywordId", async (c) => {
  // MP-02: spends or ends something on the owner's eBay account.
  const roleRefused = refuseBelowRole(c, c.get("workspaceRole"), "listing_manager");
  if (roleRefused) return roleRefused;
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const keywordId = c.req.param("keywordId");
  let body: { bid_cents?: unknown; status?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const bidCents = Number.isFinite(Number(body.bid_cents)) && Number(body.bid_cents) > 0
    ? Math.round(Number(body.bid_cents))
    : null;
  const status = body.status === "ACTIVE" || body.status === "PAUSED" ? body.status : undefined;
  if (bidCents == null && !status) {
    return c.json({ error: "Nothing to change — send bid_cents or status." }, 400);
  }
  try {
    // MP-03: a keyword belongs to an existing campaign; never create one here.
    const found = await findCpcCampaign(ownerId);
    if (!found) return c.json({ error: "There is no cost-per-click campaign." }, 404);
    const { campaignId } = found;
    await updateKeyword(ownerId, campaignId, keywordId, { bidCents, status });
    await writeAuditLog(c, {
      action: "ebay.marketing.keyword.update",
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { keyword_id: keywordId, bid_cents: bidCents, status: status ?? null },
    });
    return c.json({ ok: true });
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the change.", err, "ebay.marketing.keyword.update");
  }
});

// POST /marketing/negative-keywords — body { text, match_type? }
flipdeskEbayRoutes.post("/marketing/negative-keywords", async (c) => {
  // MP-02: spends or ends something on the owner's eBay account.
  const roleRefused = refuseBelowRole(c, c.get("workspaceRole"), "listing_manager");
  if (roleRefused) return roleRefused;
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  let body: { text?: unknown; match_type?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text is required." }, 400);
  try {
    const { campaignId, adGroupId } = await ensureCpcCampaign(ownerId);
    const id = await createNegativeKeyword(
      ownerId,
      campaignId,
      adGroupId,
      text,
      normalizeMatchType(body.match_type),
    );
    await writeAuditLog(c, {
      action: "ebay.marketing.negative_keyword.create",
      targetType: "ebay_ad_campaign",
      targetId: campaignId,
      details: { negative_keyword_id: id, text },
    });
    return c.json({ ok: true, negative_keyword_id: id });
  } catch (err) {
    return failSafe(
      c,
      502,
      "eBay rejected the negative keyword.",
      err,
      "ebay.marketing.negative_keyword.create",
    );
  }
});

// PHRASE by default: EXACT blocks one spelling and lets every variation through,
// which reads to a seller as "the negative keyword did nothing".
function normalizeMatchType(raw: unknown): MatchType {
  return raw === "EXACT" || raw === "BROAD" ? raw : "PHRASE";
}

// ── Promoted Listings management (US-1044) ──────────────────────────
// GET status, POST to opt-in/set the ad rate, DELETE to opt out. The publish
// path already auto-attaches an ad; these give the seller explicit control.

interface PromoListingRow {
  platform_listing_id: string | null;
  platform_category_id: string | null;
  promo_opt_out: boolean | null;
  promote_override: boolean | null;
  promo_rate_pct: number | null;
  promo_ad_id: string | null;
  promo_status: string | null;
  platform_fields: { markdown_promotion_id?: unknown; markdown_pct?: unknown } | null;
}

async function loadPromoRow(
  listingId: string,
  userId: string,
): Promise<PromoListingRow | null> {
  const { data } = await supabaseAdmin
    .from("listings")
    .select(
      "platform_listing_id, platform_category_id, promo_opt_out, promote_override, promo_rate_pct, promo_ad_id, promo_status, platform_fields, inventory_items!inner(user_id)",
    )
    .eq("id", listingId)
    .maybeSingle();
  if (!data) return null;
  const row = data as unknown as PromoListingRow & {
    inventory_items: { user_id: string };
  };
  if (row.inventory_items.user_id !== userId) return null;
  return row;
}

flipdeskEbayRoutes.get("/listings/:id/promotion", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  const row = await loadPromoRow(listingId, userId);
  if (!row) return c.json({ error: "Listing not found" }, 404);
  const saleActive = typeof row.platform_fields?.markdown_promotion_id === "string";
  // 00432: seller defaults, so the client can show the EFFECTIVE promotion state
  // (override ?? default) and seed the default rate from the seller's setting.
  const { data: ownerRow } = await supabaseAdmin
    .from("users")
    .select(
      "promote_listings_by_default, default_promo_rate_pct, default_promo_mode",
    )
    .eq("id", userId)
    .maybeSingle();
  const owner = ownerRow as {
    promote_listings_by_default: boolean | null;
    default_promo_rate_pct: number | null;
    default_promo_mode: string | null;
  } | null;

  // US-1979 (AC1): prefer eBay's trending rate for this listing over our
  // category heuristic. Only live listings have an id eBay can recommend against;
  // a draft keeps the heuristic. fetchTrendingAdRates swallows its own failures
  // and returns an empty map, so a suggestion outage degrades to the heuristic
  // rather than failing the whole promotion panel.
  let suggestedRate = suggestedAdRateForCategory(row.platform_category_id);
  let suggestedBasis: "ebay_trending" | "category_heuristic" = "category_heuristic";
  if (row.platform_listing_id) {
    const trending = await fetchTrendingAdRates(userId, [row.platform_listing_id]);
    const pct = trending.get(row.platform_listing_id);
    if (pct !== undefined) {
      suggestedRate = pct;
      suggestedBasis = "ebay_trending";
    }
  }

  const promoteByDefault = owner?.promote_listings_by_default ?? false;
  const effectivePromote = row.promote_override ?? promoteByDefault;
  return c.json({
    opt_out: row.promo_opt_out ?? false,
    // Tri-state per-listing override (null = inherit) + the resolved effective state.
    promote_override: row.promote_override,
    effective_promote: effectivePromote,
    promote_by_default: promoteByDefault,
    default_rate_pct: owner?.default_promo_rate_pct ?? null,
    default_mode: owner?.default_promo_mode ?? null,
    rate_pct: row.promo_rate_pct,
    ad_id: row.promo_ad_id,
    status: row.promo_status,
    // US-1979 (AC1): eBay's OWN trending rate for THIS listing when it has one —
    // the average ad rate of listings that recently SOLD in the same category —
    // falling back to our category heuristic. suggested_rate_basis tells the UI
    // which it got, so it can say "eBay's trending rate" rather than implying our
    // guess came from eBay.
    suggested_rate_pct: suggestedRate,
    suggested_rate_basis: suggestedBasis,
    sale_active: saleActive,
    sale_pct: typeof row.platform_fields?.markdown_pct === "number"
      ? row.platform_fields.markdown_pct
      : null,
  });
});

flipdeskEbayRoutes.post("/listings/:id/promotion", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  let body: { rate_pct?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const rate = Number(body.rate_pct);
  if (!Number.isFinite(rate) || rate <= 0) {
    return c.json({ error: "rate_pct must be a positive number" }, 400);
  }
  const row = await loadPromoRow(listingId, userId);
  if (!row) return c.json({ error: "Listing not found" }, 404);
  if (!row.platform_listing_id) {
    return c.json(
      { error: "This listing has no eBay listing id. Sync or republish first." },
      409,
    );
  }

  let appliedRate = rate;
  let adId = row.promo_ad_id;
  try {
    const campaignId = await ensureAdCampaign(userId);
    const existing = await getAdForListing(userId, campaignId, row.platform_listing_id);
    if (existing?.adId) {
      appliedRate = await updateAdRateForListing(
        userId,
        campaignId,
        row.platform_listing_id,
        rate,
      );
      adId = existing.adId;
    } else {
      const created = await createAdForListing(
        userId,
        campaignId,
        row.platform_listing_id,
        rate,
      );
      adId = created?.adId ?? null;
    }
  } catch (err) {
    return failSafe(c, 502, "eBay rejected the promotion update.", err, "ebay.promotion.set");
  }

  await supabaseAdmin
    .from("listings")
    .update({
      promo_opt_out: false,
      // 00432: an explicit opt-in pins the tri-state override on, so it no longer
      // inherits the (off-by-default) seller default.
      promote_override: true,
      promo_rate_pct: appliedRate,
      promo_ad_id: adId,
      promo_status: "active",
    } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.promotion.set",
    targetType: "listing",
    targetId: listingId,
    details: { rate_pct: appliedRate, ad_id: adId },
  });
  return c.json({ ok: true, rate_pct: appliedRate, ad_id: adId });
});

flipdeskEbayRoutes.delete("/listings/:id/promotion", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const listingId = c.req.param("id");
  const row = await loadPromoRow(listingId, userId);
  if (!row) return c.json({ error: "Listing not found" }, 404);

  if (row.platform_listing_id) {
    try {
      const campaignId = await ensureAdCampaign(userId);
      await removeAdForListing(userId, campaignId, row.platform_listing_id);
    } catch (err) {
      return failSafe(c, 502, "eBay rejected removing the promotion.", err, "ebay.promotion.remove");
    }
  }

  await supabaseAdmin
    .from("listings")
    .update({
      promo_opt_out: true,
      // 00432: explicit opt-out pins the tri-state override off.
      promote_override: false,
      promo_ad_id: null,
      promo_status: null,
    } as never)
    .eq("id", listingId);

  await writeAuditLog(c, {
    action: "ebay.promotion.remove",
    targetType: "listing",
    targetId: listingId,
  });
  return c.json({ ok: true });
});

// US-561: lightweight category → suggested Promoted Listings ad rate. The
// composer surfaces this as the default ad rate so "promote by default" stays
// transparent — the seller accepts, adjusts, or opts out before publish. Pure
// (no eBay round-trip), so it's cheap to call on every category change.
flipdeskEbayRoutes.get("/marketing/ad-rate-suggestion", (c) => {
  const categoryId = c.req.query("category_id") ?? null;
  return c.json({
    category_id: categoryId,
    suggested_rate_pct: suggestedAdRateForCategory(categoryId),
  });
});

// US-561: refresh the live Promoted Listings ad status + bid for the
// workspace's promoted listings (user-triggered "Refresh" on the promotions
// surface). Tenant-scoped to the workspace owner inside the lib helper.
flipdeskEbayRoutes.post("/marketing/promoted/sync", async (c) => {
  // MP-11: the same guard and failSafe every other eBay route has. Before,
  // an unconfigured server or a thrown read escaped as a bare 500.
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  try {
    const result = await syncPromotedListingsForOwner(userId);
    return c.json({ ok: true, ...result });
  } catch (err) {
    return failSafe(c, 502, "Couldn't refresh your promoted listings.", err, "ebay.promoted.sync");
  }
});

// US-1044: read-only promotions overview — the seller's promoted listings plus
// roll-up performance for the management surface. Tenant-scoped to the workspace
// owner. Performance is what we reliably hold locally (live ad status, bid %,
// and the Cost-Per-Sale ad fee that eBay charges only on an attributed sale);
// click/impression metrics require eBay's async ad-report task and aren't
// surfaced synchronously here.
flipdeskEbayRoutes.get("/marketing/promoted/overview", async (c) => {
  const userId = c.get("workspaceOwnerId") ?? c.get("userId");
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, listing_title, listing_url, listing_price, listing_status, promo_status, promo_rate_pct, promo_ad_fees_cents, promo_synced_at",
    )
    .eq("user_id", userId)
    .eq("platform", "ebay")
    .not("promo_ad_id", "is", null)
    .order("promo_synced_at", { ascending: false, nullsFirst: false })
    .limit(200);
  // MP-11: a failed read is not "no promoted listings yet".
  if (error) {
    return failSafe(c, 500, "Couldn't load promoted listings.", error, "ebay.promoted.overview");
  }
  const listings = (data ?? []) as unknown as PromotedListingRow[];
  return c.json({ listings, summary: summarizePromotedListings(listings) });
});

// US-561: scheduled refresh of Promoted Listings ad status + bid. Walks every
// owner that has at least one live ad and syncs their promoted listings from the
// Marketing API, so the seller's post-publish "Promoted" surface reflects the
// current eBay adStatus. Job-secret gated (path is /jobs/*, not /listings/*).
flipdeskEbayRoutes.post("/jobs/promoted-sync", async (c) => {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("promoted-sync", 240);
  if (!lock.acquired) {
    return c.json({ skipped: true, reason: lock.reason, owners: 0 });
  }
  try {
    // Distinct owners with at least one live ad. The partial index
    // idx_listings_promo_active keeps this scan cheap.
    const { data: rows, error } = await supabaseAdmin
      .from("listings")
      .select("user_id")
      .eq("platform", "ebay")
      .not("promo_ad_id", "is", null)
      .limit(5000);
    if (error) {
      console.error("[flipdesk-ebay] promoted-sync owner scan failed:", error);
      return c.json({ error: "Scan failed" }, 500);
    }
    const owners = Array.from(
      new Set(((rows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
    );
    let scanned = 0;
    let updated = 0;
    for (const owner of owners) {
      try {
        const res = await syncPromotedListingsForOwner(owner);
        scanned += res.scanned;
        updated += res.updated;
      } catch (err) {
        console.warn(
          `[flipdesk-ebay] promoted-sync for owner ${owner} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return c.json({ owners: owners.length, scanned, updated });
  } finally {
    await lock.release();
  }
});

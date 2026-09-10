// US-3299: reading discount campaigns, and keeping their Stripe coupons honest.
//
// The arithmetic is in discount-campaigns.ts and imports nothing. This file is
// the side that touches the database and Stripe.
//
// Contract: docs/superpowers/specs/2026-09-09-discount-campaigns-design.md

import type Stripe from "stripe";
import { supabaseAdmin } from "./supabase.ts";
import { getStripe } from "./stripe-client.ts";
import {
  type DiscountCampaign,
  type DiscountTarget,
  resolveDiscount,
  type ResolvedDiscount,
} from "./discount-campaigns.ts";
import { listPriceCents } from "./package-prices.ts";

export const DISCOUNT_SELECT_COLS =
  "id, name, description, discount_type, percent_off, amount_off_cents, " +
  "starts_at, ends_at, enabled, targets, applies_to_all, stripe_coupon_id, " +
  "stripe_sync_error, revision, created_at, updated_at";

// Same 30s TTL as pricing-config. A sale starting is not urgent to the second,
// and an operator who ends one early gets it fleet-wide within half a minute.
const CACHE_TTL_MS = 30_000;
let cache: { value: DiscountCampaign[]; expires: number } | null = null;

/** Drop the cache on the replica that handled an admin edit, so it is instant there. */
export function clearDiscountCache(): void {
  cache = null;
}

/**
 * Every campaign whose window has not closed yet, cached.
 *
 * Deliberately NOT filtered to "live right now" in SQL: the rows are few, and a
 * 30-second cache that filtered by `now()` at query time would serve a stale
 * answer across a window boundary. resolveDiscount re-checks the dates against
 * the real clock on every call, so a cached row cannot outlive its window.
 *
 * FAIL-SAFE: a read error returns an empty list, which prices everything at list
 * price. That is the safe direction to be wrong in — the alternative is charging
 * a discount nobody authorised.
 */
export async function loadDiscountCampaigns(): Promise<DiscountCampaign[]> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.value;

  const { data, error } = await supabaseAdmin
    .from("discount_campaigns")
    .select(DISCOUNT_SELECT_COLS)
    .eq("enabled", true)
    .gt("ends_at", new Date(now).toISOString());

  if (error) {
    console.error("[discounts] read failed, pricing at list price:", error.message);
    return [];
  }

  const rows = (data ?? []) as unknown as DiscountCampaign[];
  cache = { value: rows, expires: now + CACHE_TTL_MS };
  return rows;
}

/** The best live campaign for one package, straight from the store. */
export async function resolveDiscountFor(
  target: DiscountTarget,
  originalCents: number,
  nowMs: number = Date.now(),
): Promise<ResolvedDiscount | null> {
  return resolveDiscount(await loadDiscountCampaigns(), target, originalCents, nowMs);
}

/**
 * Apply the best live campaign to a Checkout Session, in place.
 *
 * LAST in the precedence chain, after the referral coupon (US-1070), the win-back
 * drip incentive (US-942) and the earned rewards milestone (US-1853). Stripe
 * accepts exactly one coupon per session, and a discount promised to one person
 * outranks a sale offered to everyone — so this only fires when nothing else has
 * claimed the slot, which is what `sessionParams.discounts` already being set
 * means.
 *
 * Returns the resolution so the caller can fold the campaign id into its
 * idempotency key. That matters: several of these routes key on
 * `${userId}:${plan}:${interval}`, and Stripe replays a cached session for 24
 * hours. Without the campaign in the key, a user who opened checkout an hour
 * before the sale started would be handed the pre-sale session and charged full
 * price with the discount plainly on the card behind them.
 */
export async function applyCampaignDiscount(
  sessionParams: {
    discounts?: Array<{ coupon?: string }>;
    allow_promotion_codes?: boolean;
    metadata?: Record<string, string> | null;
  },
  target: DiscountTarget,
): Promise<ResolvedDiscount | null> {
  if (sessionParams.discounts) return null;

  // The list price comes from whichever source owns this product family, so the
  // saving recorded in metadata is against the price actually charged rather than
  // a compiled default an operator may have edited away from.
  const originalCents = await listPriceCents(target);
  if (originalCents === null) return null;

  const resolved = await resolveDiscountFor(target, originalCents);
  if (!resolved || !resolved.campaign.stripe_coupon_id) return null;

  // Stripe rejects `discounts` alongside `allow_promotion_codes`.
  delete sessionParams.allow_promotion_codes;
  sessionParams.discounts = [{ coupon: resolved.campaign.stripe_coupon_id }];

  // So the webhook and the revenue reports can attribute the sale to the campaign
  // that produced it.
  sessionParams.metadata = {
    ...(sessionParams.metadata ?? {}),
    discount_campaign_id: resolved.campaign.id,
    discount_saved_cents: String(resolved.savedCents),
  };
  return resolved;
}

/** Suffix for a Checkout idempotency key, so a sale starting invalidates a replay. */
export function discountKeySuffix(resolved: ResolvedDiscount | null): string {
  return resolved ? `:d-${resolved.campaign.id}` : "";
}

// ── Stripe coupon lifecycle ────────────────────────────────────────────────

export interface CouponSyncResult {
  couponId: string | null;
  error: string | null;
}

/**
 * Mint the Stripe coupon a campaign is redeemed through.
 *
 * `duration: "once"` is the owner's decision (2026-09-09): a subscriber who signs
 * up during the sale gets the discount on their FIRST invoice only — first month,
 * or first year on an annual plan — then pays list price. It is also the only
 * duration that behaves identically on the one-time products (grades, credit
 * packs), which have no second invoice for a "repeating" coupon to land on.
 *
 * `redeem_by` is the campaign's end. Stripe then refuses the coupon itself once
 * the window closes, so an expired campaign cannot be redeemed even by a client
 * holding a stale cache.
 *
 * The idempotency key carries the revision, so a retried save reuses the existing
 * coupon while a real edit mints a fresh one. Stripe coupons are immutable except
 * for name and metadata, which is why an edit cannot patch in place.
 */
export async function syncCampaignCoupon(
  campaign: {
    id: string;
    name: string;
    discount_type: "percent" | "amount";
    percent_off: number | null;
    amount_off_cents: number | null;
    ends_at: string;
    revision: number;
  },
): Promise<CouponSyncResult> {
  const stripe = getStripe();
  if (!stripe) return { couponId: null, error: "Stripe is not configured" };

  const params: Stripe.CouponCreateParams = {
    // Stripe caps the coupon name at 40 characters and rejects a longer one.
    name: campaign.name.slice(0, 40),
    duration: "once",
    redeem_by: Math.floor(Date.parse(campaign.ends_at) / 1000),
    metadata: { campaign_id: campaign.id, source: "discount_campaign" },
  };
  if (campaign.discount_type === "percent") {
    params.percent_off = Number(campaign.percent_off);
  } else {
    params.amount_off = Math.round(Number(campaign.amount_off_cents));
    params.currency = "usd";
  }

  try {
    const coupon = await stripe.coupons.create(params, {
      idempotencyKey: `discount-campaign:${campaign.id}:${campaign.revision}`,
    });
    return { couponId: coupon.id, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[discounts] coupon mint failed:", message);
    return { couponId: null, error: message };
  }
}

/**
 * Best-effort delete of a superseded coupon.
 *
 * Never throws. A coupon left behind in Stripe costs nothing — it is unreachable
 * once no campaign row points at it — whereas failing the admin save over it would
 * leave the row and Stripe disagreeing about which coupon is current.
 */
export async function deleteCampaignCoupon(couponId: string | null): Promise<void> {
  if (!couponId) return;
  const stripe = getStripe();
  if (!stripe) return;
  try {
    await stripe.coupons.del(couponId);
  } catch (err) {
    console.error(
      "[discounts] coupon delete failed (harmless, it is now unreferenced):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The fields whose change forces a new coupon, because Stripe cannot patch them. */
export function couponNeedsRemint(
  before: {
    discount_type: string;
    percent_off: number | null;
    amount_off_cents: number | null;
    ends_at: string;
  },
  after: {
    discount_type: string;
    percent_off: number | null;
    amount_off_cents: number | null;
    ends_at: string;
  },
): boolean {
  return (
    before.discount_type !== after.discount_type ||
    Number(before.percent_off) !== Number(after.percent_off) ||
    Number(before.amount_off_cents) !== Number(after.amount_off_cents) ||
    Date.parse(before.ends_at) !== Date.parse(after.ends_at)
  );
}

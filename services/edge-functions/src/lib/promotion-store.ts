// US-2949: the local record of promotions, and what they actually did.
//
// Markdown sales, coupons and volume discounts were created through FlipDesk
// and then never looked at again. The promotions card re-fetched them from eBay
// on every open, and nothing measured whether a sale sold more — so a seller
// repeated discounts on the strength of a feeling.
//
// ── LIFT IS A COMPARISON, AND THE COMPARISON IS STATED ──────────────────────
//
// "This sale made $840" is not a finding; the items would have sold something
// without it. The number worth reporting is units and revenue DURING the
// promotion against the same item set over the equal window BEFORE it, and both
// windows are returned so a seller can see what was compared rather than trust
// a lift figure with no denominator.
//
// A promotion too new or too short to have a comparable window returns null
// rather than a number. Same discipline as every other analytic here.
//
// Tenant-scoped: every function takes an ownerId and filters on it (US-268).

import { supabaseAdmin } from "./supabase.ts";

export interface PromotionInput {
  externalPromotionId: string;
  promotionType?: string | null;
  name?: string | null;
  status?: string | null;
  discountPct?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  itemCount?: number | null;
  reportedUnits?: number | null;
  reportedRevenueCents?: number | null;
  reportedAt?: string | null;
  raw?: unknown;
}

export interface StoredPromotion {
  id: string;
  externalPromotionId: string;
  promotionType: string | null;
  name: string | null;
  status: string | null;
  discountPct: number | null;
  startsAt: string | null;
  endsAt: string | null;
  itemCount: number | null;
  reportedUnits: number | null;
  reportedRevenueCents: number | null;
}

/**
 * Pure. Drops undefined, keeps null — the same rule as the post-sale and offer
 * stores, and for the same reason: a list sync carries fewer fields than a
 * report read, and writing every column would erase the report on the next
 * list refresh.
 */
export function toPromotionRow(
  ownerId: string,
  input: PromotionInput,
  nowIso: string,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    user_id: ownerId,
    platform: "ebay",
    external_promotion_id: input.externalPromotionId,
    last_seen_at: nowIso,
  };
  const optional: Array<[string, unknown]> = [
    ["promotion_type", input.promotionType],
    ["name", input.name],
    ["status", input.status],
    ["discount_pct", input.discountPct],
    ["starts_at", input.startsAt],
    ["ends_at", input.endsAt],
    ["item_count", input.itemCount],
    ["reported_units", input.reportedUnits],
    ["reported_revenue_cents", input.reportedRevenueCents],
    ["reported_at", input.reportedAt],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) row[key] = value;
  }
  if (input.raw !== undefined) row.raw = input.raw;
  return row;
}

export async function recordPromotions(
  ownerId: string,
  inputs: PromotionInput[],
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const rows = inputs
    .filter((i) => i.externalPromotionId)
    .map((i) => toPromotionRow(ownerId, i, nowIso));
  if (rows.length === 0) return 0;
  const { error } = await supabaseAdmin
    .from("marketplace_promotions")
    .upsert(rows, { onConflict: "user_id,platform,external_promotion_id" });
  if (error) {
    console.error("[promotion-store] recordPromotions:", error.message);
    return 0;
  }
  return rows.length;
}

const SELECT_COLUMNS =
  "id, external_promotion_id, promotion_type, name, status, discount_pct, starts_at, " +
  "ends_at, item_count, reported_units, reported_revenue_cents";

export async function loadPromotions(
  ownerId: string,
  limit = 100,
): Promise<StoredPromotion[]> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_promotions")
    .select(SELECT_COLUMNS)
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .order("starts_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    console.error("[promotion-store] loadPromotions:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Array<{
    id: string;
    external_promotion_id: string;
    promotion_type: string | null;
    name: string | null;
    status: string | null;
    discount_pct: number | string | null;
    starts_at: string | null;
    ends_at: string | null;
    item_count: number | null;
    reported_units: number | null;
    reported_revenue_cents: number | null;
  }>).map((r) => ({
    id: r.id,
    externalPromotionId: r.external_promotion_id,
    promotionType: r.promotion_type,
    name: r.name,
    status: r.status,
    discountPct: r.discount_pct == null ? null : Number(r.discount_pct),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    itemCount: r.item_count,
    reportedUnits: r.reported_units,
    reportedRevenueCents: r.reported_revenue_cents,
  }));
}

// ── Lift ────────────────────────────────────────────────────────────

/** The shortest promotion worth comparing, in whole days. */
export const MIN_PROMOTION_DAYS = 2;

export interface WindowStats {
  fromIso: string;
  toIso: string;
  units: number;
  revenueCents: number;
}

export interface PromotionLift {
  during: WindowStats;
  before: WindowStats;
  /** Change in units, as a fraction. Null when the BEFORE window sold nothing. */
  unitLift: number | null;
  revenueLift: number | null;
}

/**
 * Compare a promotion's window against the equal window before it. Pure.
 *
 * Returns null when the promotion is shorter than MIN_PROMOTION_DAYS or has no
 * readable window: a two-hour sale has no comparable "before", and reporting
 * one anyway produces a lift figure driven entirely by which afternoon it was.
 *
 * A BEFORE window that sold nothing yields a null lift rather than an infinite
 * one. Three units against zero is not "infinite improvement", it is a
 * comparison with no denominator, and printing a percentage there is the
 * clearest way to make a real finding look like a bug.
 */
export function computeLift(
  startsAt: string | null,
  endsAt: string | null,
  sales: Array<{ soldAt: string; priceCents: number }>,
  nowMs: number = Date.now(),
): PromotionLift | null {
  if (!startsAt) return null;
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) return null;
  // A running promotion is compared up to NOW, not to a future end date —
  // otherwise the "during" window includes days that have not happened and the
  // lift reads low for the whole time the sale is live.
  const endParsed = endsAt ? Date.parse(endsAt) : Number.NaN;
  const end = Number.isFinite(endParsed) ? Math.min(endParsed, nowMs) : nowMs;
  const spanMs = end - start;
  if (spanMs < MIN_PROMOTION_DAYS * 86_400_000) return null;

  const tally = (fromMs: number, toMs: number): WindowStats => {
    let units = 0;
    let revenueCents = 0;
    for (const s of sales) {
      const at = Date.parse(s.soldAt);
      if (!Number.isFinite(at) || at < fromMs || at >= toMs) continue;
      units++;
      revenueCents += s.priceCents;
    }
    return {
      fromIso: new Date(fromMs).toISOString(),
      toIso: new Date(toMs).toISOString(),
      units,
      revenueCents,
    };
  };

  const during = tally(start, end);
  const before = tally(start - spanMs, start);
  return {
    during,
    before,
    unitLift: before.units > 0 ? (during.units - before.units) / before.units : null,
    revenueLift: before.revenueCents > 0
      ? (during.revenueCents - before.revenueCents) / before.revenueCents
      : null,
  };
}

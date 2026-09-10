// US-3299: resolving a live sale campaign against one package price.
//
// The SAME algorithm lives at services/edge-functions/src/lib/discount-campaigns.ts
// and the two are pinned to the same vectors by a test on each side. They cannot
// share a file: this one imports nothing Deno-shaped and that one imports nothing
// browser-shaped, and a discount the card shows but checkout refuses is the exact
// failure the pair exists to prevent.
//
// Contract: docs/superpowers/specs/2026-09-09-discount-campaigns-design.md

export type DiscountTargetKind =
  | "flipdesk_plan"
  | "buyer_plan"
  | "grade_tier"
  | "credit_pack"
  | "action_pack";

export type DiscountInterval = "monthly" | "yearly";

/** A package a campaign can be aimed at. */
export interface DiscountTarget {
  kind: DiscountTargetKind;
  key: string;
  /** Subscription kinds only. Absent on a campaign target means "both". */
  interval?: DiscountInterval;
}

/** A row of public.discount_campaigns, as the client reads it. */
export interface DiscountCampaign {
  id: string;
  name: string;
  description: string | null;
  discount_type: "percent" | "amount";
  percent_off: number | null;
  amount_off_cents: number | null;
  starts_at: string;
  ends_at: string;
  enabled: boolean;
  targets: DiscountTarget[];
  applies_to_all: boolean;
  stripe_coupon_id: string | null;
}

export interface ResolvedDiscount {
  campaign: DiscountCampaign;
  originalCents: number;
  finalCents: number;
  savedCents: number;
  /** "20% off" / "$5 off" */
  label: string;
  /** "through Oct 31" */
  endsLabel: string;
}

/** The kinds that carry a billing interval. Everything else is a one-time buy. */
export const SUBSCRIPTION_KINDS: ReadonlySet<DiscountTargetKind> = new Set([
  "flipdesk_plan",
  "buyer_plan",
]);

function parseMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

/**
 * Live means enabled, inside the window, and successfully synced to Stripe.
 *
 * The stripe_coupon_id check is not belt-and-braces. The public RLS policy
 * already hides an unsynced row, but the edge reads this table with the
 * service-role client and sees every row, so the two callers would otherwise
 * disagree about which campaigns exist.
 *
 * The window is half-open: a campaign is live AT starts_at and not live AT
 * ends_at, so two back-to-back campaigns (ends 11-01T00:00, starts 11-01T00:00)
 * never both apply for an instant.
 */
export function isCampaignLive(c: DiscountCampaign, nowMs: number): boolean {
  if (!c.enabled) return false;
  if (!c.stripe_coupon_id) return false;
  const start = parseMs(c.starts_at);
  const end = parseMs(c.ends_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return start <= nowMs && nowMs < end;
}

/** Does this campaign cover the package being priced? */
export function campaignMatches(c: DiscountCampaign, target: DiscountTarget): boolean {
  if (c.applies_to_all) return true;
  if (!Array.isArray(c.targets)) return false;
  return c.targets.some((t) => {
    if (t.kind !== target.kind) return false;
    if (String(t.key) !== String(target.key)) return false;
    // A target with no interval covers both. A target WITH one only covers that
    // one, which is how "20% off annual plans only" is expressed.
    if (!t.interval) return true;
    return t.interval === target.interval;
  });
}

/**
 * The discounted price in cents. Floored at 0 and never above the original, so a
 * fat-fingered $500-off on a $29 plan is free rather than a negative charge.
 */
export function discountedCents(c: DiscountCampaign, originalCents: number): number {
  if (originalCents <= 0) return originalCents;
  if (c.discount_type === "percent") {
    const pct = Number(c.percent_off);
    if (!Number.isFinite(pct) || pct <= 0) return originalCents;
    const capped = Math.min(pct, 100);
    return Math.max(0, Math.round((originalCents * (100 - capped)) / 100));
  }
  const off = Number(c.amount_off_cents);
  if (!Number.isFinite(off) || off <= 0) return originalCents;
  return Math.max(0, originalCents - Math.round(off));
}

/**
 * Money, with cents only when there are cents.
 *
 * A discount is exactly why this cannot be a fixed number of decimals. FlipDesk
 * plans are whole dollars ($29, not $29.00 — money-display.test.ts pins that),
 * but 15% off $29 is $24.65, and rendering that as "$25" would be the invented
 * price the landing page once shipped for a $24.99 credit pack (US-2075).
 */
export function dollarsExact(cents: number): string {
  if (cents === 0) return "$0";
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function formatDiscountLabel(c: DiscountCampaign): string {
  if (c.discount_type === "percent") {
    const pct = Number(c.percent_off);
    // 20 reads as "20%", 12.5 as "12.5%" — never "20.00%".
    const shown = Number.isInteger(pct) ? String(pct) : String(Number(pct.toFixed(2)));
    return `${shown}% off`;
  }
  const cents = Number(c.amount_off_cents) || 0;
  const dollars = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return `$${dollars} off`;
}

export function formatEndsLabel(c: DiscountCampaign): string {
  const end = parseMs(c.ends_at);
  if (Number.isNaN(end)) return "";
  return `through ${new Date(end).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

/**
 * The best live campaign for one package, or null.
 *
 * OVERLAP: the largest saving wins, then the later start (the newer sale), then
 * the id. Two campaigns aimed at the same package must not resolve differently on
 * two page loads, and the array arrives in whatever order PostgREST returned it.
 *
 * A zero or negative price is skipped entirely, so the free plan card never
 * carries a "20% off $0" badge.
 */
export function resolveDiscount(
  campaigns: readonly DiscountCampaign[] | null | undefined,
  target: DiscountTarget,
  originalCents: number,
  nowMs: number = Date.now(),
): ResolvedDiscount | null {
  if (!campaigns || campaigns.length === 0) return null;
  if (!Number.isFinite(originalCents) || originalCents <= 0) return null;

  let best: ResolvedDiscount | null = null;
  for (const c of campaigns) {
    if (!isCampaignLive(c, nowMs)) continue;
    if (!campaignMatches(c, target)) continue;

    const finalCents = discountedCents(c, originalCents);
    const savedCents = originalCents - finalCents;
    if (savedCents <= 0) continue;

    const candidate: ResolvedDiscount = {
      campaign: c,
      originalCents,
      finalCents,
      savedCents,
      label: formatDiscountLabel(c),
      endsLabel: formatEndsLabel(c),
    };
    if (!best || beats(candidate, best)) best = candidate;
  }
  return best;
}

function beats(a: ResolvedDiscount, b: ResolvedDiscount): boolean {
  if (a.savedCents !== b.savedCents) return a.savedCents > b.savedCents;
  const aStart = parseMs(a.campaign.starts_at);
  const bStart = parseMs(b.campaign.starts_at);
  if (aStart !== bStart) return aStart > bStart;
  return a.campaign.id < b.campaign.id;
}

/** Every campaign live right now, newest window first. Drives the sale banner. */
export function liveCampaigns(
  campaigns: readonly DiscountCampaign[] | null | undefined,
  nowMs: number = Date.now(),
): DiscountCampaign[] {
  if (!campaigns) return [];
  return campaigns
    .filter((c) => isCampaignLive(c, nowMs))
    .sort((a, b) => parseMs(b.starts_at) - parseMs(a.starts_at));
}

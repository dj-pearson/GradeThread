// US-3299: resolving a live sale campaign against one package price (edge copy).
//
// MIRROR of src/lib/discounts.ts, line for line. They cannot share a file — that
// one is browser TypeScript resolved through Vite's `@/` alias, this one is Deno
// with `.ts` specifiers — so the pair is pinned instead by identical vectors in
// src/lib/__tests__/discounts.test.ts and src/tests/discount-campaigns_test.ts.
// Change one, change both.
//
// This module imports NOTHING on purpose. The store and the Stripe coupon
// lifecycle live in discount-store.ts, so a test of the arithmetic needs no
// database env.
//
// Contract: docs/superpowers/specs/2026-09-09-discount-campaigns-design.md

export type DiscountTargetKind =
  | "flipdesk_plan"
  | "buyer_plan"
  | "grade_tier"
  | "credit_pack"
  | "action_pack";

export type DiscountInterval = "monthly" | "yearly";

export interface DiscountTarget {
  kind: DiscountTargetKind;
  key: string;
  /** Subscription kinds only. Absent on a campaign target means "both". */
  interval?: DiscountInterval;
}

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
  label: string;
  endsLabel: string;
}

export const DISCOUNT_TARGET_KINDS: DiscountTargetKind[] = [
  "flipdesk_plan",
  "buyer_plan",
  "grade_tier",
  "credit_pack",
  "action_pack",
];

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
 * The stripe_coupon_id check matters MORE here than in the browser. The public
 * RLS policy already hides an unsynced row from the client, but this side reads
 * with the service-role client and sees every row — without the check the two
 * would disagree about which campaigns exist.
 *
 * The window is half-open: live AT starts_at, dead AT ends_at, so two back-to-back
 * campaigns never both apply for an instant.
 */
export function isCampaignLive(c: DiscountCampaign, nowMs: number): boolean {
  if (!c.enabled) return false;
  if (!c.stripe_coupon_id) return false;
  const start = parseMs(c.starts_at);
  const end = parseMs(c.ends_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return start <= nowMs && nowMs < end;
}

export function campaignMatches(c: DiscountCampaign, target: DiscountTarget): boolean {
  if (c.applies_to_all) return true;
  if (!Array.isArray(c.targets)) return false;
  return c.targets.some((t) => {
    if (t.kind !== target.kind) return false;
    if (String(t.key) !== String(target.key)) return false;
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

export function formatDiscountLabel(c: DiscountCampaign): string {
  if (c.discount_type === "percent") {
    const pct = Number(c.percent_off);
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
  return `through ${
    new Date(end).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  }`;
}

/**
 * The best live campaign for one package, or null.
 *
 * OVERLAP: the largest saving wins, then the later start (the newer sale), then
 * the id. Two campaigns aimed at the same package must not resolve differently on
 * two requests, and the array arrives in whatever order PostgREST returned it.
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

export function liveCampaigns(
  campaigns: readonly DiscountCampaign[] | null | undefined,
  nowMs: number = Date.now(),
): DiscountCampaign[] {
  if (!campaigns) return [];
  return campaigns
    .filter((c) => isCampaignLive(c, nowMs))
    .sort((a, b) => parseMs(b.starts_at) - parseMs(a.starts_at));
}

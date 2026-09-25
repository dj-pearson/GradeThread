// Pure helpers and shared types for the Referrals page and its tab
// components, kept out of the component files so fast refresh works and so
// they unit-test without rendering anything.

import { edgeFetch } from "@/lib/edge-fetch";
import { toastError } from "@/lib/toast-error";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

// US-1295 + the creator programme: earnings, onboarding and what blocks pay.
export interface AffiliatePayouts {
  enabled: boolean;
  program?: "user" | "creator";
  commission_model?: "flat" | "subscription_pct";
  commission_pct?: number;
  commission_cap_usd?: number;
  commission_window_months?: number;
  rate: number;
  minimum_payout: number;
  hold_days: number;
  onboarding: { connected: boolean; payouts_enabled: boolean };
  tax_profile_certified?: boolean;
  blocked_reason?: "below_minimum" | "not_onboarded" | "tax_profile_missing" | null;
  balance: { accrued_payable: number; accrued_held: number; paid: number; in_transit?: number };
  tax: { threshold: number; paid_this_year: number; reaches_1099_threshold: boolean };
  payouts: Array<{
    id: string;
    amount: number;
    status: string;
    stripe_transfer_id: string | null;
    paid_at: string | null;
    created_at: string;
  }>;
}

/** Start (or resume) Stripe Connect onboarding and go there. */
export async function startPayoutOnboarding(): Promise<void> {
  try {
    const res = await edgeFetch("/api/affiliate/connect", { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.url) throw new Error(json.error || "Couldn't start payout setup.");
    window.location.href = json.url;
  } catch (e) {
    toastError(e, "Couldn't start payout setup.");
    throw e;
  }
}

/** The rate sentence for the payout card, from the model in force. Exported for tests. */
export function payoutRateCopy(p: AffiliatePayouts): string {
  if (p.commission_model === "flat") {
    return `${usd(p.rate)} for every seller who joins through your link and makes a first paid grade.`;
  }
  const pct = p.commission_pct ?? 25;
  const months = p.commission_window_months ?? 12;
  const cap = p.commission_cap_usd ?? 250;
  return `${pct}% of their first ${months} months, up to ${usd(cap)} per account.`;
}

export type TaxField = "legal_name" | "tin" | "address_line1" | "city" | "region" | "postal_code" | "certify";

/** Field-level problems with the tax form, before it is sent. Exported for tests. */
export function taxFormErrors(f: {
  legalName: string;
  tin: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  certify: boolean;
}): Partial<Record<TaxField, string>> {
  const out: Partial<Record<TaxField, string>> = {};
  if (f.legalName.trim().length < 2) out.legal_name = "Enter your legal name.";
  if (f.tin.replace(/\D/g, "").length !== 9) out.tin = "A US tax ID is 9 digits.";
  if (!f.addressLine1.trim()) out.address_line1 = "Enter your street address.";
  if (!f.city.trim()) out.city = "Enter your city.";
  if (!/^[A-Z]{2}$/.test(f.region)) out.region = "Pick your state.";
  if (!/^\d{5}(-?\d{4})?$/.test(f.postalCode.trim())) out.postal_code = "ZIP is 5 digits, or 9.";
  if (!f.certify) out.certify = "Tick the box to certify.";
  return out;
}

export interface ReferralEvent {
  label: string;
  joined_at: string;
  status: "waiting" | "rewarded" | "forfeit";
  reason: "expired" | "over_cap" | null;
  credits: number;
  qualify_by: string | null;
}

const STATUS_ORDER: Record<ReferralEvent["status"], number> = {
  waiting: 0,
  rewarded: 1,
  forfeit: 2,
};

/**
 * Waiting rows first, the one closest to its deadline at the top (no deadline
 * sorts after every dated one), then rewarded, then forfeit, newest first
 * within each. Pure; exported for tests.
 */
export function sortReferralEvents(events: ReferralEvent[]): ReferralEvent[] {
  const time = (s: string | null) => {
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return events.slice().sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.status === "waiting") {
      const byDeadline = time(a.qualify_by) - time(b.qualify_by);
      if (byDeadline !== 0) return byDeadline;
    }
    return time(b.joined_at) - time(a.joined_at);
  });
}

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** The plain-words status for one row. Exported for tests. */
export function referralStatusText(e: ReferralEvent): string {
  if (e.status === "rewarded") return `Rewarded, +${e.credits} credits`;
  if (e.status === "forfeit") {
    return e.reason === "over_cap"
      ? "Didn't qualify: you'd reached the referral cap"
      : "Didn't qualify: no paid grade in time";
  }
  return e.qualify_by
    ? `Waiting for a first paid grade by ${shortDate(e.qualify_by)}`
    : "Waiting for a first paid grade";
}

/** The query key every leaderboard reader shares, so a save can refresh it. */
export const REFERRAL_LEADERBOARD_QUERY_KEY = ["referral-leaderboard"] as const;

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 23 -> "23rd". Exported for tests. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffixes: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
  const suffix = suffixes[n % 10] ?? "th";
  return `${n}${suffix}`;
}

export function rankLabel(rank: number, tied: boolean): string {
  return tied ? `Tied for ${ordinal(rank)}` : `Rank ${rank}`;
}

/**
 * The share message, built from what the friend actually gets. With no signup
 * bonus configured it promises nothing. Exported for tests.
 */
export function referralShareMessage(referredBonus: number | undefined): string {
  if (referredBonus && referredBonus > 0) {
    const grades = referredBonus === 1 ? "1 free grade" : `${referredBonus} free grades`;
    return `I grade my pre-owned clothing with GradeThread. Join with my link and get ${grades}:`;
  }
  return "I grade my pre-owned clothing with GradeThread. Take a look:";
}

// US-1845: the buyer platform's measurement vocabulary.
//
// The buyer funnel crosses four surfaces — a free public tool, signup, the buyer
// app, buyer billing — and every one of them was firing (or not firing) whatever
// event name its author happened to type. Two shipped events already existed
// (`buyer_funnel_cta`, `buyer_funnel_claimed`, US-1843) and nothing said what the
// third one should be called. This module is that answer: one ordered step list,
// one feature list, and one name-builder, so a step nobody can name is a step
// nobody can silently invent a second spelling for.
//
// PRIVACY. Everything here goes through `track()` (analytics.ts), which is a
// no-op until the visitor opts into the "analytics" cookie category — PostHog is
// not even downloaded before that. So these events are opt-in by construction:
// there is no code path that captures one from a visitor who declined, and no
// second consent notion to keep in sync. Acquisition properties come from the
// SAME gate (`getStoredUtm` refuses to store without analytics consent), which is
// why they can be attached unconditionally here.
//
// The names are stable identifiers in PostHog. Renaming one orphans its history,
// so the legacy US-1843 spellings are preserved exactly by the builder below
// rather than being "tidied" into a new scheme.

import { getConsent, track } from "./analytics";
import { getStoredUtm, type StoredUtm } from "./ad-attribution";
import { storedAffiliateRefCode } from "./affiliate";
import { BUYER_PLANS, type BuyerPlanKey } from "./constants";

// ── The funnel ───────────────────────────────────────────────────────
//
// Ordered: index N is downstream of index N-1. The order is what makes a
// drop-off chart possible without a hand-maintained funnel definition in the
// PostHog UI, so it is exported as data rather than as a comment.

export const BUYER_FUNNEL_STEPS = [
  /** A free public tool (whats-it-worth / grade-checker) produced a result. */
  "tool_result",
  /** A buyer conversion moment on that result was pressed. */
  "cta",
  /** Buyer signup was reached with a buyer intent. */
  "signup",
  /** The parked anonymous result became a real alert / closet entry. */
  "claimed",
  /** A buyer feature was used for the first time in this session. */
  "activated",
  /** Checkout was started from the buyer plan picker. */
  "subscribe_start",
  /** The buyer subscription is live (billing shows a paid buyer plan). */
  "subscribed",
  /** A buyer with an existing account came back to the buyer home. */
  "retained",
] as const;

export type BuyerFunnelStep = (typeof BUYER_FUNNEL_STEPS)[number];

/**
 * Exits are NOT steps. They record leaving the funnel, so putting them in the
 * ordered list would make every drop-off chart count a dismissal as progress.
 */
export const BUYER_FUNNEL_EXITS = ["claim_dismissed"] as const;
export type BuyerFunnelExit = (typeof BUYER_FUNNEL_EXITS)[number];

/** Zero-based position of a step in the funnel; -1 for an exit. */
export function buyerFunnelStepIndex(step: BuyerFunnelStep | BuyerFunnelExit): number {
  const i = (BUYER_FUNNEL_STEPS as readonly string[]).indexOf(step);
  return i;
}

/** The PostHog event name for a funnel step. Preserves the US-1843 spellings. */
export function buyerFunnelEventName(step: BuyerFunnelStep | BuyerFunnelExit): string {
  return `buyer_funnel_${step}`;
}

// ── Feature usage ────────────────────────────────────────────────────
//
// One event with a `feature` property, not one event per feature: adoption is a
// group-by, and a per-feature event name makes "which features does a Guard
// buyer actually use" a manual union of N series that goes stale the moment
// somebody ships the N+1th.
//
// These keys are the SAME keys the admin adoption panel reports
// (admin-growth /buyer → adoption), so a PostHog number and a database number
// can be put beside each other and mean the same thing.

export const BUYER_TRACKED_FEATURES = [
  "extension_check",
  "alerts",
  "confirmations",
  "guarantee_claims",
  "portfolio",
  "wants",
  "authenticity",
  "video_grade",
] as const;

export type BuyerTrackedFeature = (typeof BUYER_TRACKED_FEATURES)[number];

export const BUYER_FEATURE_EVENT = "buyer_feature_used";

// ── Acquisition attribution ──────────────────────────────────────────
//
// AC3: a buyer subscription and the credits they burn have to be traceable to
// what brought them. The resolution order is deliberate and is MIRRORED by the
// server-side aggregate (migration 00537 `buyer_growth_metrics`), so the two
// halves bucket the same buyer the same way:
//
//   1. first-touch utm_source — the channel that originally brought them; the
//      LAST touch is the one that closed and is kept as a separate property,
//      never as the bucket, or every buyer ends up attributed to whatever
//      newsletter they last clicked.
//   2. "affiliate" — an earned link (US-603) with no UTM on it.
//   3. "direct".

export const DIRECT_ACQUISITION_SOURCE = "direct";
export const AFFILIATE_ACQUISITION_SOURCE = "affiliate";

export interface BuyerAcquisitionProps {
  acquisition_source: string;
  acquisition_medium?: string;
  acquisition_campaign?: string;
  acquisition_last_source?: string;
  affiliate_ref?: string;
}

/**
 * Resolve the acquisition properties every buyer event carries. Pure over its
 * two inputs so the precedence is unit-testable without touching storage.
 */
export function buyerAcquisitionProps(
  utm: StoredUtm | null = getStoredUtm(),
  ref: string | null = storedAffiliateRefCode(),
): BuyerAcquisitionProps {
  const first = utm?.first;
  const source = first?.utm_source
    ?? (ref ? AFFILIATE_ACQUISITION_SOURCE : DIRECT_ACQUISITION_SOURCE);
  const props: BuyerAcquisitionProps = { acquisition_source: source };
  if (first?.utm_medium) props.acquisition_medium = first.utm_medium;
  if (first?.utm_campaign) props.acquisition_campaign = first.utm_campaign;
  if (utm?.last?.utm_source) props.acquisition_last_source = utm.last.utm_source;
  if (ref) props.affiliate_ref = ref;
  return props;
}

// ── MRR ──────────────────────────────────────────────────────────────
//
// Computed HERE, from the frontend tier matrix, and never in SQL. BUYER_PLANS is
// already written twice (advertised here, enforced on the edge) and guarded by
// one parity test; a third copy of the prices inside a migration would be a copy
// that test cannot see, in a file that can never be corrected once applied.
//
// A yearly subscription contributes a TWELFTH of its yearly price, so the number
// is monthly recurring revenue rather than "money collected this month" — a
// yearly cohort would otherwise make MRR spike on renewal and read as growth.

export interface BuyerPlanMixRow {
  plan: string;
  interval: string;
  users: number;
  /** Absent means already filtered to live subscriptions. */
  status?: string;
}

const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/** Monthly recurring cents from a plan × interval × status mix. */
export function buyerMrrCents(rows: readonly BuyerPlanMixRow[]): number {
  let cents = 0;
  for (const row of rows) {
    if (row.status !== undefined && !LIVE_SUBSCRIPTION_STATUSES.has(row.status)) continue;
    const plan = BUYER_PLANS[row.plan as BuyerPlanKey];
    if (!plan) continue;
    const monthly = row.interval === "yearly"
      ? plan.priceYearlyCents / 12
      : plan.priceMonthlyCents;
    cents += monthly * Math.max(0, row.users);
  }
  return Math.round(cents);
}

// ── The two call sites product code uses ─────────────────────────────

/** Record a buyer funnel step (or exit), enriched with acquisition source. */
export function trackBuyerFunnel(
  step: BuyerFunnelStep | BuyerFunnelExit,
  props: Record<string, unknown> = {},
): void {
  track(buyerFunnelEventName(step), {
    step,
    step_index: buyerFunnelStepIndex(step),
    ...buyerAcquisitionProps(),
    ...props,
  });
}

/**
 * Record one use of a buyer feature. `action` distinguishes what happened
 * inside the feature (created / removed / claimed …) without multiplying event
 * names, so adoption stays a single group-by on `feature`.
 *
 * The first feature used in a session ALSO emits the `activated` funnel step,
 * because activation is not a thing anyone presses — it is the first time a
 * signup did something. Deriving it here means no surface has to remember to
 * report it, and no surface can report it twice.
 */
export function trackBuyerFeature(
  feature: BuyerTrackedFeature,
  action: string,
  props: Record<string, unknown> = {},
): void {
  if (takeFirstFeatureOfSession()) {
    trackBuyerFunnel("activated", { feature, action });
  }
  track(BUYER_FEATURE_EVENT, {
    feature,
    action,
    ...buyerAcquisitionProps(),
    ...props,
  });
}

const ACTIVATION_SESSION_KEY = "gt_buyer_activated";

/**
 * True exactly once per browser session, the first time a buyer feature is
 * used. Consent-gated like everything else here: with analytics declined we
 * write no marker (so nothing is stored) and report false (so nothing is sent).
 */
function takeFirstFeatureOfSession(): boolean {
  if (getConsent()?.analytics !== true) return false;
  try {
    if (sessionStorage.getItem(ACTIVATION_SESSION_KEY)) return false;
    sessionStorage.setItem(ACTIVATION_SESSION_KEY, "1");
    return true;
  } catch {
    // Storage unavailable (private mode / SSR): skip the derived step rather
    // than emit it on every action.
    return false;
  }
}

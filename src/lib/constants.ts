// NOTE: RELATIVE import (not the "@/" alias). constants.ts is pulled into the
// Vite-config Node context via the public-routes → glossary → constants chain,
// where the "@/" alias is NOT resolved (and tsc -b compiles it under a project
// without the alias). Type-only, so it's erased at runtime. (US-1670 build fix.)
import type { SignupSource } from "../types/database";

// There is no integer-keyed GRADE_LABELS map here any more. US-2436 deleted it,
// and not for being unused — for being WRONG. It named ten labels including
// "Below Average", "Very Poor" and "Salvage/Parts Only", which are not on the
// published scale: that scale has the seven tiers below, and
// vault/20-domain/grading-scale-and-weights.md is its contract. whats-it-worth.tsx
// had already written its own tierLabelForGrade() to get away from those labels.
// A grade's display text comes from the server-written inventory_items.grade_label
// column; a tier name comes from GRADE_TIERS.
export const GRADE_TIERS = [
  "NWT",
  "NWOT",
  "Excellent",
  "Very Good",
  "Good",
  "Fair",
  "Poor",
] as const;

// Garment types
export const GARMENT_TYPES = [
  "tops",
  "bottoms",
  "outerwear",
  "dresses",
  "footwear",
  "accessories",
] as const;

// Garment categories
export const GARMENT_CATEGORIES = [
  "t-shirt",
  "shirt",
  "blouse",
  "sweater",
  "hoodie",
  "jacket",
  "coat",
  "jeans",
  "pants",
  "shorts",
  "skirt",
  "dress",
  "sneakers",
  "boots",
  "sandals",
  "hat",
  "bag",
  "belt",
  // US-2224 (00570): neckwear and gloves had NO garment_category at all, so a
  // tie could only be filed as "other" — which routes it into the clothing
  // rubric, the exact thing the accessories rubric exists to stop.
  // "neckwear" rather than "tie" because one rubric grades a bow tie, an ascot
  // and a cravat, and a value named for one invites "other" for the rest.
  "scarf",
  "neckwear",
  "gloves",
  "other",
] as const;

// Submission statuses
export const SUBMISSION_STATUSES = [
  "pending",
  "processing",
  "pending_review",
  "completed",
  "failed",
  "disputed",
] as const;

// Measurement photo points — flat shots with a tape measure used to derive
// size when a garment has no/illegible size tag (e.g. used Lululemon). Shared
// verbatim by both the grading (image_type) and FlipDesk (flipdesk_photo_type)
// taxonomies so a measurement shot means the same thing everywhere.
export const MEASUREMENT_PHOTO_TYPES = [
  "measurement_chest",
  "measurement_waist",
  "measurement_length",
  "measurement_sleeve",
  "measurement_inseam",
] as const;

// The human labels for these five live in PHOTO_TYPE_LABELS below, which covers
// the same keys with a "Measure: " prefix and is the one anything renders.
// US-2436 removed a third, unreferenced copy that sat here; the second copy is
// still inline in photo-upload.tsx, which is a de-duplication worth doing but
// not in a mechanical pass.

// Image types (core grading submissions). label_2 = a second tag shot (brand +
// separate size/care tag); detail_2..4 = extra close-ups; measurement_* let a
// seller document dimensions when there's no size tag.
export const IMAGE_TYPES = [
  "front",
  "back",
  "label",
  "label_2",
  "detail",
  "detail_2",
  "detail_3",
  "detail_4",
  "defect",
  ...MEASUREMENT_PHOTO_TYPES,
] as const;

// No DISPUTE_STATUSES array here: the DisputeStatus union in
// src/types/database.ts is the live contract and superseded the runtime array,
// which US-2436 removed after finding nothing had imported it. Same shape as the
// PayoutImportMethod note further down. admin/disputes.tsx builds its own label
// and colour maps keyed by that union, so the compiler catches a missing status.

// US-2153: how long after a grade is issued it can still be disputed. This is
// the web copy of the value; the SERVER (grade.ts DISPUTE_WINDOW_DAYS) is the
// source of truth and enforces it — this only decides whether the "Dispute"
// affordance is shown. Keep the two numbers equal; the server echoes its window
// (windowDays) in a DISPUTE_WINDOW_EXPIRED rejection if they ever drift.
export const DISPUTE_WINDOW_DAYS = 7;

// Predefined dispute reason categories (US: submitter dispute path). A submitter
// picks one — or "Other" — and can add free-text details. The chosen label is
// composed into the dispute's `reason` text.
export const DISPUTE_REASONS = [
  { value: "grade_too_low", label: "Overall grade is too low" },
  { value: "design_as_damage", label: "Intentional design counted as damage" },
  { value: "defect_not_present", label: "A listed defect isn't actually present" },
  { value: "missed_detail", label: "An important detail or flaw was missed" },
  { value: "wrong_category", label: "Wrong garment type or category" },
  { value: "factor_score", label: "A factor score looks wrong" },
  { value: "other", label: "Other (please explain)" },
] as const;

export type DisputeReasonValue = (typeof DISPUTE_REASONS)[number]["value"];


// ─── Pricing model (US-200) ──────────────────────────────────────
//
// Two products billed on one Stripe customer:
//   1. FlipDesk subscription (FLIPDESK_PLANS) — recurring tiers
//   2. GradeThread per-grade (GRADETHREAD_TIERS + CREDIT_PACKS) — consumption
//
// Debit precedence per submission: included monthly grades (Standard only)
// → credit balance → one-time Stripe checkout. See US-207.

export interface FlipdeskGateFlags {
  /** Multi-select / bulk actions across listings. */
  bulkActions: boolean;
  /** Scheduled relist/end/promotion actions. */
  scheduledActions: boolean;
  /** AI-driven comp pulls (sold-listing analysis). */
  compPulls: boolean;
  /** Automatic relist after end-without-sale. */
  autoRelist: boolean;
  /** Invite additional seats / sub-accounts. */
  subAccounts: boolean;
  /** Programmatic API key access. */
  apiAccess: boolean;
  /**
   * US-9101: the Claude connector. Its OWN flag, not apiAccess.
   *
   * apiAccess means raw /api/v1 access and stays business-only. The connector
   * is a different product decision: it is the strongest reason to pay for
   * GradeThread, and gating it at the top tier means almost nobody sees it. So
   * it opens at pro, where it becomes the reason to move up from starter, and
   * business keeps the higher action ceiling.
   *
   * The SANDBOX tools are exempt from this in the dispatcher and work on every
   * plan including free, deliberately — a seller who cannot see what the
   * connector does has no reason to pay for it.
   */
  connectorAccess: boolean;
  /** Payout-import reconciliation (CSV + API). */
  reconciliation: boolean;
  /** Priority support SLA. */
  prioritySupport: boolean;
  /** AI AutoLister — bulk photos → generated eBay listings (US-323). Premium. */
  autolister: boolean;
}

export interface FlipdeskPlanConfig {
  name: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  /** -1 = unlimited (soft-capped). */
  activeListingCap: number;
  aiActionsPerMonth: number;
  /**
   * US-9101: connector write actions per month, counted separately from
   * aiActionsPerMonth. Its own number so the connector can be priced as an
   * upsell later, and so an AutoLister batch cannot eat the allowance a
   * seller's connector needs. 0 on plans without connectorAccess.
   */
  connectorActionsPerMonth: number;
  /** -1 = all marketplaces. */
  marketplacesCap: number;
  includedStandardGradesPerMonth: number;
  features: string[];
  gateFlags: FlipdeskGateFlags;
}

export const FLIPDESK_PLANS: Record<FlipdeskPlanKey, FlipdeskPlanConfig> = {
  free: {
    name: "Free",
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    activeListingCap: 25,
    aiActionsPerMonth: 25,
    connectorActionsPerMonth: 0,
    marketplacesCap: 1,
    includedStandardGradesPerMonth: 3,
    features: [
      "25 active listings",
      "eBay only",
      "25 AI actions / month",
      "3 free Standard grades / month",
    ],
    gateFlags: {
      bulkActions: false,
      scheduledActions: false,
      compPulls: false,
      autoRelist: false,
      subAccounts: false,
      apiAccess: false,
      connectorAccess: false,
      reconciliation: false,
      prioritySupport: false,
      autolister: false,
    },
  },
  starter: {
    name: "Starter",
    priceMonthlyCents: 2900,
    priceYearlyCents: 29000,
    activeListingCap: 250,
    aiActionsPerMonth: 200,
    connectorActionsPerMonth: 0,
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 10,
    features: [
      "250 active listings",
      "eBay + Shopify listings & sync (live API)",
      "Cross-list to Poshmark, Mercari & Grailed via the GradeThread Lister extension",
      "200 AI actions / month",
      "10 Standard grades included / month",
      "Auto-import payouts",
    ],
    gateFlags: {
      bulkActions: false,
      scheduledActions: false,
      compPulls: false,
      autoRelist: false,
      subAccounts: false,
      apiAccess: false,
      connectorAccess: false,
      reconciliation: false,
      prioritySupport: false,
      autolister: false,
    },
  },
  pro: {
    name: "Pro",
    priceMonthlyCents: 5900,
    priceYearlyCents: 59000,
    activeListingCap: 1000,
    aiActionsPerMonth: 750,
    connectorActionsPerMonth: 500,
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 30,
    features: [
      "1,000 active listings",
      "Claude connector — run your store from a chat (500 actions / month)",
      "eBay + Shopify listings & sync (live API)",
      "Cross-list to Poshmark, Mercari & Grailed via the GradeThread Lister extension",
      "750 AI actions / month",
      "30 Standard grades included / month",
      "Bulk actions + scheduled actions",
      "AI AutoLister — bulk photos to eBay listings",
      "AI comp pulls",
      "Auto-relist",
    ],
    gateFlags: {
      bulkActions: true,
      scheduledActions: true,
      compPulls: true,
      autoRelist: true,
      subAccounts: false,
      apiAccess: false,
      connectorAccess: true,
      reconciliation: false,
      prioritySupport: false,
      autolister: true,
    },
  },
  business: {
    name: "Business",
    priceMonthlyCents: 9900,
    priceYearlyCents: 99000,
    activeListingCap: -1,
    aiActionsPerMonth: 2000,
    connectorActionsPerMonth: 2000,
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 75,
    features: [
      "Unlimited active listings",
      "Claude connector — run your store from a chat (2,000 actions / month)",
      "eBay + Shopify listings & sync (live API)",
      "Cross-list to Poshmark, Mercari & Grailed via the GradeThread Lister extension",
      "2,000 AI actions / month",
      "75 Standard grades included / month",
      "AI AutoLister — bulk photos to eBay listings",
      "Sub-accounts (team seats)",
      "Programmatic API access",
      "Payout reconciliation",
      "Priority support",
    ],
    gateFlags: {
      bulkActions: true,
      scheduledActions: true,
      compPulls: true,
      autoRelist: true,
      subAccounts: true,
      apiAccess: true,
      connectorAccess: true,
      reconciliation: true,
      prioritySupport: true,
      autolister: true,
    },
  },
} as const;

export type FlipdeskPlanKey = "free" | "starter" | "pro" | "business";

// US-219: every new seller signup is granted a free Pro trial. The length was
// written out as a bare 14 in the signup page, the plan picker chip, the
// landing CTA and two FAQ answers, with nothing tying them together — and
// US-2115's auto-renewal disclosure has to state the same number a third
// surface already claims. One source, so shortening the trial cannot leave a
// screen still promising the old length.
export const TRIAL_DAYS = 14;

// Human label for a plan's marketplace cap (number of live API connections a
// tier may open). The Free tier is capped at 1, which is eBay-only, so a cap of
// 1 reads as "eBay" rather than an ambiguous bare "1". Paid tiers use -1 → "All"
// (eBay + Shopify today, Depop once approved; the Lister extension channels
// don't consume a cap). See MARKETPLACE_TIER for the per-channel capability.
export function formatMarketplacesCap(cap: number): string {
  if (cap === -1) return "All";
  if (cap === 1) return "eBay";
  return String(cap);
}

// US-2483: how many listings a tier covers, as a shopper reads it.
//
// WHY THIS IS ITS OWN FUNCTION AND ITS OWN LINE ON THE PRICING PAGE. Every
// competitor a reseller is comparing us against — Crosslist, Vendoo, List
// Perfectly — prices by LISTING VOLUME. It is the first number they look for
// and the axis they compare on. GradeThread priced by AI actions and left the
// listing number buried in a features bullet, so the one figure a shopper came
// for was the one they had to hunt for.
//
// The number is `activeListingCap`, which is what the edge actually enforces
// (plan-gate.ts), tied to it by plan-limits-parity.test.ts. It is deliberately
// NOT a separate marketing figure — an allowance the server does not grant is
// the advertised-vs-enforced defect US-2123 found on the iOS paywall.
//
// -1 is unlimited, and it says "Unlimited" rather than inventing a cap.
export function formatListingAllowance(cap: number): string {
  if (cap === -1) return "Unlimited";
  return cap.toLocaleString();
}

// eBay Sell API condition enum values with buyer-friendly labels. Mirrors
// EBAY_CONDITION_VALUES in services/edge-functions/src/lib/ai-listing.ts.
// Shared by the listing composer and the AutoLister bulk editor.
export const EBAY_CONDITION_OPTIONS: { value: string; label: string }[] = [
  { value: "NEW", label: "New with tags" },
  // eBay apparel "new" conditions — "New without tags" is NEW_OTHER (1500), NOT
  // LIKE_NEW (2750). Most clothing categories reject 2750, so NWOT items must
  // use NEW_OTHER. (Mirror of EBAY_CONDITION_VALUES in edge ai-listing.ts.)
  { value: "NEW_OTHER", label: "New without tags" },
  { value: "NEW_WITH_DEFECTS", label: "New with defects" },
  { value: "LIKE_NEW", label: "Like new" },
  // eBay's granular pre-owned apparel conditions (ids 2990 / 3010). Most clothing
  // leaves accept only {1000,1500,1750,2990,3000,3010}. The "(apparel)" hint
  // disambiguates them from the generic USED_* tiers in this fallback list; when
  // a category is known, the composer replaces this list with eBay's own
  // category-correct labels (see useEbayCategoryConditions).
  { value: "PRE_OWNED_EXCELLENT", label: "Pre-owned — Excellent (apparel)" },
  { value: "USED_EXCELLENT", label: "Pre-owned — Excellent" },
  { value: "PRE_OWNED_FAIR", label: "Pre-owned — Fair (apparel)" },
  { value: "USED_VERY_GOOD", label: "Pre-owned — Very good" },
  { value: "USED_GOOD", label: "Pre-owned — Good" },
  { value: "USED_ACCEPTABLE", label: "Pre-owned — Acceptable" },
  { value: "FOR_PARTS_OR_NOT_WORKING", label: "For parts / not working" },
];

// eBay "Department" item-specific values for clothing — the most common required
// aspect that blocks publish. Values mirror what inferDepartment() produces
// server-side; eBay's plural-tolerant matching reconciles e.g. "Unisex Adult"
// against its "Unisex Adults" allowed value.
export const EBAY_DEPARTMENT_OPTIONS: { value: string; label: string }[] = [
  { value: "Men", label: "Men" },
  { value: "Women", label: "Women" },
  { value: "Unisex Adult", label: "Unisex Adult" },
  { value: "Boys", label: "Boys" },
  { value: "Girls", label: "Girls" },
  { value: "Unisex Kids", label: "Unisex Kids" },
  { value: "Baby", label: "Baby" },
  { value: "Maternity", label: "Maternity" },
];

export interface GradeTierConfig {
  label: string;
  priceCents: number;
  slaHours: number;
  /** How many credits one purchase at this tier consumes. */
  creditCost: number;
}

export const GRADETHREAD_TIERS = {
  standard: { label: "Standard", priceCents: 299, slaHours: 48, creditCost: 1 },
  premium:  { label: "Premium",  priceCents: 799, slaHours: 12, creditCost: 3 },
  express:  { label: "Express",  priceCents: 1299, slaHours: 1, creditCost: 5 },
} as const satisfies Record<GradeTierKey, GradeTierConfig>;

export type GradeTierKey = "standard" | "premium" | "express";

export interface CreditPackConfig {
  credits: number;
  priceCents: number;
}

// Ordered smallest → largest. 1 credit = 1 Standard grade. Credits never expire.
export const CREDIT_PACKS: readonly CreditPackConfig[] = [
  { credits: 10,  priceCents: 2499 },
  { credits: 25,  priceCents: 5999 },
  { credits: 50,  priceCents: 10999 },
  { credits: 100, priceCents: 19999 },
] as const;

export type CreditPackSize = (typeof CREDIT_PACKS)[number]["credits"];

// ─── Buyer Platform plans (US-1799) ────────────────────────────────
//
// The buyer product is a SEPARATE subscription from any FlipDesk/seller plan —
// one person can hold both on one Stripe customer (webhook plan-resolution keys
// on price/product, not "the subscription"). Tiers: Free / Guard (~$8) /
// Connoisseur (~$19). BuyerGateFlags is the single source of truth for what each
// tier unlocks; US-1800 resolves it on client + edge. Flag + allowance names are
// STABLE — they are referenced across the buyer feature epics (US-1805…1844), so
// rename with care.

export type BuyerPlanKey = "free" | "guard" | "connoisseur";

export interface BuyerGateFlags {
  /** AI condition second-opinion inside the browser extension (US-1753/1834). */
  extensionSecondOpinion: boolean;
  /** Claimed-vs-objective condition discrepancy scoring (US-1834). */
  discrepancyScoring: boolean;
  /** Condition-adjusted price-fairness meter (US-1835). */
  priceFairness: boolean;
  /** Condition-based alerts + watchlist (US-1805). */
  conditionAlerts: boolean;
  /** "Will it fit me?" fit prediction (US-1776/1839). */
  fitPrediction: boolean;
  /** Authenticity verification add-on access (US-1767/1840). Metered by credits. */
  authenticityAddon: boolean;
  /** Walk-around video grading access (US-1762/1841). Metered by credits. */
  videoGrading: boolean;
  /** Grade-confirmation rewards loop (US-1810). */
  rewards: boolean;
  /** Buyer trust score & connoisseur levels (US-1815). */
  trustScore: boolean;
  /** Insured grade-locked purchase guarantee (US-1819). */
  purchaseGuarantee: boolean;
  /** Wardrobe portfolio / closet valuation (US-1824). */
  wardrobePortfolio: boolean;
  /** "Graded Wanted" reverse demand board (US-1829). */
  demandBoard: boolean;
  /** Priority support SLA. */
  prioritySupport: boolean;
}

/** Plan-based alert delivery cadence cap (ties to notifications US-1803). */
export type BuyerAlertFrequency = "daily" | "hourly" | "instant";
/** Insured grade-locked guarantee coverage tier (US-1819). */
export type BuyerGuaranteeTier = "none" | "standard" | "plus";

export interface BuyerPlanConfig {
  name: string;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  // Metered monthly allowances (-1 = unlimited). Debit precedence for metered
  // actions is: included allowance → credit balance → upgrade prompt (US-1800).
  extensionChecksPerMonth: number;
  authenticityCreditsPerMonth: number;
  videoGradeCreditsPerMonth: number;
  /** Max concurrently-active alerts/saved-searches (-1 = unlimited). */
  activeAlertsCap: number;
  /** Fastest alert cadence this tier may pick. */
  alertFrequency: BuyerAlertFrequency;
  guaranteeCoverageTier: BuyerGuaranteeTier;
  /** Max items tracked in the wardrobe portfolio (-1 = unlimited). */
  portfolioItemCap: number;
  features: string[];
  gateFlags: BuyerGateFlags;
}

export const BUYER_PLANS: Record<BuyerPlanKey, BuyerPlanConfig> = {
  free: {
    name: "Free",
    priceMonthlyCents: 0,
    priceYearlyCents: 0,
    extensionChecksPerMonth: 10,
    authenticityCreditsPerMonth: 0,
    videoGradeCreditsPerMonth: 0,
    activeAlertsCap: 3,
    alertFrequency: "daily",
    guaranteeCoverageTier: "none",
    portfolioItemCap: 10,
    features: [
      "10 extension second-opinions / month",
      "3 condition alerts (daily)",
      "Grade-confirmation rewards",
      "Buyer trust score",
      "Track up to 10 closet items",
    ],
    gateFlags: {
      extensionSecondOpinion: true,
      discrepancyScoring: false,
      priceFairness: false,
      conditionAlerts: true,
      fitPrediction: false,
      authenticityAddon: false,
      videoGrading: false,
      rewards: true,
      trustScore: true,
      purchaseGuarantee: false,
      wardrobePortfolio: true,
      demandBoard: false,
      prioritySupport: false,
    },
  },
  guard: {
    name: "Guard",
    priceMonthlyCents: 800,
    priceYearlyCents: 8000,
    extensionChecksPerMonth: -1,
    authenticityCreditsPerMonth: 3,
    videoGradeCreditsPerMonth: 2,
    activeAlertsCap: 25,
    alertFrequency: "hourly",
    guaranteeCoverageTier: "standard",
    portfolioItemCap: 200,
    features: [
      "Unlimited extension second-opinions",
      "Claimed-vs-objective discrepancy + price-fairness",
      "25 condition alerts (hourly)",
      "Fit prediction",
      "3 authenticity + 2 video-grade credits / month",
      "Standard grade-locked purchase guarantee",
      "Track up to 200 closet items",
    ],
    gateFlags: {
      extensionSecondOpinion: true,
      discrepancyScoring: true,
      priceFairness: true,
      conditionAlerts: true,
      fitPrediction: true,
      authenticityAddon: true,
      videoGrading: true,
      rewards: true,
      trustScore: true,
      purchaseGuarantee: true,
      wardrobePortfolio: true,
      demandBoard: false,
      prioritySupport: false,
    },
  },
  connoisseur: {
    name: "Connoisseur",
    priceMonthlyCents: 1900,
    priceYearlyCents: 19000,
    extensionChecksPerMonth: -1,
    authenticityCreditsPerMonth: 15,
    videoGradeCreditsPerMonth: 10,
    activeAlertsCap: -1,
    alertFrequency: "instant",
    guaranteeCoverageTier: "plus",
    portfolioItemCap: -1,
    features: [
      "Everything in Guard",
      "Unlimited alerts (instant)",
      "15 authenticity + 10 video-grade credits / month",
      "Plus grade-locked purchase guarantee",
      "Graded-Wanted demand board",
      "Unlimited closet portfolio",
      "Priority support",
    ],
    gateFlags: {
      extensionSecondOpinion: true,
      discrepancyScoring: true,
      priceFairness: true,
      conditionAlerts: true,
      fitPrediction: true,
      authenticityAddon: true,
      videoGrading: true,
      rewards: true,
      trustScore: true,
      purchaseGuarantee: true,
      wardrobePortfolio: true,
      demandBoard: true,
      prioritySupport: true,
    },
  },
} as const;

// US-1887: seller (FlipDesk) plans INCLUDE tier-matched buyer functions. A
// seller's effective buyer plan is the HIGHER of their buyer subscription and
// this seller-derived tier — so a seller gets the extension + confidence suite
// without a separate buyer subscription. LOCKSTEP with SELLER_PLAN_BUYER_TIER in
// services/edge-functions/src/lib/buyer-plans.ts.
export const SELLER_PLAN_BUYER_TIER: Record<FlipdeskPlanKey, BuyerPlanKey> = {
  free: "free",
  starter: "guard",
  pro: "guard",
  business: "connoisseur",
};

export const BUYER_PLAN_RANK: Record<BuyerPlanKey, number> = {
  free: 0,
  guard: 1,
  connoisseur: 2,
};

/** The higher-ranked of two buyer plans (Connoisseur > Guard > Free). */
export function higherBuyerPlan(a: BuyerPlanKey, b: BuyerPlanKey): BuyerPlanKey {
  return BUYER_PLAN_RANK[a] >= BUYER_PLAN_RANK[b] ? a : b;
}

// Canonical machine-readable mirror of the FlipDesk tier matrix in
// vault/50-business/pricing.md (US-200 AC). Alias of FLIPDESK_PLANS so there is exactly one
// source of truth — any change here changes both. Prefer FLIPDESK_PLANS in new
// code; PLAN_MATRIX exists so the pricing doc can reference a stable name.
export const PLAN_MATRIX = FLIPDESK_PLANS;

// No FLIPDESK_UPGRADE_TRIGGERS here, and vault/50-business/pricing.md no longer
// says there is. US-2436 deleted it: nothing had ever read it, while the soft
// warn threshold really lives as SOFT_WARN_PCT in the edge's plan-gate.ts (which
// emits the X-Plan-Warning header) and is mirrored by two bare 0.8 literals in
// usage-meter.tsx and sidebar-usage-widget.tsx. Its userOptions field described
// a user-configurable threshold (US-209) that has no column, no setting and no
// UI. Deleting a constant does not fix the 0.8 living in three places with no
// guard between them — that is US-2441.

// ─── The legacy plan vocabulary ──────────────────────────────────
//
// US-2365 removed the deprecated `PLANS` object. What could NOT be removed is
// the vocabulary itself: `public.user_plan`
// ('free'|'starter'|'professional'|'enterprise') is still the type of the
// `users.plan` COLUMN, and the admin dashboard groups planDistribution by it
// (00513). So the legacy keys are live data, not dead code.
//
// What changed is that the translation is now EXPLICIT. A caller holding a
// legacy value calls flipdeskPlanForLegacy() and can be seen doing it; before,
// a deprecated alias did it invisibly and six call sites accumulated behind it
// while the story that filed this counted two.
//
// There was a second translator here, legacyPlanConfig(), returning the whole
// plan config rather than the key. US-2436 deleted it — nothing had called it
// since US-2365 split the two apart, and this sentence naming it was the only
// thing keeping it looking used.
//
// Prefer `profile.flipdesk_plan` wherever it exists. Reach for these only when
// the value you hold really is the legacy column.
//
// Legacy keys map: free → free, starter → starter,
// professional → pro, enterprise → business.
// Removed when US-211 (billing rebuild) + US-220 (landing rewrite) land.

/**
 * US-2365: the legacy `users.plan` enum → the current FlipDesk plan key.
 *
 * EXPORTED rather than folded away, because the legacy vocabulary is not dead
 * code — `public.user_plan` ('free'|'starter'|'professional'|'enterprise') is
 * still the type of the `users.plan` COLUMN, and the admin dashboard's
 * planDistribution is grouped by it (00513). So callers that read that column
 * genuinely need to translate, and hiding the translation inside a deprecated
 * alias made it look like nobody did.
 *
 * Prefer `profile.flipdesk_plan` where it exists; use this only when the value
 * you hold really is the legacy column.
 */
export function flipdeskPlanForLegacy(legacy: PlanKey): FlipdeskPlanKey {
  return LEGACY_MAP[legacy];
}


const LEGACY_MAP: Record<PlanKey, FlipdeskPlanKey> = {
  free: "free",
  starter: "starter",
  professional: "pro",
  enterprise: "business",
};


/** @deprecated Use FlipdeskPlanKey instead (US-202). */
export type PlanKey = "free" | "starter" | "professional" | "enterprise";

// Grade factors with weights (must sum to 1.0)
export const GRADE_FACTORS = {
  fabric_condition: { label: "Fabric Condition", weight: 0.30 },
  structural_integrity: { label: "Structural Integrity", weight: 0.25 },
  cosmetic_appearance: { label: "Cosmetic Appearance", weight: 0.20 },
  functional_elements: { label: "Functional Elements", weight: 0.15 },
  odor_cleanliness: { label: "Odor & Cleanliness", weight: 0.10 },
} as const;

export type GradeFactorKey = keyof typeof GRADE_FACTORS;

// US-601: premium authenticity / counterfeit-confidence add-on. Offered only on
// the paid Premium/Express tiers (mirrors tierSupportsAuthenticityAddon on the
// edge). The add-on is a SEPARATE garment-authenticity signal — distinct from
// the condition grade and from photo-tamper detection.
const AUTHENTICITY_ADDON_TIERS: readonly GradeTierKey[] = [
  "premium",
  "express",
] as const;

export function tierSupportsAuthenticityAddon(tier: GradeTierKey): boolean {
  return AUTHENTICITY_ADDON_TIERS.includes(tier);
}

// Buyer-facing labels + styling for the coarse counterfeit-risk bucket.
export const COUNTERFEIT_RISK_LABELS: Record<
  "low" | "elevated" | "high" | "indeterminate",
  { label: string; tone: "good" | "warn" | "alert" | "neutral" }
> = {
  low: { label: "Low counterfeit risk", tone: "good" },
  elevated: { label: "Elevated counterfeit risk", tone: "warn" },
  high: { label: "High counterfeit risk", tone: "alert" },
  indeterminate: { label: "Could not assess", tone: "neutral" },
};

// Listing platforms
export const LISTING_PLATFORMS = [
  "ebay",
  "poshmark",
  "mercari",
  "depop",
  "grailed",
  "facebook",
  "offerup",
  "shopify",
  "etsy",
  "whatnot",
  "vinted",
  "other",
] as const;

// Inventory item statuses (full lifecycle + personal-use side tracks)
export const ITEM_STATUSES = [
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "grading",
  "graded",
  "comped",
  "drafted",
  "listed",
  "sold",
  "shipped",
  "completed",
  "returned",
  "archived",
  "keeping",
  "wearing",
] as const;

// Personal-use statuses — keeping/wearing, filtered out of the main Kanban
// pipeline (US-101 / US-109). There is no constant for them: workflow.ts and
// pipeline-rules.ts each test the pair inline and never imported the array that
// used to sit here, so US-2436 removed it. Those two modules are the source.

// US-1484: statuses a user may hand-set when creating an item at intake. The
// system/terminal states — grading (owned by the grade-submission flow), graded,
// comped, drafted, listed, sold, shipped, completed, returned — are set only by
// their proper flows and must NOT be writable directly from the New Item form
// (e.g. writing 'grading' here bypasses the submission + charge). Early-pipeline
// choices plus the off-pipeline archived/personal statuses remain.
export const INTAKE_STATUSES = [
  "sourced",
  "acquired",
  "cataloged",
  "measured",
  "photographed",
  "archived",
  "keeping",
  "wearing",
] as const;

export const ITEM_STATUS_LABELS: Record<
  (typeof ITEM_STATUSES)[number],
  string
> = {
  sourced: "Sourced",
  acquired: "Acquired",
  cataloged: "Cataloged",
  measured: "Measured",
  photographed: "Photographed",
  grading: "Grading",
  graded: "Graded",
  comped: "Comped",
  drafted: "Draft",
  listed: "Listed",
  sold: "Sold",
  shipped: "Shipped",
  completed: "Complete",
  returned: "Returned",
  archived: "Archived",
  keeping: "Keeping",
  wearing: "Wearing",
};

// Single source of truth for status badge colors (consumed by <StatusBadge>).
// Statuses are grouped into a small set of semantic "tones" by pipeline phase
// so the same status looks identical everywhere it appears. Each tone's
// classes carry light + dark variants tuned to pass WCAG AA contrast.
export type StatusTone =
  | "neutral"
  | "prep"
  | "grading"
  | "pricing"
  | "live"
  | "success"
  | "danger"
  | "dispute"
  | "muted";

export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  neutral:
    "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
  prep: "border-sky-300 bg-sky-100 text-sky-800 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  grading:
    "border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-800 dark:bg-violet-950/50 dark:text-violet-300",
  pricing:
    "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  live: "border-blue-300 bg-blue-100 text-blue-800 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
  success:
    "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  danger:
    "border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  dispute:
    "border-purple-300 bg-purple-100 text-purple-800 dark:border-purple-800 dark:bg-purple-950/50 dark:text-purple-300",
  muted: "border-border bg-muted text-muted-foreground",
};

export const ITEM_STATUS_TONE: Record<
  (typeof ITEM_STATUSES)[number],
  StatusTone
> = {
  sourced: "neutral",
  acquired: "neutral",
  cataloged: "prep",
  measured: "prep",
  photographed: "prep",
  grading: "grading",
  graded: "grading",
  comped: "pricing",
  drafted: "pricing",
  listed: "live",
  sold: "success",
  shipped: "success",
  completed: "success",
  returned: "danger",
  archived: "muted",
  keeping: "muted",
  wearing: "muted",
};

// Submission/grade-report lifecycle statuses mapped onto the same tone scale,
// so a submission's status pill matches the rest of the app. One source for
// the submissions list + dashboard (previously copy-pasted in both).
export const SUBMISSION_STATUS_TONE: Record<string, StatusTone> = {
  pending: "pricing",
  processing: "live",
  // Mandatory review: preliminary grade awaiting human finalization.
  pending_review: "grading",
  completed: "success",
  failed: "danger",
  disputed: "dispute",
  expired: "muted",
};

// Tailwind classes for a submission-status badge. Returns "" for unknown
// statuses (caller's <Badge variant="outline"> keeps its default look).
export function getStatusBadgeClasses(status: string): string {
  const tone = SUBMISSION_STATUS_TONE[status];
  return tone ? STATUS_TONE_CLASSES[tone] : "";
}

// ─── Plan + role badge colors ────────────────────────────────────
// Single source of truth for the soft plan/role pills in the admin/billing
// surfaces (previously hand-maintained per page, where an unlisted key fell
// through to no color at all). Every unknown key resolves to a neutral pill via
// the helpers below, so a badge is NEVER left uncolored.

// Neutral fallback shared by both helpers.
const NEUTRAL_BADGE_CLASSES = "bg-muted text-muted-foreground";

// Keyed off the canonical FlipDesk plan set (free/starter/pro/business) AND the
// legacy UserPlan keys (professional/enterprise) still stored on users.plan, so
// both spellings of the paid tiers pick up the same color while the sets
// coexist (US-202). pro ≡ professional (blue), business ≡ enterprise (amber).
const PLAN_BADGE_CLASSES: Record<string, string> = {
  free: NEUTRAL_BADGE_CLASSES,
  starter: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  pro: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  professional: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  business: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  enterprise: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
};

// Keyed off the UserRole set (user/reviewer/admin/super_admin).
const ROLE_BADGE_CLASSES: Record<string, string> = {
  user: NEUTRAL_BADGE_CLASSES,
  reviewer: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  admin: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
  super_admin: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
};

// Soft pill classes for a plan badge. Unknown/diverged keys → neutral (never
// uncolored).
export function getPlanBadgeClasses(plan: string): string {
  return PLAN_BADGE_CLASSES[plan] ?? NEUTRAL_BADGE_CLASSES;
}

// Soft pill classes for a role badge. Unknown roles → neutral (never uncolored).
export function getRoleBadgeClasses(role: string): string {
  return ROLE_BADGE_CLASSES[role] ?? NEUTRAL_BADGE_CLASSES;
}

// ─── Grade-score color tokens ────────────────────────────────────
// Single source for grade-score coloring across the app — vault/20-domain/brand-design-system.md §3B
// refreshed media kit: Emerald Mint (>7), Amber Gold (5–7), AA-safe brand red
// (<5). Used by certificate, submission/inventory detail, dashboard,
// submissions. Edit these three to restyle every score everywhere.
export function getScoreColor(score: number): string {
  if (score > 7) return "text-emerald-500";
  if (score >= 5) return "text-amber-500";
  return "text-brand-red-text";
}

export function getScoreBorderColor(score: number): string {
  if (score > 7) return "border-emerald-500";
  if (score >= 5) return "border-amber-500";
  return "border-brand-red";
}

// Progress-bar fill color (targets the inner <Progress> indicator div).
export function getProgressColor(score: number): string {
  if (score > 7) return "[&>div]:bg-emerald-500";
  if (score >= 5) return "[&>div]:bg-amber-500";
  return "[&>div]:bg-brand-red";
}

// Soft pill (bg + text + border) for a grade tier — used by the certificate
// and submission detail's headline score badge.
export function getTierBadgeClasses(score: number): string {
  if (score > 7)
    return "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800";
  if (score >= 5)
    return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800";
  return "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800";
}

// ─── Brand + chart color hexes (US-2193) ─────────────────────────
// Raw HEX values for non-Tailwind surfaces — SVG, canvas, and Recharts
// fill/stroke props, where a class name can't be used. In JSX prefer the
// Tailwind utilities (`bg-brand-navy`, `text-brand-red-text`); reach for these
// only where a literal hex is required.

// Canonical brand red. This is the US-439 AA-safe value (#cc1f3d, deepened from
// the old vibrant #f03d5f / #E94560) so white-on-red clears AA. It intentionally
// differs from the legacy #E94560/#F03D5F reds that had drifted across the app.
// NOTE: for red TEXT in JSX use the theme-inverting `text-brand-red-text`
// utility — never this hex as a text color on a light surface.
export const BRAND_RED = "#cc1f3d";

// Brand navy — chart/SVG primary (matches `--color-brand-navy` intent for
// data surfaces; the vivid #0F3460 reads better on charts than the deepened UI
// navy #0c1e36).
export const BRAND_NAVY = "#0F3460";

// Score / severity stop hexes — the HEX equivalents of getScoreColor's Tailwind
// stops, for SVG/canvas/Recharts contexts (score bars, defect callouts). Keep
// in lockstep with getScoreColor: emerald > 7, amber 5–7, brand red < 5.
export const SCORE_STOP = {
  high: "#10b981", // emerald (tailwind emerald-500) — score > 7
  mid: "#f59e0b", // amber (tailwind amber-500) — 5 <= score <= 7
  low: BRAND_RED, // AA-safe brand red — score < 5
} as const;

// Shared categorical palette for Recharts. Charts previously each hardcoded
// their own hexes (#0F3460, #E94560, #16a34a, #f59e0b, #3b82f6, #94a3b8, …);
// this consolidates them into one accessible, stably-named ramp so every chart
// reads as one system. `navy`/`red` are the brand anchors; the rest are a fixed
// categorical ramp.
export const CHART_PALETTE = {
  navy: BRAND_NAVY, // #0F3460 — brand primary / default single series
  red: BRAND_RED, // #cc1f3d — brand accent / negative
  emerald: "#16a34a", // positive / revenue / success
  green: "#22c55e", // secondary positive
  amber: "#f59e0b", // warning / pending / mid
  blue: "#3b82f6", // categorical
  indigo: "#6366f1", // categorical
  violet: "#8b5cf6", // categorical
  violetLight: "#a78bfa", // categorical (ramp tail)
  slate: "#94a3b8", // muted / baseline / comparison
} as const;

// There is no stable-ordered CHART_SERIES ramp, though two comments here used to
// tell you to index one. US-2436 removed it: nothing ever imported it, and
// grade-charts.tsx built its own ordered ramp in a DIFFERENT order instead, so
// the shared one had become an instruction nobody followed. Wiring the charts to
// a single ramp would repaint live charts, which is a deliberate visual change,
// not a cleanup — so the local ramp stands until someone decides to.

// ─── FlipDesk ────────────────────────────────────────────────────

// Pipeline columns in display order with the next-action hint.
export const FLIPDESK_PIPELINE: Array<{
  status: (typeof ITEM_STATUSES)[number];
  label: string;
  nextAction: string;
}> = [
  { status: "sourced",      label: "Sourced",      nextAction: "Catalog basic info" },
  { status: "cataloged",    label: "Cataloged",    nextAction: "Measure" },
  { status: "measured",     label: "Measured",     nextAction: "Photograph" },
  { status: "photographed", label: "Photographed", nextAction: "Send to GradeThread" },
  { status: "grading",      label: "Grading",      nextAction: "Awaiting grade" },
  { status: "graded",       label: "Graded",       nextAction: "Run comps" },
  { status: "comped",       label: "Comped",       nextAction: "Draft listing" },
  { status: "drafted",      label: "Drafted",      nextAction: "Push to eBay" },
  { status: "listed",       label: "Listed",       nextAction: "Wait for sale" },
  { status: "sold",         label: "Sold",         nextAction: "Ship" },
  { status: "shipped",      label: "Shipped",      nextAction: "Confirm delivery" },
  { status: "completed",    label: "Completed",    nextAction: "Archive" },
  { status: "returned",     label: "Returned",     nextAction: "Relist or write off" },
];

// ─── North Star: Items Listed Per Week (US-597) ──────────────────────
// The PRD North Star metric is "Items Listed Per Week" — the throughput that
// directly correlates with revenue and platform value. We surface a weekly
// goal + a "don't break the chain" listing streak to keep resellers engaged
// with that one behavior. Defaults are deliberately attainable for a part-time
// flipper; the streak rewards consistency over volume.
export const NORTH_STAR_WEEKLY_GOAL = 10;

// Lifetime items-listed milestones that trigger a celebration email. Kept in
// sync with the edge cron (jobs-north-star.ts NORTH_STAR_MILESTONES).
export const NORTH_STAR_MILESTONES = [10, 25, 50, 100, 250, 500, 1000] as const;

export const FLIPDESK_SOURCE_TYPES = [
  "thrift",
  "goodwill_auction",
  "estate_sale",
  "wholesale",
  "retail_arbitrage",
  "consignment",
  "other",
] as const;

export const FLIPDESK_SOURCE_TYPE_LABELS: Record<
  (typeof FLIPDESK_SOURCE_TYPES)[number],
  string
> = {
  thrift: "Thrift store",
  goodwill_auction: "Goodwill auction",
  estate_sale: "Estate sale",
  wholesale: "Wholesale",
  retail_arbitrage: "Retail arbitrage",
  consignment: "Consignment",
  other: "Other",
};

// US-600: consignment mode labels.
export const CONSIGNOR_STATUSES = ["active", "paused", "archived"] as const;

export const CONSIGNOR_STATUS_LABELS: Record<
  (typeof CONSIGNOR_STATUSES)[number],
  string
> = {
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

// A plain union, not an `as const` array: nothing iterates these, so the array
// only ever existed to derive this type and was emitted into the bundle for it.
//
// US-2022: the last two are what happens when the sale comes apart AFTER the
// consignor was paid. "reversed" — we clawed the transfer back; nothing is owed.
// "clawback_pending" — the transfer could NOT be reversed (the consignor had
// already withdrawn the funds), so the seller is genuinely out of pocket until a
// human recovers it. That status exists so the loss is VISIBLE; leaving the row
// on "paid" is the silent failure the story was about.
type ConsignorPayoutStatus =
  | "pending"
  | "processing"
  | "paid"
  | "failed"
  | "canceled"
  | "reversed"
  | "clawback_pending";

export const CONSIGNOR_PAYOUT_STATUS_LABELS: Record<
  ConsignorPayoutStatus,
  string
> = {
  pending: "Pending",
  processing: "Processing",
  paid: "Paid",
  failed: "Failed",
  canceled: "Canceled",
  reversed: "Reversed",
  clawback_pending: "Clawback needed",
};

export const ITEM_CATEGORIES = [
  "clothing",
  "shoes",
  "watches",
  "jewelry",
  "sports_cards",
  "collectibles",
  "electronics",
  "books",
  "bags",
  "accessories",
  // US-2223 (00570): its own top level, NOT folded into accessories. A cap's
  // condition lives in the crown, the brim and the sweatband; an accessory's
  // lives in its material, edges and hardware. item_category is the dimension
  // that picks the rubric, the photo profile and the measurement template, so
  // filing headwear under accessories makes the headwear rubric unreachable
  // while looking correct.
  "headwear",
  "other",
] as const;

// Human labels for the item_category picker. `accessories` here = non-garment
// accessories sold standalone (belts, scarves, sunglasses), distinct from the
// clothing garment_type "accessories".
//
// US-2799: this said "hats, belts, sunglasses", two lines under the `headwear`
// value that exists precisely so a hat is NOT one of these. The comment was
// written before 00570 and outlived it, which is how three other files came to
// route a cap here as well.
export const ITEM_CATEGORY_LABELS: Record<
  (typeof ITEM_CATEGORIES)[number],
  string
> = {
  clothing: "Clothing",
  shoes: "Shoes",
  watches: "Watches",
  jewelry: "Jewelry",
  sports_cards: "Sports cards",
  collectibles: "Collectibles",
  electronics: "Electronics",
  books: "Books",
  bags: "Bags",
  accessories: "Accessories",
  headwear: "Hats & caps",
  other: "Other",
};

// Canonical gallery/cover order (index 0 = cover = eBay main image):
// Front → Back → Tag → Detail → measurements → defects → extras → universal.
// This array's index IS a photo type's sort rank (see src/lib/photo-order.ts),
// so the order here drives the persisted sort_order and the listing sequence.
export const FLIPDESK_PHOTO_TYPES = [
  "front",
  "back",
  "tag",
  "detail",
  // US-1571 (migration 00346): the MeasureCard calibration frame — the whole
  // garment laid flat with the GradeThread MeasureCard beside it; the
  // photo-measurement pipeline keys on this tag. Never sent to eBay /
  // cross-listings, never fed to the generation/classify AI passes, never
  // public (the card is a branded foreign object in a listing photo) — the
  // edge enforces via filterListablePhotos, like 'internal'. Distinct from
  // the measurement_* tape close-ups below (size-estimate shots).
  "measurement",
  // Measurements rank ahead of defects in the gallery.
  ...MEASUREMENT_PHOTO_TYPES,
  "defect",
  // Secondary tag + extra detail/context shots follow the defects.
  "tag_2",
  "detail_2",
  "detail_3",
  "detail_4",
  "interior",
  "flatlay",
  // US-2462 (migration 00587): the two roles the epic added that had no
  // existing type to reuse. Placed with the other presentation shots so the
  // gallery order stays Front → Back → Tag → Detail → measurements → defects →
  // context → universal.
  "on_hanger",
  "on_model",
  "set_pair",
  // US-1577 (migration 00350): GENERATED card-free annotated measurements
  // photo (unbranded lines + inch labels). Listing-ELIGIBLE, never primary;
  // regenerating replaces the previous render.
  "measurement_overlay",
  // Universal roles (migration 00230) reused across non-clothing categories.
  "angle",
  "sole",
  "marking",
  "serial",
  "accessory",
  "certificate",
  "corner",
  "surface",
  // US-1549: seller-reference only (the price tag you paid, a receipt, a
  // sourcing note). Carried with the item and shown in-app, but never sent to
  // eBay, never fed to AI, never shown publicly. Last on purpose — reference
  // shots trail the gallery ordering.
  "internal",
] as const;

// Photos a CLOTHING item must have before it can advance to "photographed".
// Only Front + Back are blocking. Tag + Detail are encouraged (and still shown
// as default capture slots) but optional — many garments legitimately have no
// readable tag (e.g. Lululemon's size label is commonly cut off), so requiring
// one would wrongly block listing and grading.
// Non-clothing categories define their own required set via photo profiles
// (src/lib/photo-profiles.ts → usePhotoProfile); this remains the default/
// fallback for clothing and for any consumer that hasn't loaded a profile.
export const REQUIRED_PHOTO_TYPES = ["front", "back"] as const;

/**
 * Photos a clothing item must have before it can be SUBMITTED FOR GRADING.
 *
 * US-2304 (owner's call, 2026-08-03): a superset of REQUIRED_PHOTO_TYPES, and a
 * SEPARATE constant on purpose. Those two lists answer different questions and
 * had been sharing one answer:
 *
 *   REQUIRED_PHOTO_TYPES         — may this item advance to "photographed" and
 *                                  be listed? Front + back. Unchanged.
 *   REQUIRED_GRADING_PHOTO_TYPES — may this item be graded? Front, back, tag.
 *
 * Folding the tag into the first one would have blocked the LISTING pipeline
 * for every tagless garment, which nobody asked for and which is a different
 * product decision from what grading needs.
 *
 * Why grading needs the tag: image-quality.ts lists `label` in
 * REQUIRED_IMAGE_TYPES at severity `block`, and the pipeline applies it BEFORE
 * any confidence scoring. A FlipDesk item with no tag photo was charged, ran a
 * vision call per image, then abstained and refunded — the money came back and
 * the AI spend did not. This is the client half of telling the seller first.
 *
 * Client mirror of REQUIRED_GRADING_PHOTO_TYPES in
 * services/edge-functions/src/routes/flipdesk-grading.ts, which DERIVES its
 * list from the grading gate. Asserted against the shared fixture
 * src/test/fixtures/grading-readiness-cases.json by both suites.
 */
export const REQUIRED_GRADING_PHOTO_TYPES = ["front", "back", "tag"] as const;
// A fabric close-up (weave/knit/seam) is what the fabric_condition factor (30%
// of the score) is read from. Client mirror of FABRIC_CLOSEUP_PHOTO_TYPES in
// services/edge-functions/src/routes/flipdesk-grading.ts; the two MUST stay in
// lockstep. Consumed by previewGradingReadiness().
//
// US-2397: no longer REQUIRED. The image-quality gate used to abstain without
// one; now it warns, the grade proceeds capped, and a human checks it. So this
// list decides whether the seller gets a warning and a slower grade, not whether
// they can submit at all.
export const FABRIC_CLOSEUP_PHOTO_TYPES = [
  "detail",
  "detail_2",
  "detail_3",
  "detail_4",
] as const;
// There is deliberately no OPTIONAL_PHOTO_TYPES. Every list above answers a
// question some gate asks; "optional" is just the complement of the required
// ones inside FLIPDESK_PHOTO_TYPES, and no gate ever asked for it. US-2436
// removed it unused rather than leave a fourth list that has to be kept in step
// with three others for nothing.

export const PHOTO_TYPE_LABELS: Record<
  (typeof FLIPDESK_PHOTO_TYPES)[number],
  string
> = {
  front: "Front",
  back: "Back",
  tag: "Garment Tag",
  tag_2: "Garment Tag 2",
  detail: "Detail 1",
  detail_2: "Detail 2",
  detail_3: "Detail 3",
  detail_4: "Detail 4",
  interior: "Interior / Lining",
  defect: "Defect",
  flatlay: "Flat lay",
  on_hanger: "On hanger",
  on_model: "On model",
  set_pair: "Set / pair",
  angle: "Angle / Profile",
  sole: "Sole",
  marking: "Markings / Hallmark",
  serial: "Serial / Model",
  accessory: "Accessories / Box",
  certificate: "Certificate / Label",
  corner: "Corners",
  surface: "Surface / Centering",
  measurement: "Measurement card (not listed)",
  measurement_overlay: "Measurements photo (generated)",
  measurement_chest: "Measure: Chest / Bust",
  measurement_waist: "Measure: Waist",
  measurement_length: "Measure: Length",
  measurement_sleeve: "Measure: Sleeve",
  measurement_inseam: "Measure: Inseam",
  internal: "Internal (not listed)",
};

// US-1571: photo types that must never leave GradeThread — excluded from the
// eBay/cross-listing photo set, AI listing passes, and public surfaces.
// Mirror of the edge's filterListablePhotos (lib/item-photo-storage.ts);
// clients use this to keep previews honest about what will actually publish.
export const NON_LISTABLE_PHOTO_TYPES = ["internal", "measurement"] as const;

// US-2462: role-aware, mirroring the edge's isNonListableItemPhoto. A
// 'measurement' with NO role is the MeasureCard calibration frame and never
// lists (a branded card in a listing photo); a 'measurement' WITH a role is a
// tape close-up, which is what `measurement_chest` used to be and which sellers
// publish deliberately. Pre-00587 rows have a NULL role, so the old behavior is
// preserved exactly.
export function isNonListablePhotoType(
  t?: string | null,
  role?: string | null,
): boolean {
  if ((t ?? "") === "measurement") return !role;
  return (NON_LISTABLE_PHOTO_TYPES as readonly string[]).includes(t ?? "");
}

// US-979 / US-1638 mirror of the edge's SENSITIVE_ITEM_PHOTO_TYPES
// (services/edge-functions/src/lib/item-photo-storage.ts). These close-ups can
// carry PII — serials, receipts, certificate numbers — so their originals live
// in the PRIVATE submission-images bucket, not the public item-photos one.
// Background removal already refuses them; the photo editor refuses them too,
// because writing an edited copy back would have to choose a bucket and the
// public one would publish the PII.
const SENSITIVE_PHOTO_TYPES = ["tag", "tag_2", "certificate"] as const;

export function isSensitivePhotoType(t?: string | null): boolean {
  return (SENSITIVE_PHOTO_TYPES as readonly string[]).includes(t ?? "");
}

export const LISTING_STATUSES = [
  "draft",
  "active",
  "ended",
  "sold",
  "relisted",
] as const;

// US-568: eBay listing format + auction durations. 'fixed_price' is Buy It Now
// (GTC); 'auction' uses one of the timed durations below.
export const LISTING_FORMATS = ["fixed_price", "auction"] as const;

export const LISTING_FORMAT_LABELS: Record<
  (typeof LISTING_FORMATS)[number],
  string
> = {
  fixed_price: "Fixed price (Buy It Now)",
  auction: "Auction",
};

// eBay listingDuration enum values valid for auction offers.
export const AUCTION_DURATIONS = [
  "DAYS_1",
  "DAYS_3",
  "DAYS_5",
  "DAYS_7",
  "DAYS_10",
] as const;

export const AUCTION_DURATION_LABELS: Record<
  (typeof AUCTION_DURATIONS)[number],
  string
> = {
  DAYS_1: "1 day",
  DAYS_3: "3 days",
  DAYS_5: "5 days",
  DAYS_7: "7 days",
  DAYS_10: "10 days",
};

/**
 * US-2107: the confidence below which a grade is routed to human review, stated
 * publicly on /grading/methodology. Published as a spec number, so it must not
 * be allowed to drift from the engine.
 *
 * ⚠️ The LIVE threshold is DB-backed (settings registry key
 * `grading_review_confidence_threshold`, US-884) so the calibration report's
 * recommended operating point can be applied without a deploy. This constant is
 * the DEFAULT that the engine falls back to, and the number we publish.
 * `grading-threshold-parity.test.ts` fails if it diverges from the edge's
 * fallback — a published spec that silently stops matching the code is worse
 * than not publishing one. If an operator moves the registry value, the public
 * page must be updated deliberately.
 */
export const GRADING_REVIEW_CONFIDENCE_THRESHOLD = 0.75;

// No GRADING_SUBMISSION_TIERS constant here, and removing the unused one was
// not the fix. US-2436 found the standard/premium/express triple written out
// SIX times — GRADE_TIERS in the edge's grade-pricing.ts and again in
// openapi-spec.ts, TIER_OPTIONS in grade-this-item-card.tsx, GRADE_TIER_OPTIONS
// in pipeline.tsx, an inline literal in landing.tsx, and a z.enum in
// flipdesk-grading.ts — with the DB enum grading_submission_tier (00008) under
// all of them. This copy was simply the one nothing imported. Consolidating the
// other five is a real job and is not a mechanical cleanup.

// No PAYOUT_IMPORT_METHODS constant either: the PayoutImportMethod union in
// src/types/database.ts is the live contract and superseded the runtime array.

export const EXPENSE_CATEGORIES = [
  "shipping_supplies",
  "mileage",
  "subscriptions",
  "platform_fees",
  "sourcing_travel",
  "equipment",
  "storage",
  "other",
] as const;

export const EXPENSE_CATEGORY_LABELS: Record<
  (typeof EXPENSE_CATEGORIES)[number],
  string
> = {
  shipping_supplies: "Shipping supplies",
  mileage: "Mileage",
  subscriptions: "Subscriptions",
  platform_fees: "Platform fees",
  sourcing_travel: "Sourcing travel",
  equipment: "Equipment",
  storage: "Storage",
  other: "Other",
};

export const MARKETPLACE_LABELS: Record<(typeof LISTING_PLATFORMS)[number], string> = {
  ebay: "eBay",
  poshmark: "Poshmark",
  mercari: "Mercari",
  depop: "Depop",
  grailed: "Grailed",
  facebook: "Facebook",
  offerup: "OfferUp",
  shopify: "Shopify",
  etsy: "Etsy",
  whatnot: "Whatnot",
  vinted: "Vinted",
  other: "Other",
};

// Cross-listing platform id space (backs the CrossListingPlatform type + the
// cross-push hook payload).
//
// US-1488: do NOT drive the composer's "Push to" picker from this raw list — it
// mixes real API channels with extension-only ones. The picker is driven by
// API_CROSS_LISTING_PLATFORMS (real server publish, with api_pending shown
// disabled) + EXTENSION_CROSS_LISTING_PLATFORMS (listed via the browser
// extension, shown with an honest mechanism badge — never a pushable checkbox),
// so a seller can't select a channel that does nothing externally.
export const CROSS_LISTING_PLATFORMS = [
  "ebay",
  "shopify",
  "poshmark",
  "mercari",
  "depop",
  "etsy",
  "whatnot",
] as const;
// Cross-list platforms that publish for real TODAY via a server-side API. The
// extension platforms below are also "live" but through the browser extension,
// not an API.
//
// US-2327: Depop was removed. Its adapter is genuinely built (US-714, no
// stubbed methods), but the whole connector is gated behind DEPOP_ENABLED,
// which DEFAULTS TO FALSE — so on a stock deployment nothing about it works.
// "Built" and "live" are different claims, and this constant makes the second
// one. MARKETPLACE_TIER already said `api_pending` for Depop; this list
// disagreed with it, and this list was the wrong one.
//
// The invariant, asserted in marketplace-mechanism.test.ts: everything here
// must be MARKETPLACE_TIER === "api".
export const LIVE_CROSS_LISTING_PLATFORMS = ["ebay", "shopify"] as const;
export type CrossListingPlatform = (typeof CROSS_LISTING_PLATFORMS)[number];

// US-717: how each marketplace is actually reached. The composer + Marketplaces
// UI read this so a channel is never advertised as a clean API when it isn't.
//   "api"       — server-side connector (OAuth + write API): eBay/Shopify/Depop.
//   "extension" — the GradeThread Lister browser extension (US-716), which lists
//                 from the seller's OWN logged-in tab: Poshmark/Mercari/Grailed.
//   "none"      — no integration yet (manual only).
export type MarketplaceMechanism = "api" | "extension" | "none";
export const MARKETPLACE_MECHANISM: Record<
  (typeof LISTING_PLATFORMS)[number],
  MarketplaceMechanism
> = {
  ebay: "api",
  shopify: "api",
  depop: "api",
  etsy: "api",
  // US-2327: was "api", which was the boldest claim in this file and the least
  // supported. Every method on the Whatnot adapter is notImplemented, and
  // lib/whatnot-api.ts states the base URL, endpoints and field names were
  // MODELLED with no public documentation — so there is not an API waiting on
  // approval, there is a guess. "none" is what a seller needs to read.
  whatnot: "none",
  poshmark: "extension",
  mercari: "extension",
  grailed: "extension",
  vinted: "extension",
  // US-2480: was "none". Facebook Marketplace is the highest-traffic local
  // channel and both Crosslist and Vendoo support it, so "no integration" was
  // the coverage gap rather than an honest classification — there is a content
  // script (extension-unified/lister/facebook.js) and a delist path now.
  facebook: "extension",
  offerup: "none",
  other: "none",
};

// US-718: the presentation TIER each marketplace is honestly advertised in,
// derived from its real capability. This is the single source of truth the
// Marketplaces UI (web + iOS US-668) reads so a channel is never shown above
// the integration that actually ships at launch.
//   "api"         — live server-side connector you can connect today: eBay, Shopify.
//   "api_pending" — a real API connector is built but the channel is awaiting
//                   platform approval, so there's NO connect flow yet: Depop
//                   (US-713/714, gated behind DEPOP_ENABLED until approved).
//   "extension"   — lists from the seller's own logged-in tab via the GradeThread
//                   Lister browser extension (US-716): Poshmark/Mercari/Grailed.
//   "coming_soon" — no integration of any kind yet.
// Mechanism (api vs extension) answers "how is it reached"; tier answers
// "what can the seller honestly do right now". Depop is mechanism=api but
// tier=api_pending until approved.
export type MarketplaceTier = "api" | "api_pending" | "extension" | "coming_soon";
export const MARKETPLACE_TIER: Record<
  (typeof LISTING_PLATFORMS)[number],
  MarketplaceTier
> = {
  ebay: "api",
  shopify: "api",
  depop: "api_pending",
  etsy: "api_pending",
  // US-2327: demoted from api_pending. "Pending" implies an integration
  // awaiting approval; Whatnot's is entirely unimplemented against an API
  // nobody has documented. Moving it also keeps the tier↔mechanism consistency
  // rule intact rather than carving out an exception for it.
  whatnot: "coming_soon",
  poshmark: "extension",
  mercari: "extension",
  grailed: "extension",
  vinted: "extension",
  // US-2480: moved from coming_soon in lockstep with MARKETPLACE_MECHANISM
  // above, keeping the tier↔mechanism consistency rule intact. Whether the flow
  // is switched ON is MARKETPLACE_EXTENSION_FLOW below — tier says how a channel
  // is reached, not whether its selectors are verified.
  facebook: "extension",
  offerup: "coming_soon",
  other: "coming_soon",
};

// ─── US-2477..US-2480: is an extension channel's flow actually switched on? ──
//
// MARKETPLACE_TIER answers "how is this channel reached". It does NOT answer
// "does the flow run today", and conflating the two is how Mercari, Grailed and
// Vinted spent months rendering "Connect via browser extension" in the UI while
// their selectors sat at `enabled: false` and every attempt reported "list
// manually for now". A seller reading the badge had no way to know.
//
//   "live"      — selectors verified against the live sell form, flow enabled.
//   "verifying" — the content script and selectors exist, but no one has
//                 re-checked them against the real form yet, so the flow
//                 deliberately degrades to the manual message rather than
//                 half-filling a form it has not seen.
//
// THIS MUST MATCH `enabled` IN extension-unified/lister/selectors.js. It is not
// derived from it, because the frontend cannot import an extension content
// script — so marketplace-mechanism.test.ts parses that file and fails the build
// if the two disagree. Flipping a channel on is therefore exactly two edits:
// `enabled: true` + `lastVerified` there, and "live" here.
export type MarketplaceFlowStatus = "live" | "verifying";
export const MARKETPLACE_EXTENSION_FLOW: Record<
  (typeof EXTENSION_CROSS_LISTING_PLATFORMS)[number],
  MarketplaceFlowStatus
> = {
  poshmark: "live",
  // 2026-08-11: verified against the live forms and switched on in
  // extension-unified/lister/selectors.js. These two must move together with
  // that file — the whole point of this map is that the badge cannot claim
  // something the selectors do not do.
  mercari: "live",
  // Grailed lists but cannot auto-delist: its delete is confirmed by a NATIVE
  // browser dialog, which nothing in a page can answer. The seller gets a
  // pending-delist reminder instead, and chose that trade knowingly. "Ready to
  // list" is the honest badge for exactly what it does.
  grailed: "live",
  // 2026-08-11: the list flow was verified on www.vinted.com and switched on in
  // selectors.js. It lists; it cannot yet auto-delist, and the disclosure says
  // so — same honest badge as Grailed, for a different reason (Grailed's wall is
  // permanent, Vinted's is an unfinished check).
  vinted: "live",
  facebook: "verifying",
};

export const MARKETPLACE_FLOW_LABEL: Record<MarketplaceFlowStatus, string> = {
  live: "Ready to list",
  verifying: "Checking the form — list manually for now",
};

// Short, human-facing label for each tier — used by the Marketplaces UI badges
// so web and iOS describe a channel's capability with identical wording.
export const MARKETPLACE_TIER_LABEL: Record<MarketplaceTier, string> = {
  api: "Connected via API",
  api_pending: "API · coming once approved",
  extension: "Connect via browser extension",
  coming_soon: "Coming soon",
};

// US-2475's per-channel risk disclosure used to live here. It moved to
// src/lib/marketplace-disclosure.ts because constants.ts is in the eager bundle
// graph and that copy is ~5.5 KB of prose only the Marketplaces screen renders
// — it pushed the eager graph over the US-2112 budget. Import
// `marketplaceDisclosureFor` from there.

// Cross-listable platforms fanned out server-side via POST /cross-push (the
// US-708 adapter registry). Order = composer display order.
// US-2327: Whatnot removed. This group means "reached by a server-side API",
// and the existing consistency guard requires every member to be
// mechanism=api — which Whatnot no longer is, because its adapter implements
// nothing and its API was modelled without documentation.
export const API_CROSS_LISTING_PLATFORMS = [
  "ebay",
  "shopify",
  "depop",
  "etsy",
] as const satisfies readonly CrossListingPlatform[];

// Cross-listable platforms reached through the browser extension (US-716).
export const EXTENSION_CROSS_LISTING_PLATFORMS = [
  "poshmark",
  "mercari",
  "grailed",
  "vinted",
  "facebook", // US-2480
] as const satisfies readonly (typeof LISTING_PLATFORMS)[number][];
export type ExtensionCrossListingPlatform =
  (typeof EXTENSION_CROSS_LISTING_PLATFORMS)[number];

// THE BROWSER DOES NOT KNOW ANY STRIPE PRICE ID, and it must not learn one.
//
// There used to be a STRIPE_PRICE_IDS map here reading a whole VITE_STRIPE_PRICE_*
// env family at build time. US-2436 deleted it. Nothing imported it, and the env
// family it read is now referenced nowhere in the repo — the pricing pages render
// dollar amounts from FLIPDESK_PLANS and GRADETHREAD_TIERS, never an id.
//
// Every checkout posts a PLAN NAME — {plan, interval} — and the edge resolves the
// id server-side: pricing-config.ts layers the pricing_plans rows over Deno.env
// STRIPE_PRICE_* per field, and payments.ts reads the grade, credit-pack, buyer
// and API-overage ids from Deno.env directly. That is one source of truth, and it
// is admin-editable without a rebuild.
//
// The reason this is a warning and not just history: every entry fell back to a
// literal like "price_flipdesk_pro_monthly_placeholder". A client-side map of
// price ids with placeholder fallbacks sends a fake id into a live Checkout the
// first time someone adopts it from a context where the env vars are not inlined.
// If you need a price id in the browser, you have taken a wrong turn — send the
// plan name instead.

// ─── Content module (Blog + Social) ────────────────────────────────

export const CONTENT_SURFACES = ["blog", "social"] as const;
export const CONTENT_PRODUCTS = ["gradethread", "flipdesk", "both"] as const;
export const CONTENT_STATUSES = [
  "draft",
  "scheduled",
  "published",
  "archived",
  "failed",
] as const;
export const TOPIC_STATUSES = [
  "queued",
  "assigned",
  "used",
  "rejected",
] as const;

export const SURFACE_LABELS: Record<(typeof CONTENT_SURFACES)[number], string> = {
  blog: "Blog",
  social: "Social",
};

export const PRODUCT_LABELS: Record<(typeof CONTENT_PRODUCTS)[number], string> = {
  gradethread: "GradeThread",
  flipdesk: "FlipDesk",
  both: "Both",
};

export const CONTENT_STATUS_LABELS: Record<
  (typeof CONTENT_STATUSES)[number],
  string
> = {
  draft: "Draft",
  scheduled: "Scheduled",
  published: "Published",
  archived: "Archived",
  failed: "Failed",
};

export const TOPIC_STATUS_LABELS: Record<
  (typeof TOPIC_STATUSES)[number],
  string
> = {
  queued: "Queued",
  assigned: "Assigned",
  used: "Used",
  rejected: "Rejected",
};

// Hard caps surfaced in the social editor as live char counters.
// LinkedIn allows 3000, Facebook ~63k. We standardize on 3000 for the
// long format since LI is the binding constraint. X is 280, Threads
// 500 — we display X's lower bound to keep cross-posting safe.
export const SOCIAL_LONG_LIMIT = 3000;
export const SOCIAL_SHORT_LIMIT = 280;

// US-870: per-platform social variants. Mirrors the edge spec in
// services/edge-functions/src/lib/social-platforms.ts — keep in sync.
export const SOCIAL_PLATFORMS = [
  "x",
  "linkedin",
  "facebook",
  "threads",
  "pinterest",
  "instagram",
  "tiktok",
] as const;

export type SocialPlatformKey = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatformKey, string> = {
  x: "X",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  threads: "Threads",
  pinterest: "Pinterest",
  instagram: "Instagram",
  tiktok: "TikTok",
};

// Hard character ceilings per platform (matches PLATFORM_CHAR_LIMIT edge-side).
export const SOCIAL_PLATFORM_CHAR_LIMITS: Record<SocialPlatformKey, number> = {
  x: 280,
  linkedin: 3000,
  facebook: 5000,
  threads: 500,
  pinterest: 500,
  instagram: 2200,
  tiktok: 2200,
};

// Seed knowledge doc keys (cannot be deleted via the dashboard).
export const SEED_KNOWLEDGE_KEYS = [
  "brand.voice",
  "blog.gradethread.style",
  "blog.flipdesk.style",
  "social.long.style",
  "social.short.style",
  "seo.pillars",
] as const;

// US-377: legal-document versions for the signup clickwrap + re-acceptance gate.
// The version string is the document's EFFECTIVE DATE — bump these whenever the
// Terms of Service or Privacy Policy materially change (and update the matching
// `effectiveDate` in src/pages/legal/{terms,privacy}.tsx). A user whose recorded
// acceptance version differs from the current one is shown the re-acceptance
// gate before they can use the dashboard. Keep IN SYNC with the edge mirror in
// services/edge-functions/src/routes/legal.ts.
export const LEGAL_VERSIONS = {
  tos: "2026-04-01",
  privacy: "2026-04-01",
} as const;

// US-1670: the self-reported "How did you hear about us?" signup survey. The
// "AI assistant" option is the point — self-reported AI discovery is the only
// reliable ChatGPT/Claude/Perplexity attribution (referrers are often stripped),
// complementing the referrer-side ai_referrer analytics property. The `value`s
// MUST match the whitelist in the handle_new_user() trigger (migration 00379)
// and the SignupSource union in src/types/database.ts.
export const SIGNUP_SOURCE_OPTIONS: ReadonlyArray<{
  value: SignupSource;
  label: string;
}> = [
  { value: "ai_assistant", label: "AI assistant (ChatGPT, Claude, Perplexity)" },
  { value: "search", label: "Search engine (Google, Bing)" },
  { value: "reddit", label: "Reddit" },
  { value: "youtube", label: "YouTube" },
  { value: "social", label: "Social media" },
  { value: "reseller_community", label: "A reseller community or forum" },
  { value: "friend", label: "A friend or colleague" },
  { value: "ad", label: "An ad" },
  { value: "other", label: "Other" },
];

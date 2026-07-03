// Grade scale labels (1.0-10.0)
export const GRADE_LABELS = {
  10: "New with Tags (NWT)",
  9: "New without Tags (NWOT)",
  8: "Excellent",
  7: "Very Good",
  6: "Good",
  5: "Fair",
  4: "Below Average",
  3: "Poor",
  2: "Very Poor",
  1: "Salvage/Parts Only",
} as const;

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
  "scarf",
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

// Human labels for the measurement points (shared by both taxonomies).
export const MEASUREMENT_PHOTO_LABELS: Record<
  (typeof MEASUREMENT_PHOTO_TYPES)[number],
  string
> = {
  measurement_chest: "Chest / Bust",
  measurement_waist: "Waist",
  measurement_length: "Length",
  measurement_sleeve: "Sleeve",
  measurement_inseam: "Inseam",
};

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

// Dispute statuses
export const DISPUTE_STATUSES = [
  "open",
  "under_review",
  "resolved",
  "rejected",
] as const;

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
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 30,
    features: [
      "1,000 active listings",
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
    marketplacesCap: -1,
    includedStandardGradesPerMonth: 75,
    features: [
      "Unlimited active listings",
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
      reconciliation: true,
      prioritySupport: true,
      autolister: true,
    },
  },
} as const;

export type FlipdeskPlanKey = "free" | "starter" | "pro" | "business";

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
  { value: "USED_EXCELLENT", label: "Pre-owned — Excellent" },
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

// Canonical machine-readable mirror of the FlipDesk tier matrix in
// docs/PRICING.md (US-200 AC). Alias of FLIPDESK_PLANS so there is exactly one
// source of truth — any change here changes both. Prefer FLIPDESK_PLANS in new
// code; PLAN_MATRIX exists so the pricing doc can reference a stable name.
export const PLAN_MATRIX = FLIPDESK_PLANS;

// Thresholds at which the frontend fires upgrade modals. Tweakable per-user
// via users.usage_alert_thresholds in US-209.
export const FLIPDESK_UPGRADE_TRIGGERS = {
  /** Soft toast at this fraction of any cap (default). */
  softWarnPct: 0.8,
  /** Hard 402 block at this fraction. */
  hardBlockPct: 1.0,
  /** User-configurable threshold options (US-209 settings). */
  userOptions: [0.5, 0.8, 0.95] as const,
} as const;

// ─── Legacy PLANS (DEPRECATED — see US-202) ──────────────────────
//
// Kept for now so existing UI (billing, landing, admin, dashboard, etc.)
// keeps compiling. New code MUST NOT add callers. Values are derived from
// FLIPDESK_PLANS so changes propagate without drift. Legacy keys map:
//   free → flipdesk.free, starter → flipdesk.starter,
//   professional → flipdesk.pro, enterprise → flipdesk.business.
// Removed when US-211 (billing rebuild) + US-220 (landing rewrite) land.

const LEGACY_MAP: Record<PlanKey, FlipdeskPlanKey> = {
  free: "free",
  starter: "starter",
  professional: "pro",
  enterprise: "business",
};

interface LegacyPlanShape {
  name: string;
  gradesPerMonth: number;
  aiActionsPerMonth: number;
  priceMonthly: number | null;
  features: readonly string[];
}

function deriveLegacyPlan(key: PlanKey): LegacyPlanShape {
  const flip = FLIPDESK_PLANS[LEGACY_MAP[key]];
  return {
    name: flip.name,
    // Old "gradesPerMonth" → bundled grades. Old enterprise was unlimited,
    // but the new Business tier is 75 — surface that as the legacy value too.
    gradesPerMonth: flip.includedStandardGradesPerMonth,
    aiActionsPerMonth: flip.aiActionsPerMonth,
    priceMonthly: flip.priceMonthlyCents === 0 ? 0 : flip.priceMonthlyCents / 100,
    features: flip.features,
  };
}

/** @deprecated Use FLIPDESK_PLANS + GRADETHREAD_TIERS + CREDIT_PACKS instead (US-202). */
export const PLANS: Record<PlanKey, LegacyPlanShape> = {
  free: deriveLegacyPlan("free"),
  starter: deriveLegacyPlan("starter"),
  professional: deriveLegacyPlan("professional"),
  enterprise: deriveLegacyPlan("enterprise"),
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
export const AUTHENTICITY_ADDON_TIERS: readonly GradeTierKey[] = [
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
  "whatnot",
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

// Personal-use statuses — items the user is keeping/wearing rather than selling.
// These are filtered out of the main Kanban pipeline view (US-101 / US-109).
export const PERSONAL_STATUSES = ["keeping", "wearing"] as const;

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

// ─── Grade-score color tokens ────────────────────────────────────
// Single source for grade-score coloring across the app — design.md §3B
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

export const CONSIGNOR_PAYOUT_STATUSES = [
  "pending",
  "processing",
  "paid",
  "failed",
  "canceled",
] as const;

export const CONSIGNOR_PAYOUT_STATUS_LABELS: Record<
  (typeof CONSIGNOR_PAYOUT_STATUSES)[number],
  string
> = {
  pending: "Pending",
  processing: "Processing",
  paid: "Paid",
  failed: "Failed",
  canceled: "Canceled",
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
  "other",
] as const;

// Human labels for the item_category picker. `accessories` here = non-garment
// accessories sold standalone (hats, belts, sunglasses), distinct from the
// clothing garment_type "accessories".
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
  "on_model",
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
export const OPTIONAL_PHOTO_TYPES = [
  "tag",
  "detail",
  "tag_2",
  "detail_2",
  "detail_3",
  "detail_4",
  "interior",
  "defect",
  "flatlay",
  "on_model",
  ...MEASUREMENT_PHOTO_TYPES,
] as const;

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
  on_model: "On model",
  angle: "Angle / Profile",
  sole: "Sole",
  marking: "Markings / Hallmark",
  serial: "Serial / Model",
  accessory: "Accessories / Box",
  certificate: "Certificate / Label",
  corner: "Corners",
  surface: "Surface / Centering",
  measurement: "Measurement card (not listed)",
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

export function isNonListablePhotoType(t?: string | null): boolean {
  return (NON_LISTABLE_PHOTO_TYPES as readonly string[]).includes(t ?? "");
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

export const GRADING_SUBMISSION_TIERS = [
  "standard",
  "premium",
  "express",
] as const;

export const PAYOUT_IMPORT_METHODS = ["csv_upload", "api_sync"] as const;

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
  whatnot: "Whatnot",
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
] as const;
// Cross-list platforms that publish for real today via a server-side API
// (US-599 Shopify, US-714 Depop). The extension platforms below are also "live"
// but through the browser extension, not an API.
export const LIVE_CROSS_LISTING_PLATFORMS = ["ebay", "shopify", "depop"] as const;
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
  poshmark: "extension",
  mercari: "extension",
  grailed: "extension",
  facebook: "none",
  offerup: "none",
  whatnot: "none",
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
  poshmark: "extension",
  mercari: "extension",
  grailed: "extension",
  facebook: "coming_soon",
  offerup: "coming_soon",
  whatnot: "coming_soon",
  other: "coming_soon",
};

// Short, human-facing label for each tier — used by the Marketplaces UI badges
// so web and iOS describe a channel's capability with identical wording.
export const MARKETPLACE_TIER_LABEL: Record<MarketplaceTier, string> = {
  api: "Connected via API",
  api_pending: "API · coming once approved",
  extension: "Connect via browser extension",
  coming_soon: "Coming soon",
};

// Cross-listable platforms fanned out server-side via POST /cross-push (the
// US-708 adapter registry). Order = composer display order.
export const API_CROSS_LISTING_PLATFORMS = [
  "ebay",
  "shopify",
  "depop",
] as const satisfies readonly CrossListingPlatform[];

// Cross-listable platforms reached through the browser extension (US-716).
export const EXTENSION_CROSS_LISTING_PLATFORMS = [
  "poshmark",
  "mercari",
  "grailed",
] as const satisfies readonly (typeof LISTING_PLATFORMS)[number][];
export type ExtensionCrossListingPlatform =
  (typeof EXTENSION_CROSS_LISTING_PLATFORMS)[number];

// Stripe price IDs (US-202) — populated from import.meta.env at build time
// by the setup script in US-203. Placeholders for local dev; production
// IDs ship through VITE_STRIPE_PRICE_* env vars.
//
// Note: edge-function (Deno/Hono) code reads these from Deno.env directly
// so this constant is frontend-only.
// `import.meta.env` is typed by vite/client under the app tsconfig, but this
// module is also reached by the Vite-config type-check graph (via the SEO route
// registry), where that type isn't present — so read it through a local cast
// that type-checks in both contexts. Behavior is unchanged (Vite still inlines
// the real VITE_* values at build time; the fallback covers non-Vite contexts).
const env = (key: string, fallback: string): string =>
  ((import.meta as { env?: Record<string, string | undefined> }).env?.[key]) ??
  fallback;

export const STRIPE_PRICE_IDS = {
  flipdesk: {
    starter: {
      monthly: env("VITE_STRIPE_PRICE_FLIPDESK_STARTER_MONTHLY", "price_flipdesk_starter_monthly_placeholder"),
      yearly:  env("VITE_STRIPE_PRICE_FLIPDESK_STARTER_YEARLY",  "price_flipdesk_starter_yearly_placeholder"),
    },
    pro: {
      monthly: env("VITE_STRIPE_PRICE_FLIPDESK_PRO_MONTHLY", "price_flipdesk_pro_monthly_placeholder"),
      yearly:  env("VITE_STRIPE_PRICE_FLIPDESK_PRO_YEARLY",  "price_flipdesk_pro_yearly_placeholder"),
    },
    business: {
      monthly: env("VITE_STRIPE_PRICE_FLIPDESK_BUSINESS_MONTHLY", "price_flipdesk_business_monthly_placeholder"),
      yearly:  env("VITE_STRIPE_PRICE_FLIPDESK_BUSINESS_YEARLY",  "price_flipdesk_business_yearly_placeholder"),
    },
  },
  gradethread: {
    standard: env("VITE_STRIPE_PRICE_GRADE_STANDARD", "price_grade_standard_placeholder"),
    premium:  env("VITE_STRIPE_PRICE_GRADE_PREMIUM",  "price_grade_premium_placeholder"),
    express:  env("VITE_STRIPE_PRICE_GRADE_EXPRESS",  "price_grade_express_placeholder"),
  },
  creditPacks: {
    10:  env("VITE_STRIPE_PRICE_CREDITS_10",  "price_credits_10_placeholder"),
    25:  env("VITE_STRIPE_PRICE_CREDITS_25",  "price_credits_25_placeholder"),
    50:  env("VITE_STRIPE_PRICE_CREDITS_50",  "price_credits_50_placeholder"),
    100: env("VITE_STRIPE_PRICE_CREDITS_100", "price_credits_100_placeholder"),
  },
} as const;

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
] as const;

export type SocialPlatformKey = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatformKey, string> = {
  x: "X",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  threads: "Threads",
  pinterest: "Pinterest",
  instagram: "Instagram",
};

// Hard character ceilings per platform (matches PLATFORM_CHAR_LIMIT edge-side).
export const SOCIAL_PLATFORM_CHAR_LIMITS: Record<SocialPlatformKey, number> = {
  x: 280,
  linkedin: 3000,
  facebook: 5000,
  threads: 500,
  pinterest: 500,
  instagram: 2200,
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

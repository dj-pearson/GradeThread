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
  "completed",
  "failed",
  "disputed",
] as const;

// Image types
export const IMAGE_TYPES = [
  "front",
  "back",
  "label",
  "detail",
  "defect",
] as const;

// Dispute statuses
export const DISPUTE_STATUSES = [
  "open",
  "under_review",
  "resolved",
  "rejected",
] as const;

// Subscription plans
export const PLANS = {
  free: {
    name: "Free",
    gradesPerMonth: 5,
    priceMonthly: 0,
    features: [
      "5 grades per month",
      "Basic grade reports",
      "Email support",
    ],
  },
  starter: {
    name: "Starter",
    gradesPerMonth: 50,
    priceMonthly: 29,
    features: [
      "50 grades per month",
      "Detailed grade reports",
      "Certificate links",
      "Priority support",
    ],
  },
  professional: {
    name: "Professional",
    gradesPerMonth: 500,
    priceMonthly: 99,
    features: [
      "500 grades per month",
      "Full grade reports with AI analysis",
      "Certificate links & embeds",
      "API access",
      "Bulk uploads",
      "Priority support",
    ],
  },
  enterprise: {
    name: "Enterprise",
    gradesPerMonth: -1, // unlimited
    priceMonthly: null, // custom pricing
    features: [
      "Unlimited grades",
      "Full grade reports with AI analysis",
      "Certificate links & embeds",
      "Full API access",
      "Bulk uploads",
      "White-label options",
      "Dedicated support",
      "Custom integrations",
    ],
  },
} as const;

export type PlanKey = keyof typeof PLANS;

// Grade factors with weights (must sum to 1.0)
export const GRADE_FACTORS = {
  fabric_condition: { label: "Fabric Condition", weight: 0.30 },
  structural_integrity: { label: "Structural Integrity", weight: 0.25 },
  cosmetic_appearance: { label: "Cosmetic Appearance", weight: 0.20 },
  functional_elements: { label: "Functional Elements", weight: 0.15 },
  odor_cleanliness: { label: "Odor & Cleanliness", weight: 0.10 },
} as const;

export type GradeFactorKey = keyof typeof GRADE_FACTORS;

// Inventory item statuses
export const ITEM_STATUSES = [
  "acquired",
  "grading",
  "graded",
  "listed",
  "sold",
  "shipped",
  "completed",
  "returned",
] as const;

// Stripe price IDs (replace with actual IDs)
export const STRIPE_PRICE_IDS = {
  starter_monthly: "price_starter_monthly_placeholder",
  starter_yearly: "price_starter_yearly_placeholder",
  professional_monthly: "price_professional_monthly_placeholder",
  professional_yearly: "price_professional_yearly_placeholder",
} as const;

import type { BuyerGateFlags } from "@/lib/constants";

// US-1902: single source of truth for whether each buyer-suite feature's SURFACE
// is live yet, so the pricing page can't sell a feature that still lands on a
// placeholder. `live` mirrors the /buyer/* route table (src/routes/index.tsx):
// a route that renders BuyerPlaceholderPage is NOT live. Keep this in lockstep
// with that table — the guard test (buyer-features.test.ts) + the pricing render
// test fail if a placeholder-backed feature is sold without a "Coming soon"
// badge. Entitlement (which PLAN unlocks a feature) is separate — that's
// BuyerGateFlags on the plan; this is purely shipped-vs-planned.

/**
 * US-2503: whether iOS can deliver this capability, and if not, why not.
 *
 * `live` above answers "does the WEB surface exist". That was the only question
 * while there was one client. There are two now, /pricing says **"Every FlipDesk
 * plan includes buyer tools"**, and a phone-only subscriber currently gets none
 * of them — so "shipped" and "shipped where" stopped being the same fact.
 *
 * - `shipped`     — an iOS screen exists and works today.
 * - `planned`     — iOS can deliver it and has not yet. AC2's four screens.
 * - `desktop-only` — iOS cannot deliver it and never will, for a reason that is
 *                    about the capability rather than about effort. Only the
 *                    browser extension qualifies: it is an extension.
 */
export type BuyerFeatureIosDelivery = "shipped" | "planned" | "desktop-only";

export interface BuyerFeatureMeta {
  /** Short human label for the feature. */
  label: string;
  /** Is the feature's buyer surface shipped (not a placeholder)? WEB. */
  live: boolean;
  /** Does a curated plan-feature bullet describe THIS feature? Used to badge the
   *  right bullet on the pricing page without a hand-maintained duplicate list. */
  match: (bullet: string) => boolean;
  /** US-2503: can iOS deliver this, and if not, why not. */
  ios: BuyerFeatureIosDelivery;
  /**
   * Required when `ios` is `desktop-only`: the reason, in the words the iOS plan
   * screen will show. AC2 says the extension "must be stated as such" rather
   * than quietly omitted — a bullet that vanishes on one client reads as a bug,
   * and a subscriber who paid for the bundle deserves to be told which part of
   * it lives somewhere else instead of wondering where it went.
   */
  iosNote?: string;
  /**
   * Required when `ios` is `shipped`: the Swift file that delivers it, relative
   * to the repo root.
   *
   * This is what makes AC5 — "no bullet advertises a screen that does not
   * exist" — checkable rather than an honour system. The first version of the
   * guard only counted how many capabilities claimed to be shipped, and a
   * `planned` entry flipped to `shipped` sailed straight through it: the count
   * stayed under the threshold, so the one thing the guard existed to catch was
   * the one thing it missed. Naming the file means the claim can be tested by
   * looking for it.
   */
  iosScreen?: string;
}

// Keyed by the BuyerGateFlags flag so the registry can never list a feature the
// entitlement model doesn't know about (TS enforces the full key set).
export const BUYER_FEATURES: Record<keyof BuyerGateFlags, BuyerFeatureMeta> = {
  extensionSecondOpinion: {
    label: "Extension second-opinion checks",
    live: true,
    match: (b) => /second[- ]opinion/i.test(b),
    // The ONLY desktop-only entry, and the bar for adding a second is high: the
    // capability has to be impossible on the platform, not merely unbuilt. This
    // one IS a browser extension — it reads the marketplace page you are looking
    // at. There is no iOS shape for that.
    ios: "desktop-only",
    iosNote: "Runs in the desktop browser extension while you shop.",
  },
  discrepancyScoring: {
    label: "Claimed-vs-objective discrepancy",
    live: true,
    match: (b) => /discrepancy/i.test(b),
    // Scored inside an extension check, so it reaches the buyer only through the
    // surface above. Not separately deliverable on a phone.
    ios: "desktop-only",
    iosNote: "Part of the desktop extension's check.",
  },
  priceFairness: {
    label: "Price-fairness meter",
    live: true,
    match: (b) => /price[- ]fairness/i.test(b),
    ios: "desktop-only",
    iosNote: "Part of the desktop extension's check.",
  },
  conditionAlerts: {
    label: "Condition alerts",
    live: true,
    match: (b) => /condition alert|\balerts?\b/i.test(b),
    // AC2 screen 1 of 4.
    ios: "planned",
  },
  fitPrediction: {
    label: "Fit prediction",
    live: true,
    match: (b) => /fit prediction/i.test(b),
    // Reached through the extension check today; an iOS surface is possible but
    // is not one of AC2's four and is not being promised.
    ios: "desktop-only",
    iosNote: "Part of the desktop extension's check.",
  },
  authenticityAddon: {
    label: "Authenticity add-on",
    live: true,
    match: (b) => /authenticity/i.test(b),
    // An add-on bought against a grade, not a screen of its own.
    ios: "desktop-only",
    iosNote: "Bought on the web when you request a grade.",
  },
  videoGrading: {
    label: "Walk-around video grading",
    live: true,
    match: (b) => /video[- ]grad/i.test(b),
    // US-2504 owns the iOS recorder. Classified as planned here so this
    // registry does not contradict that story, and so the plan screen does not
    // advertise it until that recorder lands.
    ios: "planned",
  },
  rewards: {
    label: "Grade-confirmation rewards",
    live: true,
    match: (b) => /rewards?/i.test(b),
    ios: "planned",
  },
  trustScore: {
    label: "Buyer trust score",
    live: true,
    match: (b) => /trust score/i.test(b),
    // AC2 screen 3 of 4 — SHIPPED. Reads GET /api/buyer/reputation, which
    // resolves the level, the perks and the distance to the next level on the
    // server. The web resolves those from its own mirror of the perk matrix; a
    // Swift mirror would have made three copies of one policy.
    ios: "shipped",
    iosScreen: "ios/GradeThread/Buyer/BuyerTrustScoreView.swift",
  },
  // The only buyer surface still behind BuyerPlaceholderPage (/buyer/guarantee).
  purchaseGuarantee: {
    label: "Grade-locked purchase guarantee",
    // US-2073: now LIVE — /buyer/guarantee renders the real coverage surface
    // (covered purchases with window + payout cap + trigger threshold, claim
    // status, and WHY anything is excluded) instead of a placeholder. This flag
    // drives the "Coming soon" badge on the public pricing page, so leaving it
    // false would keep advertising a shipped feature as unshipped.
    live: true,
    match: (b) => /guarantee|purchase protection/i.test(b),
    // AC2 screen 4 of 4 — SHIPPED. Reads GET /api/buyer/guarantee-coverage,
    // which joins purchases to their coverage snapshot and any filed claim.
    // The web builds the same view from five parallel reads joined in the
    // browser; a second implementation of that join is a second answer to
    // "what am I covered for".
    ios: "shipped",
    iosScreen: "ios/GradeThread/Buyer/BuyerGuaranteeView.swift",
  },
  wardrobePortfolio: {
    label: "Wardrobe portfolio",
    live: true,
    match: (b) => /closet|portfolio/i.test(b),
    // AC2 screen 2 of 4 — SHIPPED. Reads GET /api/buyer/closet/valuation,
    // which gained an additive `items` array carrying the identity fields
    // alongside the estimates it already computed. A new key rather than a
    // change to `valuations`, which the web reads: an extra key is ignored by
    // an existing client, changed semantics are not.
    ios: "shipped",
    iosScreen: "ios/GradeThread/Buyer/BuyerPortfolioView.swift",
  },
  demandBoard: {
    label: "Graded-Wanted demand board",
    live: true,
    match: (b) => /demand board|graded[- ]wanted/i.test(b),
    ios: "planned",
  },
  prioritySupport: {
    label: "Priority support",
    live: true,
    match: (b) => /priority support/i.test(b),
    // Support tickets already exist on iOS; priority is a queue property of the
    // plan, not a screen, so it needs nothing built to be true there.
    ios: "shipped",
    iosScreen: "ios/GradeThread/Support/SupportTicketsView.swift",
  },
};

export type BuyerFeatureFlag = keyof BuyerGateFlags;

/** The buyer feature a curated bullet describes, or null if it maps to none
 *  (e.g. "Everything in Guard", allowance-only lines). First match wins. */
export function buyerFeatureForBullet(
  bullet: string,
): BuyerFeatureFlag | null {
  for (const flag of Object.keys(BUYER_FEATURES) as BuyerFeatureFlag[]) {
    if (BUYER_FEATURES[flag].match(bullet)) return flag;
  }
  return null;
}

/**
 * Is this plan-feature bullet describing a not-yet-live feature? `liveOverride`
 * lets the test force every feature planned ("all buyer flags off") to prove no
 * placeholder-backed bullet can escape the badge as features are added.
 */
export function isBulletComingSoon(
  bullet: string,
  liveOverride?: Partial<Record<BuyerFeatureFlag, boolean>>,
): boolean {
  const flag = buyerFeatureForBullet(bullet);
  if (!flag) return false;
  const live = liveOverride?.[flag] ?? BUYER_FEATURES[flag].live;
  return !live;
}

// ── iOS delivery (US-2503 AC2/AC5) ──────────────────────────────────

/**
 * The capabilities an iOS plan screen may list as available TODAY.
 *
 * AC5: "no bullet advertises a screen that does not exist." Deriving the list
 * from the registry rather than typing it into the Swift makes that a property
 * instead of a promise — and because BUYER_FEATURES is
 * `Record<keyof BuyerGateFlags, …>`, a NEW buyer capability does not compile
 * until somebody classifies it. The default is therefore "decide", not
 * "silently appears as an iOS bullet", which is the failure this whole story is
 * an instance of.
 */
export function iosDeliverableFeatures(): BuyerFeatureFlag[] {
  return (Object.keys(BUYER_FEATURES) as BuyerFeatureFlag[]).filter(
    (f) => BUYER_FEATURES[f].ios === "shipped",
  );
}

/** Bundled capabilities iOS cannot deliver, each with the reason to show. */
export function iosDesktopOnlyFeatures(): Array<{
  flag: BuyerFeatureFlag;
  label: string;
  note: string;
}> {
  return (Object.keys(BUYER_FEATURES) as BuyerFeatureFlag[])
    .filter((f) => BUYER_FEATURES[f].ios === "desktop-only")
    .map((flag) => ({
      flag,
      label: BUYER_FEATURES[flag].label,
      // The type permits an absent note; the guard forbids one. Falling back
      // keeps a missing note from rendering "undefined" at a paying customer.
      note: BUYER_FEATURES[flag].iosNote ?? "Available on the web.",
    }));
}

/**
 * May an iOS plan screen list this capability as something you can use now?
 *
 * `planned` answers FALSE, and that is the point rather than an oversight: a
 * capability somebody intends to build is exactly the kind that gets listed
 * early. The screen has to exist.
 */
export function isIosDeliverable(flag: BuyerFeatureFlag): boolean {
  return BUYER_FEATURES[flag].ios === "shipped";
}

// The calculator family (US-9002): /tools/{slug} plus the hub at
// /tools/calculators.
//
// WHY THIS FAMILY EXISTS, in one number: /tools/authenticity-check earns 9.0%
// CTR at average position 13.4 while the site averages 0.85% at position 11.6
// (Search Console, 6 months to 2026-08-16). One tool page out-clicks 104 blog
// posts sitting three positions above it. That is local evidence, not a
// borrowed Keyword Planner estimate, and it is why the calculators go first.
//
// STATUS FLAG: an entry is only routed once its own story ships the compute.
// The registry carries all eight so the family can be planned, sized and
// interlinked in one place, but calculatorRoutes() emits only `live` ones. A
// page that promises a calculator and renders an empty shell is worse than no
// page, and that is the failure the flag prevents.
//
// PURE DATA: imports only the PublicRoute TYPE, like every other route family
// in this directory. Fee schedules and compute live with their calculator.

import type { PublicRoute } from "./public-routes";

export const CALCULATOR_HUB_PATH = "/tools/calculators";

/** Who the calculator is for. Drives hub grouping and the interlink target. */
export type CalculatorAudience = "seller" | "buyer" | "both";

export interface Calculator {
  /** URL slug under /tools/, e.g. "ebay-fee-calculator". */
  slug: string;
  /**
   * `live` once the calculator computes something. `planned` entries are
   * registry-only: no route, no prerender, no sitemap entry, no hub card.
   */
  status: "live" | "planned";
  /** The story that ships the compute. */
  story: string;
  audience: CalculatorAudience;
  /** <title> without the " | GradeThread" suffix the SEO component adds. */
  title: string;
  description: string;
  h1: string;
  /** One line on the hub card. */
  cardBlurb: string;
  /** The head keyword this page owns, mirrored into keyword-targets.ts. */
  primaryKeyword: string;
}

export function calculatorPath(slug: string): string {
  return `/tools/${slug}`;
}

// The eight, in build order. Volumes cited in the stories come from the 2026-08
// Keyword Planner pull and are BUCKETED estimates from an Ads account with no
// spend. US-9001 found three of four "proven 5,000/mo" URLs with zero
// impressions after ten weeks, so treat every such figure as a rank ordering
// rather than a forecast.
export const CALCULATORS: readonly Calculator[] = [
  {
    slug: "ebay-fee-calculator",
    status: "planned",
    story: "US-9003",
    audience: "seller",
    title: "eBay Fee Calculator: What a Sale Actually Nets You",
    description:
      "Work out the real payout on an eBay sale: category final value fee, per-order fixed fee, insertion fees past the free allotment, promoted-listing rate and international surcharge.",
    h1: "eBay fee calculator",
    cardBlurb: "Every eBay fee on one sale, itemised, including the ones sellers forget.",
    primaryKeyword: "ebay fee calculator",
  },
  {
    slug: "ebay-shipping-calculator",
    status: "planned",
    story: "US-9004",
    audience: "seller",
    title: "eBay Shipping Calculator for Clothing Sellers",
    description:
      "Compare shipping cost by weight, box size and service for the packages clothing sellers actually send, with dimensional weight applied and flat-rate compared against weight-based.",
    h1: "eBay shipping calculator",
    cardBlurb: "Weight, box size and service compared, with dimensional weight shown separately.",
    primaryKeyword: "ebay shipping calculator",
  },
  {
    slug: "poshmark-fee-calculator",
    status: "planned",
    story: "US-9005",
    audience: "seller",
    title: "Poshmark Fee Calculator: What Poshmark Takes",
    description:
      "What Poshmark keeps from a sale and what lands in your account, with the flat fee on small orders and the commission above it applied to the number you enter.",
    h1: "Poshmark fee calculator",
    cardBlurb: "The flat fee, the commission, and where the cutoff between them falls.",
    primaryKeyword: "how much does poshmark take",
  },
  {
    slug: "mercari-fee-calculator",
    status: "planned",
    story: "US-9005",
    audience: "seller",
    title: "Mercari Fee Calculator: Your Real Payout",
    description:
      "What Mercari takes from a sale, including the selling fee, the payment processing cut and the shipping choice that decides which side pays the postage.",
    h1: "Mercari fee calculator",
    cardBlurb: "Selling fee, processing cut, and who ends up paying the postage.",
    primaryKeyword: "mercari fee calculator",
  },
  {
    slug: "depop-fee-calculator",
    status: "planned",
    story: "US-9005",
    audience: "seller",
    title: "Depop Fee Calculator: What You Keep on a Sale",
    description:
      "What Depop keeps from a sale after the selling fee and payment processing, and what the same item would net you on eBay, Poshmark, Mercari or Etsy instead.",
    h1: "Depop fee calculator",
    cardBlurb: "Depop's cut, next to what the same item nets on four other platforms.",
    primaryKeyword: "depop fee calculator",
  },
  {
    slug: "etsy-fee-calculator",
    status: "planned",
    story: "US-9005",
    audience: "seller",
    title: "Etsy Fee Calculator for Vintage and Resale Sellers",
    description:
      "Listing fee, transaction fee, payment processing and offsite ads, applied to a vintage or resale listing so you can see the payout before you set the price.",
    h1: "Etsy fee calculator",
    cardBlurb: "Listing, transaction, processing and offsite ads on one vintage listing.",
    primaryKeyword: "etsy fee calculator",
  },
  {
    slug: "reseller-profit-calculator",
    status: "planned",
    story: "US-9006",
    audience: "seller",
    title: "Reseller Profit Calculator That Factors In Condition",
    description:
      "Cost of goods, fees, shipping and the item's condition grade, worked through to net profit, margin and ROI. The condition adjustment is shown, not buried in the total.",
    h1: "Reseller profit calculator",
    cardBlurb:
      "The only one that adjusts the sale price for what condition the item is actually in.",
    primaryKeyword: "reseller profit calculator",
  },
  {
    slug: "measurement-converter",
    status: "planned",
    story: "US-9007",
    audience: "both",
    title: "Clothing Measurement and Size Converter",
    description:
      "Convert US, UK, EU and JP sizing, and inches to centimetres for pit to pit, length, sleeve, waist and inseam, with a diagram of where each measurement is taken.",
    h1: "Measurement and size converter",
    cardBlurb: "US, UK, EU and JP sizing, plus where on the garment each measurement is taken.",
    primaryKeyword: "clothing measurement converter",
  },
];

export const CALCULATOR_HUB_META = {
  path: CALCULATOR_HUB_PATH,
  title: "Free Reseller Calculators: Fees, Shipping and Profit",
  description:
    "Free calculators for people who sell used clothing: marketplace fees, shipping cost, and profit that accounts for the item's condition. No signup, no account.",
  h1: "Reseller calculators",
  intro:
    "Every one of these answers a question you would otherwise guess at: what a sale nets after fees, what postage will cost before you list, and whether an item is worth buying once its condition is priced in. They run in your browser, they need no account, and the fee schedules are dated so you can see which rates a result used.",
  faqs: [
    {
      q: "Are these calculators free?",
      a: "Yes, all of them, with no account and no signup. They run in your browser and nothing you type is sent anywhere.",
    },
    {
      q: "How current are the fee rates?",
      a: "Each fee schedule carries the date it took effect, and the calculator states which schedule produced your result. When a marketplace changes its rates, the schedule is updated and the effective date moves with it.",
    },
    {
      q: "Why does the profit calculator ask for a condition grade?",
      a: "Because condition is the largest single lever on resale price, and a comp taken from a mint example will overstate what a worn one sells for. The calculator adjusts the estimated sale price for the grade you enter and shows the adjustment it applied rather than folding it into the total.",
    },
  ],
};

/** Only calculators whose compute has shipped. */
export function liveCalculators(): Calculator[] {
  return CALCULATORS.filter((c) => c.status === "live");
}

export function getCalculatorBySlug(slug: string): Calculator | undefined {
  return CALCULATORS.find((c) => c.slug === slug);
}

export function getCalculatorByPath(path: string): Calculator | undefined {
  const norm = path.replace(/\/+$/, "");
  return CALCULATORS.find((c) => calculatorPath(c.slug) === norm);
}

export function isCalculatorHubPath(path: string): boolean {
  return path.replace(/\/+$/, "") === CALCULATOR_HUB_PATH;
}

export function calculatorBreadcrumbItems(
  calc: Calculator,
): Array<{ name: string; path: string }> {
  return [
    { name: "GradeThread", path: "/" },
    { name: "Calculators", path: CALCULATOR_HUB_PATH },
    { name: calc.h1, path: calculatorPath(calc.slug) },
  ];
}

export function calculatorHubBreadcrumbItems(): Array<{ name: string; path: string }> {
  return [
    { name: "GradeThread", path: "/" },
    { name: "Calculators", path: CALCULATOR_HUB_PATH },
  ];
}

/**
 * The hub plus every LIVE calculator. Spread into PUBLIC_ROUTES.
 *
 * Planned entries are deliberately absent: registering a route before its
 * compute exists ships a page that promises a calculator and renders nothing.
 *
 * The hub follows the same rule. With nothing live it is an empty list page,
 * which is a worse result than no page at all, so the family registers NOTHING
 * until the first calculator ships. That makes US-9002 (this file and its
 * wiring) and US-9003 (the first calculator) land together by construction.
 */
export function calculatorRoutes(): PublicRoute[] {
  const live = liveCalculators();
  if (live.length === 0) return [];
  const routes: PublicRoute[] = [
    {
      path: CALCULATOR_HUB_PATH,
      title: CALCULATOR_HUB_META.title,
      description: CALCULATOR_HUB_META.description,
      changefreq: "monthly",
      priority: 0.7,
      jsonLdType: "CollectionPage",
    },
  ];
  for (const c of live) {
    routes.push({
      path: calculatorPath(c.slug),
      title: c.title,
      description: c.description,
      changefreq: "monthly",
      priority: 0.7,
      jsonLdType: "WebApplication",
    });
  }
  return routes;
}

// Platform comparison pages (US-1667): /compare/{a}-vs-{b}/.
//
// A reusable comparison template plus hand-written flagships. Every comparison
// carries the column no generic "X vs Y" post has — a "returns & condition-
// dispute handling" row — which is where the GradeThread grading wedge inserts:
// the platform you sell on decides how a dispute is adjudicated, and an
// objective condition grade + certificate is the reseller's defense on any of
// them. Front-loads the query phrase + year in the title (refresh annually,
// US-1694), links up to the returns spine (US-1673) and /grading/scale.
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD (Article + FAQPage) is
// composed in src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";

export const COMPARE_HUB_PATH = "/compare";

/** Freshness stamp shown on every comparison; bump on the annual refresh (US-1694). */
export const COMPARISON_VERIFIED = "July 2026";

export interface CompareRow {
  /** The dimension being compared, e.g. "Selling fees". */
  dimension: string;
  /** Platform A's answer. */
  a: string;
  /** Platform B's answer. */
  b: string;
  /** Set on the unique returns/condition-dispute row so the template can highlight it. */
  wedge?: boolean;
}

export interface ComparisonSection {
  heading: string;
  body: string;
}

export interface Comparison {
  slug: string;
  /** Platform A display name (first named in the slug). */
  platformA: string;
  /** Platform B display name. */
  platformB: string;
  /** <title> without the " | GradeThread" suffix — ≤ 46, unique, year front-loaded. */
  title: string;
  /** Meta description — 70–160, unique. */
  description: string;
  h1: string;
  /** Self-contained intro (~45–60 words). */
  intro: string;
  /** Comparison table rows; MUST include exactly one row with wedge:true. */
  rows: CompareRow[];
  /** Prose sections after the table (category fit, who each is for, etc.). */
  sections: ComparisonSection[];
  /** The bottom-line recommendation — honest, not "it depends" filler. */
  verdict: string;
  /** The grading wedge — how a condition grade protects the seller on either platform. */
  gradingWedge: string;
  faqs: Array<{ q: string; a: string }>;
}

export function comparePath(slug: string): string {
  return `${COMPARE_HUB_PATH}/${slug}`;
}

// ── The comparisons ─────────────────────────────────────────────────
export const COMPARISONS: Comparison[] = [
  {
    slug: "mercari-vs-ebay",
    platformA: "Mercari",
    platformB: "eBay",
    title: "Mercari vs eBay for Resellers (2026)",
    description:
      "Mercari vs eBay in 2026 for selling used clothes: fees, category fit, shipping, payout speed, and how each handles condition disputes and returns.",
    h1: "Mercari vs eBay: which is better for resellers in 2026?",
    intro:
      "Mercari and eBay are the two default US marketplaces for reselling clothing, and they optimize for opposite sellers: Mercari for casual, low-friction listing, eBay for volume and reach. This comparison covers fees, category fit, shipping, and payout speed — plus the thing most comparisons skip: how each one adjudicates a 'not as described' condition dispute, which is where resellers actually lose money.",
    rows: [
      {
        dimension: "Selling fees",
        a: "A flat ~10% selling fee plus payment processing; historically the lowest-friction fee model. Fee structures shift often — verify the current rate before you price.",
        b: "Final value fee ~13.25% for most apparel categories plus a per-order fee; lower with a Store subscription. Higher headline take, but more levers to reduce it.",
      },
      {
        dimension: "Audience & reach",
        a: "Smaller, US-focused, mobile-first buyer base that skews casual. Great for fast turnover of mid-priced items; thinner demand for niche or high-end pieces.",
        b: "The largest secondhand-clothing buyer pool, global, with deep demand for brands, vintage, and hard-to-find sizes. Better ceiling for grails and comps.",
      },
      {
        dimension: "Category fit",
        a: "Strong for everyday casualwear, streetwear, and mid-market brands sold quickly at a fair price.",
        b: "Strong across the board — vintage, designer, workwear, deadstock, and anything with an established sold-comp history.",
      },
      {
        dimension: "Shipping",
        a: "Prepaid label the seller can pass to the buyer; simple flat-rate options. Less control, less optimization.",
        b: "Full control of carrier, service, and cost; calculated shipping and combined-order discounts reward high-volume sellers.",
      },
      {
        dimension: "Payout speed",
        a: "Funds release after delivery confirmation; direct deposit is typically a few business days.",
        b: "Managed Payments deposits on a set schedule (often next-day to a few days) once an order clears; more predictable for cash flow at volume.",
      },
      {
        dimension: "Returns & condition-dispute handling",
        wedge: true,
        a: "Buyer-protection claims are adjudicated by Mercari; a 'not as described' condition claim usually favors the buyer, and the seller carries the burden of proving the item matched the listing.",
        b: "Money-back-guarantee cases can be opened for 'item not as described'; eBay tends to side with buyers on condition disputes, and repeated cases hurt your seller metrics — the burden of accurate condition is on you.",
      },
    ],
    sections: [
      {
        heading: "Who Mercari is for",
        body: "Mercari fits the reseller who wants to list fast and move mid-priced everyday clothing without much overhead. The fee model is simple, the app is quick, and the buyer expects a casual transaction. The trade-off is a smaller audience and less pricing ceiling — a rare piece will usually clear for less than it would on eBay.",
      },
      {
        heading: "Who eBay is for",
        body: "eBay fits the volume or specialist reseller. The audience is the largest in secondhand clothing, the sold-comp data is the deepest, and you control shipping and store economics. The cost is a higher headline fee and stricter seller-performance standards — including how condition disputes count against you.",
      },
      {
        heading: "The part both have in common: condition risk",
        body: "On either platform, the single most expensive event is a 'not as described' return over condition — a stain the buyer says you hid, wear you called 'excellent.' Both platforms resolve these in the buyer's favor by default, and both put the burden of proof on the seller. That risk is identical whether you sell on Mercari or eBay, and it's the one most 'X vs Y' comparisons never mention.",
      },
    ],
    verdict:
      "Sell everyday, mid-priced clothing you want to move quickly on Mercari for the lower friction; sell brands, vintage, and higher-value pieces on eBay for the reach and comp depth. Most serious resellers cross-list to both. Whichever you choose, the condition-dispute exposure is the same — and that's the piece you can actually control.",
    gradingWedge:
      "Neither platform will take your word on condition when a buyer opens a dispute — but an objective, third-party condition grade and a shareable certificate is evidence you graded honestly and disclosed accurately. Grading each item on a standardized 1.0–10.0 scale before you list sets buyer expectations up front (fewer disputes) and gives you documentation to fall back on (better outcomes when one happens), on Mercari, eBay, or anywhere you cross-list.",
    faqs: [
      {
        q: "Is Mercari or eBay cheaper for sellers?",
        a: "Mercari's flat selling fee is usually the lower headline rate, but eBay gives you more ways to cut costs — a Store subscription, promoted-listing control, and combined shipping. For low-volume casual selling Mercari is cheaper; for high volume, eBay's levers can close the gap. Fee structures on both change often, so verify the current rates before pricing.",
      },
      {
        q: "Which platform is better for selling used clothes?",
        a: "eBay has the larger audience and deeper sold-comp data, which makes it better for brands, vintage, and higher-value pieces. Mercari is faster and lower-friction for everyday, mid-priced clothing you want to turn over quickly. Many resellers cross-list to both to maximize reach.",
      },
      {
        q: "Who wins a condition dispute on Mercari vs eBay?",
        a: "Both platforms resolve 'not as described' condition disputes in the buyer's favor by default, and both put the burden of proof on the seller. The best protection on either is to disclose condition accurately up front — an objective condition grade and certificate document that you did, which both reduces disputes and helps your case when one is opened.",
      },
      {
        q: "Should I cross-list to both Mercari and eBay?",
        a: "Yes, for most resellers — it maximizes reach and lets each item find its best-fit buyer. Use a consistent, accurate condition description across both so a buyer can't claim the listings disagreed, and keep inventory synced so you don't oversell.",
      },
    ],
  },
];

export function getComparisonBySlug(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

export function getComparisonByPath(path: string): Comparison | undefined {
  const norm = path.replace(/\/+$/, "");
  return COMPARISONS.find((c) => comparePath(c.slug) === norm);
}

export function isComparePath(path: string): boolean {
  return getComparisonByPath(path) !== undefined;
}

export function isCompareHubPath(path: string): boolean {
  return path.replace(/\/+$/, "") === COMPARE_HUB_PATH;
}

/** Public routes: the hub index + one page per comparison. */
export function comparisonRoutes(): PublicRoute[] {
  const hub: PublicRoute = {
    path: COMPARE_HUB_PATH,
    title: "Marketplace Comparisons for Resellers",
    description:
      "Compare the marketplaces resellers sell used clothes on — fees, reach, shipping, payout speed, and how each handles condition disputes and returns.",
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "CollectionPage",
  };
  const pages: PublicRoute[] = COMPARISONS.map((c) => ({
    path: comparePath(c.slug),
    title: c.title,
    description: c.description,
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "Article",
  }));
  return [hub, ...pages];
}

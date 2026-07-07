// Consumer "where to sell used clothes" mega-guide (US-1693): /where-to-sell-used-clothes.
//
// ONE comprehensive, AI-citable mega-guide (deliberately NOT a cluster) that
// captures deferred consumer closet-cleanout intent — criteria-driven, with a
// comparison table and pros/cons in the formats retrieval engines favor. Links
// into the reseller pillar and the /compare cluster; positions GradeThread on
// the condition/returns differentiator without building a losing consumer cluster.
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD (Article + ItemList +
// FAQPage) is composed in src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";
import { verifiedLabel } from "./freshness";

export const WHERE_TO_SELL_PATH = "/where-to-sell-used-clothes";

/** Freshness stamp — derived from the real re-check date (US-1694). */
export const WHERE_TO_SELL_VERIFIED = verifiedLabel("where-to-sell");

export interface SellingVenue {
  name: string;
  /** The one-line "best for" that makes this venue the answer for someone. */
  bestFor: string;
  /** Effort level, consumer-facing. */
  effort: "Low" | "Medium" | "High";
  /** Fee/payout model in plain consumer terms. */
  economics: string;
  pro: string;
  con: string;
}

/** Consumer-facing venue table. Ordered roughly most-effort/most-return → least. */
export const SELLING_VENUES: SellingVenue[] = [
  {
    name: "eBay",
    bestFor: "brands, vintage, and anything with resale demand — the widest reach",
    effort: "High",
    economics: "~13% fee for apparel; you set price and shipping",
    pro: "Largest buyer pool and the best prices for desirable items",
    con: "Most listing effort and the strictest seller standards",
  },
  {
    name: "Poshmark",
    bestFor: "contemporary women's and men's fashion sold to a social community",
    effort: "Medium",
    economics: "Flat fee on cheap items, ~20% on $15+; prepaid label",
    pro: "Built-in social audience; simple shipping",
    con: "Selling rewards active sharing and engagement",
  },
  {
    name: "Depop",
    bestFor: "vintage, streetwear, and y2k for a young, style-led audience",
    effort: "Medium",
    economics: "~10% fee plus processing; photo-first listings",
    pro: "Strong demand for trend and vintage pieces",
    con: "Smaller for mainstream/mid-market brands",
  },
  {
    name: "Mercari",
    bestFor: "fast, low-effort selling of everyday clothing",
    effort: "Low",
    economics: "~10% fee plus processing; prepaid label",
    pro: "Quick to list; no social engine required",
    con: "Smaller audience and lower ceiling on rare items",
  },
  {
    name: "Vinted",
    bestFor: "casual clothing with no seller selling fee",
    effort: "Low",
    economics: "No seller fee — buyers pay Buyer Protection",
    pro: "You keep the sale price; simple integrated shipping",
    con: "Best for lower-priced everyday items",
  },
  {
    name: "ThredUp / consignment",
    bestFor: "hands-off closet cleanouts you don't want to list yourself",
    effort: "Low",
    economics: "You send a bag; they list and take a large cut",
    pro: "Zero listing work — mail it and forget it",
    con: "Lowest payout, and lower-condition items are rejected",
  },
  {
    name: "The RealReal",
    bestFor: "authenticated luxury and designer consignment",
    effort: "Low",
    economics: "Luxury consignment; commission scales with value",
    pro: "Handles authentication and luxury buyers for you",
    con: "Luxury only; they set condition tier and price",
  },
  {
    name: "Local (Facebook / apps)",
    bestFor: "bulky lots, fast cash, and no shipping",
    effort: "Low",
    economics: "No platform fee; cash in person",
    pro: "No fees or shipping; instant payment",
    con: "Local-only reach and lower prices",
  },
];

export function whereToSellRoute(): PublicRoute {
  return {
    path: WHERE_TO_SELL_PATH,
    title: "Where to Sell Used Clothes (2026)",
    description:
      "Where to sell used clothes in 2026: eBay, Poshmark, Depop, Mercari, Vinted, ThredUp, and consignment compared by fees, effort, and payout.",
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "Article",
  };
}

export function isWhereToSellPath(path: string): boolean {
  return path.replace(/\/+$/, "") === WHERE_TO_SELL_PATH;
}

export const WHERE_TO_SELL = {
  path: WHERE_TO_SELL_PATH,
  h1: "Where to sell used clothes: the complete 2026 guide",
  definition:
    "The best place to sell used clothes depends on what you're selling and how much effort you'll put in: eBay and Poshmark get the highest prices for desirable brands but take real listing work, while Mercari, Vinted, and consignment services trade a lower payout for far less effort. Match the venue to your items and your time, not to whichever app you've heard of.",
  intro:
    "Cleaning out a closet raises one question: where's the best place to actually sell it? This guide compares the major options on the things that matter — fees, audience, effort, and payout speed — and helps you pick by your situation instead of guessing.",
  criteria: [
    { name: "What you're selling", text: "Desirable brands, vintage, and designer earn the most on eBay, Depop, Grailed, or luxury consignment. Everyday mid-market clothing does fine on Mercari or Vinted and often isn't worth the fees elsewhere." },
    { name: "How much effort you'll put in", text: "Listing each item yourself (photos, description, shipping) earns the most. Bag-it-and-mail-it consignment earns the least but takes almost no time. Be honest about which you'll actually do." },
    { name: "Fees and payout", text: "Fees range from zero seller fee (Vinted) to ~13% (eBay) to a large consignment cut. Faster, predictable payouts matter if you need the cash soon." },
    { name: "Condition and returns", text: "Condition is the #1 cause of 'not as described' returns everywhere. Describing it accurately — ideally with a verifiable grade — is what keeps a sale from bouncing back." },
  ],
  faqs: [
    {
      q: "What is the best place to sell used clothes?",
      a: "There's no single best place — it depends on the item and your effort. eBay and Poshmark get the highest prices for brands and desirable pieces but take listing work; Mercari and Vinted are faster and lower-effort for everyday clothing; consignment services like ThredUp are hands-off but pay the least. Match the venue to what you're selling.",
    },
    {
      q: "Where can I sell used clothes for the most money?",
      a: "For desirable brands, vintage, and designer, eBay gives the widest reach and best prices, with Depop and Grailed strong for streetwear and menswear and The RealReal for authenticated luxury. The trade-off is that these take the most listing effort — the highest payout and the lowest effort rarely come together.",
    },
    {
      q: "How do I avoid returns when selling used clothes?",
      a: "Most returns are 'not as described' over condition. Describe condition accurately and disclose every flaw with photos — and an objective condition grade plus a certificate makes your description verifiable, which both reduces disputes and helps if one is opened.",
    },
    {
      q: "Is it worth selling used clothes online?",
      a: "Yes, if you match effort to value: listing desirable items yourself on eBay or Poshmark is worth it, while low-value everyday clothing is often better sold in bulk via consignment or locally. Pricing to real sold comps and disclosing condition accurately are what make it pay.",
    },
  ],
};

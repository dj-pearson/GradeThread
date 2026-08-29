// Opportunist mid-tail guides (US-1668): fast-rising, low-competition eBay
// how-to pages that feed FlipDesk features.
//
//   /reselling/ebay-item-specifics  — what item specifics drive Cassini search,
//                                      required vs recommended, how AutoLister
//                                      removes the tedium. Feeds AutoLister.
//   /reselling/comps/ebay-sold-comps — how to read sold vs active comps, filter
//                                      by condition. Feeds the comp-pull tool.
//
// Each page front-loads the query phrase, opens with a quotable definition
// block, links UP to the /reselling pillar and OVER to the relevant /flipdesk
// feature. HowTo + Article schema.
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD composed in
// src/pages/marketing/marketing-jsonld.ts. Paths are explicit (varying depth),
// so these are registered directly — not via a single dynamic slug route.

import type { PublicRoute } from "./public-routes";

export interface OpportunistStep {
  name: string;
  text: string;
}

export interface OpportunistSection {
  heading: string;
  body: string;
}

export interface OpportunistGuide {
  /** Absolute path, no trailing slash. */
  path: string;
  /** <title> without the " | GradeThread" suffix — ≤ 46, unique, query front-loaded. */
  title: string;
  /** Meta description — 70–160, unique. */
  description: string;
  h1: string;
  /** The quotable one-paragraph definition block (AI-citable answer). */
  definition: string;
  /** Self-contained intro after the definition (~40–55 words). */
  intro: string;
  /** HowTo steps (rendered as an ordered list + HowTo schema). */
  steps: OpportunistStep[];
  sections: OpportunistSection[];
  /** The FlipDesk feature this page routes to, with anchor copy. */
  flipdeskCta: { label: string; href: string; blurb: string };
  faqs: Array<{ q: string; a: string }>;
}

export const OPPORTUNIST_GUIDES: OpportunistGuide[] = [
  {
    path: "/reselling/ebay-item-specifics",
    title: "eBay Item Specifics: the Reseller's Guide",
    description:
      "What eBay item specifics are, which are required vs recommended, and how they drive Cassini search visibility — plus how to fill them without the tedium.",
    h1: "eBay item specifics: what they are and why they rank",
    definition:
      "eBay item specifics are the structured attribute fields on a listing — brand, size, color, material, style, department, and dozens more — that describe an item in a format eBay's Cassini search engine and buyer filters can read. Filling them accurately and completely is one of the highest-leverage, lowest-effort things a reseller can do to get found.",
    intro:
      "Most sellers treat item specifics as a chore and leave half of them blank. That's a mistake: they're a primary Cassini ranking and filtering signal. This guide covers what specifics do, which ones eBay requires versus recommends, and how to fill them at volume without losing hours.",
    steps: [
      {
        name: "Fill every required specific first",
        text: "eBay blocks or suppresses listings missing required specifics for a category. Start there — brand, size type, size, color, and department for apparel are almost always required.",
      },
      {
        name: "Add the recommended specifics that buyers filter on",
        text: "Material, style, sleeve length, fit, occasion, and pattern are the fields buyers narrow searches by. Each one you fill is another filtered search your listing can appear in.",
      },
      {
        name: "Match eBay's exact accepted values",
        text: "Use the values from eBay's dropdowns, not free text — 'Crewneck', not 'crew neck sweater'. Off-spec values don't match filters and can trip category requirements.",
      },
      {
        name: "Never overstate — including condition",
        text: "Specifics are a promise. An inflated material or an overstated condition is exactly what a 'not as described' return is built on. Describe what the garment actually is.",
      },
    ],
    sections: [
      {
        heading: "How item specifics drive Cassini search",
        body: "Cassini, eBay's search engine, ranks on relevance and on how completely a listing is described. Structured specifics let Cassini match a listing to a query and to a buyer's filter selections at once — a shopper who filters to Brand: Patagonia, Size: M, Color: Blue only sees listings whose specifics say so. Blank fields make your item invisible to those filtered searches no matter how good the title is.",
      },
      {
        heading: "Required vs recommended specifics",
        body: "Required specifics must be present for eBay to fully publish and surface a listing in a category; leaving them blank suppresses visibility or blocks the listing. Recommended specifics are optional but each one opens another filtered search path and improves ranking. The practical rule: fill all required, then fill every recommended one you can answer honestly.",
      },
      {
        heading: "Filling specifics at volume without the tedium",
        body: "The reason specifics go unfilled is time — dozens of fields per listing across a large inventory. GradeThread's AutoLister reads your item photos and details, proposes the category's required and recommended specifics with eBay-accepted values, and lets you confirm in one pass instead of typing each field. Accurate condition rides alongside, so the listing is both complete and honest.",
      },
    ],
    flipdeskCta: {
      label: "See how AutoLister fills item specifics",
      href: "/flipdesk",
      blurb:
        "AutoLister proposes required and recommended item specifics with eBay-accepted values from your photos, so you confirm instead of type.",
    },
    faqs: [
      {
        q: "What are eBay item specifics?",
        a: "Item specifics are the structured attribute fields on an eBay listing — brand, size, color, material, style, and more — that describe an item in a format eBay's Cassini search and buyer filters can read. Complete, accurate specifics are one of the strongest visibility signals a listing has.",
      },
      {
        q: "Do item specifics affect eBay search ranking?",
        a: "Yes. eBay's Cassini engine uses specifics to match listings to queries and to buyer filter selections, and rewards completely described listings. A listing missing specifics won't appear in the filtered searches that use them, regardless of its title.",
      },
      {
        q: "Which eBay item specifics are required?",
        a: "It varies by category, but for apparel the commonly required specifics are brand, size type, size, color, and department. eBay flags required specifics in the listing form and will suppress or block a listing that omits them.",
      },
    ],
  },
  {
    path: "/reselling/comps/ebay-sold-comps",
    title: "How to Read eBay Sold Comps",
    description:
      "How to read eBay sold comps to price used clothing: sold vs active listings, filtering by condition, and turning real sale prices into an accurate list price.",
    h1: "eBay sold comps: how to price with real sale data",
    definition:
      "eBay sold comps are the prices that comparable items actually sold for — not what sellers are asking. They're the single most reliable pricing input a reseller has, because they reflect real buyer demand. Pricing to sold comps in the same condition, rather than to hopeful active listings, is what keeps items from sitting unsold.",
    intro:
      "The most common pricing mistake is anchoring to active listings — what other sellers hope to get. Sold comps tell you what buyers actually paid. This guide covers how to pull sold comps, why sold beats active, and how to filter comps by condition so your price reflects the item you're actually selling.",
    steps: [
      {
        name: "Search sold, not active",
        text: "On eBay, filter to Sold Items. Active listings are asking prices — many never sell. Sold comps are completed transactions and are the only prices that reflect real demand.",
      },
      {
        name: "Match the item as closely as you can",
        text: "Same brand, model, size, and — critically — condition. A near-mint piece and a heavily worn one are different products with different comps, even if the title is identical.",
      },
      {
        name: "Read the distribution, not one sale",
        text: "Look at the range of recent solds and price to the middle of comparable-condition sales, adjusting for how yours differs. One outlier sale is not a price.",
      },
      {
        name: "Adjust for condition honestly",
        text: "If your item grades below the comps you're reading, price below them. If it's cleaner, you can price toward the top. The comp is only valid for the condition it describes.",
      },
    ],
    sections: [
      {
        heading: "Sold comps vs active listings",
        body: "Active listings show what sellers are asking; sold comps show what buyers paid. The gap between them is large and misleading — plenty of active listings are overpriced and will never sell, so averaging them inflates your price and leaves your item sitting. Always price from completed, sold transactions.",
      },
      {
        heading: "Why condition changes the comp",
        body: "Two listings for the same item can be genuinely different products if their condition differs. A comp for an 'excellent' piece doesn't price a 'fair' one. The problem is that condition language on comps is subjective — one seller's 'good' is another's 'like new' — which makes condition the noisiest variable in any comp set.",
      },
      {
        heading: "Turning comps into a price, automatically",
        body: "Do the sold search yourself, then let the tool handle the part that is hard to eyeball. GradeThread's comp tool pulls comparable eBay listings for an item and pairs them with a standardized condition grade, so you compare like condition to like condition instead of guessing whether a comp's 'good condition' matches yours. It also labels what you are looking at: comps read from eBay are asking prices, and once you have sold three comparable items yourself it prices from those realised sales instead.",
      },
    ],
    flipdeskCta: {
      label: "See the comp tool in FlipDesk",
      href: "/flipdesk",
      blurb:
        "FlipDesk pulls comparable eBay listings per item, prices to the median and says whether that median is an asking price or one of your own realised sales, paired with a standardized condition grade so you compare like for like.",
    },
    faqs: [
      {
        q: "What are eBay sold comps?",
        a: "Sold comps are the prices that comparable items actually sold for on eBay — completed transactions, not asking prices. They're the most reliable pricing input a reseller has because they reflect real buyer demand rather than seller hope.",
      },
      {
        q: "Why use sold listings instead of active listings to price?",
        a: "Active listings are asking prices, and many never sell — pricing to them inflates your number and leaves your item unsold. Sold comps are completed sales, so they show what a buyer will actually pay.",
      },
      {
        q: "How do I filter eBay comps by condition?",
        a: "Match comps to your item's actual condition, since a comp for an excellent piece doesn't price a worn one. Because sellers describe condition inconsistently, pairing comps with a standardized condition grade — like GradeThread's 1.0–10.0 scale — makes the comparison far more accurate.",
      },
    ],
  },
];

export function getOpportunistGuideByPath(path: string): OpportunistGuide | undefined {
  const norm = path.replace(/\/+$/, "");
  return OPPORTUNIST_GUIDES.find((g) => g.path === norm);
}

export function opportunistRoutes(): PublicRoute[] {
  return OPPORTUNIST_GUIDES.map((g) => ({
    path: g.path,
    title: g.title,
    description: g.description,
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "HowTo",
  }));
}

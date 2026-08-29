// FlipDesk conversion landing pages (US-1675 money pages + US-1676 feature pages).
//
// Five job-to-be-done landing pages under /flipdesk/* that target the
// highest-intent commercial reseller-software queries (the $20–47 CPC inventory
// terms, "ai ebay listing generator", crosslisting, sold comps, bookkeeping).
// Each renders full content in the initial HTML and emits SoftwareApplication +
// FAQPage JSON-LD. Claims are honest — every feature below maps to shipped
// FlipDesk functionality (FLIPDESK_PLANS gate flags in src/lib/constants.ts).
//
// PURE DATA: imports only the PublicRoute TYPE (relative path, Vite Node context).
// The SoftwareApplication JSON-LD (with the offers price range derived from
// FLIPDESK_PLANS) is composed in src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";

export interface FlipdeskLandingSection {
  heading: string;
  body: string;
}

export interface FlipdeskLanding {
  slug: string;
  /** Absolute path, e.g. "/flipdesk/inventory-management". */
  path: string;
  /** Primary keyword target (documentation / measurement). */
  keywordTarget: string;
  /** <title> without the " | FlipDesk" or " | GradeThread" suffix — ≤ 46, unique. */
  title: string;
  /** Meta description — 70–160 chars, unique. */
  description: string;
  h1: string;
  /** Job-to-be-done intro, self-contained + quotable (the snippet/AI unit). */
  intro: string;
  /** SoftwareApplication `name`. */
  appName: string;
  /** SoftwareApplication `description`. */
  appDescription: string;
  /** SoftwareApplication `featureList` — honest, shipped capabilities. */
  featureList: string[];
  /** On-page feature blocks. */
  sections: FlipdeskLandingSection[];
  faqs: Array<{ q: string; a: string }>;
}

const FLIPDESK_BASE = "/flipdesk";

export const FLIPDESK_LANDINGS: FlipdeskLanding[] = [
  // ── US-1675: money pages ───────────────────────────────────────────
  {
    slug: "inventory-management",
    path: `${FLIPDESK_BASE}/inventory-management`,
    keywordTarget: "clothing inventory management software",
    title: "Clothing Inventory Management Software",
    description:
      "Clothing inventory management software for resellers: track every item from sourcing to sale, with cost basis, condition grades, and payouts in one place.",
    h1: "Inventory management built for clothing resellers",
    intro:
      "FlipDesk is inventory management software built for clothing resellers. It tracks every garment from the moment you source it — cost basis, measurements, photos, condition grade, listing status, and final payout — in one workspace, so you always know what you own, what it cost, and what it's earning. It replaces the spreadsheet that falls apart at 200 items.",
    appName: "FlipDesk Inventory Management",
    appDescription:
      "Reseller inventory management software: track clothing from sourcing to sale with cost basis, measurements, condition grades, listing status, and payout reconciliation in one workspace.",
    featureList: [
      "Item pipeline from sourced → cataloged → listed → sold",
      "Cost basis and source tracking per item",
      "Measurements and guided photo capture",
      "Standardized 1.0–10.0 condition grades on inventory",
      "Table, photo-grid, and kanban views of the same data",
      "eBay listing sync and payout auto-import",
    ],
    sections: [
      {
        heading: "One record per garment, sourcing to sale",
        body: "Every item carries its cost basis, source, measurements, photos, condition grade, listing status, and realized payout. The pipeline moves it from sourced to cataloged to listed to sold, so nothing sits unlisted in a bin you forgot about (the reseller 'death pile').",
      },
      {
        heading: "See it the way you work",
        body: "The same inventory renders as a filterable table, a photo grid for visual work, or a kanban board of the pipeline — switch views without losing your filters or saved views.",
      },
      {
        heading: "Condition is a first-class field",
        body: "Grade an item on the standardized 1.0–10.0 scale and the grade — plus a verifiable certificate — travels onto the listing. Condition-aware pricing means you price against what your grade actually sells for.",
      },
    ],
    faqs: [
      {
        q: "What is the best inventory management software for clothing resellers?",
        a: "The best fit tracks the whole garment lifecycle, not just a SKU count: cost basis, measurements, photos, condition, listing status, and payout. FlipDesk does that and adds a standardized 1.0–10.0 condition grade and verifiable certificate on every item — the trust signal a generic inventory tool can't produce.",
      },
      {
        q: "Does FlipDesk replace my reselling spreadsheet?",
        a: "Yes. FlipDesk holds cost basis, source, condition, listing status, fees, and payouts per item and rolls them up automatically, so you don't hand-maintain a spreadsheet that breaks down as your inventory grows.",
      },
    ],
  },
  {
    slug: "autolister",
    path: `${FLIPDESK_BASE}/autolister`,
    keywordTarget: "ai ebay listing generator",
    title: "AI eBay Listing Generator",
    description:
      "FlipDesk AutoLister turns garment photos into complete eBay listings with AI — title, description, item specifics, condition, and price — ready to review.",
    h1: "AI eBay listing generator for clothing",
    intro:
      "FlipDesk AutoLister is an AI listing generator for clothing that works with eBay. Photograph a garment and it drafts a complete listing — a keyword-front-loaded title, a description, eBay item specifics (aspects), the condition, and a suggested price from live comps — for you to review and publish. It turns the slowest part of reselling, writing listings, into a review step.",
    appName: "FlipDesk AutoLister",
    appDescription:
      "AI listing generator for clothing resellers: turns garment photos into complete eBay listings — title, description, item specifics, condition, and comp-based price — ready to review and publish.",
    featureList: [
      "AI-drafted eBay title, description, and item specifics from photos",
      "Style/product identification from tag photos (RN, style code, UPC)",
      "Condition grade and certificate folded into the listing",
      "Comp-based price suggestion",
      "Bulk intake and batch generation",
      "Review-before-publish (AI drafts, you approve)",
    ],
    sections: [
      {
        heading: "Photos in, a full draft out",
        body: "AutoLister reads the garment photos, identifies the brand and style (including from the care/tag photo), and writes a front-loaded title, a description, and the eBay item specifics buyers filter on — the fields eBay keeps adding and requiring.",
      },
      {
        heading: "Priced from comps, and told which kind",
        body: "Each draft comes with a suggested price drawn from comparable eBay listings, kept condition-aware so an item graded Excellent is priced against comparable Excellent items rather than a blind average. Those are live asking prices, and the draft says so. Once you have sold three comparable items yourself, it prices from your own realised sales instead and tells you it switched.",
      },
      {
        heading: "You stay in control",
        body: "AutoLister drafts; you review and edit the title, description, condition, specifics, and price before anything publishes. AI can make mistakes, so nothing goes live without your approval.",
      },
    ],
    faqs: [
      {
        q: "Is there an AI tool that writes eBay listings from photos?",
        a: "Yes. FlipDesk AutoLister works with eBay and generates a complete listing from garment photos — title, description, item specifics, condition, and a comp-based price — which you review and edit before publishing. It also identifies the brand and style from the tag photo so titles are specific, not generic.",
      },
      {
        q: "Does the AI listing generator handle eBay item specifics?",
        a: "Yes. AutoLister fills the eBay item specifics (aspects) buyers filter on — brand, size, color, material, style — which is exactly the tedious, algorithm-driven part eBay keeps expanding. You confirm them before publishing.",
      },
    ],
  },
  // ── US-1676: feature pages ─────────────────────────────────────────
  {
    slug: "crosslisting",
    path: `${FLIPDESK_BASE}/crosslisting`,
    keywordTarget: "clothing crosslisting software",
    title: "Clothing Crosslisting Software",
    description:
      "Crosslist clothing from one catalog to eBay, Shopify, Poshmark, Mercari, and Grailed — with a verifiable condition grade in every listing to cut returns.",
    h1: "Crosslist clothing from one catalog",
    intro:
      "FlipDesk is crosslisting software for clothing resellers: build a listing once and publish it to eBay and Shopify via live API, and to Poshmark, Mercari, and Grailed through the GradeThread Lister browser extension. Unlike a plain crosslister, every FlipDesk listing can carry a standardized condition grade and a verifiable certificate — the trust signal that cuts 'not as described' returns.",
    appName: "FlipDesk Crosslisting",
    appDescription:
      "Crosslisting software for clothing resellers: list once and publish to eBay, Shopify, Poshmark, Mercari, and Grailed, each with a verifiable condition grade to reduce returns.",
    featureList: [
      "List once, publish to eBay + Shopify via live API",
      "Cross-list to Poshmark, Mercari & Grailed via the GradeThread Lister extension",
      "One catalog as the source of truth across marketplaces",
      "Verifiable 1.0–10.0 condition grade in every listing",
      "Condition-aware pricing from live comps and your own past sales",
    ],
    sections: [
      {
        heading: "One catalog, every marketplace",
        body: "Build the listing once in FlipDesk. It publishes to eBay and Shopify over their live APIs and to Poshmark, Mercari, and Grailed through the GradeThread Lister extension, so your catalog stays the single source of truth instead of five diverging copies.",
      },
      {
        heading: "The differentiator a crosslister can't copy",
        body: "A standardized 1.0–10.0 condition grade and a public certificate ride along in every listing. Buyers can verify the condition, which builds trust and reduces the 'not as described' returns that eat reseller margin.",
      },
      {
        heading: "Where this differs from Vendoo and List Perfectly",
        body: "Vendoo and List Perfectly are crosslisters, and both cover more marketplaces than FlipDesk does. If breadth of marketplace coverage is what you are buying, they are the better tools and this page is not going to argue otherwise. What neither produces is evidence about condition. They move your description from one site to another; the buyer still has only your word for what 'excellent' means. FlipDesk grades the garment from photographs on a published 1.0–10.0 scale and attaches a certificate the buyer can check, which is the input that decides whether a not-as-described case goes your way. Pick on that axis, not on the crosslisting itself.",
      },
    ],
    faqs: [
      {
        q: "What is the best crosslisting app for clothing?",
        a: "The best crosslister keeps one catalog as the source of truth and pushes it to every marketplace you sell on. FlipDesk does that for eBay, Shopify, Poshmark, Mercari, and Grailed — and uniquely adds a verifiable condition grade to each listing, which a standalone crosslister can't produce.",
      },
      {
        q: "Which marketplaces can FlipDesk crosslist to?",
        a: "eBay and Shopify via their live APIs, and Poshmark, Mercari, and Grailed through the GradeThread Lister browser extension. The condition grade and certificate travel with the item wherever you list it.",
      },
    ],
  },
  {
    slug: "comps",
    path: `${FLIPDESK_BASE}/comps`,
    keywordTarget: "ebay comps tool",
    title: "eBay Comps Tool for Clothing Resellers",
    description:
      "FlipDesk pulls comparable eBay listings per item, keeps them condition-aware, and says whether the number is an asking price or one of your own realised sales.",
    h1: "Comps by condition, labelled by where they came from",
    intro:
      "FlipDesk pulls comparable eBay listings for your item and keeps them condition-aware. Instead of averaging a blur of mint and worn listings, it prices an Excellent (8) piece against comparable Excellent ones. It also tells you what kind of number you are looking at, which most tools do not: comps from eBay are what sellers are ASKING today, and they read high. Once you have sold three comparable items yourself, FlipDesk prices from those realised sales instead and says it has switched.",
    appName: "FlipDesk Comps",
    appDescription:
      "Comp pricing tool for clothing resellers: pulls comparable eBay listings, filters them by condition, and labels each number as a live asking price or one of the seller's own realised sales.",
    featureList: [
      "Pulls comparable eBay listings per item",
      "Labels every number as an asking price or a realised sale",
      "Condition-aware comps (price by grade, not a blind average)",
      "Relevance-ranked comp queries (brand, size, stopword trimming)",
      "Zero-result fallback ladder (progressive broadening)",
      "Feeds AutoLister's price suggestion",
    ],
    sections: [
      {
        heading: "Comps that respect condition",
        body: "A comp average that mixes mint and beat-up items tells you nothing. FlipDesk keeps comps condition-aware, so the number you price to reflects your item's actual grade on the 1.0–10.0 scale.",
      },
      {
        heading: "Smart queries, real results",
        body: "The comp builder ranks by relevance, trims stopwords and sizes that pollute results, and — when a query returns nothing — broadens progressively so you still get a signal instead of an empty screen.",
      },
    ],
    faqs: [
      {
        q: "How do I find eBay comps for used clothing?",
        a: "Search eBay for comparable items and filter by condition, because an average that mixes mint and worn items misleads. Tick Sold items while you are there: active listings are asking prices and many never sell. FlipDesk pulls the comparable listings for you and keeps them condition-aware, and tells you whether the number in front of you is an asking price or one of your own realised sales.",
      },
      {
        q: "Why do condition-aware comps matter?",
        a: "Condition is one of the biggest levers on resale price. Pricing to a blind sold-comp average leaves money on the table for a high-grade item and overprices a low-grade one. Condition-aware comps price each item to its grade.",
      },
    ],
  },
  {
    slug: "bookkeeping",
    path: `${FLIPDESK_BASE}/bookkeeping`,
    keywordTarget: "reseller bookkeeping profit tracker",
    title: "Reseller Bookkeeping & Profit Tracker",
    description:
      "A reseller profit tracker and bookkeeping tool: auto-import payouts, reconcile fees and shipping per sale, track expenses, and see true profit per item.",
    h1: "Know your real profit on every sale",
    intro:
      "FlipDesk is a bookkeeping and profit-tracking tool for clothing resellers. It auto-imports your marketplace payouts, reconciles each sale's fees and shipping against the item's cost basis, tracks business expenses, and shows your true profit per item and per month — so your numbers are ready at tax time instead of reconstructed from a shoebox.",
    appName: "FlipDesk Bookkeeping",
    appDescription:
      "Bookkeeping and profit-tracking software for clothing resellers: auto-imports payouts, reconciles fees and shipping per sale against cost basis, tracks expenses, and reports true profit.",
    featureList: [
      "Auto-import marketplace payouts",
      "Per-sale reconciliation of fees, shipping, and cost basis",
      "True net profit per item and per month",
      "Business expense tracking",
      "Tax-ready profit & loss export",
    ],
    sections: [
      {
        heading: "Payouts reconciled automatically",
        body: "FlipDesk imports your payouts and matches each one to the sale, subtracting marketplace fees, shipping, and the item's cost basis — so 'sold for $80' becomes the real net profit, not a headline number.",
      },
      {
        heading: "Ready for tax time",
        body: "Track expenses alongside sales and export a profit-and-loss summary, so your reseller bookkeeping is done as you go instead of reconstructed in April.",
      },
    ],
    faqs: [
      {
        q: "Is there bookkeeping software for clothing resellers?",
        a: "Yes. FlipDesk auto-imports marketplace payouts, reconciles each sale's fees and shipping against the item's cost basis, tracks expenses, and reports true net profit per item and per month — reseller-specific bookkeeping, not a generic accounting app you have to bend to fit.",
      },
      {
        q: "How does FlipDesk calculate profit per item?",
        a: "For each sale it starts from the payout, subtracts marketplace fees and shipping, and subtracts the item's recorded cost basis, leaving the true net profit. Those roll up into monthly totals and a tax-ready P&L export.",
      },
    ],
  },
];

// Path-keyed only. There was a slug index and a getFlipdeskLandingBySlug beside
// it; routing is path-keyed everywhere, so neither ever found a caller and
// US-2436 removed both.
const LANDING_BY_PATH = new Map(FLIPDESK_LANDINGS.map((l) => [l.path, l]));

export function getFlipdeskLandingByPath(path: string): FlipdeskLanding | undefined {
  return LANDING_BY_PATH.get(path);
}

/** PublicRoute entries for the five FlipDesk landing pages. */
export function flipdeskLandingRoutes(): PublicRoute[] {
  return FLIPDESK_LANDINGS.map((l) => ({
    path: l.path,
    title: l.title,
    description: l.description,
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "SoftwareApplication",
  }));
}

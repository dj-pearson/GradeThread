// Reselling pillar + TOFU guides (US-1688).
//
// A workflow pillar at /reselling/ ("How to Resell Clothes: Source → Ship") plus
// beginner guides (/reselling/<slug>): sourcing, death-pile, best-brands,
// bolo-list, how-to-sell-used-clothes-online, thrift-store-reselling. Captures
// top-of-funnel volume with a GRADING STEP woven into every guide (the wedge),
// linked to the returns spine (/reduce-returns) and /grading/. Timed to be
// indexed and aged before the November→spring demand waves.
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD (HowTo for the pillar,
// Article for the guides) is composed in src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";

export const RESELLING_PILLAR_PATH = "/reselling";

export interface ResellingSection {
  heading: string;
  body: string;
}

export interface ResellingGuide {
  slug: string;
  /** <title> without the " | GradeThread" suffix — ≤ 46, unique. */
  title: string;
  /** Meta description — 70–160, unique. */
  description: string;
  h1: string;
  /** Self-contained intro (~45–60 words). */
  intro: string;
  sections: ResellingSection[];
  /** The grading wedge — where a condition grade fits in THIS guide's workflow. */
  gradingWedge: string;
  faqs: Array<{ q: string; a: string }>;
}

export function resellingGuidePath(slug: string): string {
  return `${RESELLING_PILLAR_PATH}/${slug}`;
}

// ── The pillar (workflow overview) ──────────────────────────────────
export interface ResellingWorkflowStep {
  name: string;
  text: string;
  /** Optional guide this step links to. */
  guideSlug?: string;
}

export const RESELLING_PILLAR = {
  path: RESELLING_PILLAR_PATH,
  title: "How to Resell Clothes: the Full Workflow",
  description:
    "How to resell clothes, source to ship: sourcing, pricing to comps, grading condition, listing, and shipping — the full reseller workflow for beginners.",
  h1: "How to resell clothes: the full workflow",
  intro:
    "Reselling clothes is a repeatable workflow: source inventory, catalog and grade it, price it to real comps, list it, sell, and ship. This guide walks the whole loop from source to ship — and shows where a standardized condition grade turns 'used, good condition' into buyer trust that sells faster and comes back less.",
  steps: [
    {
      name: "Source inventory",
      text: "Find items worth reselling — thrift stores, bins, estate sales, your own closet. Buy on sell-through and margin, not just cheap price.",
      guideSlug: "sourcing",
    },
    {
      name: "Catalog and grade condition",
      text: "Photograph, measure, and grade each item's condition on a standardized 1.0–10.0 scale so buyers trust the listing and you price accurately.",
    },
    {
      name: "Price to sold comps",
      text: "Look up what comparable items in the same condition actually sold for, and price to that — not to a hopeful number.",
    },
    {
      name: "List across marketplaces",
      text: "Write a keyword-front-loaded title, fill the item specifics, and cross-list to eBay, Poshmark, Mercari, and Depop.",
      guideSlug: "how-to-sell-used-clothes-online",
    },
    {
      name: "Sell and ship",
      text: "Ship fast and accurately. Accurate condition up front is what keeps 'not as described' returns from eating your margin.",
    },
  ] as ResellingWorkflowStep[],
  faqs: [
    {
      q: "How do beginners start reselling clothes?",
      a: "Start with what you can source cheaply and know well, then run the loop: source, catalog and grade condition, price to sold comps, list, and ship. The fastest wins come from accurate condition (fewer returns) and pricing to real comps (fewer dead listings), not from listing volume alone.",
    },
    {
      q: "What's the most overlooked step in reselling clothes?",
      a: "Condition. Most beginners write 'good used condition' and hope. A standardized condition grade and a verifiable certificate set accurate expectations, which is the single biggest lever on returns and on how fast an item sells.",
    },
  ],
};

// ── The guides ──────────────────────────────────────────────────────
export const RESELLING_GUIDES: ResellingGuide[] = [
  {
    slug: "sourcing",
    title: "How to Source Clothes to Resell",
    description:
      "Where and how to source clothes to resell: thrift stores, bins, estate sales, and outlets — how to buy on sell-through and margin, not just low price.",
    h1: "How to source clothes to resell",
    intro:
      "Sourcing is where reselling profit is really made or lost. The goal isn't the cheapest item — it's the item that sells through quickly at a healthy margin. That means buying brands and categories with real demand, in condition good enough to grade well, at a cost basis that leaves room after fees and shipping.",
    sections: [
      {
        heading: "Where to source",
        body: "Thrift stores and charity shops, thrift bins (sold by the pound), estate and garage sales, outlet clearance, and your own closet. Each has a different effort-to-margin trade-off; bins are cheap but slow to sort, estate sales can hide grails.",
      },
      {
        heading: "What to buy",
        body: "Buy on sell-through and margin. Favor brands with proven resale demand and categories that photograph and ship well. Skip fast-fashion unless it's near-new — the grade and the price both come out too low to bother.",
      },
    ],
    gradingWedge:
      "Inspect condition at the point of sourcing, not after you get home. A quick condition check — flaws, structure, odor — tells you whether an item will grade high enough to be worth the cost basis. Grade it properly once cataloged so the listing carries a verifiable condition, and see how condition drives resale value on the grade scale.",
    faqs: [
      {
        q: "What clothes are worth reselling?",
        a: "Items with real resale demand in good enough condition to grade well: known brands, categories that ship easily, and pieces without deal-breaking flaws. A great brand in Poor condition often isn't worth the fees; a solid brand in Excellent condition usually is.",
      },
    ],
  },
  {
    slug: "death-pile",
    title: "How to Clear a Reseller Death Pile",
    description:
      "A reseller death pile is sourced inventory you haven't listed yet. Why it grows and a step-by-step system to clear it and turn dead stock into sales.",
    h1: "How to clear your death pile",
    intro:
      "A death pile is the backlog of items you've sourced but never listed — capital sitting in bins instead of earning. It grows because sourcing is fast and fun while listing is slow and repetitive. Clearing it is mostly about turning listing into a batched, gradeable assembly line instead of a dreaded chore.",
    sections: [
      {
        heading: "Why it grows",
        body: "Sourcing outpaces listing. Every un-listed item is money you already spent that isn't working. The pile also hides your real numbers — you can't know your margin on inventory you never listed.",
      },
      {
        heading: "A system to clear it",
        body: "Batch the workflow: photograph a stack, measure a stack, grade a stack, then draft a stack. Standardizing condition up front (a quick grade) removes the 'how do I describe this?' hesitation that stalls listing.",
      },
    ],
    gradingWedge:
      "Grading is one of the steps that gates the death pile. When condition is a standardized 1.0–10.0 grade instead of a paragraph you have to agonize over, cataloging and pricing speed up — items move from pile to listed faster. Batch-grade as part of your assembly line and let the condition carry into every listing.",
    faqs: [
      {
        q: "How do I get through my reseller death pile?",
        a: "Batch it: photograph, measure, grade, and draft in stacks rather than one item end-to-end. Standardizing condition with a quick grade removes the biggest listing hesitation. Track what's listed vs. sourced so the pile can't silently grow again.",
      },
    ],
  },
  {
    slug: "best-brands-to-resell",
    title: "Best Clothing Brands to Resell",
    description:
      "The types of clothing brands that resell best — and how to judge any brand by demand, sell-through, and how well condition holds its value.",
    h1: "The best clothing brands to resell",
    intro:
      "The 'best' brands to resell aren't a fixed list — they're the ones with steady demand, strong sell-through, and resale value that holds up when condition is good. Rather than chase a leaderboard that shifts every season, learn to judge any brand by the same signals, so your sourcing improves everywhere you buy.",
    sections: [
      {
        heading: "How to judge a brand",
        body: "Look at demand (are people searching for it?), sell-through (do listings actually sell, and how fast?), and price durability (does resale value hold, or crater?). Denim, outerwear, activewear, and quality natural-fiber knits tend to travel well; trend-driven fast fashion usually doesn't.",
      },
      {
        heading: "Condition matters more for premium brands",
        body: "The better the brand, the more condition swings the price. A premium jacket in Excellent condition commands a real premium; the same jacket with an undisclosed flaw gets returned. Higher-value brands are exactly where a verified grade pays for itself.",
      },
    ],
    gradingWedge:
      "For the brands worth reselling, condition is the biggest lever on price. Grade your higher-value, brand-name pieces on the 1.0–10.0 scale and attach a certificate — a proven Excellent grade justifies the premium those brands can command, and reduces the disputes that hit valuable items hardest.",
    faqs: [
      {
        q: "What clothing brands sell best for resale?",
        a: "The ones with steady demand, fast sell-through, and durable resale value — often denim, outerwear, activewear, and quality natural-fiber knits, rather than trend fast-fashion. Judge any brand by demand, sell-through, and how well its price holds in good condition.",
      },
    ],
  },
  {
    slug: "bolo-list",
    title: "How to Build a Reseller BOLO List",
    description:
      "A BOLO (Be On the LookOut) list is the brands and items a reseller hunts while sourcing. How to build and maintain one that actually improves your buys.",
    h1: "How to build a BOLO list",
    intro:
      "BOLO stands for Be On the LookOut — the running list of brands and items a reseller watches for while sourcing. A good BOLO list turns a chaotic thrift run into a targeted hunt: you recognize a profitable item in seconds instead of second-guessing every tag. The trick is building it from your own sold data, not someone else's hype.",
    sections: [
      {
        heading: "Build it from your data",
        body: "Start with what has actually sold well for you: brands, categories, and price points with proven sell-through. Add community BOLOs cautiously — a brand everyone lists is a brand with more competition and thinner margins.",
      },
      {
        heading: "Keep it current",
        body: "Demand shifts. Prune BOLOs that stopped selling, add ones that started. A stale BOLO list has you chasing last year's brands at this year's fees.",
      },
    ],
    gradingWedge:
      "A BOLO gets you to the right item; condition decides whether it's worth buying. Pair your BOLO with a fast condition check at the rack — a target brand in Poor condition often isn't a buy. Grade the keepers so the resale listing carries verifiable condition, and let the grade-vs-value data sharpen which BOLOs actually pay.",
    faqs: [
      {
        q: "What does BOLO mean in reselling?",
        a: "BOLO stands for Be On the LookOut — the list of brands and items a reseller actively hunts for while sourcing. The best BOLO lists are built from your own sold-through data rather than copied from hype, so they match what actually sells for you.",
      },
    ],
  },
  {
    slug: "how-to-sell-used-clothes-online",
    title: "How to Sell Used Clothes Online",
    description:
      "How to sell used clothes online: choose a marketplace, write a listing that ranks, price to comps, and use condition to cut returns and sell faster.",
    h1: "How to sell used clothes online",
    intro:
      "Selling used clothes online comes down to four things you control: which marketplace, how well the listing is written, how it's priced, and how clearly condition is disclosed. Get those right and items sell faster with fewer returns — the two numbers that actually decide whether reselling is worth your time.",
    sections: [
      {
        heading: "Pick the marketplace and write the listing",
        body: "eBay, Poshmark, Mercari, and Depop each suit different items and buyers. Wherever you list, front-load the title with the brand and item, fill the item specifics buyers filter on, and shoot clean, well-lit photos on a plain background.",
      },
      {
        heading: "Price to real comps",
        body: "Price to what comparable items in the same condition actually sold for, not to a hopeful number or a blind average of mint and worn listings. Condition-aware comps are how you avoid both underpricing and pricing yourself unsold.",
      },
    ],
    gradingWedge:
      "Condition is the buyer's biggest question and the top reason used clothes come back. Instead of 'good used condition', give a standardized 1.0–10.0 grade and a verifiable certificate the buyer can check before they pay. It sets accurate expectations up front — the single most effective way to reduce 'not as described' returns.",
    faqs: [
      {
        q: "Where is the best place to sell used clothes online?",
        a: "It depends on the item: eBay for breadth and hard-to-find pieces, Poshmark and Depop for fashion and community, Mercari for quick everyday sales. Cross-listing widens reach. Whatever you pick, accurate condition and comp-based pricing matter more than the platform.",
      },
      {
        q: "How do I stop getting returns on used clothes?",
        a: "Most returns are 'not as described', and condition is the usual gap. Disclose condition precisely — a standardized grade with photos and real measurements — so buyers know exactly what they're getting before they pay. See the returns playbook for the full method.",
      },
    ],
  },
  {
    slug: "thrift-store-reselling",
    title: "Thrift Store Reselling for Beginners",
    description:
      "Thrift store reselling for beginners: how to source profitably at thrift stores, spot resaleable items fast, and turn thrift finds into online sales.",
    h1: "Thrift store reselling for beginners",
    intro:
      "Thrift store reselling is buying secondhand clothing cheaply and reselling it online for a margin. The skill isn't finding a store — it's scanning racks efficiently, recognizing demand and condition in seconds, and buying only what clears a real profit after fees and shipping. Done well, a single sourcing run stocks weeks of listings.",
    sections: [
      {
        heading: "Scan racks efficiently",
        body: "Work by feel and fiber first — quality fabrics and construction stand out by touch. Then check the tag for brand and the garment for deal-breaking flaws. Speed comes from knowing your BOLOs and skipping fast-fashion on sight.",
      },
      {
        heading: "Do the margin math at the rack",
        body: "Estimate the resale price in the item's actual condition, subtract fees, shipping, and your cost, and only buy if what's left is worth your time. A $4 thrift find that resells for $12 after $6 of fees isn't the win it looks like.",
      },
    ],
    gradingWedge:
      "Condition is what turns a thrift find into a trustworthy listing. Check flaws, structure, and odor at the rack, then grade the keepers on the 1.0–10.0 scale once home so the listing carries verifiable condition. A proven grade lets a thrifted piece command what its condition is actually worth — see how value tracks the grade.",
    faqs: [
      {
        q: "Is thrift store reselling still profitable?",
        a: "Yes, when you source selectively and price accurately. The margin comes from buying items with real demand in gradeable condition at a low cost basis, then setting accurate condition and comp-based prices so they sell fast with few returns — not from buying everything cheap.",
      },
    ],
  },
];

const GUIDE_BY_SLUG = new Map(RESELLING_GUIDES.map((g) => [g.slug, g]));
const GUIDE_BY_PATH = new Map(
  RESELLING_GUIDES.map((g) => [resellingGuidePath(g.slug), g]),
);

export function getResellingGuideBySlug(slug: string): ResellingGuide | undefined {
  return GUIDE_BY_SLUG.get(slug);
}
export function getResellingGuideByPath(path: string): ResellingGuide | undefined {
  return GUIDE_BY_PATH.get(path);
}
export function isResellingGuidePath(path: string): boolean {
  return GUIDE_BY_PATH.has(path);
}
export function isResellingPillarPath(path: string): boolean {
  return path === RESELLING_PILLAR_PATH;
}

/** PublicRoute entries for the pillar + every guide. */
export function resellingRoutes(): PublicRoute[] {
  const pillar: PublicRoute = {
    path: RESELLING_PILLAR.path,
    title: RESELLING_PILLAR.title,
    description: RESELLING_PILLAR.description,
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "HowTo",
  };
  const guides: PublicRoute[] = RESELLING_GUIDES.map((g) => ({
    path: resellingGuidePath(g.slug),
    title: g.title,
    description: g.description,
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "Article",
  }));
  return [pillar, ...guides];
}

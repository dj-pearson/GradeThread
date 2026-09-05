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
import type { FreshnessGroup } from "./freshness";
import { canReadCloset, destinationMechanism } from "./crosslist-pairs";

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
  /**
   * The freshness group whose re-verification date stamps this guide (US-3090).
   *
   * Set it on any guide that states a FEE, A DEADLINE OR A PAYOUT TIME — the
   * numbers a platform changes without announcing. The stamp is derived from
   * freshness.ts, so it cannot say "verified" about a date nobody re-checked,
   * and freshness.test.ts fails the build once the group is past its cadence.
   */
  freshnessGroup?: FreshnessGroup;
  /**
   * Curated onward links, rendered as a block at the foot of the guide.
   *
   * Every entry is checked against isCrossHubLinkAllowed by
   * reselling-guide-links.test.ts, so a guide cannot leak authority across hubs
   * by linking wherever it likes.
   */
  related?: Array<{ to: string; label: string }>;
}

/**
 * What the extension does on a marketplace, DERIVED from the constants.
 *
 * The listing mechanism is exactly the one the crosslist pair pages use, so a
 * guide cannot promise a run that MARKETPLACE_EXTENSION_FLOW has switched off.
 * Hand-writing this sentence is how Mercari, Grailed and Vinted spent months
 * being advertised as ready while their selectors sat disabled.
 */
export function guideMechanismSentence(platform: string, label: string): string {
  switch (destinationMechanism(platform)) {
    case "api":
      return `GradeThread publishes to ${label} over ${label}'s own API, so the listing goes live from your dashboard.`;
    case "extension":
      return `${label} has no listing API for sellers, so the GradeThread browser extension fills ${label}'s own listing form in your logged-in tab and you press post.`;
    default:
      return `${label} has no seller listing API and no verified extension flow yet, so FlipDesk holds the listing, the photos and the grade, and the last step is yours.`;
  }
}

/** Whether the extension can import a marketplace's own listings back out. */
export function guideClosetSentence(platform: string, label: string): string {
  return canReadCloset(platform)
    ? `The extension can also read your existing ${label} closet back into FlipDesk, photos and all.`
    : `${label} has no export the extension can read, so an item starts from its photos rather than from an existing ${label} listing.`;
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

  // ── Vinted, US edition (US-3090) ────────────────────────────────────
  //
  // Every fee, deadline and payout number below was read on 2026-09-05 from
  // Vinted's own pages, listed in the `vinted` freshness group. Do not edit a
  // number here without re-reading the page it came from and bumping that date;
  // the stamp on the rendered page says a human checked, and it should be true.
  //
  // The pitch is that no US seller guide covers this properly. Every Vinted term
  // in the 2026-09-02 keyword pull is Low competition at difficulty 0-3, the UK
  // sends 11 of the site's 130 clicks, and the guides that exist are written for
  // a UK seller paying a UK Buyer Protection fee on a Royal Mail label.
  {
    slug: "how-to-sell-on-vinted",
    title: "How to Sell on Vinted in the US",
    description:
      "How to sell on Vinted in the US: no seller fee, a buyer-paid $0.70 + 5% protection fee, USPS QR labels, a 5-business-day ship deadline, and when you get paid.",
    h1: "How to sell on Vinted in the US",
    intro:
      "Vinted charges sellers nothing. The buyer pays a Buyer Protection fee and the shipping, you get a prepaid USPS label, and the money lands after the buyer confirms. This guide covers the numbers, the deadlines, the condition options, and how to move listings you already have onto Vinted.",
    sections: [
      {
        heading: "What Vinted costs you: nothing",
        body:
          "Vinted's US price list sets no seller commission and no listing fee. What the buyer pays on top of your asking price is the Buyer Protection fee: a fixed $0.70 plus 5% of the item price, shipping excluded. The buyer also pays the shipping, which they see at checkout. So a $40 sweater costs the buyer $42.70 plus postage, and you keep $40. That is the whole pitch against Poshmark's 20% and Mercari's per-sale cut, and it is why Vinted works for items under about $25 that the fee-taking platforms make uneconomic. The one optional cost on your side is bumping a listing, which is priced at checkout for a 3-day or 7-day run.",
      },
      {
        heading: "Yes, Vinted works in the US",
        body:
          "Vinted runs in all 50 states, Washington D.C. and Puerto Rico on vinted.com, with USPS as the carrier. It is not a UK-only app, though most of the advice written about it is UK advice: a US listing does not use Royal Mail, does not price in pounds, and does not follow the UK fee table. Vinted also runs a US-to-UK route, so a US listing can reach a UK buyer, but the day-to-day flow you will use is domestic USPS.",
      },
      {
        heading: "The shipping flow, and the deadline that cancels orders",
        body:
          "When an item sells, Vinted issues the label. Choose the post-office option and you get a digital QR code to scan at the counter, nothing to print; choose the from-home option and you schedule a pickup and print a label. You then have 5 business days to send it. Miss that and Vinted cancels the order automatically, so a weekend away is a real risk on a Wednesday sale. You can ask the buyer for a 3 or 5 business-day extension, and they can decline. Keep the drop-off receipt until the order completes, and give tracking up to 48 hours to appear.",
      },
      {
        heading: "When you actually get paid",
        body:
          "The money sits as pending until the order completes. The buyer has 2 days from the delivery notification to press the confirmation or raise an issue; if they do nothing, the order closes on its own. Once it closes, your payment reaches your Vinted Wallet within 2 days, and you transfer from the Wallet to your bank. Budget roughly delivery plus four days before the cash is movable, which is slower than an eBay payout and faster than a Poshmark one on a buyer who sits on the confirm.",
      },
      {
        heading: "The five condition options, and which one is honest",
        body:
          "Vinted offers New, Like new, Very good, Good and Satisfactory, plus a Needs repair option that only appears on electronics. Note that its two unworn options split on packaging, not on tags: New means unopened in its original packaging, Like new means unused but opened or unpackaged, so an unworn garment without its tag is Like new rather than New. Very good is gentle wear that does not affect appearance, Good shows wear but works, Satisfactory is clear wear. Vinted's own listing advice is to photograph each flaw separately and describe it, which is also the fastest way to keep a Buyer Protection claim from starting.",
      },
      {
        heading: "Moving listings you already have onto Vinted",
        body:
          `${guideMechanismSentence("vinted", "Vinted")} ${guideClosetSentence("vinted", "Vinted")} The practical order is to catalog the item once in FlipDesk with its photos, measurements and grade, then push it to Vinted along with wherever else you sell it. One thing to plan around: GradeThread does not end a Vinted listing for you. When an item sells somewhere else it flags the Vinted copy and reminds you, and you close it by hand.`,
      },
    ],
    gradingWedge:
      "Vinted holds the buyer's money until they confirm the item, so condition is the thing standing between you and a hold that turns into a refund. Pick the Vinted option that matches the grade band, put the 1.0–10.0 grade and the certificate number in the description, and photograph every flaw. If a buyer disputes the condition later, you are arguing from a dated report rather than from memory.",
    freshnessGroup: "vinted",
    // ⚠ NO /grading/platform-standards/vinted HERE, though US-3090's AC4 asks
    // for it. isCrossHubLinkAllowed forbids it: a reselling page may only reach
    // the grading hub through the spine or the hub pillar, which is how US-1674
    // concentrates authority on /grading/scale instead of spraying it across
    // every platform page. The grading wedge below links /grading/scale, which
    // is the allowed crossover, and that page carries the Vinted mapping one
    // hop on. Adding the direct link would satisfy the criterion and break the
    // rule the criterion also asks this list to pass.
    related: [
      { to: "/compare/vinted-vs-mercari", label: "Vinted vs Mercari" },
      { to: "/compare/vinted-vs-poshmark", label: "Vinted vs Poshmark" },
      { to: "/reselling/crosslist/mercari-to-vinted", label: "Crosslist Mercari to Vinted" },
      { to: "/reselling/crosslist/vinted-to-poshmark", label: "Crosslist Vinted to Poshmark" },
    ],
    faqs: [
      {
        q: "What are the Vinted fees for sellers?",
        a: "There are none. Vinted's US price list sets no seller commission and no listing fee, so you keep your full asking price. The fee on a Vinted order is the Buyer Protection fee, which the buyer pays: a fixed $0.70 plus 5% of the item price, not counting shipping. The buyer pays the shipping too. Bumping a listing is the only thing a seller can choose to pay for, and its price is shown before you confirm.",
      },
      {
        q: "How long does a Vinted payout take?",
        a: "The buyer has 2 days from the delivery notification to confirm the order or raise an issue, and the order closes on its own if they do neither. Your payment then reaches your Vinted Wallet within 2 days, and you transfer it from the Wallet to your bank. Plan on roughly delivery plus four days before the money is movable.",
      },
      {
        q: "Is Vinted available in the US?",
        a: "Yes. Vinted operates in all 50 states, Washington D.C. and Puerto Rico through vinted.com, shipping with USPS on prepaid labels Vinted issues after a sale. There is also a US-to-UK route for international sales. Most Vinted advice online is written for UK sellers, so check that any fee or postage figure you read is the US one.",
      },
      {
        q: "What counts as satisfactory condition on Vinted?",
        a: "Vinted defines Satisfactory as a well-used item that shows clear signs of wear and imperfections but still works as intended. It is the lowest option a garment can be listed under, and it is the one buyers scrutinise hardest, so photograph each flaw on its own and say what it is. On the 1.0–10.0 grading scale that band sits around 3.0–4.5.",
      },
      {
        q: "How long do I have to ship a Vinted order?",
        a: "5 business days from the sale. Vinted cancels the order automatically if the item has not been sent by then. You can ask the buyer for a 3 or 5 business-day extension and they can accept or decline, so ask early rather than on day five.",
      },
    ],
  },

  // ── Vinted scams and disputes, seller side (US-3092) ────────────────
  //
  // `vinted scams` is 500/mo at competition index 0 with a $10.14 top-of-page
  // bid and flagged growing; `vinted dispute` is 50/mo at 0. The dispute cluster
  // is dead as a FAMILY (keyword-strategy-2026-09-02 section 2), so this is one
  // page rather than a spine, and it exists because Vinted publishes no
  // seller-side dispute documentation for the US.
  //
  // Same freshness group as the how-to guide: the 2-day windows and the
  // compensation caps are Vinted's to change.
  //
  // ⚠ ONE THING DELIBERATELY NOT SAID. A web search reported that promoting
  // off-platform selling "can result in account banning". Vinted's own community
  // standards page does not say that. It says buyer protection does not apply.
  // The page states what the page states.
  {
    slug: "vinted-scams-and-disputes",
    title: "Vinted Scams and Disputes for Sellers",
    description:
      "The scams that target Vinted sellers, how a Vinted dispute actually runs, and the evidence that settles one: the 2-day window, the photos, the drop-off receipt.",
    h1: "Vinted scams and disputes, from the seller's side",
    intro:
      "Almost everything that goes wrong for a Vinted seller happens inside one short window: the two days after delivery when the buyer can still raise a claim. This is what gets tried, how Vinted decides it, and what proof you need to already have when it starts.",
    sections: [
      {
        heading: "The three things aimed at sellers",
        body:
          "First, the move off-platform. A buyer offers to pay you directly to skip the fee. Vinted's community standards are blunt about the consequence: buying outside its secure payment system means no Buyer Protection applies, and its guidance is to keep conversations on Vinted's own message screen rather than moving to a phone number or an email. There is no held payment, no tracked label and no claim process to appeal to, so if the money never arrives you have no route back. Second, the not-as-described claim on an item that came back different: a buyer opens a claim, returns something that is not what you sent, and asks for the refund. Third, the late complaint, which is the one sellers fear most and the one Vinted answers most clearly. See the window below.",
      },
      {
        heading: "How a Vinted dispute runs",
        body:
          "The buyer has 2 calendar days from the delivery notification to report an issue. When they do, the order is suspended and your payment is held rather than released, and Vinted asks the buyer for photographs of the item and the problem, the outer and inner packaging, and any visible damage to the packaging. What happens next depends on what is claimed. On an item significantly not as described, the resolution may be a full refund without a return, or the buyer may be asked to send it back, in which case they get 5 business days to post it. On a lost or damaged parcel there is no return at all: the refund follows the shipping company confirming the loss, and that investigation can take several weeks. Vinted also states it will step in on the seller's side when a buyer's claim does not appear solid.",
      },
      {
        heading: "After 2 days the window is shut",
        body:
          "Once the order completes and the payment reaches your Vinted Wallet, Vinted states it can no longer offer a refund, compensation or a return for that order. The confirmation period is 2 days from the package being marked delivered, and after it closes the platform's answer to a complaining buyer is to talk to the seller directly. That cuts both ways. It means the open-ended chargeback fear sellers carry over from other platforms is not the Vinted shape of the problem, and it means every piece of evidence you are going to need has to exist before the parcel is delivered, because nothing you gather afterwards changes an order that has already closed.",
      },
      {
        heading: "The evidence that settles it",
        body:
          "Keep the proof of shipping until the order completes. Vinted names the copy of the label, the drop-off receipt and the email confirmation, and that receipt is the whole of your defence on a claim that the parcel never arrived. Use the Vinted-generated prepaid label rather than your own, because compensation for a lost or damaged parcel is only available on one, and sending with a different label or the wrong shipping method cancels the order automatically. The domestic caps are up to $100 per package on USPS and FedEx, up to $30 on Better Trucks and up to $15 on SpeedX; international USPS and SpeedX are up to $27. On condition, the argument is photographs taken before it left you. A dated condition record with every flaw photographed is what turns a not-as-described claim into a comparison anyone can make.",
      },
      {
        heading: "What a graded listing changes here",
        body:
          "Nothing about the dispute process, and quite a lot about the argument. A 1.0 to 10.0 grade with the flaws photographed and dated gives you something specific to point at when a buyer says the wear was worse than stated, and it is the difference between two people describing the same jacket from memory and one of them holding a record made before it shipped. It keeps you honest in the other direction too: if the flaw was real and never disclosed, the buyer has a point, and refunding fast is cheaper than losing the claim slowly.",
      },
    ],
    gradingWedge:
      "Vinted holds the money until the buyer confirms, so a condition dispute is decided on what you can show. Grade the item on the 1.0–10.0 scale before it ships, photograph every flaw, and put the grade and the certificate number in the description. When a claim opens you are quoting a dated record rather than arguing from memory, which is the only version of this conversation you can win.",
    freshnessGroup: "vinted",
    related: [
      { to: "/reselling/how-to-sell-on-vinted", label: "How to sell on Vinted in the US" },
      { to: "/compare/vinted-vs-mercari", label: "Vinted vs Mercari" },
      { to: "/reselling/crosslist/vinted-to-poshmark", label: "Crosslist Vinted to Poshmark" },
    ],
    faqs: [
      {
        q: "Is Vinted safe for sellers?",
        a: "It is, inside its own payment system. Vinted holds the buyer's payment until the order completes, issues the shipping label, and states it will step in for the seller when a buyer's refund claim does not appear solid. What it does not cover is a payment taken outside that system: its community standards say Buyer Protection does not apply to a direct bank transfer, so an off-platform sale has no held payment and no claim process behind it.",
      },
      {
        q: "What happens if a buyer opens a dispute on Vinted?",
        a: "The order is suspended and your payment is held rather than released. Vinted asks the buyer for photographs of the item and the issue, the outer and inner packaging, and any visible damage to it. Depending on the claim the outcome is a refund with no return, a return the buyer has 5 business days to post, or, for a lost or damaged parcel, a refund once the shipping company confirms the loss.",
      },
      {
        q: "How long does a Vinted dispute take?",
        a: "The buyer has 2 calendar days from the delivery notification to raise one at all. A straightforward not-as-described claim resolves inside the return window, which gives the buyer 5 business days to send the item back. A lost or damaged parcel is slower, because it waits on the shipping company's investigation, and Vinted says that can take several weeks.",
      },
      {
        q: "Can a Vinted buyer claim a refund after the order is completed?",
        a: "No. Once the order completes and the payment reaches your Vinted Wallet, Vinted states it can no longer offer a refund, compensation or a return for that order, and it tells the buyer to contact the seller directly. The confirmation period is 2 days from the package being marked delivered.",
      },
      {
        q: "What proof should a Vinted seller keep?",
        a: "The proof of shipping until the order completes: the copy of the label, the drop-off receipt or the email confirmation. Send with the Vinted-generated prepaid label rather than your own, because a lost or damaged parcel is only compensated on one, up to $100 per package on USPS and FedEx domestically. For condition, keep dated photographs of every flaw taken before the item shipped.",
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

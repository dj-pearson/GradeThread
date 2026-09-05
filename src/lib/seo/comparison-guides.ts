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
import { verifiedLabel } from "./freshness";

export const COMPARE_HUB_PATH = "/compare";

/** Freshness stamp — derived from the real re-check date (US-1694). */
export const COMPARISON_VERIFIED = verifiedLabel("comparisons");

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

// ── Per-platform facts for the templated tail (US-1685) ─────────────
// Editorially curated, quarterly re-verified (see COMPARISON_VERIFIED). Fee
// numbers shift often — the page carries the "verify current rates" stamp, and
// these are described as models rather than asserted to the cent.
interface PlatformFacts {
  name: string;
  fees: string;
  audience: string;
  categoryFit: string;
  shipping: string;
  payout: string;
  /** The returns/condition-dispute fact — feeds the unique wedge row. */
  returns: string;
  /** One clause: who this platform is for (used in intro/verdict). */
  bestFor: string;
  /**
   * US-9018 migration facts. Search Console found 13 queries of the shape
   * "mercari to grailed" earning 202 impressions and ZERO clicks, every one of
   * them landing on the /compare/ page for that pair. They are not asking which
   * is better; they are asking how to move. These three fields answer that on
   * the page that already ranks.
   */
  /** What survives the move when you relist here. */
  carriesOver: string;
  /** What does not, and cannot be rebuilt by relisting. */
  leftBehind: string;
  /** How condition has to be expressed on this platform. */
  conditionWording: string;
}

const PLATFORM_FACTS: Record<string, PlatformFacts> = {
  ebay: {
    name: "eBay",
    fees: "A 13.6% final value fee on apparel plus $0.40 per order; 12.7% with a Basic Store or above. Charged on shipping and tax as well as the price.",
    audience: "The largest, global secondhand-clothing buyer pool, with deep demand for brands, vintage, and hard-to-find sizes.",
    categoryFit: "Everything — vintage, designer, workwear, deadstock, and anything with an established sold-comp history.",
    shipping: "Full control of carrier, service, and cost; calculated shipping and combined-order discounts reward volume.",
    payout: "Managed Payments deposits on a set schedule once an order clears — predictable for cash flow.",
    returns: "Money-back-guarantee cases for 'item not as described'; eBay tends to side with buyers on condition, and repeated cases hurt your seller metrics.",
    bestFor: "volume and specialist sellers who want reach and comp depth",
    carriesOver:
      "Photos and description text, if you keep copies. eBay wants item specifics (brand, size, colour, style) that other platforms do not ask for, so expect to fill gaps rather than paste.",
    leftBehind:
      "Your feedback score, seller level and sold history all start from zero. On eBay that matters more than most: seller metrics feed Cassini, so a new account ranks below an established one on identical listings.",
    conditionWording:
      "A fixed condition dropdown, not free text. Apparel runs on a three-tier set, and the tier you pick is what a not-as-described case is judged against.",
  },
  poshmark: {
    name: "Poshmark",
    fees: "A flat fee on low-price sales and roughly a fifth of the sale price on higher-priced items.",
    audience: "A large, social US/Canada community that skews contemporary women's and men's fashion.",
    categoryFit: "Contemporary and casual clothing, accessories, and recognizable mid-market brands.",
    shipping: "A flat-rate prepaid label, usually paid by the buyer — simple but not optimizable.",
    payout: "Funds release after delivery confirmation; direct deposit lands in a few business days.",
    returns: "Posh Protect cases for 'not as described'; there are no fit or change-of-mind returns, but condition claims favor buyers.",
    bestFor: "social sellers of contemporary fashion who work the sharing and community engine",
    carriesOver:
      "Photos and copy. Poshmark's listing form is light, so a listing from anywhere else transfers with little rework.",
    leftBehind:
      "Followers, shares and your closet's social history, which is the engine Poshmark rewards. Rebuilding that is the real cost of arriving, not the relisting.",
    conditionWording:
      "A short condition dropdown plus free text. Most sellers carry the detail in the description, which means a Posh Protect case turns on what you wrote.",
  },
  mercari: {
    name: "Mercari",
    fees: "A flat selling fee around 10% plus payment processing; the fee model shifts often, so verify before you price.",
    audience: "A smaller, US-focused, mobile-first buyer base that skews casual.",
    categoryFit: "Everyday casualwear, streetwear, and mid-market brands sold quickly.",
    shipping: "A prepaid label or flat-rate options; less control than eBay.",
    payout: "Funds release after delivery confirmation; direct deposit in a few business days.",
    returns: "A buyer can return within the rating window if an item is not as described; condition claims favor buyers.",
    bestFor: "fast turnover of mid-priced everyday clothing with low friction",
    carriesOver:
      "Photos and description. Mercari's form is the lightest of the group, so this is the easiest destination to relist into.",
    leftBehind:
      "Ratings and sold history. Mercari surfaces seller ratings prominently, so an empty profile sells slower at the same price.",
    conditionWording:
      "A five-step condition dropdown, from new to poor, plus free text. The dropdown is what a buyer filters on.",
  },
  depop: {
    name: "Depop",
    // CORRECTED 2026-09-04. This said "a selling fee around 10% plus payment
    // processing", which has been wrong in the US since July 2024: Depop
    // removed the 10% seller commission and moved the marketplace fee to the
    // buyer's side of checkout. It was telling US sellers they pay a fee they
    // do not, on every Depop comparison, which is the same class of error the
    // quarterly re-verify exists to catch and is why the row is dated.
    fees:
      "No US seller commission since July 2024 — payment processing only " +
      "(about 3.3% + $0.45). Buyers pay a marketplace fee at checkout instead.",
    audience: "A young, style-driven, global Gen-Z audience.",
    categoryFit: "Streetwear, vintage, y2k, and indie or thrifted styles.",
    shipping: "Seller-arranged or a platform label; photo-first listings.",
    payout: "Paid to your linked payment account after the sale clears.",
    returns: "Buyer Protection claims for not-as-described items; photo-led disputes favor buyers.",
    bestFor: "trend and vintage sellers reaching a young, style-led audience",
    carriesOver:
      "Photos, which Depop leans on harder than anywhere else. Copy usually needs rewriting: what reads as thorough on eBay reads as corporate here.",
    leftBehind:
      "Followers and likes, which drive Depop's feed. A listing with no social signal behind it is close to invisible.",
    conditionWording:
      "A condition dropdown from brand new to used-fair, plus free text and hashtags. Buyers read the photos first and the words second, so flaws have to be shown, not only described.",
  },
  grailed: {
    name: "Grailed",
    fees: "A commission around 9% plus payment processing.",
    audience: "A discerning, higher-spend menswear and designer audience.",
    categoryFit: "Designer, streetwear, archive, and elevated menswear.",
    shipping: "Seller-arranged, backed by Buyer Protection.",
    payout: "Released after the buyer-protection window closes.",
    returns: "Buyer Protection disputes for not-as-described items; condition scrutiny is high on designer pieces.",
    bestFor: "designer and menswear sellers with higher-value, condition-scrutinized pieces",
    carriesOver:
      "Photos and description, but Grailed asks for designer, category and precise measurements that other platforms treat as optional. Expect to add data, not paste it.",
    leftBehind:
      "Your seller history and any transaction feedback. On higher-value designer pieces buyers check that record before they buy, so it costs more here than elsewhere.",
    conditionWording:
      "A condition scale from new to very worn, and buyers hold it to a stricter standard than any other platform on this list because the items are worth more.",
  },
  vinted: {
    name: "Vinted",
    // The figure, not just the shape. US-3091: three Vinted comparisons said
    // "no seller fee" without ever naming what the buyer pays, which is the
    // number a seller is actually comparing against Poshmark's 20% or eBay's
    // 13.6%. Vinted's own help page says "usually 5% + $0.70" and the "usually"
    // is theirs — it varies by order — so it is carried rather than rounded off
    // into a certainty the source does not claim.
    fees:
      "No seller selling fee. Buyers pay a Buyer Protection fee instead, " +
      "usually 5% + $0.70 of the item price, excluding shipping and tax.",
    audience: "A large European-rooted and growing-US casual audience.",
    categoryFit: "Everyday casualwear, kids' clothing, and mid-market brands.",
    shipping: "Integrated prepaid labels chosen at checkout.",
    payout: "Held until the buyer accepts the order, then paid to your Vinted balance.",
    returns: "Buyer Protection claims for not-as-described items; funds stay held until the buyer accepts.",
    bestFor: "no-seller-fee casual selling to a value-focused audience",
    carriesOver:
      "Photos and copy. Vinted's form is simple, and there is no seller fee, so the cost of relisting is your time only.",
    leftBehind:
      "Ratings and any following. Vinted's search leans on freshness, so a new seller is not penalised the way an eBay one is.",
    conditionWording:
      "A five-step condition dropdown from new with tags to satisfactory, plus free text. The dropdown is a filter, so the wrong pick hides the item.",
  },
  whatnot: {
    name: "Whatnot",
    fees: "A commission around 8% plus payment processing on live sales.",
    audience: "A live-shopping, community-driven buyer base that commits in seconds.",
    categoryFit: "Streetwear, thrift hauls, and curated live drops.",
    shipping: "A platform-provided label.",
    payout: "Released after the order clears.",
    returns: "Returns for not-as-described items; live sales move fast, so the on-stream condition call is what sets expectations.",
    bestFor: "live sellers who move volume through streamed drops",
    carriesOver:
      "Almost nothing, and this is the one move that is not a relist. Whatnot is live selling: the item goes into a stream, not a listing page, so photos and copy become a script and a camera angle.",
    leftBehind:
      "Everything reputational, plus the format itself. There is no static listing to carry over and no browse traffic to inherit.",
    conditionWording:
      "Spoken, on stream, in real time. The condition call you make out loud is what sets the expectation, and it is the hardest one to evidence afterwards.",
  },
};

/**
 * Build a templated comparison from two platforms' facts (US-1685). Every page
 * carries the unique returns/condition-dispute wedge row. `overrides` lets a
 * hand-written flagship (poshmark-vs-mercari, depop-vs-poshmark) supply editorial
 * intro/verdict copy while reusing the derived table + FAQ.
 *
 * US-9017: `title`/`description` are overridable too. The default
 * "X vs Y for Resellers (2026)" pattern ranks — four of these pairs sit at
 * position 8.5 — and does not get clicked, because it promises the same thing
 * as the nine results above it. A pair that earns real impressions gets a title
 * naming the ANSWER instead of the matchup. Pairs with no measured traffic keep
 * the template; there is nothing to learn from rewriting those yet.
 */
/** Lowercase the first letter so a sentence-shaped fact can be spliced mid-clause. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function templatedComparison(
  aSlug: string,
  bSlug: string,
  overrides?: Partial<Pick<Comparison, "intro" | "verdict" | "h1" | "title" | "description">>,
): Comparison {
  const a = PLATFORM_FACTS[aSlug];
  const b = PLATFORM_FACTS[bSlug];
  if (!a || !b) throw new Error(`Unknown platform in comparison: ${aSlug}/${bSlug}`);
  const slug = `${aSlug}-vs-${bSlug}`;
  return {
    slug,
    platformA: a.name,
    platformB: b.name,
    title: overrides?.title ?? `${a.name} vs ${b.name} for Resellers (2026)`,
    description:
      overrides?.description ??
      `${a.name} vs ${b.name} for selling used clothes: fees, category fit, shipping, payout speed, and how each handles condition disputes and returns.`,
    h1: overrides?.h1 ?? `${a.name} vs ${b.name}: which is better for resellers in 2026?`,
    intro:
      overrides?.intro ??
      `${a.name} and ${b.name} both sell used clothing but suit different sellers — ${a.name} for ${a.bestFor}, ${b.name} for ${b.bestFor}. This comparison covers fees, category fit, shipping, and payout speed, plus the column most comparisons skip: how each platform handles a condition dispute, which is where resellers actually lose money.`,
    rows: [
      { dimension: "Selling fees", a: a.fees, b: b.fees },
      { dimension: "Audience & reach", a: a.audience, b: b.audience },
      { dimension: "Category fit", a: a.categoryFit, b: b.categoryFit },
      { dimension: "Shipping", a: a.shipping, b: b.shipping },
      { dimension: "Payout speed", a: a.payout, b: b.payout },
      { dimension: "Returns & condition-dispute handling", wedge: true, a: a.returns, b: b.returns },
    ],
    sections: [
      { heading: `Who ${a.name} is for`, body: `${a.name} fits ${a.bestFor}. Match it to the items and pace that suit that profile, and it will out-earn a platform you picked by habit.` },
      { heading: `Who ${b.name} is for`, body: `${b.name} fits ${b.bestFor}. If your inventory and selling style line up with that, it's the stronger home for those listings.` },
      { heading: "The risk both share: condition", body: `On both ${a.name} and ${b.name}, the most expensive event is a 'not as described' return over condition. Both resolve these in the buyer's favor by default and put the burden of proof on the seller — identical risk whichever you choose, and the piece you can actually control.` },
      // US-9018. People searching "${aSlug} to ${bSlug}" have already decided;
      // they want to know how to move. Answering that here rather than on a
      // separate /migrate/ page keeps one URL per pair, which matters on a site
      // whose problem is authority concentration rather than page count.
      { heading: `Moving your listings from ${a.name} to ${b.name}`, body: `What comes with you: ${b.carriesOver} What does not: ${b.leftBehind} And the part that trips people up, because it is not a copy-paste — condition. ${a.name} expects ${lowerFirst(a.conditionWording)} ${b.name} expects ${lowerFirst(b.conditionWording)} Relisting the same words on the new platform is how a clean item becomes a not-as-described case.` },
      { heading: `Moving from ${b.name} to ${a.name}`, body: `The same move in reverse. What comes with you: ${a.carriesOver} What does not: ${a.leftBehind} Re-read the condition line before you publish: ${a.name} expects ${lowerFirst(a.conditionWording)}` },
    ],
    verdict:
      overrides?.verdict ??
      `Sell where your inventory fits: ${a.name} for ${a.bestFor}, ${b.name} for ${b.bestFor}. Most serious resellers cross-list to both. Whichever you choose, the condition-dispute exposure is the same — so control it with accurate, verifiable condition.`,
    gradingWedge: `Neither ${a.name} nor ${b.name} will take your word on condition when a buyer opens a dispute — but an objective, third-party condition grade and a shareable certificate is evidence you graded honestly. Grading each item on a standardized 1.0–10.0 scale before you list sets buyer expectations up front (fewer disputes) and gives you documentation to fall back on (better outcomes when one happens), on either platform or anywhere you cross-list.`,
    faqs: [
      {
        q: `Is ${a.name} or ${b.name} better for selling used clothes?`,
        a: `${a.name} is better for ${a.bestFor}; ${b.name} is better for ${b.bestFor}. Match the platform to your inventory and selling style, and consider cross-listing to both to maximize reach.`,
      },
      {
        q: `Who wins a condition dispute on ${a.name} vs ${b.name}?`,
        a: `Both platforms resolve 'not as described' condition disputes in the buyer's favor by default and put the burden of proof on the seller. The best protection on either is accurate condition disclosure up front — an objective grade and certificate document that you did.`,
      },
      {
        q: `How do I move my listings from ${a.name} to ${b.name}?`,
        a: `There is no transfer button on either platform, so every listing is created again on the destination. ${b.carriesOver} ${b.leftBehind} Rewrite the condition line rather than pasting it: ${b.name} expects ${lowerFirst(b.conditionWording)} Cross-listing software does the relisting in bulk, which is worth it past roughly twenty items.`,
      },
      {
        q: `Can I sell the same item on ${a.name} and ${b.name} at once?`,
        a: `Yes, and most sellers past a certain volume do. The catch is delisting: an item that sells on one and stays live on the other becomes a cancelled order and a metrics hit. That is the problem cross-listing tools exist to solve, by removing the listing everywhere the moment it sells.`,
      },
    ],
  };
}

// The templated tail (US-1685). Editorially reviewed; flagships poshmark-vs-
// mercari and depop-vs-poshmark carry hand-written intro/verdict overrides.
// mercari-vs-ebay is the separate hand-written literal below. Prune tail pages
// under 10 impressions/mo at month 4 (AC) — an operational review, not code.
const COMPARISON_PAIRS: Comparison[] = [
  templatedComparison("poshmark", "mercari", {
    intro:
      "Poshmark and Mercari are the two go-to apps for casually reselling clothing in the US, and the choice comes down to how you sell. Poshmark rewards social selling — sharing, following, parties — while Mercari is a quieter, list-it-and-forget-it marketplace. This compares fees, audience, and, crucially, how each handles the condition disputes that eat resale margin.",
    verdict:
      "Choose Poshmark if you'll work its social engine and sell contemporary fashion; choose Mercari for lower-effort listing of everyday, mid-priced items. Many resellers run both. The condition-dispute risk is the same on each — accurate, verifiable condition is what protects you either way.",
  }),
  templatedComparison("depop", "poshmark", {
    intro:
      "Depop and Poshmark target different closets: Depop's young, style-led audience hunts vintage and streetwear, while Poshmark's community skews contemporary brands. Picking the right one is about where your inventory's buyers actually are — and both put the burden of a condition dispute on you. This compares fees, fit, and returns handling.",
    verdict:
      "Sell vintage, streetwear, and y2k to a Gen-Z audience on Depop; sell contemporary brands to Poshmark's social community. If your inventory spans both, cross-list. Whichever you choose, condition disputes resolve for the buyer — grade accurately and document it.",
  }),
  templatedComparison("ebay", "poshmark"),
  templatedComparison("ebay", "depop"),
  templatedComparison("mercari", "depop"),
  // 165 impressions at position 9.7 for 1 click (US-9017).
  templatedComparison("grailed", "ebay", {
    title: "Grailed vs eBay: Where Menswear Actually Sells",
    description:
      "Grailed vs eBay for used menswear: the fee split, buyer base, payout speed and condition disputes. Plus what to expect if you move listings between them.",
  }),
  templatedComparison("grailed", "depop"),
  // 124 impressions at position 11.0, zero clicks (US-9017).
  templatedComparison("grailed", "poshmark", {
    title: "Grailed vs Poshmark: Which Fits Your Inventory",
    description:
      "Grailed vs Poshmark on fees, audience, shipping and condition disputes. Which suits menswear, streetwear and designer resale, and when to list on both.",
  }),
  // US-3091. These three were plain templatedComparison calls with zero clicks,
  // next to vinted-vs-mercari — same template, one override — earning 9 clicks
  // on 1,182 impressions at position 8. The difference is the title: it answers
  // the money question instead of naming two platforms.
  //
  // Baselines on the day of the commit (Search Console, 2026-09-02):
  //   vinted-vs-poshmark  83 impressions, position 21.7, 0 clicks
  //   vinted-vs-ebay      26 impressions, position 19.0, 0 clicks
  //   vinted-vs-depop     11 impressions, position 12.9, 0 clicks
  // Read again 2026-11-15. A page still at zero clicks above 100 impressions
  // gets written down rather than quietly re-templated.
  //
  // Each worked example uses a price the pair actually turns on: $40 is where
  // Poshmark's 20% starts to hurt, and $25 is where Depop's flat processing
  // charge is a bigger share than its percentage.
  templatedComparison("vinted", "poshmark", {
    // Titles are capped at 60 INCLUDING the " | GradeThread" suffix
    // (route-metadata.test.ts), which is 13 of the 60 before a word is written.
    title: "Vinted vs Poshmark: Who Takes the Cut",
    description:
      "Poshmark takes 20% of a $40 sale. Vinted takes nothing and charges " +
      "the buyer instead. Fees, payouts and condition disputes, worked " +
      "through on one item.",
  }),
  templatedComparison("vinted", "depop", {
    title: "Vinted vs Depop: Neither Charges Sellers Now",
    description:
      "Depop dropped its US seller commission in 2024 and Vinted never had " +
      "one, so it comes down to processing, audience and disputes. What " +
      "each costs on a $25 item.",
  }),
  // The worst CTR gap in the family: 530 impressions at position 8.5 for 6
  // clicks (1.13%), where page one should return 3-10% (US-9017).
  templatedComparison("vinted", "mercari", {
    title: "Vinted vs Mercari: Who Pays Sellers More",
    description:
      "Vinted charges the buyer, Mercari charges you. Fees, payout speed, category fit and how each handles condition disputes, worked through on a $40 item.",
  }),
  templatedComparison("vinted", "ebay", {
    title: "Vinted vs eBay: What a $40 Sale Pays You",
    description:
      "eBay takes 13.6% plus $0.40 on apparel, charged on shipping and tax " +
      "too. Vinted charges the seller nothing. Fees, reach and condition " +
      "disputes on a $40 item.",
  }),
  templatedComparison("whatnot", "ebay"),
  // 99 impressions at position 15.5, zero clicks (US-9017).
  templatedComparison("whatnot", "poshmark", {
    title: "Whatnot vs Poshmark: Live Selling or Listings?",
    description:
      "Whatnot vs Poshmark on fees, format and audience. Whether live selling beats static listings for your inventory, and what moving between them involves.",
  }),
  templatedComparison("mercari", "grailed"),
];

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
        b: "Final value fee 13.6% for most apparel categories plus a $0.40 per-order fee; 12.7% with a Basic Store or above. Higher headline take, but more levers to reduce it.",
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
  ...COMPARISON_PAIRS,
];

export function getComparisonBySlug(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

export function getComparisonByPath(path: string): Comparison | undefined {
  const norm = path.replace(/\/+$/, "");
  return COMPARISONS.find((c) => comparePath(c.slug) === norm);
}

export function isCompareHubPath(path: string): boolean {
  return path.replace(/\/+$/, "") === COMPARE_HUB_PATH;
}

/** Public routes: the hub index + one page per comparison. */
/**
 * Comparison slugs whose canonical points at a DIFFERENT URL (US-9008).
 *
 * depop-vs-poshmark: two GradeThread URLs target this query and neither wins
 * it. /blog/depop-vs-poshmark-which-should-you-use has 168 impressions at
 * position 16.45; this page has never had a single impression in ten weeks
 * (Search Console, 6 months to 2026-08-16). Consolidating on one URL per
 * intent is right, and the direction is not close — one side has ranking
 * history and the other has none. Working in
 * docs/seo/compare-family-diagnosis.md.
 *
 * The page stays LIVE and stays linked from the hub. Only the canonical and
 * the sitemap entry change.
 */
export const COMPARISON_CANONICAL_OVERRIDES: Readonly<Record<string, string>> = {
  "depop-vs-poshmark": "/blog/depop-vs-poshmark-which-should-you-use",
};

export function comparisonRoutes(): PublicRoute[] {
  const hub: PublicRoute = {
    path: COMPARE_HUB_PATH,
    title: "Marketplace Comparisons for Resellers",
    description:
      "Compare the marketplaces resellers sell used clothes on — fees, reach, shipping, payout speed, and how each handles condition disputes and returns.",
    changefreq: "monthly",
    priority: 0.6,
    // US-2044: jsonLdType must describe what is ACTUALLY prerendered — it is
    // now enforced by jsonld-parity.test.tsx, so a decorative value fails the
    // build rather than quietly misinforming the next reader.
    // US-2072: now emits a real CollectionPage + ItemList enumerating this
    // hub's children, so an AI answer engine can read the set whole rather
    // than scrape it out of prose. Declaring it here makes the US-2044 parity
    // test enforce that the markup keeps being prerendered.
    jsonLdType: "CollectionPage",
  };
  const pages: PublicRoute[] = COMPARISONS.map((c) => {
    const route: PublicRoute = {
      path: comparePath(c.slug),
      title: c.title,
      description: c.description,
      changefreq: "monthly",
      priority: 0.7,
      jsonLdType: "Article",
    };
    const canonical = COMPARISON_CANONICAL_OVERRIDES[c.slug];
    if (canonical) route.canonicalPath = canonical;
    return route;
  });
  return [hub, ...pages];
}

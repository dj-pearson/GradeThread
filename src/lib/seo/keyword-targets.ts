// US-1402 (SEO): the keyword-target registry. Encodes the primary/secondary/
// question keyword targets per public route — the keyword strategy made
// explicit, durable, and ENFORCED (see keyword-targets.test.ts: every route's
// title or description must contain its primary keyword, so copy and targets
// can't silently drift).
//
// Clusters + keywords are derived from the 2026 SEO deep-research pass
// (vault/40-growth/seo-geo-strategy.md). NOTE: search-volume/difficulty figures were under-evidenced
// in that research (flagged as an open question) — these targets encode INTENT
// and topical CLUSTER, not hard volume. Validate volume/difficulty with GSC +
// a keyword tool post-launch and refine. `questions[]` feed FAQ/answer-capsule
// content (the format AI engines cite most).

export type KeywordCluster =
  | "grading-standard" // the codified clothing condition standard (the moat)
  | "condition-value" // resale value by condition / what's it worth
  | "reseller-tools" // FlipDesk / eBay reseller management
  | "selling-guide" // how to sell used clothes (marketplace guides)
  | "trust-verify" // certificates, verification, buyer guarantee
  // US-9012: garment care and repair, served under /care. Deliberately its own
  // cluster rather than folded into an existing one, because the whole point of
  // the containment decision is that this content is NOT part of the reseller
  // spine and must be measurable separately. US-9016's kill criteria read it as
  // its own line.
  | "care";

export type SearchIntent = "informational" | "commercial" | "transactional";

export interface KeywordTarget {
  /** The PUBLIC_ROUTES path this targets. */
  path: string;
  cluster: KeywordCluster;
  intent: SearchIntent;
  /**
   * The head keyword this page owns. ENFORCED: must appear (case-insensitive)
   * in the route's registered title or description.
   */
  primary: string;
  /** Supporting keywords to weave into copy/headings. */
  secondary: string[];
  /** Question-format keywords for FAQ + answer-capsule targeting (GEO). */
  questions: string[];
}

export const KEYWORD_TARGETS: readonly KeywordTarget[] = [
  // ── grading-standard cluster (the authority moat) ──────────────────
  {
    path: "/condition-grading",
    cluster: "grading-standard",
    intent: "informational",
    primary: "clothing condition grading",
    secondary: [
      "condition grading scale",
      "clothing condition grades",
      "garment condition grading",
      "used clothing condition scale",
    ],
    questions: [
      "what is clothing condition grading",
      "what are the clothing condition grades",
      "how is used clothing condition graded",
    ],
  },
  {
    path: "/grading-standard",
    cluster: "grading-standard",
    intent: "informational",
    primary: "grading standard",
    secondary: [
      "clothing grading standard",
      "condition grading standard",
      "1.0-10.0 condition scale",
      "weighted grading factors",
    ],
    questions: [
      "what is the clothing grading standard",
      "how does clothing grading work",
      "is there a standard for used clothing condition",
    ],
  },
  {
    path: "/how-it-works",
    cluster: "grading-standard",
    intent: "informational",
    primary: "pre-owned clothing",
    secondary: [
      "AI clothing grading",
      "how clothing grading works",
      "condition grade certificate",
    ],
    questions: [
      "how does GradeThread grade clothing",
      "how do you grade used clothes",
    ],
  },
  // ── condition-value cluster ────────────────────────────────────────
  {
    path: "/whats-it-worth",
    cluster: "condition-value",
    intent: "commercial",
    primary: "used clothing worth",
    secondary: [
      "what is my used clothing worth",
      "resale value of used clothes",
      "used clothes value by condition",
    ],
    questions: [
      "what is my used clothing worth",
      "how much is my used clothing worth",
      "how do I value used clothes for resale",
    ],
  },
  {
    path: "/resale-value-by-condition",
    cluster: "condition-value",
    intent: "informational",
    primary: "resale value",
    secondary: [
      "resale value by condition",
      "condition and resale price",
      "how condition affects resale value",
    ],
    questions: [
      "how much does condition affect resale value",
      "what does condition do to resale price",
    ],
  },
  // ── reseller-tools cluster (FlipDesk) ──────────────────────────────
  {
    path: "/flipdesk",
    cluster: "reseller-tools",
    intent: "commercial",
    primary: "eBay reseller",
    secondary: [
      "eBay reseller management",
      "eBay reseller tools",
      "eBay cross-listing",
      "eBay repricing",
      "reseller inventory management",
    ],
    questions: [
      "what is the best eBay reseller tool",
      "how do I manage an eBay reselling business",
    ],
  },
  {
    path: "/for-resellers",
    cluster: "reseller-tools",
    intent: "commercial",
    primary: "condition grades",
    secondary: [
      "condition grading for resellers",
      "reseller condition grades",
      "grading for eBay sellers",
    ],
    questions: [
      "why should resellers grade condition",
      "how do condition grades help resellers",
    ],
  },
  // ── selling-guide cluster (marketplace guides) ─────────────────────
  {
    path: "/sell-used-clothes-ebay",
    cluster: "selling-guide",
    intent: "informational",
    primary: "sell used clothes on eBay",
    secondary: [
      "how to sell used clothes on eBay",
      "eBay condition for used clothes",
      "selling used clothing on eBay",
    ],
    questions: [
      "how do I sell used clothes on eBay",
      "what condition should I list used clothes on eBay",
      "how do I price used clothes on eBay",
    ],
  },
  {
    path: "/reseller-grading-guide",
    cluster: "selling-guide",
    intent: "informational",
    primary: "grading",
    secondary: [
      "reseller grading guide",
      "how to grade items for resale",
      "condition grading for sellers",
    ],
    questions: [
      "how do I grade items I'm reselling",
      "how should I describe condition when reselling",
    ],
  },
  // ── trust-verify cluster ───────────────────────────────────────────
  {
    path: "/verify",
    cluster: "trust-verify",
    intent: "transactional",
    primary: "verify",
    secondary: [
      "verify condition certificate",
      "verify a clothing grade",
      "check a condition certificate",
    ],
    questions: [
      "how do I verify a clothing condition certificate",
      "is this grade certificate real",
    ],
  },
  {
    path: "/buyer-guarantee",
    cluster: "trust-verify",
    intent: "informational",
    primary: "guarantee",
    secondary: [
      "grade accuracy guarantee",
      "condition guarantee",
      "buyer protection clothing",
    ],
    questions: [
      "what does the grade accuracy guarantee cover",
      "does GradeThread refund a wrong grade",
    ],
  },
  // ── reseller-tools cluster: the calculator family (US-9002/9007) ────
  // /tools/authenticity-check earns 9.0% CTR at average position 13.4 against a
  // 0.85% site average (Search Console, 6 months to 2026-08-16). Tool pages are
  // the highest-converting surface on this site by an order of magnitude, and
  // that is the local evidence this cluster is a bet on — not a Planner volume.
  {
    path: "/tools/calculators",
    cluster: "reseller-tools",
    intent: "commercial",
    primary: "reseller calculators",
    secondary: [
      "marketplace fee calculator",
      "resale profit calculator",
      "free seller tools",
    ],
    questions: [
      "how much does a marketplace take from a sale",
      "what will I make after fees",
    ],
  },
  {
    path: "/tools/ebay-fee-calculator",
    cluster: "reseller-tools",
    intent: "informational",
    primary: "ebay fee calculator",
    secondary: [
      "ebay final value fee calculator",
      "how much does ebay take from a sale",
      "ebay seller fees",
    ],
    questions: [
      "how much does ebay take from a sale",
      "does ebay charge fees on shipping",
      "is an ebay store worth it",
      "why do sneakers have a different ebay fee",
    ],
  },
  {
    path: "/tools/ebay-shipping-calculator",
    cluster: "reseller-tools",
    intent: "informational",
    primary: "ebay shipping calculator",
    secondary: [
      "cheapest way to ship clothes",
      "usps shipping calculator by weight and zip code",
      "dimensional weight calculator",
      "flat rate vs ground advantage",
    ],
    questions: [
      "what is the cheapest way to ship clothes",
      "why did my package cost more than the scale said",
      "is priority mail flat rate worth it for clothing",
      "what usps zone am i in",
    ],
  },
  {
    path: "/tools/poshmark-fee-calculator",
    cluster: "reseller-tools",
    intent: "informational",
    primary: "how much does poshmark take",
    secondary: [
      "poshmark fee calculator",
      "poshmark fees",
      "poshmark commission",
    ],
    questions: [
      "how much does poshmark take",
      "why is the poshmark fee on a cheap item so high",
      "does poshmark charge a fee on shipping",
    ],
  },
  {
    path: "/tools/mercari-fee-calculator",
    cluster: "reseller-tools",
    intent: "informational",
    primary: "mercari fee calculator",
    secondary: [
      "mercari fees",
      "how much does mercari take",
      "mercari selling fee",
    ],
    questions: [
      "how much does mercari take from a sale",
      "did mercari get rid of seller fees",
      "what is the mercari buyer protection fee",
    ],
  },
  {
    path: "/tools/depop-fee-calculator",
    cluster: "reseller-tools",
    intent: "informational",
    primary: "depop fee calculator",
    secondary: [
      "depop fees",
      "does depop charge selling fees",
      "depop boosted listings fee",
    ],
    questions: [
      "does depop still charge a selling fee",
      "what does depop cost per sale",
      "is boosting a depop listing worth it",
    ],
  },
  {
    path: "/tools/etsy-fee-calculator",
    cluster: "reseller-tools",
    intent: "informational",
    primary: "etsy fee calculator",
    secondary: [
      "etsy fees",
      "how much does etsy take",
      "etsy offsite ads fee",
    ],
    questions: [
      "how much does etsy take from a sale",
      "what are etsy offsite ads",
      "does etsy charge a fee on shipping",
    ],
  },
  {
    path: "/flipdesk/crosslisting",
    cluster: "reseller-tools",
    intent: "commercial",
    primary: "clothing crosslisting software",
    secondary: [
      "multi channel listing software",
      "cross listing app",
      "crosslist clothing to multiple marketplaces",
    ],
    questions: [
      "what is the best crosslisting app for clothing",
      "which marketplaces can flipdesk crosslist to",
      "how is flipdesk different from vendoo",
    ],
  },
  // US-9012: the flaw library moved to /care and was reframed from disclosure
  // language to removal language, so its targets moved with it. These are the
  // four entries the US-9011 SERP check identified as winnable: weak incumbents
  // AND a condition consequence that bridges back to the product. The two
  // 50,000/mo terms it warned off (`how to sew on a button` especially) are
  // deliberately absent.
  {
    path: "/care/shrinkage",
    cluster: "care",
    intent: "informational",
    primary: "how to unshrink clothes",
    secondary: ["unshrink a shirt", "fix shrunken clothes", "clothes shrank in the dryer"],
    questions: [
      "how do you unshrink clothes",
      "can you unshrink a wool sweater",
      "does hair conditioner unshrink clothes",
    ],
  },
  {
    path: "/care/snags-pulls",
    cluster: "care",
    intent: "informational",
    primary: "how to fix a snag in a sweater",
    secondary: ["pulled thread in a sweater", "snag repair", "fix a pull in knitwear"],
    questions: [
      "how do you fix a snag in a sweater",
      "should you cut a snag off a sweater",
      "what tool fixes a snag in knitwear",
    ],
  },
  {
    path: "/care/broken-zipper",
    cluster: "care",
    intent: "informational",
    primary: "how to fix a broken zipper",
    secondary: ["zipper will not close", "zipper separates behind the slider", "fix a zip"],
    questions: [
      "how do you fix a zipper that separates",
      "can you fix a zipper without replacing it",
      "why does my zipper keep coming undone",
    ],
  },
  {
    path: "/care/holes-tears",
    cluster: "care",
    intent: "informational",
    primary: "how to fix a hole in jeans",
    secondary: ["mend a hole in clothes", "repair torn jeans", "darn a hole"],
    questions: [
      "how do you fix a hole in jeans",
      "what is the strongest way to mend a hole",
      "can you fix a hole without a sewing machine",
    ],
  },
  // US-9013: the remaining repair terms from AC4, on the entries that carry a
  // full HowTo guide. `how to sew on a button` is absent on purpose (AC7).
  {
    path: "/care/belt-loop-damage",
    cluster: "care",
    intent: "informational",
    primary: "how to fix a broken belt loop",
    secondary: ["reattach a belt loop", "belt loop repair", "torn belt loop"],
    questions: [
      "how do you reattach a belt loop",
      "what stitch holds a belt loop",
      "why do belt loops keep tearing off",
    ],
  },
  {
    path: "/care/stretching",
    cluster: "care",
    intent: "informational",
    primary: "how to fix a stretched out collar",
    secondary: ["fix a stretched neckline", "shrink a stretched shirt", "stretched cuffs"],
    questions: [
      "how do you fix a stretched out collar",
      "can you shrink a stretched shirt back",
      "why do collars stretch out",
    ],
  },
  {
    path: "/care/moth-holes",
    cluster: "care",
    intent: "informational",
    primary: "how to darn a hole in a sweater",
    secondary: ["darn moth holes", "mend a wool sweater", "invisible mending"],
    questions: [
      "how do you darn a hole in a sweater",
      "how do you kill moth larvae in clothes",
      "how big a moth hole can be darned",
    ],
  },
  {
    path: "/tools/reseller-profit-calculator",
    cluster: "reseller-tools",
    intent: "informational",
    primary: "reseller profit calculator",
    secondary: [
      "ebay profit calculator",
      "resale profit margin calculator",
      "flipping profit calculator",
    ],
    questions: [
      "how do i work out resale profit",
      "why does condition change resale price",
      "what margin should a reseller aim for",
    ],
  },
  {
    path: "/tools/measurement-converter",
    cluster: "reseller-tools",
    intent: "informational",
    primary: "clothing measurement converter",
    secondary: [
      "international size conversion chart",
      "pit to pit measurement chart",
      "mens to womens size converter",
    ],
    questions: [
      "what does pit to pit mean",
      "do I double a pit to pit measurement",
      "what size is a US 8 in UK",
      "how do I convert mens sizes to womens",
    ],
  },
  {
    // US-9021. The 2026-08-28 pull sized this cluster at 7,250/mo across 14
    // keywords at LOW competition, which is the best volume-to-difficulty
    // ratio either pull has produced. All fourteen are the same question, so
    // they are served on one URL rather than split.
    path: "/tools/ebay-sold-listings",
    cluster: "reseller-tools",
    intent: "informational",
    primary: "how to check sold items on ebay",
    secondary: [
      "how to check ebay sold listings",
      "how to find recently sold on ebay",
      "ebay sold listings search",
    ],
    questions: [
      "how do i check sold items on ebay",
      "how far back do ebay sold listings go",
      "why does ebay show best offer accepted",
      "are sold listings the same as what an item is worth",
    ],
  },
  {
    // US-9020. 8,850/mo across 25 keywords in the 2026-08-28 pull, and the
    // sitemap had no URL containing "stitch". Filed under grading-standard
    // rather than reseller-tools on purpose: dating a blank is an
    // identification question, and the page's job is to keep it separate from
    // the condition question that follows it.
    path: "/tools/single-stitch-dating",
    cluster: "grading-standard",
    intent: "informational",
    primary: "single stitch shirt",
    secondary: [
      "single stitch t shirt",
      "single stitch vintage tee",
      "vintage single stitch shirt",
    ],
    questions: [
      "what is a single stitch shirt",
      "does single stitch mean pre 1994",
      "how do i date a vintage t shirt",
      "can single stitch be faked",
    ],
  },
] as const;

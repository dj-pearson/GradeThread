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
  | "trust-verify"; // certificates, verification, buyer guarantee

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
] as const;

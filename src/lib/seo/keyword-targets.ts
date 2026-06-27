// US-1402 (SEO): the keyword-target registry. Encodes the primary/secondary/
// question keyword targets per public route — the keyword strategy made
// explicit, durable, and ENFORCED (see keyword-targets.test.ts: every route's
// title or description must contain its primary keyword, so copy and targets
// can't silently drift).
//
// Clusters + keywords are derived from the 2026 SEO deep-research pass
// (SEO_STRATEGY.md). NOTE: search-volume/difficulty figures were under-evidenced
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
] as const;

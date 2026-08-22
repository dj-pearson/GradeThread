// The slugs the PRODUCT points at (US-2584).
//
// Every <HelpLink> in the app names one of these, and the `slug` prop is typed
// against this list — so a typo is a build error rather than a question-mark
// button that opens nothing.
//
// It is also the content backlog. Each entry says which shelf the article
// belongs on and what it has to answer, so US-2586..US-2590 are writing to a
// specification rather than guessing. An entry here with no article yet is not
// a bug: the button renders nothing until the article exists (see
// components/help/help-link.tsx), so a half-written help centre degrades to the
// product it already was.

export interface ProductHelpSlug {
  slug: string;
  /** Must be a key in HELP_CATEGORIES. */
  category: string;
  /** Where the button appears. */
  surface: string;
  /** What the article has to answer. This is the brief, not a summary. */
  mustAnswer: string;
}

export const PRODUCT_HELP_SLUGS = [
  {
    slug: "your-first-grade",
    category: "getting-started",
    surface: "New submission",
    mustAnswer:
      "Which four photos are required, how to shoot each one, and what happens after you submit.",
  },
  {
    slug: "reading-your-grade-report",
    category: "grading",
    surface: "Submission detail",
    mustAnswer:
      "What the five factors are, how they are weighted into one score, what confidence means, and when a grade goes to human review.",
  },
  {
    slug: "the-flipdesk-pipeline",
    category: "flipdesk",
    surface: "FlipDesk pipeline",
    mustAnswer:
      "What each of the eleven stages means, what moves an item to the next one, and which stages are optional.",
  },
  {
    slug: "writing-a-listing-in-the-composer",
    category: "flipdesk",
    surface: "Composer",
    mustAnswer:
      "What the composer owns versus what the marketplace owns, how the grade reaches the listing, and why a field can be locked.",
  },
  {
    slug: "connecting-a-marketplace",
    category: "marketplaces",
    surface: "Marketplaces",
    mustAnswer:
      "How to connect eBay, what business policies you need first, what reconnect-required means, and what each permission is for.",
  },
  {
    slug: "reconciling-payouts",
    category: "marketplaces",
    surface: "Reconciliation",
    mustAnswer:
      "What a payout import matches against, what an unmatched row means, and how to fix one.",
  },
  {
    slug: "plans-credits-and-billing",
    category: "billing",
    surface: "Billing",
    mustAnswer:
      "Credits versus subscription, what happens on upgrade and downgrade, when you are charged, and how to cancel.",
  },
  {
    slug: "api-keys-and-the-sandbox",
    category: "integrations",
    surface: "Developers / API keys",
    mustAnswer:
      "How to mint a key, what the sandbox does differently, rate limits and quotas, and what to do when a key leaks.",
  },
  {
    slug: "inviting-your-team",
    category: "team",
    surface: "Team",
    mustAnswer:
      "What each role can do, who owns the workspace, and what happens to a member's work when they are removed.",
  },
  {
    slug: "installing-the-browser-extension",
    category: "extension",
    surface: "Connect extension",
    mustAnswer:
      "How to install it, what each permission is for, how to connect it to this account, and what runs automatically versus on click.",
  },
] as const satisfies ReadonlyArray<ProductHelpSlug>;

/** The union of slugs a <HelpLink> may name. A typo fails to compile. */
export type ProductHelpSlugKey = (typeof PRODUCT_HELP_SLUGS)[number]["slug"];


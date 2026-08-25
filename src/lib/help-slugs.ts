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
  // ── US-2862 ────────────────────────────────────────────────────────────
  // The registry stopped at ten surfaces, all of them ones a user reaches
  // after they already know what they are doing: billing, API keys, team,
  // the composer. The places somebody gets stuck on day one — intake,
  // AutoLister, sourcing, pricing, returns — had no entry, so HelpLink had
  // nothing to render there even once the articles exist.
  {
    slug: "adding-your-first-item",
    category: "flipdesk",
    surface: "Add item (intake)",
    mustAnswer:
      "Which fields matter and which can wait, what photos to take now versus later, what a SKU is for, and what happens to the item after you save it.",
  },
  {
    slug: "the-four-inventory-views",
    category: "flipdesk",
    surface: "Inventory",
    mustAnswer:
      "What Table, Grid, Board and Prep each show, what every item status means, and which view to use for which job.",
  },
  {
    slug: "batch-listing-with-autolister",
    category: "autolister",
    surface: "AutoLister",
    mustAnswer:
      "What a batch is, how photos are grouped into items, how many an account may run, what the AI writes versus what you must fill in, and what it costs.",
  },
  {
    slug: "deciding-what-to-buy",
    category: "flipdesk",
    surface: "Sourcing",
    mustAnswer:
      "What Scout, the buy decision, sources and buyer demand each answer, and which one to open when you are standing in a shop.",
  },
  {
    slug: "pricing-your-listings",
    category: "flipdesk",
    surface: "Pricing",
    mustAnswer:
      "The difference between repricing, bulk pricing, price suggestions and automations, which of them change a live price without asking, and how to stop one.",
  },
  {
    slug: "reading-your-money",
    category: "flipdesk",
    surface: "Money",
    mustAnswer:
      "Revenue versus profit, which fees are counted and when, what 'owed to you' means, and why a sold item can show no profit yet.",
  },
  {
    slug: "offers-and-buyer-messages",
    category: "marketplaces",
    surface: "Offers & Messages",
    mustAnswer:
      "Where offers come from, what happens if you do nothing, what a drafted reply does and does not send, and what counts as a binding acceptance.",
  },
  {
    slug: "returns-and-disputes",
    category: "marketplaces",
    surface: "Returns & Disputes",
    mustAnswer:
      "What each case type means, the clock on each one, what evidence a grade report provides, and what happens if a case escalates.",
  },
  {
    slug: "scheduling-a-drop",
    category: "flipdesk",
    surface: "Scheduled drops",
    mustAnswer:
      "What a drop is, how a time is chosen, what happens if a listing is not ready when its slot arrives, and how to cancel one.",
  },
  {
    slug: "becoming-a-verified-seller",
    category: "flipdesk",
    surface: "Verified",
    mustAnswer:
      "What the badge claims, what an account must do to keep it, what the public profile shows, and how to remove it.",
  },
  {
    slug: "taking-in-consignment",
    category: "flipdesk",
    surface: "Consignment",
    mustAnswer:
      "How a consignor and a split are set up, who owns the item, how a payout is calculated, and what the consignor can see.",
  },
  {
    slug: "importing-your-inventory",
    category: "flipdesk",
    surface: "Import",
    mustAnswer:
      "What the CSV needs, how a Google Sheet stays in sync afterwards, what happens to a row that does not match, and how to undo an import.",
  },
  {
    slug: "snap-to-value",
    category: "grading",
    surface: "Snap to Value",
    mustAnswer:
      "What a Snap read is and is not, how it differs from a full graded submission, what it costs, and when to pay for the real grade instead.",
  },
  {
    slug: "using-the-measurecard",
    category: "flipdesk",
    surface: "MeasureCard",
    mustAnswer:
      "What the card is for, how to print one at the right size, where to place it in a photo, and what goes wrong without it.",
  },
  {
    slug: "rewards-and-credit",
    category: "getting-started",
    surface: "Rewards",
    mustAnswer:
      "How XP is earned, what a level unlocks, when a season resets, and how earned credit is spent.",
  },
] as const satisfies ReadonlyArray<ProductHelpSlug>;

/** The union of slugs a <HelpLink> may name. A typo fails to compile. */
export type ProductHelpSlugKey = (typeof PRODUCT_HELP_SLUGS)[number]["slug"];


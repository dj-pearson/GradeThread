// US-2864. GradeThread invented about twenty words and taught none of them.
//
// FlipDesk, AutoLister, Snap to Value, MeasureCard, Scout, Prospect, Sourcing,
// Reconcile, Comp, Passport, Verified, Finds, Rewards, Trust Score, Thrift
// Radar, Consignment. Every one is a word a new seller has to learn, and every
// one was taught by being clicked. Some are explained on marketing pages a
// signed-in user never goes back to; none were explained at the point of first
// encounter. The public glossary at /grading/glossary covers GRADING terms and
// none of these.
//
// One sentence each, sixth-grade reading level, saying what the thing IS. Not
// what it is for -- the nav descriptions (US-2861) already say that -- and not
// a sales line.
//
// US-2868 added the words GradeThread BORROWED rather than invented: Item
// specifics, SKU, Provenance, Taxonomy. They are eBay's and the trade's, they
// have to STAY (renaming eBay's own vocabulary would make the app disagree
// with the site the seller is looking at), and a borrowed word is no more
// knowable to a new seller than an invented one. Same registry on purpose: a
// second glossary is how the two end up disagreeing.

export interface ProductTerm {
  /** Exactly as the product spells it. */
  term: string;
  /** One plain sentence. What it is. */
  definition: string;
  /** The surface that owns the idea, so the popover can offer a way in. */
  to?: string;
  /** Other spellings a reader might arrive with. */
  aliases?: readonly string[];
}

export const PRODUCT_TERMS = [
  {
    term: "FlipDesk",
    definition:
      "The part of GradeThread you run your reselling from: what you own, what is listed, and what you made.",
    to: "/dashboard/flipdesk",
  },
  {
    term: "Grade",
    definition:
      "A score from 1.0 to 10.0 for how worn a garment is. Five things are scored and weighed into that one number.",
    to: "/dashboard/submissions",
  },
  {
    term: "Certificate",
    definition:
      "The shareable page that proves a grade is real. It has its own number, and anyone can look it up.",
  },
  {
    term: "Passport",
    definition:
      "A public history page for one garment: its grade, its photos, and who has owned it.",
  },
  {
    term: "AutoLister",
    definition:
      "A batch tool. Give it photos of a pile of garments and it writes a draft listing for each one.",
    to: "/dashboard/flipdesk/autolister",
  },
  {
    term: "Snap to Value",
    definition:
      "A quick photo check that tells you roughly what a garment is worth, without paying for a full grade.",
    to: "/dashboard/snap",
    aliases: ["Snap-to-Value"],
  },
  {
    term: "MeasureCard",
    definition:
      "A printed card you lay next to a garment in a photo, so the AI can tell how big things are.",
    to: "/dashboard/flipdesk/measure-card",
  },
  {
    term: "Scout",
    definition:
      "Searches eBay for listings priced below what they are worth, so you can buy them and flip them.",
    to: "/dashboard/flipdesk/sourcing?tab=scout",
  },
  {
    term: "Prospect",
    definition:
      "Photograph a garment while you are still in the shop and get prices for it straight away. Phone app only.",
  },
  {
    term: "Sourcing",
    definition: "Deciding what to buy, and where to buy it from.",
    to: "/dashboard/flipdesk/sourcing",
  },
  {
    term: "Source",
    definition:
      "The shop, sale or lot an item came from. Tracking it shows you which ones actually make you money.",
    to: "/dashboard/flipdesk/sourcing?tab=sources",
  },
  {
    term: "Comp",
    definition:
      "A garment like yours that already sold. Comps are how you work out what yours is worth.",
    aliases: ["Comps"],
  },
  {
    term: "Reconcile",
    definition:
      "Matching the money that actually landed in your account against the sales you recorded.",
    to: "/dashboard/flipdesk/money?view=reconcile",
    aliases: ["Reconciliation"],
  },
  {
    term: "Verified",
    definition:
      "A public profile and badge for sellers whose grades back up what they claim about condition.",
    to: "/dashboard/flipdesk/verified",
  },
  {
    term: "Trust Score",
    definition:
      "A number saying how often a seller's condition claims turn out to match the grade.",
    aliases: ["Trust score"],
  },
  {
    term: "Finds",
    definition: "A public feed of graded garments that people have listed for sale.",
    to: "/finds",
  },
  {
    term: "Rewards",
    definition:
      "Points you earn for grading. They raise your level and turn into credit you can spend.",
    to: "/dashboard/rewards",
  },
  {
    term: "Thrift Radar",
    definition:
      "Anonymous data sellers share about which shops are worth a visit right now.",
  },
  {
    term: "Consignment",
    definition:
      "Selling a garment that belongs to someone else, and splitting the money with them.",
    to: "/dashboard/flipdesk/consignment",
  },
  {
    term: "Drop",
    definition:
      "A group of listings set to go live at the same time, usually when buyers are looking.",
    to: "/dashboard/flipdesk/scheduled-drops",
    aliases: ["Scheduled drop"],
  },
  {
    term: "Item specifics",
    definition:
      "eBay's name for the details it wants on a listing: brand, size, colour, material. Some are required before it will publish.",
    aliases: ["Aspects", "Aspect"],
  },
  {
    term: "SKU",
    definition:
      "Your own short code for one item, so you can find it on a shelf and in the app without reading the whole title.",
  },
  {
    term: "Provenance",
    definition:
      "Where a piece of information came from, and how sure we are of it: your typing, a photo, eBay, or a guess by the AI.",
  },
  {
    term: "Taxonomy",
    definition:
      "eBay's tree of categories. Picking the right branch decides which details it asks you for and who sees the listing.",
  },
] as const satisfies ReadonlyArray<ProductTerm>;

/** The union of terms a <Term> may name. A typo fails to compile. */
export type ProductTermName = (typeof PRODUCT_TERMS)[number]["term"];

const BY_TERM = new Map<string, ProductTerm>(
  PRODUCT_TERMS.map((t) => [t.term, t]),
);

export function lookupTerm(term: string): ProductTerm | undefined {
  return BY_TERM.get(term);
}

/** Alphabetical, for the glossary page. */
export function termsAlphabetical(): ProductTerm[] {
  return [...PRODUCT_TERMS].sort((a, b) => a.term.localeCompare(b.term));
}

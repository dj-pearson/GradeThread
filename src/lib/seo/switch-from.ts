// Switch-from pages (US-9209): /reselling/switch-from-<competitor>.
//
// The alternative pages answer "should I leave, and for what". These answer the
// next question, "what happens to my stuff if I do": what a CSV export carries
// across, what it does not, and what the seller does by hand. They follow the
// honesty doctrine in competitor-alternatives.ts: no prices, no version numbers,
// no "X is broken", and the list of what does NOT transfer sits next to the list
// of what does, so nobody switches on a promise.
//
// PURE DATA: imports only the PublicRoute type and the slug helper. JSON-LD is
// composed in src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";
import { verifiedLabel } from "./freshness";
import { switchFromPath, type SwitchFromSlug } from "./switch-from-slugs";

export { switchFromPath };

/** Same freshness group as the alternative pages: re-checked together. */
export const SWITCH_FROM_VERIFIED = verifiedLabel("competitor-alternatives");

export interface SwitchFromPage {
  slug: SwitchFromSlug;
  competitor: string;
  /** The slug of the matching alternative page, for the link back. */
  alternativeSlug: string;
  title: string;
  h1: string;
  /** Route meta description. Budget: 70-160 chars. */
  description: string;
  /** The direct answer, first on the page. */
  definition: string;
  /** What the export brings across, one item per line. */
  transfers: string[];
  /** What it does not, said next to the above. */
  doesNotTransfer: string[];
  /** The afternoon, in order. */
  steps: string[];
  faqs: Array<{ q: string; a: string }>;
}

const LIVE_LISTINGS_NOTE =
  "Live listings on Poshmark, Mercari, Grailed, Vinted and Facebook are not in any CSV. The closet import in the GradeThread browser extension claims them from your own logged-in browser, one marketplace at a time, and links each to the imported item.";

export const SWITCH_FROM_PAGES: SwitchFromPage[] = [
  {
    slug: "vendoo",
    competitor: "Vendoo",
    alternativeSlug: "vendoo",
    title: "Switching from Vendoo: what transfers",
    h1: "Switching from Vendoo: what transfers, what does not, and the afternoon it takes",
    description:
      "Moving from Vendoo to FlipDesk: which columns of the Vendoo export import as items, what stays behind, and how live listings come across.",
    definition:
      "Vendoo's inventory export imports into FlipDesk as items with title, description, brand, size, category, SKU, price, cost, dates and status already mapped. Photos, tags and colour do not come through a CSV, and live listings on the extension marketplaces are claimed separately from your own browser. Plan an afternoon, most of it waiting on photo uploads.",
    transfers: [
      "Items: one FlipDesk inventory item per export row, with the title and description as written",
      "Brand, size and category, matched to FlipDesk's own category list where the words line up",
      "Prices: the listing price becomes the item's list price, the cost becomes the purchase price",
      "Dates: date added, date listed and date sold, so aging and days-to-sell keep their history",
      "Status: sold rows import as sold, with the sold price, so your numbers are not reset to zero",
      "SKU or item number, so a label you already printed still resolves",
    ],
    doesNotTransfer: [
      "Photos: the export carries links, not files. Re-upload from your phone or computer, or use the closet import for items that are live on a marketplace, which brings the marketplace's copies across",
      "Tags, colour and quantity: FlipDesk stores colour and quantity on the listing, not the item, so these columns are skipped rather than guessed",
      "Marketplace connections: eBay and Shopify reconnect through FlipDesk's own authorization; nothing about your Vendoo connection carries over",
      LIVE_LISTINGS_NOTE,
      "Your Vendoo account itself: nothing here touches it. Export first, cancel later, once the import checks out",
    ],
    steps: [
      "Export your inventory from Vendoo as CSV",
      "Open FlipDesk, Import, and drop the file in; the page recognises a Vendoo export and maps the columns",
      "Check the mapping on step 2 (the mapping was drawn from Vendoo's documented columns; a column you do not see mapped is one to set by hand)",
      "Import, then open a handful of items and confirm prices and dates look right; undo is one click if they do not",
      "Install the GradeThread extension and run the closet import for each marketplace you are live on",
      "Reconnect eBay and Shopify, then list your next item from FlipDesk",
    ],
    faqs: [
      {
        q: "Do my Vendoo photos come across?",
        a: "Not through the CSV, which carries links rather than files. Items that are live on a marketplace get their photos through the closet import, which reads the marketplace's own copies from your browser. Anything not live needs a re-upload.",
      },
      {
        q: "Will my sold history import?",
        a: "Yes. Rows with a sold date and a sold price import as sold items, so sell-through, profit and days-to-sell are computed from your real history rather than starting from nothing.",
      },
      {
        q: "What if the columns are not what FlipDesk expects?",
        a: "The mapping was drawn from Vendoo's documented columns and is checked against real files as sellers send them. Step 2 of the import shows every column and what it maps to; change any of them before you import, and tell us if a column was missed so the preset is fixed for the next seller.",
      },
    ],
  },
  {
    slug: "list-perfectly",
    competitor: "List Perfectly",
    alternativeSlug: "list-perfectly",
    title: "Switching from List Perfectly: what transfers",
    h1: "Switching from List Perfectly: what transfers, what does not, and the afternoon it takes",
    description:
      "Moving from List Perfectly to FlipDesk: which export columns import as items, what stays behind, and how live listings on each marketplace come across.",
    definition:
      "List Perfectly's export imports into FlipDesk as items with title, description, brand, size, category, SKU, price, cost of goods, dates and status mapped for you. Photos, keywords and colour do not come through a CSV, and live listings on the extension marketplaces are claimed separately from your own browser. Plan an afternoon.",
    transfers: [
      "Items: one FlipDesk inventory item per export row, with the title and description as written",
      "Brand, size and category, matched to FlipDesk's own category list where the words line up",
      "Prices: the listing price becomes the item's list price, the cost of goods becomes the purchase price",
      "Dates: created, listed and sold, so aging and days-to-sell keep their history",
      "Status: sold rows import as sold, with the sold price",
      "SKU, so an existing label still resolves",
    ],
    doesNotTransfer: [
      "Photos: the export carries image links, not files. Items that are live on a marketplace get their photos through the closet import; the rest need a re-upload",
      "Keywords, colour and quantity: FlipDesk keeps colour and quantity on the listing rather than the item, so these columns are skipped rather than guessed",
      "Marketplace connections: eBay and Shopify reconnect through FlipDesk's own authorization",
      LIVE_LISTINGS_NOTE,
      "Your List Perfectly account: nothing here touches it. Export first, cancel later, once the import checks out",
    ],
    steps: [
      "Export your inventory from List Perfectly as CSV",
      "Open FlipDesk, Import, and drop the file in; the page recognises a List Perfectly export and maps the columns",
      "Check the mapping on step 2 (drawn from List Perfectly's documented columns; set by hand anything it did not catch)",
      "Import, then spot-check a few items; undo is one click",
      "Install the GradeThread extension and run the closet import for each marketplace you are live on",
      "Reconnect eBay and Shopify, then list your next item from FlipDesk",
    ],
    faqs: [
      {
        q: "Do my List Perfectly photos come across?",
        a: "Not through the CSV. Live items get their photos through the closet import, which reads the marketplace's own copies from your browser. Anything not live needs a re-upload.",
      },
      {
        q: "Will my sold history import?",
        a: "Yes. Rows with a sold date and a sold price import as sold items, so your sell-through and profit figures carry your real history.",
      },
      {
        q: "What if a column maps wrong?",
        a: "Step 2 of the import shows every column and its target; change any of them before importing. The preset was drawn from List Perfectly's documented columns and is corrected as real files are checked, so a miss you report is fixed for the next seller.",
      },
    ],
  },
];

export function getSwitchFromBySlug(slug: string): SwitchFromPage | undefined {
  return SWITCH_FROM_PAGES.find((p) => p.slug === slug);
}

export function getSwitchFromByPath(path: string): SwitchFromPage | undefined {
  const clean = path.replace(/\/+$/, "");
  return SWITCH_FROM_PAGES.find((p) => switchFromPath(p.slug) === clean);
}

export function switchFromRoutes(): PublicRoute[] {
  return SWITCH_FROM_PAGES.map((p) => ({
    path: switchFromPath(p.slug),
    title: p.title,
    description: p.description,
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "Article",
  }));
}

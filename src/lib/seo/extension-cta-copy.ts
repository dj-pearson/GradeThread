// US-9210: what the install call to action says on each public page.
//
// The rule is in the story: the copy says what the extension DOES on the site
// the reader is about to visit, not what the extension is. So a comparison
// page names the two marketplaces it compares, a garment guide names the
// garment, and a tool page names the shopping moment. Pure: reads the route
// registries and returns copy, or null for a page that gets no CTA.

import { COMPARISONS, comparePath } from "./comparison-guides";
import { GARMENT_GUIDES, guidePath } from "./garment-guides";
import { FLIPDESK_LANDINGS } from "./flipdesk-landing";
import { CROSSLIST_PAIRS, crosslistPairPath, destinationMechanism } from "./crosslist-pairs";

export interface ExtensionCtaCopy {
  /** One line: what it does, where. */
  does: string;
  /** The audience word for the button: "Get it for shopping" vs "for listing". */
  role: "buyer" | "seller";
}

/**
 * Every /tools/* page gets the shopping copy; these four get their own line.
 *
 * US-3089 widened the value from a string to the whole copy object, because
 * /tools/listing-generator is the first tool page whose visitor is a SELLER.
 * The default copy ("before you pay") and the buyer role are both wrong there:
 * somebody writing a listing is not about to buy anything, and offering them a
 * button labelled for shopping is asking for the wrong thing at the one moment
 * they are paying attention.
 */
const TOOL_COPY: Record<string, ExtensionCtaCopy> = {
  "/tools/grade-checker": {
    does:
      "On the listing you are about to buy, the GradeThread extension runs this same condition read from the seller's photos, before you pay.",
    role: "buyer",
  },
  "/tools/fit-checker": {
    does:
      "On the listing you are about to buy, the GradeThread extension reads the measurements and checks the fit against yours, before you pay.",
    role: "buyer",
  },
  "/tools/authenticity-check": {
    does:
      "On the listing you are about to buy, the GradeThread extension checks the condition from the seller's photos, so a good fake at least has to look worn right.",
    role: "buyer",
  },
  "/tools/listing-generator": {
    does:
      "On the marketplaces with no listing API, the GradeThread extension fills the listing form from a draft you already wrote, in your own logged-in tab.",
    role: "seller",
  },
};

const TOOL_DEFAULT: ExtensionCtaCopy = {
  does:
    "On the listing you are about to buy, the GradeThread extension reads the condition from the seller's photos, before you pay. No account needed.",
  role: "buyer",
};

export function extensionCtaFor(path: string): ExtensionCtaCopy | null {
  const clean = path.replace(/\/+$/, "") || "/";

  if (clean.startsWith("/tools/")) {
    return TOOL_COPY[clean] ?? TOOL_DEFAULT;
  }

  // US-9214: the pair pages are the one surface where the reader has already
  // decided to move a listing, so the copy names the two marketplaces and what
  // the extension does on the destination.
  const pair = CROSSLIST_PAIRS.find((p) => crosslistPairPath(p.slug) === clean);
  if (pair) {
    const mech = destinationMechanism(pair.to);
    return {
      does:
        mech === "extension"
          ? `The GradeThread extension fills ${pair.toLabel}'s own listing form from your ${pair.fromLabel} item, in your logged-in tab.`
          : `The GradeThread extension reads your ${pair.fromLabel} listings and any listing's condition from its photos, while FlipDesk handles the ${pair.toLabel} side.`,
      role: "seller",
    };
  }

  const comparison = COMPARISONS.find((c) => comparePath(c.slug) === clean);
  if (comparison) {
    return {
      does: `On ${comparison.platformA} and ${comparison.platformB}, the GradeThread extension reads a listing's condition from its photos before you buy, and shows sellers what buyers will see.`,
      role: "buyer",
    };
  }

  const guide = GARMENT_GUIDES.find((g) => guidePath(g.slug) === clean);
  if (guide) {
    const garment = guide.garment.toLowerCase();
    return {
      does: `Shopping for a ${garment}? The GradeThread extension reads the condition from the listing's photos, on the marketplace you are already on.`,
      role: "buyer",
    };
  }

  const landing = FLIPDESK_LANDINGS.find((l) => l.path === clean);
  if (landing) {
    return {
      does: "The GradeThread extension lists to the marketplaces that have no API from your own browser, and reads any listing's condition while you source.",
      role: "seller",
    };
  }

  return null;
}

/** The buyer home is not a public route; its copy lives here with the rest. */
export const BUYER_HOME_CTA: ExtensionCtaCopy = {
  does: "On the marketplaces you shop, the GradeThread extension reads a listing's condition from the photos before you buy, and saves the read here.",
  role: "buyer",
};

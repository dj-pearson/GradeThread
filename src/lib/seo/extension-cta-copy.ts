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

export interface ExtensionCtaCopy {
  /** One line: what it does, where. */
  does: string;
  /** The audience word for the button: "Get it for shopping" vs "for listing". */
  role: "buyer" | "seller";
}

/** Every /tools/* page gets the shopping copy; these three get their own line. */
const TOOL_COPY: Record<string, string> = {
  "/tools/grade-checker":
    "On the listing you are about to buy, the GradeThread extension runs this same condition read from the seller's photos, before you pay.",
  "/tools/fit-checker":
    "On the listing you are about to buy, the GradeThread extension reads the measurements and checks the fit against yours, before you pay.",
  "/tools/authenticity-check":
    "On the listing you are about to buy, the GradeThread extension checks the condition from the seller's photos, so a good fake at least has to look worn right.",
};

const TOOL_DEFAULT =
  "On the listing you are about to buy, the GradeThread extension reads the condition from the seller's photos, before you pay. No account needed.";

export function extensionCtaFor(path: string): ExtensionCtaCopy | null {
  const clean = path.replace(/\/+$/, "") || "/";

  if (clean.startsWith("/tools/")) {
    return { does: TOOL_COPY[clean] ?? TOOL_DEFAULT, role: "buyer" };
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

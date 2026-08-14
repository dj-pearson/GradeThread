import {
  LISTING_PLATFORMS,
  MARKETPLACE_LABELS,
  MARKETPLACE_MECHANISM,
} from "@/lib/constants";

// US-2541: which marketplaces a negotiation or post-sale surface actually
// covers.
//
// FlipDesk registers eleven marketplaces. The offers, messages and post-sale
// screens drive the eBay hooks and nothing else, and said so nowhere — so a
// seller cross-listing to Poshmark had every reason to read an empty offers
// list as "no offers" rather than "we do not read Poshmark".
//
// The gap is not laziness, and the copy should not imply it is: these features
// need a marketplace API that exposes offers, buyer messages, returns and
// cancellations, and most of the eleven either have no public API at all
// (poshmark, mercari, grailed, vinted, facebook — the extension channels) or
// have one that covers listings and not negotiation (etsy, depop, shopify).
//
// Lives here rather than in constants.ts on purpose: constants.ts is in the
// EAGER graph, and the US-2475 disclosure block was moved out of it for exactly
// this reason. Only the two FlipDesk routes that need this import it.

export type CoverageFeature = "offers" | "messages" | "post_sale";

/** The platforms each surface reads today. */
export const FEATURE_COVERAGE: Record<CoverageFeature, readonly string[]> = {
  offers: ["ebay"],
  messages: ["ebay"],
  post_sale: ["ebay"],
};

/**
 * Why a platform is not covered. Keyed by the same mechanism the marketplace
 * disclosure uses (US-2475), so the answer stays consistent with what the
 * Marketplaces page already tells the seller about that channel.
 */
export function uncoveredReason(platform: string): string {
  const mechanism = MARKETPLACE_MECHANISM[
    platform as keyof typeof MARKETPLACE_MECHANISM
  ];
  switch (mechanism) {
    case "extension":
      return "no public API — listed through your own browser";
    case "api":
      return "its API covers listings, not negotiation";
    default:
      return "no integration";
  }
}

export interface CoverageSummary {
  covered: { id: string; label: string }[];
  uncovered: { id: string; label: string; reason: string }[];
}

/**
 * The covered and uncovered platforms for one surface. Derived from
 * LISTING_PLATFORMS, so a marketplace added to the registry appears here
 * immediately — as uncovered, which is the truthful default.
 *
 * `other` is excluded: it is the catch-all bucket for a manually-tracked
 * listing, not a marketplace anyone expects offers from.
 */
export function coverageFor(feature: CoverageFeature): CoverageSummary {
  const covered: CoverageSummary["covered"] = [];
  const uncovered: CoverageSummary["uncovered"] = [];
  for (const id of LISTING_PLATFORMS) {
    if (id === "other") continue;
    const label = MARKETPLACE_LABELS[id];
    if (FEATURE_COVERAGE[feature].includes(id)) covered.push({ id, label });
    else uncovered.push({ id, label, reason: uncoveredReason(id) });
  }
  return { covered, uncovered };
}

/** "eBay" / "eBay and Etsy" / "eBay, Etsy and Depop". */
export function joinLabels(items: { label: string }[]): string {
  const labels = items.map((i) => i.label);
  if (labels.length === 0) return "no marketplaces";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

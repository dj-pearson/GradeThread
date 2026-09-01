// Crosslist pair pages (US-9214): /reselling/crosslist/{from}-to-{to}.
//
// WHY THESE AND NOT THE HEAD TERMS. docs/seo/crosslisting-cluster-diagnosis.md
// measured it: /reselling/best-crosslisting-apps chases "cross listing
// software" and sits at position 51 with two thirds of the cluster's
// impressions, because a vendor cannot credibly rank itself in a neutral list.
// Every task-intent page the site has already ranks between 7 and 11. The
// 2026-09-01 Search Console export carries 14 ordered marketplace-to-
// marketplace pairs with impressions and zero clicks at positions 11 to 24,
// every one landing on a blog post. Those are the winnable half.
//
// EVERY MECHANISM CLAIM IS DERIVED, never written by hand. The tier, the
// extension flow status and the live-API list in src/lib/constants.ts decide
// what each page says a channel can do, so a page can never promise a channel
// the product does not have. src/lib/__tests__/marketplace-mechanism.test.ts
// covers the copy.

import type { PublicRoute } from "./public-routes";
import {
  LIVE_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_EXTENSION_FLOW,
  MARKETPLACE_LABELS,
  MARKETPLACE_TIER,
} from "@/lib/constants";
import {
  CROSSLIST_PAIR_SLUGS,
  crosslistPairPath,
  type CrosslistPairSlug,
} from "./crosslist-pair-slugs";

export { crosslistPairPath };

/** How a listing actually reaches the destination marketplace. */
export type CrosslistMechanism = "api" | "extension" | "manual";

export interface CrosslistPair {
  slug: CrosslistPairSlug;
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  /** Impressions the pair's queries earned in the 2026-09-01 export. */
  impressions: number;
  /** The exact queries behind it, so the page can be judged against them. */
  queries: string[];
  /** Best average position across those queries at the time of the export. */
  bestPosition: number;
}

/** Verbatim from the export; the story's 90-day measurement reads against it. */
const PAIR_DEMAND: Record<CrosslistPairSlug, { impressions: number; bestPosition: number; queries: string[] }> = {
  "mercari-to-grailed": { impressions: 31, bestPosition: 11.9, queries: ["mercari to grailed", "import mercari to grailed", "cross list mercari to grailed"] },
  "grailed-to-mercari": { impressions: 24, bestPosition: 10.8, queries: ["grailed to mercari", "import grailed to mercari"] },
  "grailed-to-poshmark": { impressions: 21, bestPosition: 18.3, queries: ["grailed to poshmark", "import grailed to poshmark"] },
  "ebay-to-grailed": { impressions: 18, bestPosition: 19.8, queries: ["ebay to grailed", "import ebay to grailed"] },
  "whatnot-to-poshmark": { impressions: 17, bestPosition: 22.1, queries: ["whatnot to poshmark"] },
  "mercari-to-vinted": { impressions: 17, bestPosition: 22.5, queries: ["mercari to vinted"] },
  "poshmark-to-whatnot": { impressions: 17, bestPosition: 23.7, queries: ["poshmark to whatnot"] },
  "poshmark-to-grailed": { impressions: 16, bestPosition: 20.2, queries: ["poshmark to grailed"] },
  "grailed-to-ebay": { impressions: 14, bestPosition: 18.2, queries: ["grailed to ebay"] },
  "vinted-to-mercari": { impressions: 14, bestPosition: 22.1, queries: ["vinted to mercari"] },
  "mercari-to-poshmark": { impressions: 4, bestPosition: 23.2, queries: ["cross list from mercari to poshmark"] },
  "whatnot-to-ebay": { impressions: 4, bestPosition: 27.5, queries: ["whatnot to ebay"] },
  "vinted-to-poshmark": { impressions: 3, bestPosition: 29.7, queries: ["vinted to poshmark"] },
  "depop-to-poshmark": { impressions: 2, bestPosition: 16.5, queries: ["depop to poshmark"] },
};

function labelOf(platform: string): string {
  return MARKETPLACE_LABELS[platform as keyof typeof MARKETPLACE_LABELS] ?? platform;
}

export const CROSSLIST_PAIRS: CrosslistPair[] = CROSSLIST_PAIR_SLUGS.map((slug) => {
  const [from, to] = slug.split("-to-") as [string, string];
  const demand = PAIR_DEMAND[slug];
  return {
    slug,
    from,
    to,
    fromLabel: labelOf(from),
    toLabel: labelOf(to),
    impressions: demand.impressions,
    queries: demand.queries,
    bestPosition: demand.bestPosition,
  };
});

/**
 * How FlipDesk puts a listing ON a marketplace, from the constants alone.
 *
 * "api" only when the platform is in LIVE_CROSS_LISTING_PLATFORMS (a tier of
 * `api` alone is not enough — Depop and Etsy are `api_pending`). "extension"
 * only when the tier is extension AND its list flow reads `live`, so a channel
 * whose selectors are still being verified says "by hand" rather than
 * promising a run. Everything else is manual.
 */
export function destinationMechanism(platform: string): CrosslistMechanism {
  const tier = MARKETPLACE_TIER[platform as keyof typeof MARKETPLACE_TIER];
  if (tier === "api" && (LIVE_CROSS_LISTING_PLATFORMS as readonly string[]).includes(platform)) {
    return "api";
  }
  const flow = (MARKETPLACE_EXTENSION_FLOW as Record<string, string>)[platform];
  if (tier === "extension" && flow === "live") return "extension";
  return "manual";
}

/**
 * The marketplaces whose own listings the extension can read back out
 * (US-9201). Mirrors CLOSET_IMPORT_PLATFORMS in
 * src/lib/marketplace-disclosure.ts, which is NOT imported here on purpose:
 * public-routes.ts pulls this module in, and that file carries ~5.5 KB of
 * per-channel disclosure prose that the route registry must not drag into the
 * eager bundle graph. crosslist-pairs.test.ts asserts the two lists are equal,
 * so the copy here cannot outlive the capability.
 */
const CLOSET_READABLE = ["poshmark", "mercari"] as const;

/** Can the extension read this marketplace's own listings back out (US-9201)? */
export function canReadCloset(platform: string): boolean {
  return (CLOSET_READABLE as readonly string[]).includes(platform);
}

/** One sentence for how the listing lands on the destination. Never a promise. */
export function destinationSentence(pair: CrosslistPair): string {
  switch (destinationMechanism(pair.to)) {
    case "api":
      return `FlipDesk publishes to ${pair.toLabel} over ${pair.toLabel}'s own API, so the listing goes live from your dashboard.`;
    case "extension":
      return `${pair.toLabel} has no listing API for sellers. The GradeThread browser extension fills ${pair.toLabel}'s own listing form in your logged-in tab, and you press post.`;
    default:
      return `${pair.toLabel} has no seller listing API and no verified extension flow yet, so the last step is yours: FlipDesk holds the listing, the photos and the grade, and you paste them into ${pair.toLabel}.`;
  }
}

/** One sentence for how the item gets out of the source marketplace. */
export function sourceSentence(pair: CrosslistPair): string {
  return canReadCloset(pair.from)
    ? `The extension reads your own ${pair.fromLabel} closet and imports each listing as a FlipDesk item, with its photos, title, description and price.`
    : `${pair.fromLabel} has no export the extension can read yet, so the item starts from its photos: upload them and FlipDesk writes the title, the specifics and the price.`;
}

/** The page's own honest summary line, used as the answer block and the meta description. */
export function pairAnswer(pair: CrosslistPair): string {
  const mech = destinationMechanism(pair.to);
  const how = mech === "api"
    ? `published to ${pair.toLabel} over its API`
    : mech === "extension"
      ? `filled into ${pair.toLabel}'s own form by the browser extension`
      : `handed to you ready to paste into ${pair.toLabel}`;
  const read = canReadCloset(pair.from)
    ? `read out of ${pair.fromLabel} by the extension`
    : `rebuilt from the item's photos`;
  return `A ${pair.fromLabel} listing is ${read}, checked once in FlipDesk, then ${how} — with the condition grade travelling with the item.`;
}

export function getCrosslistPairBySlug(slug: string): CrosslistPair | undefined {
  return CROSSLIST_PAIRS.find((p) => p.slug === slug);
}

export function getCrosslistPairByPath(path: string): CrosslistPair | undefined {
  const clean = path.replace(/\/+$/, "");
  return CROSSLIST_PAIRS.find((p) => crosslistPairPath(p.slug) === clean);
}

export function crosslistPairRoutes(): PublicRoute[] {
  return CROSSLIST_PAIRS.map((p) => ({
    path: crosslistPairPath(p.slug),
    title: `${p.fromLabel} to ${p.toLabel}: cross-list a listing`,
    description:
      `How to cross-list from ${p.fromLabel} to ${p.toLabel}: what carries over, what ${p.toLabel} needs, ` +
      `and the tool that fills the form. ${p.toLabel} photo and size rules included.`,
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "Article",
  }));
}

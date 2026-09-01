// The crosslist pair SLUGS, and nothing else (US-9214).
//
// Same reason as competitor-alternative-slugs.ts: the router needs the paths to
// register them ahead of /reselling/:slug, and must not pull the page data into
// the eager entry chunk.

/**
 * Ordered pairs, each one a marketplace-to-marketplace query that actually
 * earned impressions in the 2026-09-01 Search Console export. Fourteen of a
 * possible forty-two: a pair with no demand and no mechanism gets no page.
 */
export const CROSSLIST_PAIR_SLUGS = [
  "mercari-to-grailed",
  "grailed-to-mercari",
  "grailed-to-poshmark",
  "ebay-to-grailed",
  "whatnot-to-poshmark",
  "mercari-to-vinted",
  "poshmark-to-whatnot",
  "poshmark-to-grailed",
  "grailed-to-ebay",
  "vinted-to-mercari",
  "mercari-to-poshmark",
  "whatnot-to-ebay",
  "vinted-to-poshmark",
  "depop-to-poshmark",
] as const;

export type CrosslistPairSlug = (typeof CROSSLIST_PAIR_SLUGS)[number];

/** The public path for a crosslist pair page. */
export function crosslistPairPath(slug: string): string {
  return `/reselling/crosslist/${slug}`;
}

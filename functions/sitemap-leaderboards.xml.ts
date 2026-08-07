// Reward-leaderboards sub-sitemap (US-1856). Linked from the /sitemap.xml index
// when the grand total exceeds SITEMAP_MAX_URLS; harmless to fetch directly.

import { type PagesEnv } from "./_shared/blog-render";
import { leaderboardUrls, sitemapResponse } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-leaderboards.xml", () => leaderboardUrls(env));
};

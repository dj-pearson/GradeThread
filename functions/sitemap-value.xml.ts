// Value Index sub-sitemap (US-1747). Linked from the /sitemap.xml index when the
// grand total exceeds SITEMAP_MAX_URLS; harmless to fetch directly anytime.

import { type PagesEnv } from "./_shared/blog-render";
import { valueIndexUrls, sitemapResponse } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-value.xml", () => valueIndexUrls(env));
};

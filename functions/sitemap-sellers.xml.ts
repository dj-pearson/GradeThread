// Verified-seller-profiles sub-sitemap. See functions/sitemap.xml.ts for the
// index. Public /verified/<handle> profiles are indexable trust surfaces.

import { type PagesEnv } from "./_shared/blog-render";
import { sellerUrls, sitemapResponse } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-sellers.xml", () => sellerUrls(env));
};

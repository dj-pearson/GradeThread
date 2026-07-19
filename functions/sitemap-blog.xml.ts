// Blog sub-sitemap (US-293). See functions/sitemap.xml.ts for the index.

import { type PagesEnv } from "./_shared/blog-render";
import { blogUrls, sitemapResponse } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-blog.xml", () => blogUrls(env));
};

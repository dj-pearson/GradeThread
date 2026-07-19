// Authors sub-sitemap (US-874). See functions/sitemap.xml.ts for the index.

import { type PagesEnv } from "./_shared/blog-render";
import { authorUrls, sitemapResponse } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-authors.xml", () => authorUrls(env));
};

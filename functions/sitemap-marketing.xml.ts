// Marketing static-routes sub-sitemap (US-1679). The non-grading registry
// routes; linked from the /sitemap.xml index. The grading pSEO routes are split
// into sitemap-grading.xml so GSC can report indexation per content class.

import { type PagesEnv } from "./_shared/blog-render";
import { marketingUrls, sitemapResponse } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-marketing.xml", () => marketingUrls(env));
};

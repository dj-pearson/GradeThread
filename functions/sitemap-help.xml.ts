// Help Center sub-sitemap (US-2578). Linked from the /sitemap.xml index.
//
// Only visibility='public' articles can appear, and not because this file
// filters them: it reads the ANONYMOUS endpoint, which cannot return anything
// else. A members-only or internal article is not a URL this file could
// advertise by mistake.

import { type PagesEnv } from "./_shared/blog-render";
import { helpUrls, sitemapResponse } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-help.xml", () => helpUrls(env));
};

// Grading pSEO sub-sitemap (US-1679). Every /grading/* route — the scale,
// methodology, disambiguation, the reseller glossary hub + term pages, and the
// tier/factor spokes — so GSC reports the grading pSEO indexation rate as its own
// KPI, separate from the marketing pages (sitemap-marketing.xml).

import { type PagesEnv } from "./_shared/blog-render";
import { gradingUrls, sitemapResponse } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-grading.xml", () => gradingUrls(env));
};

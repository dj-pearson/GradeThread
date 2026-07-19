// Garment-passport sub-sitemap (US-2110). See functions/sitemap.xml.ts for the index.
//
// /passport/:slug is SSR'd with full Product JSON-LD and is explicitly designed
// to be indexed — but had no generator, so the pages were discoverable only via
// inbound links. They also sit outside the static-route CI guard, which skips
// any path containing ":", so nothing flagged the omission.

import { type PagesEnv } from "./_shared/blog-render";
import { passportUrls, sitemapResponse } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-passports.xml", () => passportUrls(env));
};

// Help Center sub-sitemap (US-2578). Linked from the /sitemap.xml index.
//
// Only visibility='public' articles can appear, and not because this file
// filters them: it reads the ANONYMOUS endpoint, which cannot return anything
// else. A members-only or internal article is not a URL this file could
// advertise by mistake.

import {
  type PagesEnv,
  withEdgeCache,
} from "./_shared/blog-render";
import { helpUrls, sitemapResponse } from "./_shared/sitemap";

/**
 * US-2614: served from the worker cache, like every other SSR surface.
 *
 * Measured 2026-08-15: /blog and /cert/:id answered `x-gt-cache: HIT` while
 * every sitemap answered with no such header, so each one rebuilt on every
 * request. A crawler that reads the index and then fetches all fifteen sections
 * paid for fifteen uncached builds, against an edge that caps public content at
 * 60 requests per minute per IP and fails closed.
 *
 * withEdgeCache stores only publicly-cacheable 200s, so the US-2097 guard below
 * still answers 503 on an unreachable upstream and that 503 is never cached.
 */
export const onRequestGet: PagesFunction<PagesEnv> = (context) =>
  withEdgeCache(context, () => buildSitemap(context.env));

async function buildSitemap(env: PagesEnv): Promise<Response> {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-help.xml", () => helpUrls(env));
}

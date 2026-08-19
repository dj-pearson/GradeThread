// Care cluster sub-sitemap (US-9015). Every /care/* route: the 32 flaw removal
// and prevention pages moved out of /grading/flaws by US-9012.
//
// WHY ITS OWN SEGMENT rather than sitting in sitemap-marketing.xml with the
// pricing page and the calculators. A sitemap segment is a statement about what
// a group of pages IS, and the containment decision says these are not the same
// kind of thing as the commercial surface. Separating them also means GSC
// reports the care cluster's indexation and impressions as its own line, which
// is what US-9016's kill criteria need in order to be answerable at all.
//
// The ratio of care URLs to everything else is reported by careRatio() in
// functions/_shared/sitemap.ts, with the ceiling and its reasoning in
// vault/40-growth/seo-strategy-options-2026-08.md.

import {
  type PagesEnv,
  withEdgeCache,
} from "./_shared/blog-render";
import { careUrls, sitemapResponse } from "./_shared/sitemap";
import { headOf } from "./_shared/head-of";

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
  return sitemapResponse("sitemap-care.xml", () => careUrls(env));
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

// Buyer-trust cluster sub-sitemap (US-3093). Every /buying/* route.
//
// WHY ITS OWN SEGMENT, and why the reason differs from care's. Care is separated
// because it is a different SUBJECT. This is separated because it is written for
// a different PERSON: GradeThread's customer is a seller, and every page under
// /buying is read by somebody about to hand money to a stranger on a
// marketplace. Mixing them into sitemap-marketing.xml would tell a crawler these
// pages are part of the commercial surface, which is the entity confusion the
// containment exists to prevent.
//
// It also makes the measurement answerable. US-3093's kill condition is zero
// extension installs from more than 500 impressions, and you cannot read that
// off a segment that also contains the pricing page.
//
// The ratio of buying URLs to everything else is reported by buyingRatio() in
// functions/_shared/sitemap.ts, capped at 10% — a quarter of care's ceiling,
// with the reasoning beside it.

import {
  type PagesEnv,
  withEdgeCache,
} from "./_shared/blog-render";
import { buyingUrls, sitemapResponse } from "./_shared/sitemap";
import { headOf } from "./_shared/head-of";

/** US-2614: served from the worker cache, like every other sitemap segment. */
export const onRequestGet: PagesFunction<PagesEnv> = (context) =>
  withEdgeCache(context, () => buildSitemap(context.env));

async function buildSitemap(env: PagesEnv): Promise<Response> {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-buying.xml", () => buyingUrls(env));
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

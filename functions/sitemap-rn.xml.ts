// RN lookup sub-sitemap (US-9032). See functions/sitemap.xml.ts for the index.
//
// Lists ONLY the numbers we can name. The unresolved ones render for humans and
// carry noindex; putting them here instead would be asking a crawler to judge
// the domain on pages that answer nothing.

import { type PagesEnv, withEdgeCache } from "./_shared/blog-render";
import { rnUrls, sitemapResponse } from "./_shared/sitemap";
import { headOf } from "./_shared/head-of";

export const onRequestGet: PagesFunction<PagesEnv> = (context) =>
  withEdgeCache(context, () => buildSitemap(context.env));

async function buildSitemap(env: PagesEnv): Promise<Response> {
  // US-2097: 503 on an unreachable upstream rather than a silently-incomplete
  // 200 that tells crawlers these URLs do not exist.
  return sitemapResponse("sitemap-rn.xml", () => rnUrls(env));
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

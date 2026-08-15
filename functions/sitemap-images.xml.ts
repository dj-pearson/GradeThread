// Image sitemap (US-975). Lists the public marketing share images + each blog
// post's hero image, grouped under the page they appear on, so Google Images
// can discover and index them. Linked from the /sitemap.xml index and
// advertised in robots.txt; harmless to fetch directly anytime.

import {
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  type PagesEnv,
  withEdgeCache,
} from "./_shared/blog-render";
import { imageUrls, imageSitemapXml, SITEMAP_HEADERS } from "./_shared/sitemap";

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
  // US-2097: 503 rather than a silently-incomplete 200. This route does NOT use
  // the shared sitemapResponse helper because it serialises a different entry
  // shape (imageSitemapXml, not urlsetXml) — so it carries its own guard. Worth
  // noting explicitly: it is the one sub-sitemap the bulk rewrite could not
  // match, which is exactly the file that would otherwise have been missed.
  let entries: Awaited<ReturnType<typeof imageUrls>>;
  try {
    entries = await imageUrls(env);
  } catch (e) {
    if (e instanceof UpstreamUnavailable) {
      console.error("[sitemap-images.xml] upstream unavailable — serving 503:", e.message);
      return upstreamUnavailableResponse();
    }
    throw e;
  }
  return new Response(imageSitemapXml(entries), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
}

// Dynamic sitemap (US-293). Builds itself from the SEO route registry manifest
// + published blog posts/tags + public certificates — no hand-edited XML.
//
// When the grand total is within SITEMAP_MAX_URLS, /sitemap.xml is a single
// <urlset>. Above that, it becomes a <sitemapindex> pointing at the per-section
// sitemaps (sitemap-static.xml / sitemap-blog.xml / sitemap-certs.xml), each
// served by its own Pages Function.

import {
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  withEdgeCache,
  type PagesEnv,
} from "./_shared/blog-render";
import type { SitemapUrl } from "./_shared/sitemap";
import {
  staticUrls,
  blogUrls,
  certUrls,
  passportUrls,
  sellerUrls,
  conditionIndexUrls,
  findsUrls,
  leaderboardUrls,
  valueIndexUrls,
  durabilityUrls,
  authorUrls,
  helpUrls,
  urlsetXml,
  sitemapIndexXml,
  newestLastmod,
  SITEMAP_MAX_URLS,
  SITEMAP_HEADERS,
} from "./_shared/sitemap";
import { headOf } from "./_shared/head-of";

/**
 * US-2614: served from the worker cache, like every other SSR surface.
 *
 * MEASURED 2026-08-15, not assumed. /blog and /cert/:id both answer
 * `x-gt-cache: HIT`; /sitemap.xml carried no such header at all, so it was the
 * one public surface rebuilding itself on every single request.
 *
 * That is expensive in a way the others are not: the builder below makes
 * ELEVEN parallel upstream fetches. The edge caps /api/content/public/* at 60
 * requests per minute per IP and fails closed, and every SSR page reaches it
 * through one Cloudflare Pages worker — so three uncached sitemap fetches in a
 * minute is 33 calls against that shared bucket, and eight is 88, which is how
 * a probe drove this endpoint to 503 four times running.
 *
 * The bypass that is meant to exempt this hop is currently OFF
 * (features.pages_origin_bypass on /health/ready reports the secret missing,
 * US-2612), so the cap is live. This does not fix that and is not a substitute
 * for it — the secret still has to be set on both sides. It removes the
 * multiplier, which is worth having either way: a crawler re-fetching the
 * sitemap should not cost eleven database reads each time.
 *
 * Correctness is unchanged. withEdgeCache only stores 200s that are publicly
 * cacheable, so the 503 the UpstreamUnavailable branch returns is never cached
 * — a transient blip cannot pin a Retry-After for an hour.
 */
export const onRequestGet: PagesFunction<PagesEnv> = (context) =>
  withEdgeCache(context, () => buildSitemap(context.env));

async function buildSitemap(env: PagesEnv): Promise<Response> {
  // US-2097: a transient upstream failure must NOT produce a structurally valid
  // sitemap that silently omits whole URL classes — served 200 and cached for an
  // hour, which tells crawlers those pages do not exist. Worse, a dropped
  // section can push the total back under SITEMAP_MAX_URLS and flip this
  // document from a sitemapindex to a truncated single urlset, changing its
  // SHAPE because of a network blip. Serve 503 + Retry-After instead, exactly as
  // rss.xml.ts has since US-2044.
  let statics: SitemapUrl[],
    blog: SitemapUrl[],
    certs: SitemapUrl[],
    passports: SitemapUrl[],
    sellers: SitemapUrl[],
    condition: SitemapUrl[],
    value: SitemapUrl[],
    durability: SitemapUrl[],
    finds: SitemapUrl[],
    leaderboards: SitemapUrl[],
    authors: SitemapUrl[],
    help: SitemapUrl[];
  try {
    [statics, blog, certs, passports, sellers, condition, value, durability, finds, leaderboards, authors, help] =
      await Promise.all([
      staticUrls(env),
      blogUrls(env),
      certUrls(env),
      passportUrls(env),
      sellerUrls(env),
      conditionIndexUrls(env),
      valueIndexUrls(env),
      durabilityUrls(env),
      findsUrls(env),
      leaderboardUrls(env),
      authorUrls(env),
      helpUrls(env),
    ]);
  } catch (e) {
    if (e instanceof UpstreamUnavailable) {
      console.error("[sitemap.xml] upstream unavailable — serving 503:", e.message);
      return upstreamUnavailableResponse();
    }
    throw e;
  }

  const total =
    statics.length +
    blog.length +
    certs.length +
    passports.length +
    sellers.length +
    condition.length +
    value.length +
    durability.length +
    finds.length +
    leaderboards.length +
    authors.length +
    help.length;

  const xml =
    total > SITEMAP_MAX_URLS
      ? sitemapIndexXml(env, [
          // US-1679: the static registry split into marketing vs grading pSEO so
          // per-segment indexation is observable in GSC.
          //
          // US-2100: each entry carries the newest lastmod from the URLs that
          // section actually contains, instead of every entry claiming today()
          // every day. The static split is derived from `statics` because
          // marketingUrls/gradingUrls partition exactly that set.
          { name: "sitemap-marketing.xml", lastmod: newestLastmod(statics) },
          { name: "sitemap-grading.xml", lastmod: newestLastmod(statics) },
          { name: "sitemap-blog.xml", lastmod: newestLastmod(blog) },
          { name: "sitemap-certs.xml", lastmod: newestLastmod(certs) },
          { name: "sitemap-passports.xml", lastmod: newestLastmod(passports) },
          { name: "sitemap-sellers.xml", lastmod: newestLastmod(sellers) },
          { name: "sitemap-condition.xml", lastmod: newestLastmod(condition) },
          { name: "sitemap-value.xml", lastmod: newestLastmod(value) },
          { name: "sitemap-durability.xml", lastmod: newestLastmod(durability) },
          { name: "sitemap-finds.xml", lastmod: newestLastmod(finds) },
          { name: "sitemap-leaderboards.xml", lastmod: newestLastmod(leaderboards) },
          { name: "sitemap-authors.xml", lastmod: newestLastmod(authors) },
          // US-2578: the Help Center. Its lastmod comes from the articles'
          // reviewed_at, so it moves when somebody re-read one, not every day.
          { name: "sitemap-help.xml", lastmod: newestLastmod(help) },
          // The image sitemap is generated from the blog payload, so its
          // content date is the blog's.
          { name: "sitemap-images.xml", lastmod: newestLastmod(blog) },
        ])
      : urlsetXml([
          ...statics,
          ...blog,
          ...certs,
          ...passports,
          ...sellers,
          ...condition,
          ...value,
          ...durability,
          ...finds,
          ...leaderboards,
          ...authors,
          ...help,
        ]);

  return new Response(xml, { status: 200, headers: { ...SITEMAP_HEADERS } });
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

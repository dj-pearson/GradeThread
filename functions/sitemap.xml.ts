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
  type PagesEnv,
} from "./_shared/blog-render";
import type { SitemapUrl } from "./_shared/sitemap";
import {
  staticUrls,
  blogUrls,
  certUrls,
  sellerUrls,
  conditionIndexUrls,
  valueIndexUrls,
  durabilityUrls,
  authorUrls,
  urlsetXml,
  sitemapIndexXml,
  SITEMAP_MAX_URLS,
  SITEMAP_HEADERS,
} from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
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
    sellers: SitemapUrl[],
    condition: SitemapUrl[],
    value: SitemapUrl[],
    durability: SitemapUrl[],
    authors: SitemapUrl[];
  try {
    [statics, blog, certs, sellers, condition, value, durability, authors] = await Promise.all([
      staticUrls(env),
      blogUrls(env),
      certUrls(env),
      sellerUrls(env),
      conditionIndexUrls(env),
      valueIndexUrls(env),
      durabilityUrls(env),
      authorUrls(env),
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
    sellers.length +
    condition.length +
    value.length +
    durability.length +
    authors.length;

  const xml =
    total > SITEMAP_MAX_URLS
      ? sitemapIndexXml(env, [
          // US-1679: the static registry split into marketing vs grading pSEO so
          // per-segment indexation is observable in GSC.
          "sitemap-marketing.xml",
          "sitemap-grading.xml",
          "sitemap-blog.xml",
          "sitemap-certs.xml",
          "sitemap-sellers.xml",
          "sitemap-condition.xml",
          "sitemap-value.xml",
          "sitemap-durability.xml",
          "sitemap-authors.xml",
          "sitemap-images.xml",
        ])
      : urlsetXml([
          ...statics,
          ...blog,
          ...certs,
          ...sellers,
          ...condition,
          ...value,
          ...durability,
          ...authors,
        ]);

  return new Response(xml, { status: 200, headers: { ...SITEMAP_HEADERS } });
};

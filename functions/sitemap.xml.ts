// Dynamic sitemap (US-293). Builds itself from the SEO route registry manifest
// + published blog posts/tags + public certificates — no hand-edited XML.
//
// When the grand total is within SITEMAP_MAX_URLS, /sitemap.xml is a single
// <urlset>. Above that, it becomes a <sitemapindex> pointing at the per-section
// sitemaps (sitemap-static.xml / sitemap-blog.xml / sitemap-certs.xml), each
// served by its own Pages Function.

import { type PagesEnv } from "./_shared/blog-render";
import {
  staticUrls,
  blogUrls,
  certUrls,
  urlsetXml,
  sitemapIndexXml,
  SITEMAP_MAX_URLS,
  SITEMAP_HEADERS,
} from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const [statics, blog, certs] = await Promise.all([
    staticUrls(env),
    blogUrls(env),
    certUrls(env),
  ]);

  const total = statics.length + blog.length + certs.length;

  const xml =
    total > SITEMAP_MAX_URLS
      ? sitemapIndexXml(env, [
          "sitemap-static.xml",
          "sitemap-blog.xml",
          "sitemap-certs.xml",
        ])
      : urlsetXml([...statics, ...blog, ...certs]);

  return new Response(xml, { status: 200, headers: { ...SITEMAP_HEADERS } });
};

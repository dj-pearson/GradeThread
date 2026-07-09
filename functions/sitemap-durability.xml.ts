// Durability Rankings sub-sitemap (US-1774). Linked from the /sitemap.xml index
// when the grand total exceeds SITEMAP_MAX_URLS; harmless to fetch directly.

import { type PagesEnv } from "./_shared/blog-render";
import { durabilityUrls, urlsetXml, SITEMAP_HEADERS } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const urls = await durabilityUrls(env);
  return new Response(urlsetXml(urls), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
};

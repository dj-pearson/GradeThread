// Condition Index sub-sitemap (US-621). Linked from the /sitemap.xml index when
// the grand total exceeds SITEMAP_MAX_URLS; harmless to fetch directly anytime.

import { type PagesEnv } from "./_shared/blog-render";
import { conditionIndexUrls, urlsetXml, SITEMAP_HEADERS } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const urls = await conditionIndexUrls(env);
  return new Response(urlsetXml(urls), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
};

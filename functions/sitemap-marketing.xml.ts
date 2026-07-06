// Marketing static-routes sub-sitemap (US-1679). The non-grading registry
// routes; linked from the /sitemap.xml index. The grading pSEO routes are split
// into sitemap-grading.xml so GSC can report indexation per content class.

import { type PagesEnv } from "./_shared/blog-render";
import { marketingUrls, urlsetXml, SITEMAP_HEADERS } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const urls = await marketingUrls(env);
  return new Response(urlsetXml(urls), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
};

// Authors sub-sitemap (US-874). See functions/sitemap.xml.ts for the index.

import { type PagesEnv } from "./_shared/blog-render";
import { authorUrls, urlsetXml, SITEMAP_HEADERS } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const urls = await authorUrls(env);
  return new Response(urlsetXml(urls), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
};

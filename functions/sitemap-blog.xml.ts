// Blog sub-sitemap (US-293). See functions/sitemap.xml.ts for the index.

import { type PagesEnv } from "./_shared/blog-render";
import { blogUrls, urlsetXml, SITEMAP_HEADERS } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const urls = await blogUrls(env);
  return new Response(urlsetXml(urls), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
};

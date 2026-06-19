// Image sitemap (US-975). Lists the public marketing share images + each blog
// post's hero image, grouped under the page they appear on, so Google Images
// can discover and index them. Linked from the /sitemap.xml index and
// advertised in robots.txt; harmless to fetch directly anytime.

import { type PagesEnv } from "./_shared/blog-render";
import { imageUrls, imageSitemapXml, SITEMAP_HEADERS } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const entries = await imageUrls(env);
  return new Response(imageSitemapXml(entries), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
};

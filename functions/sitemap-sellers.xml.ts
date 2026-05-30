// Verified-seller-profiles sub-sitemap. See functions/sitemap.xml.ts for the
// index. Public /verified/<handle> profiles are indexable trust surfaces.

import { type PagesEnv } from "./_shared/blog-render";
import { sellerUrls, urlsetXml, SITEMAP_HEADERS } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const urls = await sellerUrls(env);
  return new Response(urlsetXml(urls), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
};

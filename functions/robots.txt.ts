// Dynamic robots.txt — replaces public/robots.txt so the sitemap URL
// always reflects the deployed PUBLIC_SITE_URL.

import { siteUrl, type PagesEnv } from "./_shared/blog-render";

export const onRequestGet: PagesFunction<PagesEnv> = ({ env }) => {
  const base = siteUrl(env);
  const body = `User-agent: *
Allow: /
Allow: /blog/
Disallow: /dashboard/
Disallow: /admin/
Disallow: /auth/
Disallow: /api/

Sitemap: ${base}/sitemap.xml
`;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};

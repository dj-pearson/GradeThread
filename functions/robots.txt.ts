// Dynamic robots.txt — explicit per-user-agent crawl policy for AI + search
// crawlers (PRD: tasks/prd-seo-hardening.md, US-295). The sitemap URL always
// reflects the deployed PUBLIC_SITE_URL.

import { siteUrl, type PagesEnv } from "./_shared/blog-render";
import { buildRobotsTxt } from "./_shared/seo-config";

export const onRequestGet: PagesFunction<PagesEnv> = ({ env }) => {
  const body = buildRobotsTxt({ siteUrl: siteUrl(env) });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};

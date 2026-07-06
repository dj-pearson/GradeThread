// Grading pSEO sub-sitemap (US-1679). Every /grading/* route — the scale,
// methodology, disambiguation, the reseller glossary hub + term pages, and the
// tier/factor spokes — so GSC reports the grading pSEO indexation rate as its own
// KPI, separate from the marketing pages (sitemap-marketing.xml).

import { type PagesEnv } from "./_shared/blog-render";
import { gradingUrls, urlsetXml, SITEMAP_HEADERS } from "./_shared/sitemap";

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const urls = await gradingUrls(env);
  return new Response(urlsetXml(urls), {
    status: 200,
    headers: { ...SITEMAP_HEADERS },
  });
};

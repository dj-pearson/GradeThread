// /llms.txt — a curated Markdown map of the site for LLMs / AI answer engines
// (PRD: tasks/prd-seo-hardening.md, US-295).

import { siteUrl, type PagesEnv } from "./_shared/blog-render";
import { buildLlmsTxt } from "./_shared/seo-config";

export const onRequestGet: PagesFunction<PagesEnv> = ({ env }) => {
  const base = siteUrl(env);
  const body = buildLlmsTxt({
    siteUrl: base,
    summary:
      "GradeThread provides standardized, AI-powered condition grading for pre-owned clothing. Sellers upload garment photos and receive a numerical condition grade (1.0–10.0), a detailed condition report, and a shareable verification certificate. Built by Pearson Media LLC.",
    sections: [
      {
        heading: "Product",
        links: [
          {
            title: "GradeThread home",
            url: "/",
            note: "AI clothing condition grading for resellers.",
          },
        ],
      },
      {
        heading: "Content",
        links: [
          {
            title: "Blog",
            url: "/blog",
            note: "Condition-grading guides, reseller workflows, and FlipDesk how-tos.",
          },
          {
            title: "RSS feed",
            url: "/rss.xml",
            note: "Latest published articles.",
          },
        ],
      },
      {
        heading: "Reference",
        links: [
          {
            title: "Sitemap",
            url: "/sitemap.xml",
            note: "All indexable URLs.",
          },
        ],
      },
      {
        heading: "Legal",
        links: [
          { title: "Privacy Policy", url: "/privacy" },
          { title: "Terms of Service", url: "/terms" },
          { title: "Cookie Policy", url: "/cookies" },
          { title: "Acceptable Use", url: "/acceptable-use" },
        ],
      },
    ],
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};

// /llms.txt — a curated Markdown map of the site for LLMs / AI answer engines
// (PRD: tasks/prd-seo-hardening.md, US-295).

import { siteUrl, type PagesEnv } from "./_shared/blog-render";
import { buildLlmsTxt } from "./_shared/seo-config";

export const onRequestGet: PagesFunction<PagesEnv> = ({ env }) => {
  const base = siteUrl(env);
  const body = buildLlmsTxt({
    siteUrl: base,
    summary:
      "GradeThread is the trusted standard for pre-owned clothing condition grading. Sellers upload garment photos and receive an objective numerical condition grade (1.0–10.0), a detailed condition report, and a shareable verification certificate — like a PSA or CGC grade, but for used clothing. Resellers also run their full eBay/Poshmark/Mercari workflow in FlipDesk: source, catalog, grade, list, sell, and reconcile. Built by Pearson Media LLC.",
    sections: [
      {
        heading: "Product",
        links: [
          {
            title: "GradeThread home",
            url: "/",
            note: "The standard for pre-owned clothing condition grading — objective, AI-powered, verifiable.",
          },
          {
            title: "What is clothing condition grading?",
            url: "/condition-grading",
            note: "The 1.0–10.0 scale, the 7 tiers (NWT to Poor), and the 5 weighted grading factors.",
          },
          {
            title: "FlipDesk for resellers",
            url: "/for-resellers",
            note: "Run the full reselling workflow — source, catalog, grade, list, sell, reconcile — on top of the grading standard.",
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

// Types for seed-help-articles.mjs, so the guard test in
// src/test/help-content.test.ts can import its pure helpers under `tsc -b`.
// Same pattern as csp-hash.d.mts.

export interface SeedFaqPair {
  question: string;
  answer: string;
}

export interface SeedArticle {
  slug: string;
  title: string;
  category_key: string;
  summary: string;
  visibility: string;
  status: string;
  audience: string;
  sort_order: number;
  pillar_path: string | null;
  faq: SeedFaqPair[];
  body_markdown: string;
  body_html: string;
  reviewed_at: string;
  published_at: string;
}

export function parseArticle(raw: string, filename: string): SeedArticle;
export function markdownToHtml(md: string): string;
export function loadArticles(dir?: string): SeedArticle[];

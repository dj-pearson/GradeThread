// Shared rendering helpers for the public blog SSR (Cloudflare Pages Functions).
// String-based templating keeps the worker tiny — no React, no MDX, no jsx
// runtime on the edge. Body HTML is already sanitized at publish time in the
// edge service, so we can drop it into the template as-is.

export interface PagesEnv {
  // Edge API base, e.g. https://functions.gradethread.com
  EDGE_API_URL?: string;
  // Public site URL used in canonical links + OG metadata
  PUBLIC_SITE_URL?: string;
}

export interface PublicPostListItem {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  product_focus: "gradethread" | "flipdesk" | "both";
  hero_image_url: string | null;
  primary_keyword: string | null;
  reading_time_min: number | null;
  published_at: string;
  updated_at: string;
}

export interface PublicPost extends PublicPostListItem {
  body_html: string;
  seo_title: string | null;
  seo_description: string | null;
  secondary_keywords: string[];
  jsonld: Record<string, unknown> | null;
  tags: string[];
}

// Defaults. The Pages Function reads context.env first; these are fallbacks
// for previews and for local Wrangler runs.
export const DEFAULT_EDGE_API_URL = "https://functions.gradethread.com";
export const DEFAULT_PUBLIC_SITE_URL = "https://gradethread.com";

export function edgeApi(env: PagesEnv): string {
  return env.EDGE_API_URL ?? DEFAULT_EDGE_API_URL;
}

export function siteUrl(env: PagesEnv): string {
  return env.PUBLIC_SITE_URL ?? DEFAULT_PUBLIC_SITE_URL;
}

// Cache-Control we serve on every SSR response. Short browser cache + an
// hour at the Cloudflare edge + a day of stale-while-revalidate. Publish
// triggers a Cloudflare API purge so changes still appear immediately.
export const SSR_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escape(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c);
}

// JSON for <script type=application/ld+json>. Strip </script> for safety.
export function jsonSafe(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003C");
}

interface LayoutInput {
  title: string;
  description: string;
  canonicalUrl: string;
  ogImage?: string | null;
  jsonLd?: unknown[];
  bodyHtml: string;
  noindex?: boolean;
}

// Inline base styles. Kept tiny on purpose. Inherits the brand colors
// from the SPA's index.css indirectly — actually no, the SPA's CSS is
// not loaded on these pages. So we ship a small base stylesheet here.
const BASE_STYLES = `
  :root { --bg: #fff; --fg: #1A1A2E; --muted: #6b7280; --accent: #0F3460; --red: #E94560; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif; }
  a { color: var(--accent); }
  a:hover { text-decoration: underline; }
  .container { max-width: 720px; margin: 0 auto; padding: 24px 20px; }
  .container--wide { max-width: 1080px; }
  header.site { border-bottom: 1px solid #e5e7eb; }
  header.site .container { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; }
  header.site a.brand { font-weight: 700; color: var(--fg); text-decoration: none; }
  header.site nav a { margin-left: 16px; color: var(--muted); text-decoration: none; font-size: 14px; }
  header.site nav a:hover { color: var(--fg); }
  footer.site { border-top: 1px solid #e5e7eb; margin-top: 64px; padding: 32px 20px; color: var(--muted); font-size: 14px; text-align: center; }
  h1 { font-size: 2.25rem; line-height: 1.2; margin: 0 0 16px; }
  h2 { font-size: 1.5rem; line-height: 1.3; margin: 32px 0 12px; }
  h3 { font-size: 1.2rem; line-height: 1.4; margin: 24px 0 8px; }
  p { margin: 0 0 16px; }
  ul, ol { margin: 0 0 16px 24px; }
  li { margin: 4px 0; }
  blockquote { border-left: 3px solid var(--accent); margin: 16px 0; padding: 8px 16px; color: var(--muted); background: #f9fafb; }
  pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.95em; }
  pre { background: #f3f4f6; padding: 12px; border-radius: 6px; overflow-x: auto; }
  img { max-width: 100%; height: auto; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: left; }
  th { background: #f9fafb; font-weight: 600; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 32px 0; }
  iframe { width: 100%; aspect-ratio: 16 / 9; border: 0; border-radius: 8px; }
  .post-meta { color: var(--muted); font-size: 0.9rem; margin-bottom: 24px; }
  .post-meta .sep { margin: 0 8px; }
  .hero { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 8px; margin-bottom: 24px; }
  .post-card { display: block; padding: 16px 0; border-bottom: 1px solid #e5e7eb; text-decoration: none; color: inherit; }
  .post-card:hover { background: #f9fafb; }
  .post-card h2 { margin: 0 0 8px; font-size: 1.25rem; }
  .post-card p { color: var(--muted); margin: 0; }
  .tag-list { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 24px; }
  .tag-list a { display: inline-block; padding: 4px 10px; background: #f3f4f6; border-radius: 999px; font-size: 0.85rem; text-decoration: none; color: var(--muted); }
  .tag-list a:hover { background: var(--accent); color: white; }
  .cta { display: inline-block; margin-top: 24px; padding: 12px 24px; background: var(--accent); color: white; text-decoration: none; border-radius: 6px; font-weight: 500; }
  .cta:hover { background: #0a274a; text-decoration: none; }
`;

export function renderLayout(input: LayoutInput): string {
  const ldScripts = (input.jsonLd ?? [])
    .map(
      (ld) =>
        `<script type="application/ld+json">${jsonSafe(ld)}</script>`,
    )
    .join("");
  const robots = input.noindex ? "noindex, nofollow" : "index, follow";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(input.title)}</title>
<meta name="description" content="${escape(input.description)}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${escape(input.canonicalUrl)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="GradeThread Blog" href="/rss.xml">
<meta property="og:type" content="article">
<meta property="og:title" content="${escape(input.title)}">
<meta property="og:description" content="${escape(input.description)}">
<meta property="og:url" content="${escape(input.canonicalUrl)}">
<meta property="og:site_name" content="GradeThread">
${input.ogImage ? `<meta property="og:image" content="${escape(input.ogImage)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escape(input.title)}">
<meta name="twitter:description" content="${escape(input.description)}">
${input.ogImage ? `<meta name="twitter:image" content="${escape(input.ogImage)}">` : ""}
<style>${BASE_STYLES}</style>
${ldScripts}
</head>
<body>
<header class="site">
  <div class="container">
    <a class="brand" href="/">GradeThread</a>
    <nav>
      <a href="/blog">Blog</a>
      <a href="/">Try GradeThread</a>
      <a href="/login">Sign in</a>
    </nav>
  </div>
</header>
${input.bodyHtml}
<footer class="site">
  <div class="container">
    &copy; ${new Date().getFullYear()} Pearson Media LLC &middot; GradeThread &middot;
    <a href="/privacy">Privacy</a> &middot;
    <a href="/terms">Terms</a> &middot;
    <a href="/rss.xml">RSS</a>
  </div>
</footer>
</body>
</html>`;
}

export function notFoundResponse(env: PagesEnv): Response {
  return new Response(
    renderLayout({
      title: "Not found — GradeThread",
      description: "The page you're looking for doesn't exist.",
      canonicalUrl: `${siteUrl(env)}/blog`,
      noindex: true,
      bodyHtml: `<main class="container"><h1>404</h1><p>That post doesn't exist (or was unpublished). <a href="/blog">Back to the blog</a>.</p></main>`,
    }),
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// Best-effort JSON fetch from the edge API. Returns null on any error so
// callers can render a graceful 404/500.
export async function fetchJson<T>(
  env: PagesEnv,
  path: string,
): Promise<T | null> {
  try {
    const res = await fetch(`${edgeApi(env)}${path}`, {
      headers: { Accept: "application/json" },
      // 8s — Cloudflare Pages Functions have a 30s wall but we want the
      // page to fail fast rather than burn the budget on a stuck upstream.
      signal: AbortSignal.timeout(8_000),
      cf: { cacheTtl: 60, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) {
      console.warn(`[blog ssr] upstream ${res.status} ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.warn(`[blog ssr] upstream error ${path}:`, e);
    return null;
  }
}

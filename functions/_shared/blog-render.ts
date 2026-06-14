// Shared rendering helpers for the public blog SSR (Cloudflare Pages Functions).
// String-based templating keeps the worker tiny — no React, no MDX, no jsx
// runtime on the edge. Body HTML is already sanitized at publish time in the
// edge service, so we can drop it into the template as-is.

export interface PagesEnv {
  // Edge API base, e.g. https://functions.gradethread.com
  EDGE_API_URL?: string;
  // Public site URL used in canonical links + OG metadata
  PUBLIC_SITE_URL?: string;
  // "true" once Cloudflare Image Resizing/Transformations is enabled on the
  // zone. Until then /cdn-cgi/image/ 404s, so the blog SSR must NOT emit a
  // resize srcset (a failed candidate renders broken — no fallback to src).
  // Cloudflare Pages exposes dashboard env vars to BOTH the Vite build (as
  // import.meta.env.VITE_CF_IMAGE_RESIZING) and Functions runtime (here), so
  // it's the same single toggle the React <Image> component reads.
  VITE_CF_IMAGE_RESIZING?: string;
  // GA4 Measurement ID for the public blog SSR pages (US-255). Defaults to the
  // SPA's stream (G-CMDWCFC275) so blog + app report into one property. Set to
  // "off" / empty to disable injection.
  GA4_MEASUREMENT_ID?: string;
  // US-781: shared secret sent as `x-pages-origin` on server-to-server calls to
  // the edge so the public-content rate limiter bypasses this internal hop (one
  // Pages IP fronts all blog/cert visitors and would otherwise drain one bucket).
  // Must equal the edge's CF_PAGES_ORIGIN_SECRET. Unset = no header (limiter
  // treats the Pages worker as a normal IP — degraded but not broken).
  CF_PAGES_ORIGIN_SECRET?: string;
  // US-428: brand social profiles for entity disambiguation. Same VITE_-prefixed
  // dashboard vars the SPA reads (Cloudflare exposes them to both the Vite build
  // and the Functions runtime), so blog SSR + app emit identical twitter:site /
  // Organization.sameAs. Emitted only when set — never a placeholder URL.
  VITE_TWITTER_SITE?: string;
  VITE_TWITTER_CREATOR?: string;
  VITE_SOCIAL_X?: string;
  VITE_SOCIAL_LINKEDIN?: string;
  VITE_SOCIAL_INSTAGRAM?: string;
  VITE_SOCIAL_CRUNCHBASE?: string;
  // US-430: AI training-crawler policy. Unset (default) = allow training bots
  // (GPTBot/ClaudeBot/Google-Extended/Applebot-Extended) to crawl the public
  // site. Set to "disallow"/"block"/"off" to emit Disallow blocks for them in
  // robots.txt without a code change. Citation/search bots are always allowed;
  // aggressive scrapers (BLOCKED_AI_AGENTS) are always blocked.
  AI_TRAINING_CRAWLERS?: string;
}

// US-428: the always-live GitHub profile (mirrors src/lib/seo/social.ts).
const GITHUB_PROFILE = "https://github.com/dj-pearson/GradeThread";

/** Live external profiles for `Organization.sameAs` (GitHub + configured). */
export function socialProfileUrls(env: PagesEnv): string[] {
  return [
    GITHUB_PROFILE,
    env.VITE_SOCIAL_X,
    env.VITE_SOCIAL_LINKEDIN,
    env.VITE_SOCIAL_INSTAGRAM,
    env.VITE_SOCIAL_CRUNCHBASE,
  ]
    .map((u) => (u ?? "").trim())
    .filter((u) => /^https?:\/\//.test(u));
}

/** Brand X @handle for `twitter:site`, normalized to a leading "@" ("" if unset). */
export function twitterSiteHandle(env: PagesEnv): string {
  const raw = (env.VITE_TWITTER_SITE ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("@") ? raw : `@${raw}`;
}

// The SPA ships this same stream in index.html; keep them in sync so the blog
// SSR and the app report into one GA4 property.
export const DEFAULT_GA4_MEASUREMENT_ID = "G-CMDWCFC275";

export function ga4MeasurementId(env: PagesEnv): string | null {
  const raw = (env.GA4_MEASUREMENT_ID ?? DEFAULT_GA4_MEASUREMENT_ID).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw;
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

export interface BlogFaq {
  q: string;
  a: string;
}

// US-874: a named author entity (content_authors row) surfaced to the SSR for
// the Person JSON-LD on articles and for the /authors/:slug profile page.
export interface PublicAuthor {
  slug: string;
  name: string;
  /** jobTitle in Person JSON-LD, e.g. "Lead Condition Analyst". */
  title: string | null;
  /** Markdown bio (rendered as escaped paragraphs on the author page). */
  bio_md?: string | null;
  avatar_url: string | null;
  /** Credentials / qualifications (E-E-A-T expertise signal). */
  credentials?: string[];
  /** External profile URLs → Person.sameAs. */
  same_as?: string[];
}

// US-876: per-body-image SEO metadata, keyed by image src. Applied when
// rewriting in-body <img> tags (stored alt overrides the filename guess; a
// caption wraps the image in <figure><figcaption>).
export interface InlineImageMeta {
  src: string;
  alt?: string;
  caption?: string;
  width?: number | null;
  height?: number | null;
}

export interface PublicPost extends PublicPostListItem {
  body_html: string;
  seo_title: string | null;
  seo_description: string | null;
  secondary_keywords: string[];
  jsonld: Record<string, unknown> | null;
  tags: string[];
  // Image SEO (US-876): hero alt/caption/credit + dimensions for the hero
  // ImageObject, and per-inline-image metadata. Optional → legacy posts render
  // fine (alt falls back to the title; ImageObject omits unknown dimensions).
  hero_image_alt?: string | null;
  hero_image_caption?: string | null;
  hero_image_credit?: string | null;
  hero_image_width?: number | null;
  hero_image_height?: number | null;
  inline_images?: InlineImageMeta[];
  // Blog GEO / E-E-A-T fields (US-304). Optional → legacy posts render fine.
  author?: string | null;
  // US-874: the linked author entity. Present when the post has an author_id;
  // absent on legacy posts (the byline-only `author` string is the fallback).
  author_entity?: PublicAuthor | null;
  key_takeaways?: string[];
  faqs?: BlogFaq[];
  related?: PublicPostListItem[];
  // Topic-cluster hub-and-spoke uplink (US-873): the cornerstone pillar page
  // this post ladders up to. Absent on posts published before the interlinker
  // or whose pillar (e.g. FlipDesk clusters) has no cornerstone page yet.
  pillar?: string | null;
  pillar_url?: string | null;
  pillar_label?: string | null;
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

/** True only when Cloudflare Image Resizing is confirmed enabled on the zone. */
export function imageResizingEnabled(env: PagesEnv): boolean {
  return env.VITE_CF_IMAGE_RESIZING === "true";
}

// Cache-Control we serve on every SSR response. Short browser cache + an
// hour at the Cloudflare edge + a day of stale-while-revalidate. Publish
// triggers a Cloudflare API purge so changes still appear immediately.
export const SSR_CACHE_CONTROL =
  "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

// ─── Edge read-through cache (US-577) ─────────────────────────────────────
// Cloudflare Pages Functions are NOT cached by the colo by default — the
// `s-maxage` in SSR_CACHE_CONTROL only governs *downstream* shared caches, so
// without this every crawler/share/repeat hit re-renders. Wrapping the render
// in the Cache API (caches.default) gives a real edge HIT on repeat requests;
// publish/score-change writes call purgeCloudflareCache() (cloudflare-purge.ts)
// to evict by URL, so changes still appear immediately.
//
//   - Keyed on origin + pathname (query string ignored), so utm-tagged share
//     links share one entry and can't fragment or poison the cache.
//   - Only GET 200 responses are stored.
//   - Adds `x-gt-cache: HIT|MISS` so a HIT is verifiable with `curl -I`.
//   - cache.put runs in waitUntil() so the first (MISS) response isn't blocked.
//   - Degrades to a plain render when `caches` is unavailable (local/preview).
interface EdgeCacheCtx {
  request: Request;
  waitUntil(promise: Promise<unknown>): void;
}

// Minimal structural type for the Cloudflare Cache API (caches.default), so this
// module stays importable from the Vitest/`src` side where the workers `Cache`
// lib type isn't loaded.
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export async function withEdgeCache(
  context: EdgeCacheCtx,
  build: () => Promise<Response>,
): Promise<Response> {
  const { request } = context;
  const store = (globalThis as { caches?: { default?: EdgeCache } }).caches
    ?.default;
  if (!store || request.method !== "GET") return build();

  const url = new URL(request.url);
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: "GET" });

  const cached = await store.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("x-gt-cache", "HIT");
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

  const response = await build();
  // Only cache successful, publicly-cacheable responses. Skips error/redirect
  // statuses and any private path (e.g. the blog `preview` route serves
  // `private, no-store` — caching it would leak an unpublished draft, and
  // Cloudflare's cache.put rejects no-store anyway).
  const cc = (response.headers.get("Cache-Control") ?? "").toLowerCase();
  if (response.status !== 200 || cc.includes("no-store") || cc.includes("private")) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("x-gt-cache", "MISS");
  const stored = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  context.waitUntil(store.put(cacheKey, stored.clone()));
  return stored;
}

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

// US-872: Open Graph `article:*` metadata for rich pins / social cards. Only
// emitted on og:type="article" pages (the blog posts). Pinterest's rich-pin
// validator reads article:published_time + article:author to upgrade a pin to
// an Article rich pin.
export interface ArticleMeta {
  publishedTime?: string | null;
  modifiedTime?: string | null;
  author?: string | null;
  section?: string | null;
  tags?: string[] | null;
}

interface LayoutInput {
  title: string;
  description: string;
  canonicalUrl: string;
  ogImage?: string | null;
  jsonLd?: unknown[];
  bodyHtml: string;
  noindex?: boolean;
  // US-425: Open Graph type. Defaults to "article" (the blog). The cert SSR
  // passes "product" so og:type stays consistent with the page's primary
  // entity (a Product JSON-LD node) and matches the SPA cert route.
  ogType?: string;
  // US-872: article:* OG tags (rich pins). Emitted only when ogType="article".
  articleMeta?: ArticleMeta;
  // US-428: brand X @handle for twitter:site (pass twitterSiteHandle(env)).
  // Omitted from the head when empty.
  twitterSite?: string;
  // US-255: when set, inject GA4 gtag.js (Consent Mode v2, all-denied default —
  // mirrors index.html). Pass ga4MeasurementId(env) from the Pages Function.
  gaMeasurementId?: string | null;
}

// GA4 snippet for the SSR <head>. Mirrors index.html exactly: Consent Mode v2
// defaults everything to denied (GDPR/CCPA), queues config on the dataLayer,
// and defers gtag.js to idle so it stays off the LCP path. No cookies are set
// until consent is granted elsewhere.
function ga4Snippet(measurementId: string): string {
  const id = measurementId.replace(/[^A-Za-z0-9-]/g, "");
  return `<script>(function(){window.dataLayer=window.dataLayer||[];function gtag(){window.dataLayer.push(arguments);}window.gtag=gtag;gtag("consent","default",{ad_storage:"denied",ad_user_data:"denied",ad_personalization:"denied",analytics_storage:"denied",wait_for_update:500});gtag("js",new Date());gtag("config","${id}");function load(){if(window.__gtagLoaded)return;window.__gtagLoaded=true;var s=document.createElement("script");s.async=true;s.src="https://www.googletagmanager.com/gtag/js?id=${id}";document.head.appendChild(s);}if("requestIdleCallback" in window){requestIdleCallback(load,{timeout:4000});}else{setTimeout(load,2500);}})();</script>`;
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
  figure { margin: 0 0 24px; }
  figure.content-figure { margin: 16px 0 24px; }
  figcaption { margin-top: 8px; font-size: 0.85rem; color: var(--muted); text-align: center; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: left; }
  th { background: #f9fafb; font-weight: 600; }
  hr { border: 0; border-top: 1px solid #e5e7eb; margin: 32px 0; }
  iframe { width: 100%; aspect-ratio: 16 / 9; border: 0; border-radius: 8px; }
  .breadcrumbs { max-width: 720px; margin: 0 auto; padding: 20px 20px 0; font-size: 0.85rem; color: var(--muted); }
  .breadcrumbs a { color: var(--muted); text-decoration: none; }
  .breadcrumbs a:hover { color: var(--fg); text-decoration: underline; }
  .breadcrumbs .bc-sep { margin: 0 8px; }
  .breadcrumbs [aria-current="page"] { color: var(--fg); font-weight: 600; }
  .breadcrumbs--wide { max-width: 1080px; }
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
  .pin-save { margin: 16px 0 0; }
  .pin-button { display: inline-block; padding: 8px 16px; background: #e60023; color: white; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 0.9rem; }
  .pin-button:hover { background: #ad081b; text-decoration: none; }
  .post-meta .author { font-weight: 600; color: var(--fg); }
  .post-meta .updated { color: var(--accent); }
  .key-takeaways { background: #f9fafb; border: 1px solid #e5e7eb; border-left: 4px solid var(--accent); border-radius: 8px; padding: 16px 20px; margin: 0 0 24px; }
  .key-takeaways h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent); margin: 0 0 8px; }
  .key-takeaways ul { margin: 0 0 0 20px; }
  .key-takeaways li { margin: 6px 0; }
  .toc { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 20px; margin: 0 0 32px; font-size: 0.95rem; }
  .toc-title { font-weight: 600; margin: 0 0 8px; }
  .toc ul { margin: 0 0 0 18px; }
  .toc li { margin: 4px 0; }
  .faq { margin-top: 48px; }
  .faq dl { margin: 16px 0 0; }
  .faq dt { font-weight: 600; margin-top: 16px; }
  .faq dd { margin: 4px 0 0; color: var(--muted); }
  .pillar-link { margin: 24px 0 0; font-size: 0.9375rem; color: var(--muted); }
  .pillar-link a { color: var(--brand-navy, #0F3460); font-weight: 500; }
  .related { margin-top: 48px; border-top: 1px solid #e5e7eb; padding-top: 24px; }
  .related-grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
  @media (min-width: 640px) { .related-grid { grid-template-columns: repeat(3, 1fr); } }
  .related-card { display: block; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; text-decoration: none; color: inherit; }
  .related-card:hover { background: #f9fafb; }
  .related-card h3 { margin: 0 0 6px; font-size: 1rem; }
  .related-card p { margin: 0; color: var(--muted); font-size: 0.875rem; }
  .post-meta .author a { color: inherit; text-decoration: none; }
  .post-meta .author a:hover { text-decoration: underline; }
  .author-header { display: flex; align-items: center; gap: 20px; margin: 8px 0 24px; }
  .author-avatar { width: 96px; height: 96px; border-radius: 999px; object-fit: cover; flex-shrink: 0; background: #f3f4f6; }
  .author-header h1 { margin: 0 0 4px; }
  .author-title { color: var(--accent); font-weight: 600; margin: 0; }
  .author-credentials { margin: 24px 0; }
  .author-credentials h2 { font-size: 1.1rem; }
  .author-credentials ul { margin: 0 0 0 24px; }
  .author-sameas { margin: 16px 0 0; display: flex; flex-wrap: wrap; gap: 12px; }
  .author-sameas a { font-size: 0.9rem; }
  .author-posts { margin-top: 40px; border-top: 1px solid #e5e7eb; padding-top: 24px; }
  .author-card { display: block; padding: 16px 0; border-bottom: 1px solid #e5e7eb; text-decoration: none; color: inherit; }
  .author-card:hover { background: #f9fafb; }
  .author-card h3 { margin: 0 0 6px; font-size: 1.1rem; }
  .author-card p { margin: 0; color: var(--muted); font-size: 0.9rem; }
`;

export function renderLayout(input: LayoutInput): string {
  const ldScripts = (input.jsonLd ?? [])
    .map(
      (ld) =>
        `<script type="application/ld+json">${jsonSafe(ld)}</script>`,
    )
    .join("");
  const robots = input.noindex ? "noindex, nofollow" : "index, follow";
  const ogType = input.ogType ?? "article";
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
<meta property="og:type" content="${escape(ogType)}">
<meta property="og:title" content="${escape(input.title)}">
<meta property="og:description" content="${escape(input.description)}">
<meta property="og:url" content="${escape(input.canonicalUrl)}">
<meta property="og:site_name" content="GradeThread">
${input.ogImage ? `<meta property="og:image" content="${escape(input.ogImage)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escape(input.title)}">
<meta name="twitter:description" content="${escape(input.description)}">
${input.ogImage ? `<meta name="twitter:image" content="${escape(input.ogImage)}">` : ""}
${input.twitterSite ? `<meta name="twitter:site" content="${escape(input.twitterSite)}">` : ""}
${ogType === "article" ? renderArticleMetaTags(input.articleMeta) : ""}
<style>${BASE_STYLES}</style>
${input.gaMeasurementId ? ga4Snippet(input.gaMeasurementId) : ""}
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

// ─── Breadcrumbs (US-433) ─────────────────────────────────────────────────
// Single source of truth for the SSR pages' breadcrumb trail: the SAME items
// feed both the visible <nav> and the BreadcrumbList JSON-LD, so the on-page
// hierarchy can't drift from the structured data. Pure (no CF globals) so
// they're unit-testable from Vitest.
export interface BreadcrumbItem {
  name: string;
  /** Absolute, e.g. https://gradethread.com/blog — matches the JSON-LD `item`. */
  url: string;
}

/** BreadcrumbList JSON-LD from a {name,url} trail. */
export function breadcrumbListLd(
  items: ReadonlyArray<BreadcrumbItem>,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

/**
 * Visible breadcrumb <nav> whose links + labels match breadcrumbListLd(items).
 * Absolute SITE_URL links are emitted as root-relative paths (same-origin
 * navigation). The last item is the current page (aria-current, not a link).
 * Returns "" for a single-item trail (nothing to show).
 */
export function renderBreadcrumbs(
  items: ReadonlyArray<BreadcrumbItem>,
  siteBase: string,
  opts?: { wide?: boolean },
): string {
  if (items.length < 2) return "";
  const parts = items
    .map((it, i) => {
      const isLast = i === items.length - 1;
      const rel = it.url.startsWith(siteBase)
        ? it.url.slice(siteBase.length) || "/"
        : it.url;
      const sep =
        i > 0 ? `<span class="bc-sep" aria-hidden="true">&rsaquo;</span>` : "";
      const node = isLast
        ? `<span aria-current="page">${escape(it.name)}</span>`
        : `<a href="${escape(rel)}">${escape(it.name)}</a>`;
      return `${sep}${node}`;
    })
    .join("");
  // Wide variant aligns with .container--wide pages (blog index/tag).
  const cls = opts?.wide ? "breadcrumbs breadcrumbs--wide" : "breadcrumbs";
  return `<nav class="${cls}" aria-label="Breadcrumb">${parts}</nav>`;
}

export function notFoundResponse(env: PagesEnv): Response {
  return new Response(
    renderLayout({
      title: "Not found — GradeThread",
      description: "The page you're looking for doesn't exist.",
      canonicalUrl: `${siteUrl(env)}/blog`,
      twitterSite: twitterSiteHandle(env),
      noindex: true,
      bodyHtml: `<main class="container"><h1>404</h1><p>That post doesn't exist (or was unpublished). <a href="/blog">Back to the blog</a>.</p></main>`,
    }),
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// ─── Blog GEO helpers (US-304) ────────────────────────────────────────────
// Pure functions (no Cloudflare globals) so they're unit-testable. They power
// the answer-first key-takeaways block, the auto table-of-contents, on-page FAQ
// + FAQPage JSON-LD, the author byline, the visible "Updated <date>", and the
// related-posts internal-link block on each article.

/** Human date, e.g. "March 5, 2026". Falls back to the raw ISO on parse error. */
export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/** Strip tags + collapse whitespace from a heading's inner HTML. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Slugify a heading into a stable anchor id. */
export function slugifyHeading(text: string): string {
  return (
    stripTags(text)
      .toLowerCase()
      .replace(/&[a-z]+;/g, " ") // drop entities like &amp;
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "section"
  );
}

/**
 * Scan rendered body HTML for <h2> headings, ensure each carries a unique id
 * (so the TOC can anchor to it), and return the rewritten HTML plus the TOC
 * entries. Idempotent: existing ids are preserved and de-duplicated.
 */
export function buildTableOfContents(html: string): {
  html: string;
  toc: Array<{ id: string; text: string }>;
} {
  const toc: Array<{ id: string; text: string }> = [];
  const used = new Set<string>();
  const out = html.replace(
    /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi,
    (match, attrs: string, inner: string) => {
      const text = stripTags(inner);
      if (!text) return match;
      const existing = attrs.match(/\bid="([^"]+)"/i)?.[1];
      let id = existing ?? slugifyHeading(text);
      let unique = id;
      let n = 2;
      while (used.has(unique)) unique = `${id}-${n++}`;
      id = unique;
      used.add(id);
      toc.push({ id, text });
      const newAttrs = existing
        ? attrs.replace(/\bid="[^"]*"/i, `id="${id}"`)
        : `${attrs} id="${id}"`;
      return `<h2${newAttrs}>${inner}</h2>`;
    },
  );
  return { html: out, toc };
}

/** Answer-first key-takeaways block. Empty string when there's nothing to show. */
export function renderKeyTakeaways(items: string[] | undefined | null): string {
  const clean = (items ?? []).map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  const lis = clean.map((t) => `<li>${escape(t)}</li>`).join("");
  return `<aside class="key-takeaways"><h2>Key takeaways</h2><ul>${lis}</ul></aside>`;
}

/** Table-of-contents nav. Only worthwhile with 2+ headings; else empty string. */
export function renderTableOfContents(
  toc: Array<{ id: string; text: string }>,
): string {
  if (toc.length < 2) return "";
  const lis = toc
    .map((h) => `<li><a href="#${escape(h.id)}">${escape(h.text)}</a></li>`)
    .join("");
  return `<nav class="toc" aria-label="Table of contents"><p class="toc-title">On this page</p><ul>${lis}</ul></nav>`;
}

/** Visible on-page FAQ. Empty string when there are no FAQs. */
export function renderFaqSection(faqs: BlogFaq[] | undefined | null): string {
  const clean = (faqs ?? []).filter((f) => f?.q?.trim() && f?.a?.trim());
  if (clean.length === 0) return "";
  const items = clean
    .map(
      (f) =>
        `<dt>${escape(f.q.trim())}</dt><dd>${escape(f.a.trim())}</dd>`,
    )
    .join("");
  return `<section class="faq"><h2>Frequently asked questions</h2><dl>${items}</dl></section>`;
}

/** FAQPage JSON-LD for the article's FAQs, or null when there are none. */
export function faqPageJsonLd(
  faqs: BlogFaq[] | undefined | null,
): Record<string, unknown> | null {
  const clean = (faqs ?? []).filter((f) => f?.q?.trim() && f?.a?.trim());
  if (clean.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: clean.map((f) => ({
      "@type": "Question",
      name: f.q.trim(),
      acceptedAnswer: { "@type": "Answer", text: f.a.trim() },
    })),
  };
}

/** Related-posts internal-link block (by shared tag). Empty when none. */
export function renderRelatedPosts(
  related: PublicPostListItem[] | undefined | null,
): string {
  const clean = (related ?? []).filter((p) => p?.slug && p?.title);
  if (clean.length === 0) return "";
  const cards = clean
    .map(
      (p) =>
        `<a class="related-card" href="/blog/${escape(p.slug)}"><h3>${escape(
          p.title,
        )}</h3>${p.excerpt ? `<p>${escape(p.excerpt)}</p>` : ""}</a>`,
    )
    .join("");
  return `<section class="related"><h2>Keep reading</h2><div class="related-grid">${cards}</div></section>`;
}

/**
 * Hub-and-spoke uplink (US-873): a contextual line laddering the post up to its
 * cornerstone pillar page. Empty string when the post has no pillar with a
 * cornerstone (e.g. a FlipDesk-cluster post). Internal relative href + escaped
 * label, so it's inherently within the content-sanitize allowlist.
 */
export function renderPillarLink(
  url: string | null | undefined,
  label: string | null | undefined,
): string {
  const href = (url ?? "").trim();
  const text = (label ?? "").trim();
  if (!href || !text) return "";
  return `<p class="pillar-link">Part of our <a href="${escape(href)}">${escape(
    text,
  )}</a> guide.</p>`;
}

// ─── Pinterest rich pins + vertical pin pipeline (US-872) ──────────────────
// Pinterest is a primary discovery channel for clothing + reselling. Two
// surfaces feed it: (1) `article:*` OG tags (renderArticleMetaTags) so a pinned
// post validates as an Article rich pin, and (2) a vertical 1000x1500 "pin"
// card via the US-871 social-card endpoint plus an on-page "Save to Pinterest"
// affordance carrying that media + a keyword-rich description + the destination
// URL. All pure + escaped so they're unit-testable from Vitest.

export type PinProduct = "gradethread" | "flipdesk" | "both";

/**
 * `article:*` Open Graph meta tags Pinterest (and other crawlers) read to
 * validate an article rich pin. Returns "" when meta is absent; the caller only
 * passes it for og:type="article" pages so product/cert pages stay clean.
 * Times must be ISO-8601; author/section/tags are escaped.
 */
export function renderArticleMetaTags(meta: ArticleMeta | undefined): string {
  if (!meta) return "";
  const tags: string[] = [];
  if (meta.publishedTime) {
    tags.push(
      `<meta property="article:published_time" content="${escape(meta.publishedTime)}">`,
    );
  }
  if (meta.modifiedTime) {
    tags.push(
      `<meta property="article:modified_time" content="${escape(meta.modifiedTime)}">`,
    );
  }
  if (meta.author?.trim()) {
    tags.push(
      `<meta property="article:author" content="${escape(meta.author.trim())}">`,
    );
  }
  if (meta.section?.trim()) {
    tags.push(
      `<meta property="article:section" content="${escape(meta.section.trim())}">`,
    );
  }
  for (const t of meta.tags ?? []) {
    if (t?.trim()) {
      tags.push(`<meta property="article:tag" content="${escape(t.trim())}">`);
    }
  }
  return tags.join("\n");
}

/**
 * Vertical 1000x1500 pin image URL via the US-871 card endpoint
 * (`/og/social/card?ratio=pin`). `kind=title` renders the post title on-brand.
 * `siteBase` is the absolute origin (https://gradethread.com).
 */
export function buildPinImageUrl(
  siteBase: string,
  opts: { title: string; product?: PinProduct; eyebrow?: string | null },
): string {
  const base = siteBase.replace(/\/$/, "");
  const qs = new URLSearchParams({
    ratio: "pin",
    kind: "title",
    text: opts.title,
    product: opts.product ?? "gradethread",
  });
  if (opts.eyebrow?.trim()) qs.set("eyebrow", opts.eyebrow.trim());
  return `${base}/og/social/card?${qs.toString()}`;
}

/**
 * "Save to Pinterest" affordance: a dedicated pin-create link carrying the
 * destination URL (with UTM), the vertical pin media, and a keyword-rich
 * description, plus the `data-pin-*` attributes the Pinterest Save button /
 * browser extension read. `pinUrl` should be the canonical post URL with pin
 * UTM params; `description` is capped to Pinterest's 500-char limit.
 */
export function renderPinterestSave(opts: {
  pinUrl: string;
  media: string;
  description: string;
}): string {
  const description = opts.description.trim().slice(0, 500);
  const href = "https://www.pinterest.com/pin/create/button/?" +
    new URLSearchParams({
      url: opts.pinUrl,
      media: opts.media,
      description,
    }).toString();
  return `<div class="pin-save"><a class="pin-button" href="${escape(href)}" ` +
    `target="_blank" rel="nofollow noopener" data-pin-do="buttonPin" ` +
    `data-pin-url="${escape(opts.pinUrl)}" data-pin-media="${escape(opts.media)}" ` +
    `data-pin-description="${escape(description)}">Save to Pinterest</a></div>`;
}

// ─── Responsive images (US-306) ───────────────────────────────────────────
// Cloudflare Image Resizing for the SSR blog: the hero + in-body content images
// (R2-hosted) are served through `/cdn-cgi/image/<opts>/<src>` with format=auto
// (AVIF/WebP negotiation), fit=scale-down, and onerror=redirect (fall back to
// the original if a transform fails). PREREQUISITE: Image Resizing enabled on
// the zone. Mirrors src/lib/images.ts for the React side.

const IMG_QUALITY = 80;

/** Build a Cloudflare Image Resizing URL for `src` at a given pixel width. */
export function cfImage(src: string, width: number, quality = IMG_QUALITY): string {
  if (!src || src.startsWith("data:") || src.includes("/cdn-cgi/image/")) {
    return src;
  }
  const opts = `width=${width},quality=${quality},format=auto,fit=scale-down,onerror=redirect`;
  const source = src.startsWith("http") ? src : src.replace(/^\//, "");
  return `/cdn-cgi/image/${opts}/${source}`;
}

/** `srcset` string for the given candidate widths. */
export function buildSrcSet(src: string, widths: number[], quality = IMG_QUALITY): string {
  if (!src || src.startsWith("data:")) return "";
  return widths
    .filter((w) => w > 0)
    .map((w) => `${cfImage(src, w, quality)} ${w}w`)
    .join(", ");
}

// The blog content column is 720px wide; heroes span it, content images too.
const BLOG_IMG_WIDTHS = [640, 1024, 1600];
const BLOG_IMG_SIZES = "(max-width: 720px) 100vw, 720px";

/**
 * Hero <img>. Eager + high priority (it's the LCP). A responsive `/cdn-cgi`
 * srcset is only emitted when `resize` is true (Cloudflare Image Resizing
 * confirmed on the zone — see imageResizingEnabled). Off → plain original,
 * which always loads; a 404-ing resize candidate would render broken instead.
 */
export function renderHeroImage(
  src: string | null | undefined,
  alt: string,
  resize = false,
  caption?: string | null,
): string {
  if (!src) return "";
  const srcset = resize ? buildSrcSet(src, BLOG_IMG_WIDTHS) : "";
  // US-876: never ship an empty hero alt. The caller passes a fallback (the post
  // title), but guard here too so a future caller can't regress accessibility.
  const safeAlt = (alt ?? "").trim() || "GradeThread blog hero illustration";
  const img =
    `<img class="hero" src="${escape(src)}"` +
    (srcset ? ` srcset="${escape(srcset)}" sizes="${BLOG_IMG_SIZES}"` : "") +
    ` alt="${escape(safeAlt)}" loading="eager" fetchpriority="high" decoding="async">`;
  // US-876: wrap in <figure>/<figcaption> only when a caption exists.
  const cap = (caption ?? "").trim();
  if (!cap) return img;
  return `<figure class="hero-figure">${img}<figcaption>${escape(cap)}</figcaption></figure>`;
}

/**
 * ImageObject JSON-LD for the hero/primary image (US-876). Referenced from the
 * Article `image` field so Google + AI engines get structured contentUrl /
 * dimensions / caption instead of a bare URL string. Returns null when there is
 * no hero (the caller falls back to the logo URL).
 */
export function heroImageObjectLd(input: {
  url: string | null | undefined;
  alt?: string | null;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
}): Record<string, unknown> | null {
  const url = (input.url ?? "").trim();
  if (!url) return null;
  const obj: Record<string, unknown> = {
    "@type": "ImageObject",
    url,
    contentUrl: url,
  };
  const alt = (input.alt ?? "").trim();
  const caption = (input.caption ?? "").trim();
  // `caption` is the schema.org field; mirror alt into it when no human caption.
  if (caption || alt) obj.caption = caption || alt;
  if (alt) obj.description = alt;
  if (typeof input.width === "number" && input.width > 0) obj.width = input.width;
  if (typeof input.height === "number" && input.height > 0) obj.height = input.height;
  return obj;
}

/**
 * Derive a sensible, human-readable alt text from an image `src` (US-434).
 * Humanizes the filename ("vintage-levis-jacket.jpg" → "vintage levis jacket")
 * when it looks word-like; returns "" for hash/UUID filenames so the caller can
 * fall back to a page-level label instead of surfacing gibberish to AT/crawlers.
 */
export function deriveAltFromSrc(src: string): string {
  const noQuery = (src.split(/[?#]/)[0] ?? "").trim();
  const file = noQuery.split("/").pop() ?? "";
  const base = file.replace(/\.[a-z0-9]+$/i, "");
  const words = base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "";
  if (!/[a-z]/i.test(words)) return ""; // no letters (e.g. "1024x768")
  if (/^[0-9a-f]{16,}$/i.test(base)) return ""; // long hex hash / content-addressed
  if (words.replace(/[^a-z]/gi, "").length < 3) return ""; // too few letters to be a label
  return words;
}

/**
 * Rewrite in-body content <img> tags for SEO + a11y + CLS (US-306, US-434):
 *   - lazy `loading`/`decoding` hints (always safe)
 *   - a responsive `/cdn-cgi` srcset/sizes when `resize` is true (gated because
 *     the transform endpoint 404s until Cloudflare Image Resizing is enabled)
 *   - a `sensible alt fallback` when the image carries none — derived from the
 *     filename, else `opts.fallbackAlt` (the post title), else "" (US-434 AC#1)
 *   - a guaranteed `aspect-ratio` reservation when the image has no explicit
 *     width+height, so the layout doesn't shift as images load (US-434 AC#2).
 *     `auto 16/9` reserves 16:9 up front but defers to the image's natural ratio
 *     once known, so nothing is permanently distorted.
 * Idempotent: a second pass is a no-op (every guard already trips). Body HTML is
 * sanitized upstream, so this only adds attributes — it never introduces tags.
 */
export function rewriteContentImages(
  html: string,
  resize = false,
  opts: { fallbackAlt?: string; imageMeta?: InlineImageMeta[] } = {},
): string {
  const fallbackAlt = (opts.fallbackAlt ?? "").trim();
  // US-876: index stored per-image metadata by src for O(1) lookup.
  const metaBySrc = new Map<string, InlineImageMeta>();
  for (const m of opts.imageMeta ?? []) {
    if (m && typeof m.src === "string" && m.src.trim()) metaBySrc.set(m.src.trim(), m);
  }
  return html.replace(/<img\b([^>]*?)\s*\/?>/gi, (full, attrs: string) => {
    const src = attrs.match(/\bsrc="([^"]+)"/i)?.[1];
    if (!src || src.startsWith("data:")) return full;
    const meta = metaBySrc.get(src);
    const alreadyResponsive =
      /\bsrcset=/i.test(attrs) || /\/cdn-cgi\/image\//i.test(attrs);
    let extra = "";
    if (resize && !alreadyResponsive) {
      const srcset = buildSrcSet(src, BLOG_IMG_WIDTHS);
      if (srcset) extra += ` srcset="${escape(srcset)}" sizes="${BLOG_IMG_SIZES}"`;
    }
    if (!/\bloading=/i.test(attrs)) extra += ` loading="lazy"`;
    if (!/\bdecoding=/i.test(attrs)) extra += ` decoding="async"`;
    // Backfill a missing alt (an explicit alt="" decorative marker is respected).
    // US-876: prefer the stored alt for this src, else the filename guess, else
    // the post-title fallback — so no in-body img ever ships with empty alt.
    if (!/\balt=/i.test(attrs)) {
      const storedAlt = (meta?.alt ?? "").trim();
      const alt = storedAlt || deriveAltFromSrc(src) || fallbackAlt;
      extra += ` alt="${escape(alt)}"`;
    }
    // Reserve layout: explicit width+height already lets the browser compute the
    // ratio; otherwise add a guaranteed (non-distorting) aspect-ratio fallback.
    const hasDims = /\bwidth=/i.test(attrs) && /\bheight=/i.test(attrs);
    if (!hasDims && !/\bstyle=/i.test(attrs)) {
      extra += ` style="aspect-ratio:auto 16/9"`;
    }
    // Re-emit without the trailing void-slash the upstream sanitizer adds, so
    // appended attributes don't land after a stray `/`.
    const img = extra ? `<img${attrs.replace(/\s+$/, "")}${extra}>` : full;
    // US-876: wrap in <figure>/<figcaption> when a stored caption exists.
    const caption = (meta?.caption ?? "").trim();
    if (caption) return `<figure class="content-figure">${img}<figcaption>${escape(caption)}</figcaption></figure>`;
    return img;
  });
}

// ─── Certificate Product JSON-LD (US-300 / US-425) ────────────────────────
// Single source-of-truth shape for the cert grade descriptor, shared by the
// cert SSR Pages Function (functions/cert/[id].ts). It is a deliberate mirror
// of src/lib/seo/json-ld.ts `certificateLd()` (the SPA route): an SSR↔SPA
// equivalence test (src/lib/seo/__tests__/json-ld.test.ts) imports BOTH and
// asserts they produce byte-identical output for the same input, so the two
// code paths can't drift. Keep this pure (no Cloudflare globals) so it stays
// unit-testable from the Vite/Vitest side.
export interface CertProductLdInput {
  id: string;
  title: string;
  overallScore: number;
  gradeTier: string;
  category?: string | null;
  brand?: string | null;
  images?: string[] | null;
  datePublished?: string | null;
  /** Public site origin without a trailing slash, e.g. https://gradethread.com */
  siteUrl: string;
}

export function certificateProductLd(
  cert: CertProductLdInput,
): Record<string, unknown> {
  const canonical = `${cert.siteUrl}/cert/${cert.id}`;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": canonical,
    name: cert.title,
    ...(cert.category ? { category: cert.category } : {}),
    ...(cert.brand ? { brand: { "@type": "Brand", name: cert.brand } } : {}),
    ...(cert.images && cert.images.length ? { image: cert.images } : {}),
    itemCondition: "https://schema.org/UsedCondition",
    review: {
      "@type": "Review",
      name: `Condition grade: ${cert.gradeTier} (${cert.overallScore.toFixed(1)}/10)`,
      reviewRating: {
        "@type": "Rating",
        ratingValue: cert.overallScore,
        bestRating: 10,
        worstRating: 1,
        alternateName: cert.gradeTier,
      },
      author: { "@type": "Organization", name: "GradeThread", url: cert.siteUrl },
      ...(cert.datePublished ? { datePublished: cert.datePublished } : {}),
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
  };
}

/** Article author node — a Person for E-E-A-T, else the GradeThread Team org. */
export function articleAuthorLd(
  author: string | null | undefined,
  siteUrl: string,
): Record<string, unknown> {
  const name = author?.trim();
  return name
    ? { "@type": "Person", name }
    : { "@type": "Organization", name: "GradeThread Team", url: siteUrl };
}

// ─── Author entities (US-874) ─────────────────────────────────────────────
// E-E-A-T: a linked author entity becomes a full Person node (name, url to the
// author page, jobTitle, sameAs) instead of a bare byline string. The author
// page itself emits ProfilePage → Person. Pure (no CF globals) → unit-testable.

/** Absolute URL of an author's profile page. */
export function authorUrl(siteUrl: string, slug: string): string {
  return `${siteUrl}/authors/${slug}`;
}

/** Live external profile URLs for an author's Person.sameAs (http(s) only). */
function cleanSameAs(sameAs: string[] | undefined | null): string[] {
  return (sameAs ?? [])
    .map((u) => (u ?? "").trim())
    .filter((u) => /^https?:\/\//.test(u));
}

/**
 * A full Person node for an author entity (US-874). Used as the Article `author`
 * and embedded in the author page's ProfilePage. Omits empty optional fields so
 * we never assert a blank jobTitle / image / sameAs.
 */
export function authorPersonLd(
  author: PublicAuthor,
  siteUrl: string,
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@type": "Person",
    name: author.name,
    url: authorUrl(siteUrl, author.slug),
  };
  if (author.title?.trim()) node.jobTitle = author.title.trim();
  if (author.avatar_url?.trim()) node.image = author.avatar_url.trim();
  const sameAs = cleanSameAs(author.same_as);
  if (sameAs.length) node.sameAs = sameAs;
  const knows = (author.credentials ?? [])
    .map((c) => c.trim())
    .filter(Boolean);
  if (knows.length) node.knowsAbout = knows;
  return node;
}

/**
 * The Article `author` node: the linked Person entity when present, else the
 * legacy byline string (Person) / "GradeThread Team" (Organization) fallback.
 */
export function postAuthorLd(post: PublicPost, siteUrl: string): Record<string, unknown> {
  return post.author_entity
    ? authorPersonLd(post.author_entity, siteUrl)
    : articleAuthorLd(post.author, siteUrl);
}

/** ProfilePage JSON-LD emitted on the author page itself (US-874). */
export function profilePageLd(
  author: PublicAuthor,
  siteUrl: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url: authorUrl(siteUrl, author.slug),
    mainEntity: authorPersonLd(author, siteUrl),
  };
}

/**
 * Render an author's markdown bio as escaped paragraphs. We do NOT run a full
 * markdown parser at the edge — the bio is plain prose, so we split on blank
 * lines and escape every paragraph (no raw HTML reaches the page).
 */
export function renderAuthorBio(md: string | null | undefined): string {
  const text = (md ?? "").trim();
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escape(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Credentials list block for the author page. Empty string when none. */
export function renderAuthorCredentials(
  credentials: string[] | undefined | null,
): string {
  const clean = (credentials ?? []).map((c) => c.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  const lis = clean.map((c) => `<li>${escape(c)}</li>`).join("");
  return `<section class="author-credentials"><h2>Credentials</h2><ul>${lis}</ul></section>`;
}

/** True when the post was meaningfully updated after publish (date differs). */
export function wasUpdatedAfterPublish(
  publishedAt: string | null | undefined,
  updatedAt: string | null | undefined,
): boolean {
  if (!publishedAt || !updatedAt) return false;
  const p = publishedAt.slice(0, 10);
  const u = updatedAt.slice(0, 10);
  return u > p;
}

// Best-effort JSON fetch from the edge API. Returns null on any error so
// callers can render a graceful 404/500.
export async function fetchJson<T>(
  env: PagesEnv,
  path: string,
): Promise<T | null> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    // US-781: identify this as a trusted Pages-origin SSR hop so the edge's
    // public-content rate limiter bypasses it (it fronts ALL visitors via one IP).
    const originSecret = env.CF_PAGES_ORIGIN_SECRET?.trim();
    if (originSecret) headers["x-pages-origin"] = originSecret;
    const res = await fetch(`${edgeApi(env)}${path}`, {
      headers,
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

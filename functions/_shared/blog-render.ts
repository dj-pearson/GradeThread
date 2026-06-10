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

export interface PublicPost extends PublicPostListItem {
  body_html: string;
  seo_title: string | null;
  seo_description: string | null;
  secondary_keywords: string[];
  jsonld: Record<string, unknown> | null;
  tags: string[];
  // Blog GEO / E-E-A-T fields (US-304). Optional → legacy posts render fine.
  author?: string | null;
  key_takeaways?: string[];
  faqs?: BlogFaq[];
  related?: PublicPostListItem[];
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
  .related { margin-top: 48px; border-top: 1px solid #e5e7eb; padding-top: 24px; }
  .related-grid { display: grid; gap: 16px; grid-template-columns: 1fr; }
  @media (min-width: 640px) { .related-grid { grid-template-columns: repeat(3, 1fr); } }
  .related-card { display: block; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; text-decoration: none; color: inherit; }
  .related-card:hover { background: #f9fafb; }
  .related-card h3 { margin: 0 0 6px; font-size: 1rem; }
  .related-card p { margin: 0; color: var(--muted); font-size: 0.875rem; }
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
): string {
  if (!src) return "";
  const srcset = resize ? buildSrcSet(src, BLOG_IMG_WIDTHS) : "";
  return (
    `<img class="hero" src="${escape(src)}"` +
    (srcset ? ` srcset="${escape(srcset)}" sizes="${BLOG_IMG_SIZES}"` : "") +
    ` alt="${escape(alt)}" loading="eager" fetchpriority="high" decoding="async">`
  );
}

/**
 * Rewrite in-body content <img> tags to add lazy loading + (when `resize` is
 * true) a responsive srcset/sizes. Idempotent: skips data: URIs and images that
 * already carry a srcset or a cdn-cgi transform. Body HTML is sanitized
 * upstream, so this only adds attributes — it never introduces new tags. The
 * srcset is gated on `resize` because /cdn-cgi/image/ 404s until Image Resizing
 * is enabled; lazy/decoding hints are always safe so they apply either way.
 */
export function rewriteContentImages(html: string, resize = false): string {
  return html.replace(/<img\b([^>]*?)>/gi, (full, attrs: string) => {
    if (/\bsrcset=/i.test(attrs) || /\/cdn-cgi\/image\//i.test(attrs)) return full;
    const src = attrs.match(/\bsrc="([^"]+)"/i)?.[1];
    if (!src || src.startsWith("data:")) return full;
    let extra = "";
    if (resize) {
      const srcset = buildSrcSet(src, BLOG_IMG_WIDTHS);
      if (srcset) extra += ` srcset="${escape(srcset)}" sizes="${BLOG_IMG_SIZES}"`;
    }
    if (!/\bloading=/i.test(attrs)) extra += ` loading="lazy"`;
    if (!/\bdecoding=/i.test(attrs)) extra += ` decoding="async"`;
    return extra ? `<img${attrs}${extra}>` : full;
  });
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

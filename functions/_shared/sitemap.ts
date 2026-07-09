// Shared helpers for the dynamic sitemap set (US-293).
//
// The sitemap builds itself from three sources so it never needs hand-editing:
//   1. static registry routes — dist/seo-manifest.json (emitted from
//      src/lib/seo/public-routes.ts by the Vite seoManifestPlugin, US-291)
//   2. published blog posts + tags — /api/content/public/sitemap.json
//   3. public certificates — /api/content/public/certificates.json (US-294)
//
// When the grand total exceeds SITEMAP_MAX_URLS, /sitemap.xml becomes a sitemap
// INDEX pointing at sitemap-static.xml / sitemap-blog.xml / sitemap-certs.xml,
// each of which stays under the 50k/50MB per-file limit.

import { escape, edgeApi, siteUrl, type PagesEnv } from "./blog-render";

// Threshold from the AC. The real spec limit is 50,000 URLs / 50 MB per file;
// 5,000 keeps each file small and fast to generate at the edge.
export const SITEMAP_MAX_URLS = 5000;

export interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

interface ManifestRoute {
  path: string;
  changefreq?: string;
  priority?: number;
  /** US-429: stable per-route content-change date (YYYY-MM-DD). */
  lastModified?: string;
}
interface SeoManifest {
  siteUrl: string;
  generatedAt: string;
  routes: ManifestRoute[];
}
interface BlogSitemap {
  posts: Array<{
    slug: string;
    published_at: string;
    updated_at: string;
    // US-975: hero image fields used by the image sitemap. Optional so a legacy
    // /sitemap.json response that predates the extra columns still parses.
    title?: string;
    hero_image_url?: string | null;
    hero_image_alt?: string | null;
    hero_image_caption?: string | null;
  }>;
  tags: string[];
}
interface CertSitemap {
  certificates: Array<{ id: string; updated_at: string }>;
  next_cursor: string | null;
}
interface SellerSitemap {
  sellers: Array<{ handle: string; updated_at: string }>;
}
interface AuthorSitemap {
  authors: Array<{ slug: string; updated_at: string | null }>;
}

// Fetch a same-origin static asset (the build-emitted manifest). Falls back to
// null so the sitemap still renders (blog/cert sections) if it's missing.
async function fetchManifest(env: PagesEnv): Promise<SeoManifest | null> {
  try {
    const res = await fetch(`${siteUrl(env)}/seo-manifest.json`, {
      signal: AbortSignal.timeout(8_000),
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as SeoManifest;
  } catch {
    return null;
  }
}

async function fetchEdgeJson<T>(env: PagesEnv, path: string): Promise<T | null> {
  try {
    const res = await fetch(`${edgeApi(env)}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

// US-1679: a route is "grading pSEO" if it lives under /grading/ (the scale,
// methodology, disambiguation, glossary hub + terms, and the tier/factor spokes).
// Splitting these into their own segment lets GSC report the pSEO indexation rate
// separately from the marketing pages — the whole point of segmentation.
function isGradingRoute(path: string): boolean {
  return path === "/grading" || path.startsWith("/grading/");
}

function manifestRouteToUrl(base: string, r: ManifestRoute, generatedAt: string): SitemapUrl {
  return {
    loc: r.path === "/" ? `${base}/` : `${base}${r.path}`,
    // US-429: prefer the route's stable content-change date so an unchanged page
    // keeps a steady lastmod across deploys; fall back to the build time only for
    // legacy manifests that predate the per-route field.
    lastmod: (r.lastModified ?? generatedAt).slice(0, 10),
    changefreq: r.changefreq,
    priority: r.priority,
  };
}

/** US-1679: partition the manifest routes into marketing vs grading pSEO. */
async function partitionedStaticUrls(
  env: PagesEnv,
): Promise<{ marketing: SitemapUrl[]; grading: SitemapUrl[] }> {
  const base = siteUrl(env);
  const manifest = await fetchManifest(env);
  if (!manifest) {
    // Manifest missing — at least advertise the home page (a marketing URL).
    return {
      marketing: [{ loc: `${base}/`, lastmod: today(), changefreq: "weekly", priority: 1.0 }],
      grading: [],
    };
  }
  const marketing: SitemapUrl[] = [];
  const grading: SitemapUrl[] = [];
  for (const r of manifest.routes) {
    const url = manifestRouteToUrl(base, r, manifest.generatedAt);
    (isGradingRoute(r.path) ? grading : marketing).push(url);
  }
  return { marketing, grading };
}

/** US-1679: marketing (non-grading) static routes → sitemap-marketing.xml. */
export async function marketingUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  return (await partitionedStaticUrls(env)).marketing;
}

/** US-1679: grading pSEO routes (/grading/*) → sitemap-grading.xml. */
export async function gradingUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  return (await partitionedStaticUrls(env)).grading;
}

/**
 * All static registry routes (marketing + grading). Kept for the legacy
 * sitemap-static.xml alias + the single-file /sitemap.xml path; the index now
 * links the marketing/grading split instead (US-1679).
 */
export async function staticUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const { marketing, grading } = await partitionedStaticUrls(env);
  return [...marketing, ...grading];
}

export async function blogUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<BlogSitemap>(
    env,
    "/api/content/public/sitemap.json",
  );
  const urls: SitemapUrl[] = [
    { loc: `${base}/blog`, lastmod: today(), changefreq: "daily", priority: 0.9 },
  ];
  if (data) {
    for (const p of data.posts) {
      urls.push({
        loc: `${base}/blog/${p.slug}`,
        lastmod: p.updated_at?.slice(0, 10),
        changefreq: "weekly",
        priority: 0.8,
      });
    }
    for (const t of data.tags) {
      urls.push({
        loc: `${base}/blog/tag/${encodeURIComponent(t)}`,
        changefreq: "weekly",
        priority: 0.5,
      });
    }
  }
  return urls;
}

export async function certUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<CertSitemap>(
    env,
    "/api/content/public/certificates.json",
  );
  if (!data) return [];
  return data.certificates.map((cI) => ({
    loc: `${base}/cert/${cI.id}`,
    lastmod: cI.updated_at?.slice(0, 10),
    changefreq: "monthly",
    priority: 0.7,
  }));
}

export async function sellerUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  // US-863: lead with the public directory/leaderboard hub, then each profile.
  const urls: SitemapUrl[] = [
    { loc: `${base}/verified`, lastmod: today(), changefreq: "weekly", priority: 0.7 },
  ];
  const data = await fetchEdgeJson<SellerSitemap>(
    env,
    "/api/content/public/sellers.json",
  );
  for (const s of data?.sellers ?? []) {
    urls.push({
      loc: `${base}/verified/${encodeURIComponent(s.handle)}`,
      lastmod: s.updated_at?.slice(0, 10),
      changefreq: "weekly",
      priority: 0.6,
    });
  }
  return urls;
}

// US-874: public author (E-E-A-T) pages — the /authors hub + each profile.
export async function authorUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const urls: SitemapUrl[] = [
    { loc: `${base}/authors`, lastmod: today(), changefreq: "weekly", priority: 0.5 },
  ];
  const data = await fetchEdgeJson<AuthorSitemap>(
    env,
    "/api/content/public/authors.json",
  );
  for (const a of data?.authors ?? []) {
    urls.push({
      loc: `${base}/authors/${encodeURIComponent(a.slug)}`,
      lastmod: a.updated_at?.slice(0, 10),
      changefreq: "monthly",
      priority: 0.5,
    });
  }
  return urls;
}

// US-621: public Condition Index hub + per-item pages.
export async function conditionIndexUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<{ items: Array<{ slug: string; refreshedAt?: string }> }>(
    env,
    "/api/grading/public/condition-index",
  );
  const urls: SitemapUrl[] = [
    { loc: `${base}/condition-index`, lastmod: today(), changefreq: "weekly", priority: 0.7 },
  ];
  for (const it of data?.items ?? []) {
    urls.push({
      loc: `${base}/condition-index/${it.slug}`,
      lastmod: it.refreshedAt?.slice(0, 10),
      changefreq: "weekly",
      priority: 0.6,
    });
  }
  return urls;
}

/**
 * Value Index URLs (US-1747): the hub + one brand/item page per published curve.
 * Bounded to curves with real comp depth — the /api/grading/public/value hub is
 * already MIN_INDEX_TOTAL_SAMPLE-filtered, so no thin page enters the sitemap.
 * Per-condition pages are interlinked from the item pages (crawlable) but left
 * out of the sitemap so a condition band without comp support is never listed.
 */
export async function valueIndexUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<{
    items: Array<{ brandSlug: string; itemSlug: string; refreshedAt?: string }>;
  }>(env, "/api/grading/public/value");
  const urls: SitemapUrl[] = [
    { loc: `${base}/value`, lastmod: today(), changefreq: "weekly", priority: 0.7 },
  ];
  for (const it of data?.items ?? []) {
    if (!it.brandSlug || !it.itemSlug) continue;
    urls.push({
      loc: `${base}/value/${it.brandSlug}/${it.itemSlug}`,
      lastmod: it.refreshedAt?.slice(0, 10),
      changefreq: "weekly",
      priority: 0.6,
    });
  }
  return urls;
}

export function urlsetXml(urls: SitemapUrl[]): string {
  const body = urls
    .map(
      (u) =>
        `<url><loc>${escape(u.loc)}</loc>` +
        (u.lastmod ? `<lastmod>${escape(u.lastmod)}</lastmod>` : "") +
        (u.changefreq ? `<changefreq>${u.changefreq}</changefreq>` : "") +
        (u.priority !== undefined ? `<priority>${u.priority.toFixed(1)}</priority>` : "") +
        `</url>`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    body +
    `\n</urlset>\n`
  );
}

export function sitemapIndexXml(env: PagesEnv, names: string[]): string {
  const base = siteUrl(env);
  const lm = today();
  const body = names
    .map(
      (n) =>
        `<sitemap><loc>${escape(`${base}/${n}`)}</loc><lastmod>${lm}</lastmod></sitemap>`,
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    body +
    `\n</sitemapindex>\n`
  );
}

export const SITEMAP_HEADERS = {
  "Content-Type": "application/xml; charset=utf-8",
  "Cache-Control": "public, max-age=600, s-maxage=3600",
} as const;

// ── Image sitemap (US-975) ────────────────────────────────────────────────
// A Google image sitemap groups the indexable images that appear ON a page
// under that page's <url> entry, so crawlers can discover images they might not
// reach by parsing HTML. We list the public marketing share images + each blog
// post's hero image, each with a descriptive title + caption.

/** One image entry inside a page's <url> block. */
export interface SitemapImage {
  loc: string;
  title?: string;
  caption?: string;
}

/** A page URL plus the images that appear on it. */
export interface ImageSitemapEntry {
  loc: string;
  images: SitemapImage[];
}

// Public marketing images keyed by the page they appear on. Mirrors
// src/lib/seo/public-routes.ts ROUTE_OG_IMAGES (Pages Functions can't import
// from src/), plus the home page hero. The 1200×630 share cards double as the
// representative image Google associates with each marketing page. Keep titles
// concise and captions descriptive (they map to image:title / image:caption).
// KEEP IN SYNC with ROUTE_OG_IMAGES when adding/renaming a marketing card.
const MARKETING_IMAGES: Array<{
  path: string;
  image: string;
  title: string;
  caption: string;
}> = [
  {
    path: "/",
    image: "/og-image.png",
    title: "GradeThread — AI clothing condition grading",
    caption:
      "GradeThread delivers objective AI condition grading and verifiable certificates for pre-owned clothing.",
  },
  {
    path: "/how-it-works",
    image: "/social/how-it-works.png",
    title: "How GradeThread grading works",
    caption:
      "How GradeThread grades pre-owned clothing across five weighted factors.",
  },
  {
    path: "/pricing",
    image: "/social/pricing.png",
    title: "GradeThread pricing",
    caption:
      "GradeThread pricing — a free plan, pay-per-grade tiers, and FlipDesk subscriptions.",
  },
  {
    path: "/for-resellers",
    image: "/social/for-resellers.png",
    title: "GradeThread for resellers",
    caption:
      "GradeThread for resellers — standardized condition grades that build buyer trust.",
  },
  {
    path: "/condition-grading",
    image: "/social/condition-grading.png",
    title: "Clothing condition grading guide",
    caption:
      "A guide to clothing condition grading: the 1.0–10.0 scale, seven tiers, five factors.",
  },
  {
    path: "/grading-standard",
    image: "/social/grading-standard.png",
    title: "The GradeThread grading standard",
    caption:
      "The GradeThread grading standard — a published 1.0–10.0 rubric with confidence scoring.",
  },
  {
    path: "/transparency",
    image: "/social/transparency.png",
    title: "GradeThread grading transparency report",
    caption:
      "GradeThread's published grading accuracy and AI-vs-human agreement report.",
  },
  {
    path: "/faq",
    image: "/social/faq.png",
    title: "GradeThread FAQ",
    caption:
      "GradeThread FAQ — AI grading, the 1.0–10.0 scale, disputes, certificates, and the API.",
  },
];

/** Static marketing image entries (no network — derived from the constant). */
export function marketingImageUrls(env: PagesEnv): ImageSitemapEntry[] {
  const base = siteUrl(env);
  return MARKETING_IMAGES.map((m) => ({
    loc: m.path === "/" ? `${base}/` : `${base}${m.path}`,
    images: [
      { loc: `${base}${m.image}`, title: m.title, caption: m.caption },
    ],
  }));
}

/** Blog hero images grouped under each post URL (skips posts with no hero). */
export async function blogImageUrls(env: PagesEnv): Promise<ImageSitemapEntry[]> {
  const base = siteUrl(env);
  const data = await fetchEdgeJson<BlogSitemap>(
    env,
    "/api/content/public/sitemap.json",
  );
  const entries: ImageSitemapEntry[] = [];
  for (const p of data?.posts ?? []) {
    const hero = (p.hero_image_url ?? "").trim();
    if (!hero) continue;
    entries.push({
      loc: `${base}/blog/${p.slug}`,
      images: [
        {
          loc: hero,
          title: p.title || undefined,
          // Caption prefers an explicit hero caption, else the alt text.
          caption: p.hero_image_caption || p.hero_image_alt || undefined,
        },
      ],
    });
  }
  return entries;
}

/** All image-sitemap entries: marketing images + blog hero images. */
export async function imageUrls(env: PagesEnv): Promise<ImageSitemapEntry[]> {
  const blog = await blogImageUrls(env);
  return [...marketingImageUrls(env), ...blog];
}

/** Serialize image-sitemap entries to a Google image-sitemap <urlset>. */
export function imageSitemapXml(entries: ImageSitemapEntry[]): string {
  const body = entries
    .filter((e) => e.images.length > 0)
    .map((e) => {
      const imgs = e.images
        .map(
          (img) =>
            `<image:image><image:loc>${escape(img.loc)}</image:loc>` +
            (img.title ? `<image:title>${escape(img.title)}</image:title>` : "") +
            (img.caption
              ? `<image:caption>${escape(img.caption)}</image:caption>`
              : "") +
            `</image:image>`,
        )
        .join("");
      return `<url><loc>${escape(e.loc)}</loc>${imgs}</url>`;
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" ` +
    `xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    body +
    `\n</urlset>\n`
  );
}

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
  posts: Array<{ slug: string; published_at: string; updated_at: string }>;
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

export async function staticUrls(env: PagesEnv): Promise<SitemapUrl[]> {
  const base = siteUrl(env);
  const manifest = await fetchManifest(env);
  const urls: SitemapUrl[] = [];
  if (manifest) {
    for (const r of manifest.routes) {
      urls.push({
        loc: r.path === "/" ? `${base}/` : `${base}${r.path}`,
        // US-429: prefer the route's stable content-change date so an unchanged
        // page keeps a steady lastmod across deploys; fall back to the build
        // time only for legacy manifests that predate the per-route field.
        lastmod: (r.lastModified ?? manifest.generatedAt).slice(0, 10),
        changefreq: r.changefreq,
        priority: r.priority,
      });
    }
  } else {
    // Manifest missing — at least advertise the home page.
    urls.push({ loc: `${base}/`, lastmod: today(), changefreq: "weekly", priority: 1.0 });
  }
  return urls;
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

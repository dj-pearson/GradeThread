// Dynamic sitemap. Replaces the previously-static public/sitemap.xml.
// Includes:
//   - /, /login, /signup (static SPA routes)
//   - /blog (index)
//   - /blog/<slug> for every published post (lastmod = updated_at)
//   - /blog/tag/<tag> for every used tag

import {
  escape,
  fetchJson,
  siteUrl,
  type PagesEnv,
} from "./_shared/blog-render";

interface SitemapData {
  posts: Array<{ slug: string; published_at: string; updated_at: string }>;
  tags: string[];
}

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const data = await fetchJson<SitemapData>(env, "/api/content/public/sitemap.json");
  const base = siteUrl(env);
  const today = new Date().toISOString().slice(0, 10);

  const urls: string[] = [];
  const add = (loc: string, lastmod?: string, priority?: number, changefreq?: string) => {
    urls.push(
      `<url><loc>${escape(loc)}</loc>` +
        (lastmod ? `<lastmod>${escape(lastmod.slice(0, 10))}</lastmod>` : "") +
        (changefreq ? `<changefreq>${changefreq}</changefreq>` : "") +
        (priority !== undefined ? `<priority>${priority.toFixed(1)}</priority>` : "") +
        `</url>`,
    );
  };

  // Static landing pages.
  add(`${base}/`, today, 1.0, "weekly");
  add(`${base}/login`, today, 0.3, "yearly");
  add(`${base}/signup`, today, 0.5, "yearly");
  add(`${base}/blog`, today, 0.9, "daily");

  if (data) {
    for (const p of data.posts) {
      add(`${base}/blog/${p.slug}`, p.updated_at, 0.8, "weekly");
    }
    for (const t of data.tags) {
      add(`${base}/blog/tag/${encodeURIComponent(t)}`, undefined, 0.5, "weekly");
    }
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.join("\n") +
    `\n</urlset>\n`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=600, s-maxage=3600",
    },
  });
};

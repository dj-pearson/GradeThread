// RSS 2.0 feed of the latest 50 published posts.
// Discoverable via <link rel="alternate" type="application/rss+xml"> in the
// blog SSR pages (see _shared/blog-render.ts).

import {
  escape,
  fetchJson,
  siteUrl,
  type PagesEnv,
  type PublicPostListItem,
} from "./_shared/blog-render";

interface IndexResponse {
  posts: PublicPostListItem[];
}

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const data = await fetchJson<IndexResponse>(
    env,
    "/api/content/public/posts?limit=50",
  );
  const base = siteUrl(env);
  const posts = data?.posts ?? [];
  const lastBuildDate = new Date().toUTCString();

  const items = posts
    .map((p) => {
      const link = `${base}/blog/${p.slug}`;
      const pubDate = new Date(p.published_at).toUTCString();
      const enclosure = p.hero_image_url
        ? `<enclosure url="${escape(p.hero_image_url)}" type="image/png" length="0"/>`
        : "";
      return `<item>
  <title>${escape(p.title)}</title>
  <link>${escape(link)}</link>
  <guid isPermaLink="true">${escape(link)}</guid>
  <pubDate>${pubDate}</pubDate>
  <description>${escape(p.excerpt ?? "")}</description>
  ${enclosure}
</item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>GradeThread Blog</title>
  <link>${escape(base)}/blog</link>
  <atom:link href="${escape(base)}/rss.xml" rel="self" type="application/rss+xml" />
  <description>Condition grading for resellers, FlipDesk workflows, and how to make pre-owned clothing sell faster.</description>
  <language>en-us</language>
  <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
</channel>
</rss>
`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=600, s-maxage=3600",
    },
  });
};

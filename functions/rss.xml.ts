// RSS 2.0 feed of the latest 50 published posts.
// Discoverable via <link rel="alternate" type="application/rss+xml"> in the
// blog SSR pages (see _shared/blog-render.ts).

import {
  escape,
  fetchJson,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  siteUrl,
  type PagesEnv,
  type PublicPostListItem,
  withEdgeCache,
} from "./_shared/blog-render";

interface IndexResponse {
  posts: PublicPostListItem[];
}

/** Best-effort image MIME from a URL extension; null when unknown. */
function rssImageMime(url: string): string | null {
  if (/\.png($|\?)/i.test(url)) return "image/png";
  if (/\.jpe?g($|\?)/i.test(url)) return "image/jpeg";
  if (/\.webp($|\?)/i.test(url)) return "image/webp";
  if (/\.gif($|\?)/i.test(url)) return "image/gif";
  if (/\.avif($|\?)/i.test(url)) return "image/avif";
  return null;
}

/**
 * US-2615: served from the worker cache.
 *
 * One upstream call rather than the sitemap's eleven, but the same shared 60/min
 * bucket and the same measurement: no x-gt-cache header, so every reader and
 * every feed poller rebuilt it. Feed readers poll on a timer and do not care
 * whether the bytes are a minute old.
 *
 * The US-2044 guard is unaffected: fetchJson THROWS UpstreamUnavailable, the
 * 503 that produces is not a publicly-cacheable 200, and withEdgeCache stores
 * only those — so a blip cannot pin an empty feed for the TTL.
 */
export const onRequestGet: PagesFunction<PagesEnv> = (context) =>
  withEdgeCache(context, () => buildRssFeed(context.env));

async function buildRssFeed(env: PagesEnv): Promise<Response> {
  // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
  // null when it could not reach the API — so a transient failure can never
  // again be reported to a crawler as "this page is gone".
  let data: IndexResponse | null;
  try {
    data = await fetchJson<IndexResponse>(
    env,
    "/api/content/public/posts?limit=50",
  );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }
  const base = siteUrl(env);
  const posts = data?.posts ?? [];
  const lastBuildDate = new Date().toUTCString();

  const items = posts
    .map((p) => {
      const link = `${base}/blog/${p.slug}`;
      const pubDate = new Date(p.published_at).toUTCString();
      // US-2195: drop the old <enclosure length="0" type="image/png"> — the
      // hardcoded zero length and PNG type were wrong for non-PNG heroes.
      // media:thumbnail/media:content need no length and carry a derived type.
      const heroType = p.hero_image_url ? rssImageMime(p.hero_image_url) : null;
      const mediaBits = p.hero_image_url
        ? `<media:thumbnail url="${escape(p.hero_image_url)}" />
  <media:content url="${escape(p.hero_image_url)}" medium="image"${
            heroType ? ` type="${heroType}"` : ""
          } />`
        : "";
      // US-2195/US-2206: surface each editorial tag as a feed <category>,
      // falling back to the primary keyword when a post carries no tags.
      const categories =
        p.tags && p.tags.length > 0
          ? p.tags
          : p.primary_keyword
            ? [p.primary_keyword]
            : [];
      const categoryBit = categories
        .map((cat) => `<category>${escape(cat)}</category>`)
        .join("\n  ")
        .concat(categories.length ? "\n  " : "");
      // US-2206: attribute the item to its author byline (falls back to the
      // brand). The dc: namespace is already declared on the channel.
      const creator = escape((p.author ?? "").trim() || "GradeThread Team");
      return `<item>
  <title>${escape(p.title)}</title>
  <link>${escape(link)}</link>
  <guid isPermaLink="true">${escape(link)}</guid>
  <pubDate>${pubDate}</pubDate>
  <dc:creator>${creator}</dc:creator>
  ${categoryBit}<description>${escape(p.excerpt ?? "")}</description>
  ${mediaBits}
</item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom"
  xmlns:media="http://search.yahoo.com/mrss/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/">
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
}

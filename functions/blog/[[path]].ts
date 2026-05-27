// Catch-all Pages Function for the public blog.
// Handles:
//   /blog               → index (newest 20 published posts)
//   /blog/<slug>        → single article (full body, JSON-LD)
//   /blog/tag/<tag>     → tag landing page
//
// Static assets and the SPA are unaffected: this Function only fires
// when the path starts with /blog. The SPA's `/* /index.html 200`
// rule in public/_redirects only matches paths NOT served by Functions.

import {
  escape,
  fetchJson,
  notFoundResponse,
  renderLayout,
  siteUrl,
  SSR_CACHE_CONTROL,
  type PagesEnv,
  type PublicPost,
  type PublicPostListItem,
} from "../_shared/blog-render";

interface IndexResponse {
  posts: PublicPostListItem[];
  next_cursor: string | null;
}

interface PostResponse {
  post: PublicPost;
}

interface TagResponse {
  posts: PublicPostListItem[];
  tag: string;
}

type Ctx = EventContext<PagesEnv, "path", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, ""); // strip trailing slash

  // Route matching. params.path is undefined for /blog, an array for deeper.
  const segments = path === "/blog" ? [] : path.replace(/^\/blog\//, "").split("/");

  if (segments.length === 0) {
    return renderIndex(env);
  }
  if (segments.length === 2 && segments[0] === "tag") {
    return renderTag(env, segments[1] ?? "");
  }
  if (segments.length === 1) {
    return renderPost(env, segments[0] ?? "");
  }
  return notFoundResponse(env);
};

async function renderIndex(env: PagesEnv): Promise<Response> {
  const data = await fetchJson<IndexResponse>(env, "/api/content/public/posts?limit=20");
  if (!data) {
    return new Response("Blog temporarily unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain", "Retry-After": "30" },
    });
  }

  const canonical = `${siteUrl(env)}/blog`;
  const posts = data.posts ?? [];
  const cards = posts
    .map(
      (p) => `<a class="post-card" href="/blog/${escape(p.slug)}">
  <h2>${escape(p.title)}</h2>
  <p>${escape(p.excerpt ?? "")}</p>
  <p style="font-size:0.85rem;margin-top:8px">${escape(formatDate(p.published_at))}${
    p.reading_time_min ? ` · ${p.reading_time_min} min read` : ""
  }</p>
</a>`,
    )
    .join("");

  const bodyHtml = `<main class="container container--wide">
  <h1>The GradeThread Blog</h1>
  <p style="color:var(--muted);margin-bottom:32px">Condition grading for resellers, FlipDesk workflows, and how to make pre-owned clothing sell faster.</p>
  ${posts.length === 0 ? "<p>No posts yet.</p>" : cards}
</main>`;

  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "Blog",
      url: canonical,
      name: "GradeThread Blog",
      description:
        "Condition grading vocabulary, reseller workflows, and FlipDesk how-tos for clothing flippers.",
      publisher: organizationLd(env),
      blogPost: posts.slice(0, 10).map((p) => ({
        "@type": "BlogPosting",
        headline: p.title,
        url: `${siteUrl(env)}/blog/${p.slug}`,
        datePublished: p.published_at,
        dateModified: p.updated_at,
      })),
    },
    organizationLd(env),
  ];

  return new Response(
    renderLayout({
      title: "Blog — GradeThread",
      description:
        "Condition grading vocabulary, reseller workflows, and FlipDesk how-tos for clothing flippers.",
      canonicalUrl: canonical,
      ogImage: `${siteUrl(env)}/logo_icon_512.png`,
      jsonLd,
      bodyHtml,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": SSR_CACHE_CONTROL,
      },
    },
  );
}

async function renderPost(env: PagesEnv, slug: string): Promise<Response> {
  if (!slug) return notFoundResponse(env);
  const data = await fetchJson<PostResponse>(
    env,
    `/api/content/public/posts/${encodeURIComponent(slug)}`,
  );
  if (!data?.post) return notFoundResponse(env);
  const post = data.post;
  const canonical = `${siteUrl(env)}/blog/${post.slug}`;
  const title = post.seo_title || post.title;
  const description =
    post.seo_description || post.excerpt || `${post.title} — read on GradeThread.`;

  const tagsHtml =
    post.tags.length > 0
      ? `<div class="tag-list">${post.tags
          .map(
            (t) =>
              `<a href="/blog/tag/${encodeURIComponent(t)}">${escape(t)}</a>`,
          )
          .join("")}</div>`
      : "";

  const heroHtml = post.hero_image_url
    ? `<img class="hero" src="${escape(post.hero_image_url)}" alt="${escape(post.title)}">`
    : "";

  // CTA tailored to the post's product focus.
  const ctaText =
    post.product_focus === "flipdesk"
      ? "Try FlipDesk free"
      : "Grade a garment with GradeThread";
  const ctaHref =
    post.product_focus === "flipdesk"
      ? `/?utm_source=blog&utm_medium=organic&utm_campaign=${encodeURIComponent(post.slug)}#flipdesk`
      : `/?utm_source=blog&utm_medium=organic&utm_campaign=${encodeURIComponent(post.slug)}`;

  const bodyHtml = `<main class="container">
  ${heroHtml}
  <h1>${escape(post.title)}</h1>
  <div class="post-meta">
    <time datetime="${escape(post.published_at)}">${escape(formatDate(post.published_at))}</time>
    ${post.reading_time_min ? `<span class="sep">·</span>${post.reading_time_min} min read` : ""}
  </div>
  ${tagsHtml}
  <article>${post.body_html}</article>
  <a class="cta" href="${escape(ctaHref)}">${escape(ctaText)} &rarr;</a>
</main>`;

  // Article schema — prefer model-supplied jsonld if present, else build one.
  const articleLd = post.jsonld ?? {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description,
    image: post.hero_image_url ?? `${siteUrl(env)}/logo_icon_512.png`,
    datePublished: post.published_at,
    dateModified: post.updated_at,
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    author: {
      "@type": "Organization",
      name: "GradeThread Team",
      url: siteUrl(env),
    },
    publisher: organizationLd(env),
    keywords:
      [post.primary_keyword, ...(post.secondary_keywords ?? [])]
        .filter(Boolean)
        .join(", ") || undefined,
  };

  return new Response(
    renderLayout({
      title,
      description,
      canonicalUrl: canonical,
      ogImage: post.hero_image_url,
      jsonLd: [articleLd],
      bodyHtml,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": SSR_CACHE_CONTROL,
      },
    },
  );
}

async function renderTag(env: PagesEnv, tag: string): Promise<Response> {
  if (!tag) return notFoundResponse(env);
  const data = await fetchJson<TagResponse>(
    env,
    `/api/content/public/tags/${encodeURIComponent(tag)}`,
  );
  if (!data) return notFoundResponse(env);
  const posts = data.posts ?? [];
  const canonical = `${siteUrl(env)}/blog/tag/${encodeURIComponent(tag)}`;

  const cards = posts
    .map(
      (p) => `<a class="post-card" href="/blog/${escape(p.slug)}">
  <h2>${escape(p.title)}</h2>
  <p>${escape(p.excerpt ?? "")}</p>
</a>`,
    )
    .join("");

  const bodyHtml = `<main class="container container--wide">
  <h1>Tag: ${escape(tag)}</h1>
  ${posts.length === 0 ? `<p>No posts tagged <code>${escape(tag)}</code>.</p>` : cards}
</main>`;

  return new Response(
    renderLayout({
      title: `${tag} — GradeThread Blog`,
      description: `Articles tagged ${tag} on the GradeThread blog.`,
      canonicalUrl: canonical,
      ogImage: `${siteUrl(env)}/logo_icon_512.png`,
      bodyHtml,
    }),
    {
      status: posts.length === 0 ? 404 : 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": SSR_CACHE_CONTROL,
      },
    },
  );
}

function organizationLd(env: PagesEnv) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "GradeThread",
    url: siteUrl(env),
    logo: `${siteUrl(env)}/logo_icon_512.png`,
    sameAs: ["https://github.com/dj-pearson"],
  };
}

function formatDate(iso: string): string {
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

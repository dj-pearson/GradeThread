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
  breadcrumbListLd,
  escape,
  fetchJson,
  formatDate,
  ga4MeasurementId,
  notFoundResponse,
  renderBreadcrumbs,
  renderLayout,
  siteUrl,
  SSR_CACHE_CONTROL,
  buildTableOfContents,
  renderKeyTakeaways,
  renderTableOfContents,
  renderFaqSection,
  faqPageJsonLd,
  renderRelatedPosts,
  buildPinImageUrl,
  renderPinterestSave,
  renderHeroImage,
  rewriteContentImages,
  imageResizingEnabled,
  articleAuthorLd,
  wasUpdatedAfterPublish,
  twitterSiteHandle,
  socialProfileUrls,
  withEdgeCache,
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

export const onRequestGet: PagesFunction<PagesEnv> = (context: Ctx) =>
  withEdgeCache(context, () => routeBlog(context));

async function routeBlog(context: Ctx): Promise<Response> {
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
  if (segments.length === 2 && segments[0] === "preview") {
    return renderPreview(env, segments[1] ?? "");
  }
  if (segments.length === 1) {
    return renderPost(env, segments[0] ?? "");
  }
  return notFoundResponse(env);
}

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

  const breadcrumbItems = [
    { name: "GradeThread", url: `${siteUrl(env)}/` },
    { name: "Blog", url: canonical },
  ];

  const bodyHtml = `${renderBreadcrumbs(breadcrumbItems, siteUrl(env), { wide: true })}
  <main class="container container--wide">
  <h1>The GradeThread Blog</h1>
  <p style="color:var(--muted);margin-bottom:32px">Condition grading for resellers, FlipDesk workflows, and how to make pre-owned clothing sell faster.</p>
  ${posts.length === 0 ? "<p>No posts yet.</p>" : cards}
</main>`;

  const jsonLd = [
    breadcrumbListLd(breadcrumbItems),
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
      gaMeasurementId: ga4MeasurementId(env),
      twitterSite: twitterSiteHandle(env),
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

  // Responsive hero image (US-306): srcset via Cloudflare Image Resizing, only
  // when the zone has Transformations enabled (else plain original).
  const resizeImages = imageResizingEnabled(env);
  const heroHtml = renderHeroImage(post.hero_image_url, post.title, resizeImages);

  // CTA tailored to the post's product focus.
  const ctaText =
    post.product_focus === "flipdesk"
      ? "Try FlipDesk free"
      : "Grade a garment with GradeThread";
  const ctaHref =
    post.product_focus === "flipdesk"
      ? `/?utm_source=blog&utm_medium=organic&utm_campaign=${encodeURIComponent(post.slug)}#flipdesk`
      : `/?utm_source=blog&utm_medium=organic&utm_campaign=${encodeURIComponent(post.slug)}`;

  // GEO enhancements (US-304): author byline + visible "Updated <date>",
  // answer-first key-takeaways, auto TOC from the body's H2s, on-page FAQ,
  // and a related-posts internal-link block.
  const authorName = post.author?.trim() || "GradeThread Team";
  const updatedHtml = wasUpdatedAfterPublish(post.published_at, post.updated_at)
    ? `<span class="sep">·</span><span class="updated">Updated <time datetime="${escape(
        post.updated_at,
      )}">${escape(formatDate(post.updated_at))}</time></span>`
    : "";
  const { html: bodyWithAnchors, toc } = buildTableOfContents(post.body_html);
  // Add responsive srcset + lazy loading to in-body content images (US-306),
  // backfill a sensible alt fallback for any image missing one, and reserve a
  // guaranteed aspect-ratio so the layout doesn't shift as images load (US-434).
  const articleHtml = rewriteContentImages(bodyWithAnchors, resizeImages, {
    fallbackAlt: post.title,
  });

  // US-433: one trail for the visible breadcrumb + the BreadcrumbList JSON-LD.
  const breadcrumbItems = [
    { name: "GradeThread", url: `${siteUrl(env)}/` },
    { name: "Blog", url: `${siteUrl(env)}/blog` },
    { name: post.title, url: canonical },
  ];

  // US-872: Pinterest pin pipeline. A vertical 1000x1500 pin card (US-871
  // /og/social/card?ratio=pin) plus a "Save to Pinterest" affordance whose
  // destination is the post URL with Pinterest UTM params and whose description
  // is the keyword-rich SEO description (capped to Pinterest's 500-char limit).
  const pinUrl = `${canonical}?utm_source=pinterest&utm_medium=social&utm_campaign=${encodeURIComponent(
    post.slug,
  )}`;
  const pinImage = buildPinImageUrl(siteUrl(env), {
    title: post.title,
    product: post.product_focus,
    eyebrow: post.primary_keyword,
  });
  const pinSaveHtml = renderPinterestSave({
    pinUrl,
    media: pinImage,
    description,
  });

  const bodyHtml = `${renderBreadcrumbs(breadcrumbItems, siteUrl(env))}
  <main class="container">
  ${heroHtml}
  <h1>${escape(post.title)}</h1>
  <div class="post-meta">
    <span class="author">By ${escape(authorName)}</span>
    <span class="sep">·</span>
    <time datetime="${escape(post.published_at)}">${escape(formatDate(post.published_at))}</time>
    ${post.reading_time_min ? `<span class="sep">·</span>${post.reading_time_min} min read` : ""}
    ${updatedHtml}
  </div>
  ${tagsHtml}
  ${renderKeyTakeaways(post.key_takeaways)}
  ${renderTableOfContents(toc)}
  <article>${articleHtml}</article>
  ${renderFaqSection(post.faqs)}
  <a class="cta" href="${escape(ctaHref)}">${escape(ctaText)} &rarr;</a>
  ${pinSaveHtml}
  ${renderRelatedPosts(post.related)}
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
    // E-E-A-T author signal (US-304): a named Person when supplied, else the team.
    author: articleAuthorLd(post.author, siteUrl(env)),
    publisher: organizationLd(env),
    keywords:
      [post.primary_keyword, ...(post.secondary_keywords ?? [])]
        .filter(Boolean)
        .join(", ") || undefined,
  };

  // Breadcrumb: GradeThread › Blog › <post> (US-299) — same trail as the
  // visible <nav> above so the structured data and on-page links match (US-433).
  const breadcrumbLd = breadcrumbListLd(breadcrumbItems);

  // FAQPage node (US-304) — emitted in addition to the Article so AI answer
  // engines can extract the Q&A even though Google dropped FAQ rich results.
  const faqLd = faqPageJsonLd(post.faqs);

  return new Response(
    renderLayout({
      title,
      description,
      canonicalUrl: canonical,
      // US-307: dynamic OG image with the post's title. /og/blog/:slug
      // renders a branded 1200x630 PNG via Satori (workers-og). The static
      // logo is the last-ditch fallback if the OG worker errors.
      ogImage: `${siteUrl(env)}/og/blog/${encodeURIComponent(post.slug)}`,
      // US-872: article:* OG tags for Pinterest (and other) rich pins.
      articleMeta: {
        publishedTime: post.published_at,
        modifiedTime: post.updated_at,
        author: authorName,
        section: post.primary_keyword,
        tags: post.tags,
      },
      gaMeasurementId: ga4MeasurementId(env),
      twitterSite: twitterSiteHandle(env),
      jsonLd: [articleLd, breadcrumbLd, ...(faqLd ? [faqLd] : [])],
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

async function renderPreview(env: PagesEnv, token: string): Promise<Response> {
  if (!token) return notFoundResponse(env);
  const data = await fetchJson<PostResponse & { preview?: boolean; expires_at?: string }>(
    env,
    `/api/content/public/posts/preview/${encodeURIComponent(token)}`,
  );
  if (!data?.post) {
    return new Response(
      renderLayout({
        title: "Preview unavailable — GradeThread",
        description: "This preview link has expired or is invalid.",
        canonicalUrl: `${siteUrl(env)}/blog`,
        noindex: true,
        bodyHtml: `<main class="container"><h1>Preview link expired</h1><p>Ask the post author for a fresh link, or check the token is intact.</p></main>`,
      }),
      {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
  const post = data.post;
  const canonical = `${siteUrl(env)}/blog/${post.slug}`;

  const heroHtml = renderHeroImage(
    post.hero_image_url,
    post.title,
    imageResizingEnabled(env),
  );
  const banner = `<div style="background:#FEF3C7;border:1px solid #F59E0B;color:#92400E;padding:12px 16px;border-radius:6px;margin-bottom:24px;font-size:0.9rem">
    <strong>Preview mode</strong> &middot; This is an unpublished draft.
    ${data.expires_at ? `Link expires ${escape(formatDateTime(data.expires_at))}.` : ""}
  </div>`;

  const bodyHtml = `<main class="container">
  ${banner}
  ${heroHtml}
  <h1>${escape(post.title)}</h1>
  <article>${post.body_html}</article>
</main>`;

  return new Response(
    renderLayout({
      title: `Preview — ${post.title}`,
      description: post.excerpt ?? "Draft preview",
      canonicalUrl: canonical,
      noindex: true,
      bodyHtml,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Never cache preview pages.
        "Cache-Control": "private, no-store, max-age=0",
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

  const breadcrumbItems = [
    { name: "GradeThread", url: `${siteUrl(env)}/` },
    { name: "Blog", url: `${siteUrl(env)}/blog` },
    { name: `Tag: ${tag}`, url: canonical },
  ];

  const bodyHtml = `${renderBreadcrumbs(breadcrumbItems, siteUrl(env), { wide: true })}
  <main class="container container--wide">
  <h1>Tag: ${escape(tag)}</h1>
  ${posts.length === 0 ? `<p>No posts tagged <code>${escape(tag)}</code>.</p>` : cards}
</main>`;

  return new Response(
    renderLayout({
      title: `${tag} — GradeThread Blog`,
      description: `Articles tagged ${tag} on the GradeThread blog.`,
      canonicalUrl: canonical,
      ogImage: `${siteUrl(env)}/logo_icon_512.png`,
      gaMeasurementId: ga4MeasurementId(env),
      twitterSite: twitterSiteHandle(env),
      jsonLd: [breadcrumbListLd(breadcrumbItems)],
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
    // US-428: GitHub + any configured live profiles (mirrors the SPA's sameAs).
    sameAs: socialProfileUrls(env),
  };
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

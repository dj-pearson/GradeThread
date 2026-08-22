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
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  formatDate,
  ga4MeasurementId,
  notFoundResponse,
  renderBreadcrumbs,
  renderSsrResponse,
  siteUrl,
  SSR_CACHE_CONTROL,
  buildTableOfContents,
  renderKeyTakeaways,
  renderTableOfContents,
  renderFaqSection,
  faqPageJsonLd,
  renderRelatedPosts,
  renderPillarLink,
  buildPinImageUrl,
  renderPinterestSave,
  renderHeroImage,
  heroImageObjectLd,
  rewriteContentImages,
  linkGlossaryTerms,
  glossaryAboutLd,
  buildPostHowToLd,
  speakableSpec,
  imageResizingEnabled,
  postAuthorLd,
  wasUpdatedAfterPublish,
  twitterSiteHandle,
  socialProfileUrls,
  withEdgeCache,
  type PagesEnv,
  type PublicPost,
  type PublicPostListItem,
} from "../_shared/blog-render";
import { paginationNav } from "../_shared/blog-pagination";
import { buildPostMarkdown } from "../_shared/html-to-markdown";
import { headOf } from "../_shared/head-of";

interface IndexResponse {
  posts: PublicPostListItem[];
  next_cursor: string | null;
  /** US-2099: total published posts, so the hub can render a finite page trail. */
  total?: number | null;
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
    return renderIndex(env, 1);
  }
  // US-2099: crawlable pagination. /blog/page/N and /blog/tag/<t>/page/N are
  // real URLs with real <a href> links, so post 21 and older finally have a
  // crawl path from the hub instead of existing only in the sitemap.
  if (segments.length === 2 && segments[0] === "page") {
    const n = Number(segments[1]);
    if (!Number.isInteger(n) || n < 1) return notFoundResponse(env);
    // Page 1 lives at /blog — redirect so the two are never duplicate URLs.
    if (n === 1) return Response.redirect(`${siteUrl(env)}/blog`, 301);
    return renderIndex(env, n);
  }
  if (segments.length === 4 && segments[0] === "tag" && segments[2] === "page") {
    const n = Number(segments[3]);
    if (!Number.isInteger(n) || n < 1) return notFoundResponse(env);
    if (n === 1) {
      return Response.redirect(`${siteUrl(env)}/blog/tag/${segments[1]}`, 301);
    }
    return renderTag(env, segments[1] ?? "", n);
  }
  if (segments.length === 2 && segments[0] === "tag") {
    return renderTag(env, segments[1] ?? "", 1);
  }
  if (segments.length === 2 && segments[0] === "preview") {
    return renderPreview(env, segments[1] ?? "");
  }
  if (segments.length === 1) {
    const seg = segments[0] ?? "";
    // US-877: clean-Markdown view of a post for AI answer engines.
    if (seg.endsWith(".md")) {
      return renderPostMarkdown(env, seg.slice(0, -3));
    }
    return renderPost(env, seg);
  }
  return notFoundResponse(env);
}

// US-877: serve a published post as clean text/markdown at /blog/:slug.md. The
// upstream public endpoint returns only published posts (no drafts/previews),
// and withEdgeCache makes repeat hits a real edge HIT.
async function renderPostMarkdown(env: PagesEnv, slug: string): Promise<Response> {
  if (!slug) return notFoundResponse(env);
  // US-2044: a 404 is a REMOVAL signal. Only serve one when the upstream
  // actually said the record is absent — never because we could not reach it.
  let data: PostResponse | null;
  try {
    data = await fetchJson<PostResponse>(
    env,
    `/api/content/public/posts/${encodeURIComponent(slug)}`,
  );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }
  if (!data?.post) {
    return new Response(`# Not found\n\nNo published post at /blog/${slug}.\n`, {
      status: 404,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }
  const markdown = buildPostMarkdown(data.post, siteUrl(env));
  return new Response(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": SSR_CACHE_CONTROL,
      "X-Robots-Tag": "all",
    },
  });
}

/** US-2099: posts per page on the hub and tag pages. */
const BLOG_PAGE_SIZE = 20;

async function renderIndex(env: PagesEnv, page = 1): Promise<Response> {
  const offset = (page - 1) * BLOG_PAGE_SIZE;
  // US-2044: a 404 is a REMOVAL signal. Only serve one when the upstream
  // actually said the record is absent — never because we could not reach it.
  let data: IndexResponse | null;
  try {
    data = await fetchJson<IndexResponse>(
      env,
      `/api/content/public/posts?limit=${BLOG_PAGE_SIZE}&offset=${offset}`,
    );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }
  if (!data) {
    return new Response("Blog temporarily unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain", "Retry-After": "30" },
    });
  }

  const posts = data.posts ?? [];
  const total = typeof data.total === "number" ? data.total : posts.length;
  const totalPages = Math.max(1, Math.ceil(total / BLOG_PAGE_SIZE));
  // US-2099 AC3: page N canonicals to ITSELF. Canonicalising every page to
  // /blog would tell engines pages 2+ are duplicates of page 1 and drop the
  // very posts this pagination exists to expose.
  const canonical =
    page === 1 ? `${siteUrl(env)}/blog` : `${siteUrl(env)}/blog/page/${page}`;
  // A page past the end has no content and should not be indexed as an empty
  // listing.
  if (page > totalPages && page > 1) return notFoundResponse(env);
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
  ${paginationNav("/blog", page, totalPages)}
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

  return renderSsrResponse(
    {
      title: "Blog — GradeThread",
      description:
        "Condition grading vocabulary, reseller workflows, and FlipDesk how-tos for clothing flippers.",
      canonicalUrl: canonical,
      // US-2099 AC5: the square logo on a summary_large_image card crops badly.
      // AC5 named only the tag page, but the hub and the post-page fallback had
      // the identical defect — same class, fixed together.
      ogImage: `${siteUrl(env)}/og-image.png`,
      // US-2186: og-image.png is a 1200x630 asset.
      ogImageWidth: 1200,
      ogImageHeight: 630,
      gaMeasurementId: ga4MeasurementId(env),
      twitterSite: twitterSiteHandle(env),
      jsonLd,
      bodyHtml,
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

async function renderPost(env: PagesEnv, slug: string): Promise<Response> {
  if (!slug) return notFoundResponse(env);
  // US-2044: a 404 is a REMOVAL signal. Only serve one when the upstream
  // actually said the record is absent — never because we could not reach it.
  let data: PostResponse | null;
  try {
    data = await fetchJson<PostResponse>(
    env,
    `/api/content/public/posts/${encodeURIComponent(slug)}`,
  );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }
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
  // US-876: stored, keyword-aware hero alt (falls back to the title so the alt is
  // never empty) + an optional caption rendered as <figcaption>.
  const heroAlt = post.hero_image_alt?.trim() || post.title;
  const heroHtml = renderHeroImage(
    post.hero_image_url,
    heroAlt,
    resizeImages,
    post.hero_image_caption,
  );

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
  // US-874: prefer the linked author entity (links to its profile page); fall
  // back to the legacy byline string, then "GradeThread Team".
  const authorName =
    post.author_entity?.name?.trim() || post.author?.trim() || "GradeThread Team";
  const authorByline = post.author_entity
    ? `<a href="/authors/${escape(post.author_entity.slug)}">${escape(authorName)}</a>`
    : escape(authorName);
  const updatedHtml = wasUpdatedAfterPublish(post.published_at, post.updated_at)
    ? `<span class="sep">·</span><span class="updated">Updated <time datetime="${escape(
        post.updated_at,
      )}">${escape(formatDate(post.updated_at))}</time></span>`
    : "";
  const { html: bodyWithAnchors, toc } = buildTableOfContents(post.body_html);
  // Add responsive srcset + lazy loading to in-body content images (US-306),
  // backfill a sensible alt fallback for any image missing one, and reserve a
  // guaranteed aspect-ratio so the layout doesn't shift as images load (US-434).
  const imagedHtml = rewriteContentImages(bodyWithAnchors, resizeImages, {
    fallbackAlt: post.title,
    // US-876: apply stored per-image alt/caption to in-body images.
    imageMeta: post.inline_images,
  });
  // US-878: link the first prose mention of each canonical grading term to its
  // /grading/<slug> glossary spoke (entity consistency) and collect the terms
  // present so they can be surfaced as DefinedTerm `about` nodes on the Article.
  const { html: articleHtml, terms: glossaryTerms } = linkGlossaryTerms(imagedHtml);

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
    <span class="author">By ${authorByline}</span>
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
  ${renderPillarLink(post.pillar_url, post.pillar_label)}
  <a class="cta" href="${escape(ctaHref)}">${escape(ctaText)} &rarr;</a>
  ${pinSaveHtml}
  ${renderRelatedPosts(post.related)}
</main>`;

  // US-876: a full ImageObject for the hero (contentUrl, width, height, caption)
  // so search + AI engines get structured image data, not a bare URL string.
  // Falls back to the static logo URL when the post has no hero yet.
  const heroImageLd =
    heroImageObjectLd({
      url: post.hero_image_url,
      alt: heroAlt,
      caption: post.hero_image_caption,
      width: post.hero_image_width,
      height: post.hero_image_height,
    }) ?? `${siteUrl(env)}/og-image.png`; // US-2099 AC5: wide card asset

  // US-878 GEO depth: Speakable marks the answer-first blocks for voice/AI
  // surfaces; `about` binds the post to the canonical grading terms it mentions
  // (DefinedTerm → /grading/<slug>), reinforcing entity consistency with our
  // glossary + Organization.knowsAbout. Both omitted when there's nothing real.
  const speakable = speakableSpec(post);
  const aboutTerms = glossaryAboutLd(glossaryTerms, siteUrl(env));

  // Article schema — always build the full computed node, then let a
  // model-supplied jsonld override individual fields on top of it. US-2203:
  // previously `post.jsonld ?? {...}` REPLACED the computed node outright, so a
  // partial stored blob could silently drop publisher/author/speakable/about
  // (all E-E-A-T signals). Merging keeps those required fields present while
  // still honoring editor overrides.
  const computedArticleLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description,
    image: heroImageLd,
    datePublished: post.published_at,
    dateModified: post.updated_at,
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    // E-E-A-T author signal (US-874): a full Person node (name, url, jobTitle,
    // sameAs) for a linked author entity, else the legacy byline fallback.
    author: postAuthorLd(post, siteUrl(env)),
    publisher: organizationLd(env),
    keywords:
      [post.primary_keyword, ...(post.secondary_keywords ?? [])]
        .filter(Boolean)
        .join(", ") || undefined,
    ...(speakable ? { speakable } : {}),
    ...(aboutTerms.length ? { about: aboutTerms } : {}),
  };
  const storedArticleLd =
    post.jsonld && typeof post.jsonld === "object" && !Array.isArray(post.jsonld)
      ? (post.jsonld as Record<string, unknown>)
      : null;
  const articleLd = storedArticleLd
    ? { ...computedArticleLd, ...storedArticleLd }
    : computedArticleLd;

  // Breadcrumb: GradeThread › Blog › <post> (US-299) — same trail as the
  // visible <nav> above so the structured data and on-page links match (US-433).
  const breadcrumbLd = breadcrumbListLd(breadcrumbItems);

  // FAQPage node (US-304) — emitted in addition to the Article so AI answer
  // engines can extract the Q&A even though Google dropped FAQ rich results.
  const faqLd = faqPageJsonLd(post.faqs);

  // US-878: HowTo node for procedural ("how to …") posts, with ordered steps
  // derived from the body's first <ol> (else its H2 outline). null — and thus
  // skipped — for non-procedural posts or when too few steps can be derived.
  const howToLd = buildPostHowToLd(post, canonical);

  return renderSsrResponse(
    {
      title,
      description,
      canonicalUrl: canonical,
      // US-307: dynamic OG image with the post's title. /og/blog/:slug
      // renders a branded 1200x630 PNG via Satori (workers-og). The static
      // logo is the last-ditch fallback if the OG worker errors.
      ogImage: `${siteUrl(env)}/og/blog/${encodeURIComponent(post.slug)}`,
      // US-2186: /og/blog/:slug is a fixed 1200x630 PNG card.
      ogImageWidth: 1200,
      ogImageHeight: 630,
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
      // US-877: advertise the clean-Markdown view to AI answer engines.
      alternates: [
        {
          type: "text/markdown",
          href: `${canonical}.md`,
          title: `${post.title} (Markdown)`,
        },
      ],
      jsonLd: [
        articleLd,
        breadcrumbLd,
        ...(faqLd ? [faqLd] : []),
        ...(howToLd ? [howToLd] : []),
      ],
      bodyHtml,
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

async function renderPreview(env: PagesEnv, token: string): Promise<Response> {
  if (!token) return notFoundResponse(env);
  // US-2044: a 404 is a REMOVAL signal. Only serve one when the upstream
  // actually said the record is absent — never because we could not reach it.
  let data: PostResponse & { preview?: boolean; expires_at?: string } | null;
  try {
    data = await fetchJson<PostResponse & { preview?: boolean; expires_at?: string }>(
    env,
    `/api/content/public/posts/preview/${encodeURIComponent(token)}`,
  );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }
  if (!data?.post) {
    return renderSsrResponse(
      {
        title: "Preview unavailable — GradeThread",
        description: "This preview link has expired or is invalid.",
        canonicalUrl: `${siteUrl(env)}/blog`,
        noindex: true,
        bodyHtml: `<main class="container"><h1>Preview link expired</h1><p>Ask the post author for a fresh link, or check the token is intact.</p></main>`,
      },
      { status: 401, cacheControl: "private, no-store, max-age=0" },
    );
  }
  const post = data.post;
  const canonical = `${siteUrl(env)}/blog/${post.slug}`;

  const heroHtml = renderHeroImage(
    post.hero_image_url,
    post.hero_image_alt?.trim() || post.title,
    imageResizingEnabled(env),
    post.hero_image_caption,
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

  // Never cache preview pages (private, no-store).
  return renderSsrResponse(
    {
      title: `Preview — ${post.title}`,
      description: post.excerpt ?? "Draft preview",
      canonicalUrl: canonical,
      noindex: true,
      bodyHtml,
    },
    { cacheControl: "private, no-store, max-age=0" },
  );
}

async function renderTag(env: PagesEnv, tag: string, page = 1): Promise<Response> {
  if (!tag) return notFoundResponse(env);
  // US-2044: a 404 is a REMOVAL signal. Only serve one when the upstream
  // actually said the record is absent — never because we could not reach it.
  let data: TagResponse | null;
  try {
    data = await fetchJson<TagResponse>(
    env,
    `/api/content/public/tags/${encodeURIComponent(tag)}`,
  );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }
  if (!data) return notFoundResponse(env);
  const allPosts = data.posts ?? [];
  // US-2099 AC2: tag pages were unpaginated too. The tag endpoint returns the
  // full set, so paging here is a slice — no extra round trip.
  const totalPages = Math.max(1, Math.ceil(allPosts.length / BLOG_PAGE_SIZE));
  if (page > totalPages && page > 1) return notFoundResponse(env);
  const posts = allPosts.slice((page - 1) * BLOG_PAGE_SIZE, page * BLOG_PAGE_SIZE);

  const tagBase = `${siteUrl(env)}/blog/tag/${encodeURIComponent(tag)}`;
  // AC3: self-canonical, exactly as on the hub.
  const canonical = page === 1 ? tagBase : `${tagBase}/page/${page}`;

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
  ${paginationNav(`/blog/tag/${encodeURIComponent(tag)}`, page, totalPages)}
</main>`;

  return renderSsrResponse(
    {
      // US-2099 AC5: was `${tag} — GradeThread Blog`, an em-dash separator that
      // matched nothing else on the site; every other page uses " | GradeThread".
      title: `${tag}${page > 1 ? ` — page ${page}` : ""} | GradeThread Blog`,
      description: `Articles tagged ${tag} on the GradeThread blog.`,
      canonicalUrl: canonical,
      // US-2099 AC5: was logo_icon_512.png — a SQUARE image on a
      // summary_large_image card, which unfurls badly cropped. Use the shared
      // default OG asset, which is sized for the card.
      ogImage: `${siteUrl(env)}/og-image.png`,
      // US-2186: og-image.png is a 1200x630 asset.
      ogImageWidth: 1200,
      ogImageHeight: 630,
      gaMeasurementId: ga4MeasurementId(env),
      twitterSite: twitterSiteHandle(env),
      // Tag archives are noindex,follow. They were 138 of the ~892 URLs in the
      // sitemap against ~61 published posts, so most tags list one or two
      // articles — thin, near-duplicate pages whose content exists in full on
      // the post itself. On a domain with no external authority that is crawl
      // budget spent proving low value. "follow" is deliberate: the archives
      // still pass equity through to the posts they link.
      robots: "noindex, follow",
      jsonLd: [breadcrumbListLd(breadcrumbItems)],
      bodyHtml,
    },
    { status: posts.length === 0 ? 404 : 200, cacheControl: SSR_CACHE_CONTROL },
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

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

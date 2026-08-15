// Catch-all Pages Function for the public Help Center (US-2575).
//
//   /help                          hub (the category shelf)
//   /help/<category>               category landing
//   /help/<category>/<slug>        article
//   /help/<category>/<slug>.md     clean Markdown mirror for answer engines
//
// /help.md (the Markdown index) is its own Function next door: a [[path]]
// catch-all under functions/help/ matches /help and /help/*, and /help.md is
// neither.
//
// THIS IS THE ANSWER TO "plain HTML or database items". The articles are
// database rows, rendered to COMPLETE server HTML here at the edge, exactly the
// way functions/blog/[[path]].ts already does for the blog. A crawler receives
// finished markup with zero JavaScript and cannot tell the difference from a
// hand-written file. Static files would have cost a rebuild and a full deploy
// for every typo, and would have forked the public copy from the in-app reader,
// the contextual help sheet and the support-ticket deflector, all of which read
// the same rows.
//
// WHAT IS NOT HERE, DELIBERATELY: this Function only ever calls the ANONYMOUS
// endpoint (/api/content/public/help), which can only return
// visibility='public'. A members-only or internal article is not a page this
// renderer can be talked into serving with the wrong query string — it is a row
// the upstream never hands over. A draft, a members article and a slug that
// never existed are indistinguishable from out here, which is the point.

import {
  breadcrumbListLd,
  buildTableOfContents,
  escape,
  fetchJson,
  ga4MeasurementId,
  notFoundResponse,
  renderBreadcrumbs,
  renderFaqSection,
  linkGlossaryTerms,
  renderPillarLink,
  renderSsrResponse,
  renderTableOfContents,
  siteUrl,
  SSR_CACHE_CONTROL,
  twitterSiteHandle,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  withEdgeCache,
  type PagesEnv,
} from "../_shared/blog-render";
import {
  articlesInCategory,
  buildHelpMarkdown,
  canonicalArticleUrl,
  helpArticleOgPath,
  helpArticlePath,
  helpCategoryPath,
  HELP_HUB_DESCRIPTION,
  HELP_HUB_TITLE,
  HELP_STATIC_OG_ALT,
  HELP_STATIC_OG_PATH,
  OG_CARD_HEIGHT,
  OG_CARD_WIDTH,
  nonEmptyCategories,
  pillarLabel,
  renderArticleList,
  renderCategoryGrid,
  renderHelpSearchForm,
  renderHelpSearchResults,
  renderHelpFeedback,
  renderRelatedHelp,
  renderReviewedLine,
  renderUpdatedLine,
  toBlogFaqs,
  type HelpArticleResponse,
  type HelpCategoryPayload,
  type HelpIndexPayload,
  type HelpSearchPayload,
} from "../_shared/help-render";
import {
  helpArticleLd,
  helpCollectionLd,
  helpFaqLd,
} from "../_shared/help-json-ld";
import {
  countHelpArticleView,
  HELP_CONTENT_GROUP,
  helpArticleSlugForCount,
} from "../_shared/help-analytics";

type Ctx = EventContext<PagesEnv, "path", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = (context: Ctx) => {
  // US-2592: count the read before anything else decides how to serve it.
  //
  // It happens HERE rather than inside renderArticle for one reason: withEdgeCache
  // can return a stored response without the renderer running at all, and a
  // counter inside the renderer would miss every cache hit — under-reporting
  // exactly the articles that are popular enough to stay cached.
  //
  // waitUntil, so it never delays the response, and the slug alone is sent. The
  // upstream RPC requires the article to exist, so a made-up URL counts nothing.
  countHelpView(context);

  // withEdgeCache keys on origin + pathname and IGNORES the query string, which
  // is what stops utm-tagged share links fragmenting the cache. For /help/search
  // that same property is a data leak: every query would collide on one entry
  // and serve the first visitor's results to the next visitor's question. So
  // search skips the cache entirely rather than relying on its Cache-Control,
  // which withEdgeCache does not read.
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/\/$/, "");
  if (path === "/help/search") return routeHelp(context);
  // US-2591: same trap, second instance. The cache key ignores the query string,
  // so a page rendered with ?thanks=1 would be stored under the plain article
  // URL and every later visitor would be thanked for feedback they never gave.
  // Anything whose rendering depends on the query string must skip the cache.
  if (url.searchParams.get("thanks") === "1") return routeHelp(context);
  return withEdgeCache(context, () => routeHelp(context));
};

function countHelpView(context: Ctx): void {
  const slug = helpArticleSlugForCount(new URL(context.request.url).pathname);
  if (!slug) return;
  const pending = countHelpArticleView(
    context.env,
    slug,
    context.request.headers.get("user-agent"),
  );
  if (pending) context.waitUntil(pending);
}

async function routeHelp(context: Ctx): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");

  try {
    if (path === "/help") return await renderHub(env);
    // Before the category branch: "search" is a reserved slug (lib/help-center.ts
    // refuses to mint it) precisely so this path can never collide with a shelf.
    if (path === "/help/search") return await renderSearch(env, url.searchParams.get("q") ?? "");
    // A GET here is somebody typing the URL of the no-JS form target. Send them
    // to the hub rather than 404ing on a path that legitimately exists for POST.
    if (path === "/help/feedback") return Response.redirect(`${siteUrl(env)}/help`, 302);

    const segments = path.replace(/^\/help\//, "").split("/");
    const [categorySeg, articleSeg] = segments;

    if (segments.length === 1 && categorySeg) {
      return await renderCategory(env, categorySeg);
    }
    if (segments.length === 2 && categorySeg && articleSeg) {
      if (articleSeg.endsWith(".md")) {
        return await renderArticleMarkdown(env, articleSeg.slice(0, -3));
      }
      return await renderArticle(
        env,
        categorySeg,
        articleSeg,
        url.searchParams.get("thanks") === "1",
      );
    }
    return helpNotFound(env);
  } catch (err) {
    // An upstream we could not reach is OUR problem, not the URL's. 503 keeps
    // the URL in the index; a 404 here would teach Google the page is gone.
    if (err instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw err;
  }
}

function helpNotFound(env: PagesEnv): Response {
  return notFoundResponse(env, {
    title: "Article not found — GradeThread Help",
    heading: "We couldn't find that article",
    message:
      `It may have been renamed or taken down. ` +
      `<a href="/help">Browse the help center &rarr;</a>`,
    canonicalPath: "/help",
  });
}

async function loadIndex(env: PagesEnv): Promise<HelpIndexPayload | null> {
  return await fetchJson<HelpIndexPayload>(env, "/api/content/public/help");
}

// ── /help ─────────────────────────────────────────────────
async function renderHub(env: PagesEnv): Promise<Response> {
  const index = await loadIndex(env);
  if (!index) return helpNotFound(env);

  const base = siteUrl(env);
  const canonical = `${base}/help`;
  const crumbs = [
    { name: "GradeThread", url: `${base}/` },
    { name: HELP_HUB_TITLE, url: canonical },
  ];

  const body = `<main class="container">
${renderBreadcrumbs(crumbs, base)}
<h1>${escape(HELP_HUB_TITLE)}</h1>
<p>${escape(HELP_HUB_DESCRIPTION)}</p>
${renderHelpSearchForm()}
${renderCategoryGrid(index)}
<p class="pillar-link">Still stuck? <a href="/dashboard/support">Open a support ticket</a>.</p>
</main>`;

  return renderSsrResponse(
    {
      title: `${HELP_HUB_TITLE} — GradeThread`,
      description: HELP_HUB_DESCRIPTION,
      canonicalUrl: canonical,
      ogType: "website",
      ogImage: `${base}${HELP_STATIC_OG_PATH}`,
      ogImageAlt: HELP_STATIC_OG_ALT,
      ogImageWidth: OG_CARD_WIDTH,
      ogImageHeight: OG_CARD_HEIGHT,
      twitterSite: twitterSiteHandle(env),
      gaMeasurementId: ga4MeasurementId(env),
      contentGroup: HELP_CONTENT_GROUP,
      alternates: [{ type: "text/markdown", href: `${canonical}.md`, title: "Markdown" }],
      jsonLd: [
        breadcrumbListLd(crumbs),
        helpCollectionLd({
          name: HELP_HUB_TITLE,
          description: HELP_HUB_DESCRIPTION,
          canonical,
          items: nonEmptyCategories(index).map((c) => ({
            title: c.title,
            url: `${base}${helpCategoryPath(c.slug)}`,
          })),
        }),
      ],
      bodyHtml: body,
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

// ── /help/search?q= ───────────────────────────────────────
// noindex, FOLLOW. A search-results page is not something to rank (it is thin,
// infinite and duplicative), but its links must still pass equity to the
// articles it found, which a bare noindex would strand.
async function renderSearch(env: PagesEnv, rawQuery: string): Promise<Response> {
  const query = rawQuery.trim().slice(0, 200);
  const [index, results] = await Promise.all([
    loadIndex(env),
    query
      ? fetchJson<HelpSearchPayload>(
        env,
        `/api/content/public/help/search?q=${encodeURIComponent(query)}`,
      )
      : Promise.resolve<HelpSearchPayload>({ query: "", hits: [] }),
  ]);
  if (!index) return helpNotFound(env);

  const base = siteUrl(env);
  const canonical = `${base}/help/search`;
  const crumbs = [
    { name: "GradeThread", url: `${base}/` },
    { name: HELP_HUB_TITLE, url: `${base}/help` },
    { name: "Search", url: canonical },
  ];

  const body = `<main class="container">
${renderBreadcrumbs(crumbs, base)}
<h1>Search help</h1>
${renderHelpSearchForm(query)}
${renderHelpSearchResults(index, results ?? { query, hits: [] })}
</main>`;

  return renderSsrResponse(
    {
      title: query ? `Search: ${query} — GradeThread Help` : "Search help — GradeThread",
      description: HELP_HUB_DESCRIPTION,
      canonicalUrl: canonical,
      robots: "noindex, follow",
      ogType: "website",
      twitterSite: twitterSiteHandle(env),
      gaMeasurementId: ga4MeasurementId(env),
      contentGroup: HELP_CONTENT_GROUP,
      jsonLd: [breadcrumbListLd(crumbs)],
      bodyHtml: body,
    },
    // Never cached at the edge: a shared cache entry keyed on pathname alone
    // would serve one visitor's results to the next visitor's query.
    { cacheControl: "no-store" },
  );
}

// ── /help/<category> ──────────────────────────────────────
async function renderCategory(env: PagesEnv, categorySlug: string): Promise<Response> {
  const index = await loadIndex(env);
  if (!index) return helpNotFound(env);

  const category = index.categories.find((c) => c.slug === categorySlug);
  if (!category) return helpNotFound(env);

  const articles = articlesInCategory(index, category.key);
  const base = siteUrl(env);
  const canonical = `${base}${helpCategoryPath(category.slug)}`;
  const crumbs = [
    { name: "GradeThread", url: `${base}/` },
    { name: HELP_HUB_TITLE, url: `${base}/help` },
    { name: category.title, url: canonical },
  ];

  const body = `<main class="container">
${renderBreadcrumbs(crumbs, base)}
<h1>${escape(category.title)}</h1>
<p>${escape(category.summary)}</p>
${renderArticleList(category.slug, articles)}
</main>`;

  return renderSsrResponse(
    {
      title: `${category.title} — GradeThread Help`,
      description: category.summary || HELP_HUB_DESCRIPTION,
      canonicalUrl: canonical,
      ogType: "website",
      ogImage: `${base}${HELP_STATIC_OG_PATH}`,
      ogImageAlt: HELP_STATIC_OG_ALT,
      ogImageWidth: OG_CARD_WIDTH,
      ogImageHeight: OG_CARD_HEIGHT,
      twitterSite: twitterSiteHandle(env),
      gaMeasurementId: ga4MeasurementId(env),
      contentGroup: HELP_CONTENT_GROUP,
      jsonLd: [
        breadcrumbListLd(crumbs),
        helpCollectionLd({
          name: category.title,
          description: category.summary,
          canonical,
          items: articles.map((a) => ({
            title: a.title,
            url: `${base}${helpArticlePath(category.slug, a.slug)}`,
          })),
        }),
      ],
      bodyHtml: body,
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

// ── /help/<category>/<slug> ───────────────────────────────
async function renderArticle(
  env: PagesEnv,
  categorySlug: string,
  slug: string,
  thanked = false,
): Promise<Response> {
  const data = await fetchJson<HelpArticleResponse>(
    env,
    `/api/content/public/help/${encodeURIComponent(slug)}`,
  );
  if (!data?.article) return helpNotFound(env);

  const { article } = data;
  const category: HelpCategoryPayload | null = data.category;
  const base = siteUrl(env);
  const canonical = canonicalArticleUrl(base, category, article);

  // An article re-filed into another category keeps its slug, so the old path
  // still resolves. Serving the same body at two addresses splits its ranking,
  // so the wrong category segment is a permanent redirect, not a second page.
  const expectedCategorySlug = category?.slug ?? article.category_key;
  if (categorySlug !== expectedCategorySlug) {
    return new Response(null, {
      status: 301,
      headers: { Location: helpArticlePath(expectedCategorySlug, article.slug) },
    });
  }

  // The index gives related articles real URLs. It is a second upstream hop, so
  // it is optional: a failure loses the "Related" block, not the article.
  const index = article.related_slugs.length ? await loadIndex(env).catch(() => null) : null;

  // US-2582: the first prose mention of a canonical grading term (NWT, the tier
  // names, the five weighted factors) becomes a link to its /grading/ spoke, the
  // same treatment blog posts get. It runs BEFORE the TOC pass so an anchor id
  // is never derived from markup this inserted.
  const { html: linkedBody } = linkGlossaryTerms(article.body_html);
  const { html: bodyWithAnchors, toc } = buildTableOfContents(linkedBody);
  const crumbs = [
    { name: "GradeThread", url: `${base}/` },
    { name: HELP_HUB_TITLE, url: `${base}/help` },
    ...(category
      ? [{ name: category.title, url: `${base}${helpCategoryPath(category.slug)}` }]
      : []),
    { name: article.title, url: canonical },
  ];

  const body = `<main class="container">
${renderBreadcrumbs(crumbs, base)}
<article>
<h1>${escape(article.title)}</h1>
${article.summary ? `<p>${escape(article.summary)}</p>` : ""}
${renderReviewedLine(article)}
${renderUpdatedLine(article)}
${renderTableOfContents(toc)}
${
    article.hero_image_url
      ? `<img src="${escape(article.hero_image_url)}" alt="${escape(article.title)}" loading="lazy">`
      : ""
  }
${bodyWithAnchors}
${renderFaqSection(toBlogFaqs(article.faq))}
${renderPillarLink(article.pillar_path, pillarLabel(article.pillar_path))}
${index ? renderRelatedHelp(index, article.related_slugs) : ""}
</article>
${renderHelpFeedback(article.slug, expectedCategorySlug, thanked)}
<p class="pillar-link">Didn't answer it? <a href="/dashboard/support">Open a support ticket</a>.</p>
</main>`;

  return renderSsrResponse(
    {
      title: `${article.title} — GradeThread Help`,
      description: article.summary || HELP_HUB_DESCRIPTION,
      canonicalUrl: canonical,
      // The dynamic card, always — not the hero image. A hero is chosen to sit
      // inside an article at whatever aspect ratio suits it; cropped to 1200x630
      // it is usually a detail with no title on it, which is a worse preview
      // than a card that states what the page answers.
      ogImage: `${base}${helpArticleOgPath(article.slug)}`,
      ogImageAlt: article.title,
      ogImageWidth: OG_CARD_WIDTH,
      ogImageHeight: OG_CARD_HEIGHT,
      twitterSite: twitterSiteHandle(env),
      gaMeasurementId: ga4MeasurementId(env),
      contentGroup: HELP_CONTENT_GROUP,
      alternates: [{ type: "text/markdown", href: `${canonical}.md`, title: "Markdown" }],
      // TechArticle, or HowTo when the piece is a real procedure with real
      // steps. No aggregateRating, no author Person we cannot name, no
      // dateModified we would have to invent: markup for data that does not
      // exist is the kind a manual action is issued for.
      jsonLd: [
        breadcrumbListLd(crumbs),
        helpArticleLd(article, canonical),
        helpFaqLd(article.faq),
      ].filter(Boolean),
      bodyHtml: body,
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

// ── the Markdown mirrors ──────────────────────────────────
function markdownResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": SSR_CACHE_CONTROL,
    },
  });
}

async function renderArticleMarkdown(env: PagesEnv, slug: string): Promise<Response> {
  const data = await fetchJson<HelpArticleResponse>(
    env,
    `/api/content/public/help/${encodeURIComponent(slug)}`,
  );
  if (!data?.article) {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
  return markdownResponse(buildHelpMarkdown(data.article, data.category, siteUrl(env)));
}

// Help Center SSR helpers (US-2575).
//
// Pure functions only — no Cloudflare globals — so every one of them is
// unit-testable from Vitest the way the blog's GEO helpers are. The Function in
// functions/help/[[path]].ts does the fetching and the routing; everything that
// decides what the HTML says lives here.
//
// The payload shapes mirror what /api/content/public/help returns. They are
// deliberately restated rather than imported from the edge service: functions/
// is a separate tsconfig project compiled for the Workers runtime, and reaching
// into services/edge-functions would drag Deno-flavoured imports into it.

import { escape, formatDate } from "./blog-render";

export interface HelpCategoryPayload {
  key: string;
  title: string;
  slug: string;
  summary: string;
  sort_order: number;
  icon: string | null;
  article_count?: number;
}

export interface HelpListItemPayload {
  slug: string;
  title: string;
  summary: string;
  category_key: string;
  audience: string;
  visibility: string;
  sort_order: number;
  updated_at: string;
  reviewed_at: string | null;
}

export interface HelpFaqPayload {
  question: string;
  answer: string;
}

export interface HelpArticlePayload extends HelpListItemPayload {
  body_html: string;
  body_markdown: string;
  hero_image_url: string | null;
  faq: HelpFaqPayload[];
  related_slugs: string[];
  video_url: string | null;
  pillar_path: string | null;
  published_at: string | null;
}

export interface HelpIndexPayload {
  categories: HelpCategoryPayload[];
  articles: HelpListItemPayload[];
}

export interface HelpArticleResponse {
  article: HelpArticlePayload;
  category: HelpCategoryPayload | null;
}

export const HELP_HUB_TITLE = "Help Center";
export const HELP_HUB_DESCRIPTION =
  "How to grade a garment, run the FlipDesk pipeline, connect a marketplace, " +
  "use the browser extension, and fix it when something goes wrong.";

export function helpHubPath(): string {
  return "/help";
}

export function helpCategoryPath(categorySlug: string): string {
  return `/help/${categorySlug}`;
}

export function helpArticlePath(categorySlug: string, slug: string): string {
  return `/help/${categorySlug}/${slug}`;
}

/**
 * The canonical URL for an article, which is NOT necessarily the URL that was
 * requested: an article re-filed into another category keeps its slug, so the
 * old category path still resolves. The Function 301s to this rather than
 * serving the same body at two addresses, which would split its ranking.
 */
export function canonicalArticleUrl(
  base: string,
  category: HelpCategoryPayload | null,
  article: { slug: string; category_key: string },
): string {
  const categorySlug = category?.slug ?? article.category_key;
  return `${base.replace(/\/$/, "")}${helpArticlePath(categorySlug, article.slug)}`;
}

/** Articles for one category, in the order the shelf should read. */
export function articlesInCategory(
  index: HelpIndexPayload,
  categoryKey: string,
): HelpListItemPayload[] {
  return index.articles
    .filter((a) => a.category_key === categoryKey)
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
}

/** Categories that actually have something on them. An empty shelf is a thin page. */
export function nonEmptyCategories(index: HelpIndexPayload): HelpCategoryPayload[] {
  const counts = new Map<string, number>();
  for (const a of index.articles) counts.set(a.category_key, (counts.get(a.category_key) ?? 0) + 1);
  return index.categories
    .filter((c) => (c.article_count ?? counts.get(c.key) ?? 0) > 0)
    .sort((a, b) => a.sort_order - b.sort_order);
}

export interface HelpSearchHitPayload {
  slug: string;
  title: string;
  summary: string;
  category_key: string;
  visibility: string;
  rank: number;
}

export interface HelpSearchPayload {
  query: string;
  hits: HelpSearchHitPayload[];
}

export function helpSearchPath(query?: string): string {
  return query ? `/help/search?q=${encodeURIComponent(query)}` : "/help/search";
}

/**
 * The search box, as a plain GET form.
 *
 * No JavaScript anywhere in it, on purpose: the SSR search page has to answer a
 * visitor with scripts off and a crawler that runs none, and a box that only
 * works after hydration is a box that does not work on the first paint people
 * actually see.
 */
export function renderHelpSearchForm(value = ""): string {
  return `<form class="help-search" action="/help/search" method="get" role="search">
<label class="sr-only" for="help-q">Search help</label>
<input id="help-q" type="search" name="q" value="${escape(value)}" placeholder="Search help" autocomplete="off">
<button type="submit">Search</button>
</form>`;
}

/** Search results, resolved through the index so each hit gets a real URL. */
export function renderHelpSearchResults(
  index: HelpIndexPayload,
  payload: HelpSearchPayload,
): string {
  if (!payload.query) {
    return `<p>Type what you are stuck on.</p>`;
  }
  if (payload.hits.length === 0) {
    return `<p>Nothing matched "${escape(payload.query)}". ` +
      `<a href="/help">Browse the shelves</a> or ` +
      `<a href="/dashboard/support">open a support ticket</a>.</p>`;
  }
  const catSlug = new Map(index.categories.map((c) => [c.key, c.slug]));
  const catTitle = new Map(index.categories.map((c) => [c.key, c.title]));
  const rows = payload.hits
    .map(
      (h) =>
        `<a class="post-card" href="${escape(
          helpArticlePath(catSlug.get(h.category_key) ?? h.category_key, h.slug),
        )}"><h2>${escape(h.title)}</h2>${
          h.summary ? `<p>${escape(h.summary)}</p>` : ""
        }<p>${escape(catTitle.get(h.category_key) ?? h.category_key)}</p></a>`,
    )
    .join("");
  const n = payload.hits.length;
  return `<p>${n} result${n === 1 ? "" : "s"} for "${escape(payload.query)}"</p>${rows}`;
}

/** "Last reviewed <date>", or the publish date when it has never been reviewed. */
export function renderReviewedLine(article: {
  reviewed_at: string | null;
  published_at: string | null;
  updated_at: string;
}): string {
  const basis = article.reviewed_at ?? article.published_at ?? article.updated_at;
  if (!basis) return "";
  const label = article.reviewed_at ? "Last reviewed" : "Published";
  return `<p class="post-meta"><span class="updated">${label} ${escape(formatDate(basis))}</span></p>`;
}

/** The category shelf on the hub. */
export function renderCategoryGrid(
  index: HelpIndexPayload,
): string {
  const cats = nonEmptyCategories(index);
  if (cats.length === 0) return "";
  const cards = cats
    .map((c) => {
      const count = c.article_count ?? articlesInCategory(index, c.key).length;
      return `<a class="related-card" href="${escape(helpCategoryPath(c.slug))}"><h3>${escape(
        c.title,
      )}</h3><p>${escape(c.summary)}</p><p>${count} article${count === 1 ? "" : "s"}</p></a>`;
    })
    .join("");
  return `<div class="related-grid">${cards}</div>`;
}

/** The article list on a category page. */
export function renderArticleList(
  categorySlug: string,
  articles: HelpListItemPayload[],
): string {
  if (articles.length === 0) {
    return `<p>Nothing on this shelf yet.</p>`;
  }
  return articles
    .map(
      (a) =>
        `<a class="post-card" href="${escape(
          helpArticlePath(categorySlug, a.slug),
        )}"><h2>${escape(a.title)}</h2>${a.summary ? `<p>${escape(a.summary)}</p>` : ""}</a>`,
    )
    .join("");
}

/** Related-article links, resolved against the index so each gets a real URL. */
export function renderRelatedHelp(
  index: HelpIndexPayload,
  relatedSlugs: string[],
): string {
  const bySlug = new Map(index.articles.map((a) => [a.slug, a]));
  const catSlug = new Map(index.categories.map((c) => [c.key, c.slug]));
  const cards = relatedSlugs
    .map((s) => bySlug.get(s))
    .filter((a): a is HelpListItemPayload => Boolean(a))
    .map(
      (a) =>
        `<a class="related-card" href="${escape(
          helpArticlePath(catSlug.get(a.category_key) ?? a.category_key, a.slug),
        )}"><h3>${escape(a.title)}</h3>${a.summary ? `<p>${escape(a.summary)}</p>` : ""}</a>`,
    )
    .join("");
  if (!cards) return "";
  return `<section class="related"><h2>Related</h2><div class="related-grid">${cards}</div></section>`;
}

/**
 * A readable name for a pillar path, so the uplink reads "Part of our Condition
 * Grading guide" rather than naming the brand twice. Derived from the path
 * rather than stored: a pillar is a real route whose last segment is already
 * the human phrase, and a second stored label is a second thing to keep in sync.
 */
export function pillarLabel(path: string | null | undefined): string {
  const seg = (path ?? "").split("/").filter(Boolean).pop();
  if (!seg) return "";
  return seg
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** The help FAQ shape differs from the blog's {q,a}; map before reusing its renderer. */
export function toBlogFaqs(faq: HelpFaqPayload[]): Array<{ q: string; a: string }> {
  return (faq ?? [])
    .filter((f) => f?.question?.trim() && f?.answer?.trim())
    .map((f) => ({ q: f.question.trim(), a: f.answer.trim() }));
}

/**
 * Clean Markdown for an article, served at <url>.md.
 *
 * Answer engines read this in preference to the HTML, so it carries the same
 * facts and the same canonical link rather than a stripped-down teaser. Built
 * from body_markdown, which the editor stores alongside the HTML.
 */
export function buildHelpMarkdown(
  article: HelpArticlePayload,
  category: HelpCategoryPayload | null,
  siteUrl: string,
): string {
  const base = siteUrl.replace(/\/$/, "");
  const canonical = canonicalArticleUrl(base, category, article);
  const out: string[] = [];

  out.push(`# ${article.title.trim()}`);

  const meta: string[] = [];
  if (category) meta.push(`Category: ${category.title}`);
  const basis = article.reviewed_at ?? article.published_at;
  if (basis) {
    meta.push(`${article.reviewed_at ? "Last reviewed" : "Published"} ${basis.slice(0, 10)}`);
  }
  if (meta.length) out.push(`_${meta.join(" · ")}_`);

  if (article.summary.trim()) out.push(article.summary.trim());
  out.push(`Source: ${canonical}`);

  const body = (article.body_markdown ?? "").trim();
  if (body) out.push(body);

  const faqs = toBlogFaqs(article.faq);
  if (faqs.length) {
    out.push("## Frequently asked questions");
    for (const f of faqs) out.push(`### ${f.q}\n\n${f.a}`);
  }

  if (article.pillar_path) out.push(`Part of: ${base}${article.pillar_path}`);

  return out.join("\n\n") + "\n";
}

/** Markdown index of the whole help center, served at /help.md. */
export function buildHelpIndexMarkdown(index: HelpIndexPayload, siteUrl: string): string {
  const base = siteUrl.replace(/\/$/, "");
  const out: string[] = [`# ${HELP_HUB_TITLE}`, HELP_HUB_DESCRIPTION];
  for (const c of nonEmptyCategories(index)) {
    out.push(`## ${c.title}`);
    if (c.summary) out.push(c.summary);
    const lines = articlesInCategory(index, c.key).map(
      (a) => `- [${a.title}](${base}${helpArticlePath(c.slug, a.slug)}): ${a.summary}`,
    );
    if (lines.length) out.push(lines.join("\n"));
  }
  return out.join("\n\n") + "\n";
}

// /llms.txt — a Markdown map of the site for LLMs / AI answer engines
// (PRD: tasks/prd-seo-hardening.md, US-295; registry-driven in US-431).
//
// The section list is no longer hand-curated: it's derived from the build-emitted
// dist/seo-manifest.json (which IS src/lib/seo/public-routes.ts → PUBLIC_ROUTES),
// the same source the sitemap uses. A new public page therefore auto-appears here
// with no hand-edit, and src/test/llms-txt.test.ts fails CI if a registry route
// goes missing from the output.

import { siteUrl, edgeApi, type PagesEnv } from "./_shared/blog-render";
import {
  buildLlmsTxt,
  buildLlmsSections,
  LLMS_SUMMARY,
  AI_CRAWLER_POLICY_NOTE,
  type LlmsRoute,
} from "./_shared/seo-config";

interface SeoManifest {
  routes: Array<{
    path: string;
    title: string;
    description?: string;
    priority?: number;
  }>;
}
interface CertSitemap {
  certificates: Array<{ id: string }>;
}
interface SellerSitemap {
  sellers: Array<{ handle: string }>;
}
interface AuthorSitemap {
  authors: Array<{ slug: string; name: string }>;
}
interface PostsIndex {
  posts: Array<{ slug: string; title: string; excerpt: string | null }>;
}
// US-2580. The ANONYMOUS help endpoint, which is what makes this section
// public-only: it cannot return a members or internal article, so there is no
// filter here to get wrong.
interface HelpIndex {
  categories: Array<{ key: string; title: string; slug: string; summary: string }>;
  articles: Array<{
    slug: string;
    title: string;
    summary: string;
    category_key: string;
    sort_order: number;
  }>;
}

// How many help articles to list. Bounded like the article limit above so
// llms.txt stays a curated map — /help.md is the full territory.
const LLMS_HELP_LIMIT = 40;

// How many recent posts to list in llms.txt's Recent Articles section. Bounded
// so the file stays a curated map, not a full feed (that's rss.xml/sitemap).
const LLMS_ARTICLE_LIMIT = 25;

async function fetchJsonSafe<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      cf: { cacheTtl: 300, cacheEverything: true },
      ...init,
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Static fallback so /llms.txt still renders the core map if the manifest asset
// is somehow unavailable (e.g. a partial deploy).
const FALLBACK_ROUTES: LlmsRoute[] = [
  { path: "/", title: "GradeThread home", priority: 1.0 },
  { path: "/how-it-works", title: "How It Works", priority: 0.9 },
  { path: "/pricing", title: "Pricing", priority: 0.9 },
  { path: "/condition-grading", title: "What Is Clothing Condition Grading?", priority: 0.9 },
  { path: "/grading-standard", title: "The GradeThread Grading Standard", priority: 0.8 },
  { path: "/transparency", title: "Grading Accuracy & Transparency Report", priority: 0.8 },
  { path: "/for-resellers", title: "For Resellers", priority: 0.8 },
  { path: "/faq", title: "Frequently Asked Questions", priority: 0.7 },
];

export const onRequestGet: PagesFunction<PagesEnv> = async ({ env }) => {
  const base = siteUrl(env);
  const api = edgeApi(env);

  const manifest = await fetchJsonSafe<SeoManifest>(`${base}/seo-manifest.json`);
  const routes: LlmsRoute[] = manifest?.routes?.length
    ? manifest.routes.map((r) => ({
        path: r.path,
        title: r.title,
        description: r.description,
        priority: r.priority,
      }))
    : FALLBACK_ROUTES;

  // Representative dynamic URLs — best-effort, gracefully omitted on failure.
  const [certs, sellers, authors, posts, help] = await Promise.all([
    fetchJsonSafe<CertSitemap>(`${api}/api/content/public/certificates.json`, {
      headers: { Accept: "application/json" },
    }),
    fetchJsonSafe<SellerSitemap>(`${api}/api/content/public/sellers.json`, {
      headers: { Accept: "application/json" },
    }),
    fetchJsonSafe<AuthorSitemap>(`${api}/api/content/public/authors.json`, {
      headers: { Accept: "application/json" },
    }),
    // US-877: recent published posts (newest first) for the Recent Articles
    // section — title + one-line excerpt summary + URL.
    fetchJsonSafe<PostsIndex>(
      `${api}/api/content/public/posts?limit=${LLMS_ARTICLE_LIMIT}`,
      { headers: { Accept: "application/json" } },
    ),
    fetchJsonSafe<HelpIndex>(`${api}/api/content/public/help`, {
      headers: { Accept: "application/json" },
    }),
  ]);
  const certUrls = (certs?.certificates ?? []).slice(0, 3).map((cI) => ({
    title: `Verified grade certificate ${cI.id}`,
    url: `/cert/${cI.id}`,
  }));
  const sellerUrls = (sellers?.sellers ?? []).slice(0, 3).map((s) => ({
    title: `Verified seller @${s.handle}`,
    url: `/verified/${s.handle}`,
  }));
  // US-874: list every author (small, curated set) so AI engines can attribute
  // articles to the expert behind them.
  const authorUrls = (authors?.authors ?? []).map((a) => ({
    title: a.name,
    url: `/authors/${a.slug}`,
  }));
  // US-877: recent articles with a one-line summary. Each is also available as
  // clean Markdown at `<url>.md` (the section builder appends that hint).
  const articleUrls = (posts?.posts ?? [])
    .filter((p) => p?.slug && p?.title)
    .slice(0, LLMS_ARTICLE_LIMIT)
    .map((p) => ({
      title: p.title,
      url: `/blog/${p.slug}`,
      note: p.excerpt?.trim() || undefined,
    }));

  // US-2580: category hubs first, then the articles on them, each with its
  // Markdown mirror named. An article whose category is missing from the
  // payload is dropped rather than given a guessed URL — the same rule the
  // sitemap follows, for the same reason (a guess is a 301 in a list of facts).
  const helpCatSlug = new Map((help?.categories ?? []).map((c) => [c.key, c.slug]));
  const helpArticles = (help?.articles ?? [])
    .filter((a) => a?.slug && a?.title && helpCatSlug.has(a.category_key))
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title))
    .slice(0, LLMS_HELP_LIMIT);
  const helpUrls = [
    ...(help?.categories ?? [])
      .filter((c) => helpArticles.some((a) => a.category_key === c.key))
      .map((c) => ({
        title: c.title,
        url: `/help/${c.slug}`,
        note: c.summary?.trim() || undefined,
      })),
    ...helpArticles.map((a) => {
      const url = `/help/${helpCatSlug.get(a.category_key)}/${a.slug}`;
      return {
        title: a.title,
        url,
        note: [a.summary?.trim(), `Markdown: ${url}.md`].filter(Boolean).join(" — "),
      };
    }),
  ];

  const body = buildLlmsTxt({
    siteUrl: base,
    summary: LLMS_SUMMARY,
    policyNote: AI_CRAWLER_POLICY_NOTE,
    sections: buildLlmsSections({
      routes,
      certUrls,
      sellerUrls,
      authorUrls,
      articleUrls,
      helpUrls,
    }),
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};

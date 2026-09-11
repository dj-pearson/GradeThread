// /llms.txt, a Markdown map of the site for LLMs and AI answer engines
// (PRD: tasks/prd-seo-hardening.md, US-295; registry-driven in US-431).
//
// The route list is derived from the build-emitted dist/seo-manifest.json (which
// IS src/lib/seo/public-routes.ts, PUBLIC_ROUTES), the same source the sitemap
// uses, so a new public page appears here with no hand-edit.
//
// US-3382 corrected this header, which is worth saying because it claimed two
// things that were not true of the code under it:
//
//   • "no longer hand-curated". There WAS a hand-written 8-route list below,
//     FALLBACK_ROUTES, and it shipped silently whenever the manifest read
//     failed. Measured 2026-09-11 against the real registry: a 500 on the
//     manifest took this file from 281 entries to 13, served 200 and cached for
//     an hour. The list is deleted; a manifest we cannot read is now a 503.
//   • "src/test/llms-txt.test.ts fails CI if a registry route goes missing".
//     That test renders buildLlmsSections() with PUBLIC_ROUTES passed in by
//     hand, so it proves the SERIALIZER keeps every route. It never called this
//     function and could not see what it served. The guard that covers THIS
//     file is src/test/llms-txt-upstream-failure.test.ts, which drives
//     onRequestGet against a failing upstream and asserts the status.
//
// Both claims are the same species of bug as the one they were hiding: a
// statement about a guard that nobody re-checked. Do not restore either without
// the test that makes it true.

import {
  siteUrl,
  edgeApi,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  type PagesEnv,
  withEdgeCache,
} from "./_shared/blog-render";
import {
  enforceUrlFloor,
  STATIC_URLS_LAST_KNOWN_GOOD,
} from "./_shared/sitemap";
import {
  buildLlmsTxt,
  buildLlmsSections,
  LLMS_SUMMARY,
  AI_CRAWLER_POLICY_NOTE,
  type LlmsRoute,
} from "./_shared/seo-config";
import { headOf } from "./_shared/head-of";

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

/**
 * US-3382: this replaces fetchJsonSafe, which had SIX call sites and zero
 * failure detection. It collapsed a 500, a 429, an 8s timeout and a malformed
 * body into the same null a genuinely-empty collection produces, and every
 * caller then wrote `?? []`.
 *
 * Three-valued instead, the same convention as blog-render's fetchJson and the
 * sitemap's fetchEdgeJson, so this file stops being the one exception:
 *
 *   • 200        -> the data.
 *   • 404 / 410  -> `null`, which means EMPTY and is a real answer. A new
 *                   install with no certificates is not a failure, and must not
 *                   take the whole file down.
 *   • anything else, a network error, a timeout, a malformed body -> throw,
 *     because we do not know what is there and a guess gets cached for an hour.
 */
async function fetchJsonOrThrow<T>(
  label: string,
  url: string,
  init?: RequestInit,
): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      cf: { cacheTtl: 300, cacheEverything: true },
      ...init,
    } as RequestInit);
  } catch (e) {
    console.error(`[llms.txt] ${label} unreachable:`, e);
    throw new UpstreamUnavailable(
      `${label} ${e instanceof Error ? e.name : "unknown"}`,
    );
  }
  if (!res.ok) {
    if (res.status === 404 || res.status === 410) {
      console.error(`[llms.txt] ${label} reports no such collection (${res.status})`);
      return null;
    }
    console.error(`[llms.txt] ${label} failed: status ${res.status}`);
    throw new UpstreamUnavailable(`${label} status ${res.status}`);
  }
  try {
    return (await res.json()) as T;
  } catch (e) {
    console.error(`[llms.txt] malformed JSON from ${label}:`, e);
    throw new UpstreamUnavailable(`${label} malformed-json`);
  }
}

/**
 * US-2615: served from the worker cache.
 *
 * This builder makes FIVE upstream calls per request (certificates, sellers,
 * authors, posts, help). The edge caps /api/content/public/* at 60 requests a
 * minute per IP, fail-closed, and every SSR surface reaches it through one
 * Cloudflare Pages worker — so twelve uncached fetches of this one file would
 * exhaust the bucket for the whole public site.
 *
 * Measured 2026-08-15: this answered with no x-gt-cache header at all, so every
 * fetch rebuilt it. Answer engines poll llms.txt; that is the point of it.
 */
export const onRequestGet: PagesFunction<PagesEnv> = (context) =>
  withEdgeCache(context, () => renderLlmsTxt(context.env));

/**
 * US-3382: one upstream failure is now a 503, not a shorter file.
 *
 * The precedent is already in this tree twice and this file was the exception:
 * llms-full.txt.ts:33-53 answers 503 on exactly this class of failure, saying "a
 * partial standard is worse than none", and the sitemap throws
 * UpstreamUnavailable from the same endpoints this reads.
 *
 * THE CACHE IS WHY IT MATTERS HERE MORE THAN ANYWHERE. This response carries
 * `public, max-age=3600` and goes through withEdgeCache, which stores exactly
 * one thing: a publicly-cacheable 200. A degraded file is therefore not one bad
 * response, it is an hour of them, handed to answer engines that poll this file
 * precisely because it claims to be the map. upstreamUnavailableResponse() is a
 * 503 with Retry-After and `no-store`, which withEdgeCache refuses to store.
 */
async function renderLlmsTxt(env: PagesEnv): Promise<Response> {
  try {
    return await buildLlmsTxtResponse(env);
  } catch (e) {
    if (e instanceof UpstreamUnavailable) {
      console.error("[llms.txt] upstream unavailable, serving 503:", e.message);
      return upstreamUnavailableResponse();
    }
    throw e;
  }
}

async function buildLlmsTxtResponse(env: PagesEnv): Promise<Response> {
  const base = siteUrl(env);
  const api = edgeApi(env);

  // The spine of the document. A 404 here means the build has not landed, which
  // is still not a document worth publishing: the hand-written 8-route fallback
  // that used to cover this case is what turned a manifest blip into a file
  // claiming the site has eight pages.
  const manifest = await fetchJsonOrThrow<SeoManifest>(
    "seo-manifest.json",
    `${base}/seo-manifest.json`,
  );
  const routes: LlmsRoute[] = (manifest?.routes ?? []).map((r) => ({
    path: r.path,
    title: r.title,
    description: r.description,
    priority: r.priority,
  }));
  // US-3382 AC4: the floor. The manifest is this file's only route source, so
  // its size IS the document's size, and "200 with fewer routes than yesterday"
  // is the only symptom the failure produces. The expected count comes from
  // STATIC_URLS_LAST_KNOWN_GOOD, which the sitemap owns because both files read
  // the same artifact and a second copy of the number would drift from it;
  // src/test/sitemap-url-floor.test.ts holds it against the live registry.
  enforceUrlFloor("llms.txt route map", routes.length, STATIC_URLS_LAST_KNOWN_GOOD);

  // Representative dynamic URLs. Each of the five is a real section of the map,
  // so a read we could not make propagates rather than quietly shortening the
  // file; a 404 is the one answer that legitimately means "this section is
  // empty" and renders as an omitted section.
  const [certs, sellers, authors, posts, help] = await Promise.all([
    fetchJsonOrThrow<CertSitemap>(
      "certificates.json",
      `${api}/api/content/public/certificates.json`,
      { headers: { Accept: "application/json" } },
    ),
    fetchJsonOrThrow<SellerSitemap>(
      "sellers.json",
      `${api}/api/content/public/sellers.json`,
      { headers: { Accept: "application/json" } },
    ),
    fetchJsonOrThrow<AuthorSitemap>(
      "authors.json",
      `${api}/api/content/public/authors.json`,
      { headers: { Accept: "application/json" } },
    ),
    // US-877: recent published posts (newest first) for the Recent Articles
    // section: title, a one-line excerpt summary, and the URL.
    fetchJsonOrThrow<PostsIndex>(
      "posts",
      `${api}/api/content/public/posts?limit=${LLMS_ARTICLE_LIMIT}`,
      { headers: { Accept: "application/json" } },
    ),
    fetchJsonOrThrow<HelpIndex>("help", `${api}/api/content/public/help`, {
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
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

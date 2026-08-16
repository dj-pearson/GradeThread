// US-2581: dynamic Open Graph image for a public Help Center article.
//
// /og/help/:slug returns a 1200x630 PNG with the article's title and its
// category. functions/help/[[path]].ts points og:image and twitter:image at it.
// The raster runs on the Deno edge (US-2619), not in this Worker.
//
// Help links get pasted into Discord, Reddit and support replies more than any
// marketing page does, and a blank preview wastes the click.
//
// Addressed by SLUG alone, not by category/slug: the slug is unique across the
// corpus, and putting the category in the path would mean a re-filed article
// silently serving a card at a URL nothing points to any more.
//
// It calls the ANONYMOUS endpoint, so a members-only or internal article has no
// card here to leak its title through. That is the same wall as everywhere else
// in this feature, not a second one.

import {
  fetchJson,
  siteUrl,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  type PagesEnv,
} from "../../_shared/blog-render";
import {
  brandedFallbackResponse,
  buildHelpOgHtml,
} from "../../_shared/og-template";
import type { HelpArticleResponse } from "../../_shared/help-render";
import { headOf } from "../../_shared/head-of";
import { renderViaEdge } from "../../_shared/render-via-edge";

type Ctx = EventContext<PagesEnv, "slug", Record<string, unknown>>;

const OG_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const slug = String(params.slug ?? "");
  if (!slug) return await fallbackImage(env);

  try {
    let data: HelpArticleResponse | null;
    try {
      data = await fetchJson<HelpArticleResponse>(
        env,
        `/api/content/public/help/${encodeURIComponent(slug)}`,
      );
    } catch (e) {
      // US-2044: an upstream we could not reach is our problem, not the URL's.
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }
    if (!data?.article) return await fallbackImage(env);

    const { article, category } = data;
    const basis = article.reviewed_at ?? article.published_at;
    const reviewedAt = basis
      ? new Date(basis).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : null;

    // US-2619: rasterised on the Deno edge, like its three siblings.
    //
    // ⚠ THIS ROUTE'S RENDER HAS NEVER RUN. help_articles is empty in production
    // (US-2618), so every request has taken the article-not-found branch above
    // and served the branded fallback — which is indistinguishable from a failed
    // render, and is why this read as healthy for so long.
    //
    // CONVERTED ON A JUDGEMENT, NOT A MEASUREMENT, so it is written down. Of the
    // five og routes that rendered in-Function, four failed and only
    // /og/grade-check worked — and that one is structurally unlike the rest (a
    // QR data-URI image, a different builder). buildHelpOgHtml comes from the
    // same module as the three confirmed-broken cards, so the odds are it shares
    // their fault. The failure mode is identical either way (branded fallback),
    // so converting cannot regress it, and the alternative was shipping the help
    // corpus and discovering blank previews afterwards.
    //
    // If it turns out this route rendered fine in-Function all along, the cost
    // is one edge round trip on a rarely-shared surface. Revisit with a single
    // curl once US-2618 seeds the corpus.
    return await renderViaEdge(env, {
      markup: buildHelpOgHtml({
        title: article.title,
        category: category?.title ?? null,
        reviewedAt,
      }),
      width: 1200,
      height: 630,
      cacheControl: OG_CACHE_CONTROL,
      label: "og/help",
    });
  } catch (err) {
    console.error("[og/help] render failed:", err);
    return await fallbackImage(env);
  }
};

// US-2108 AC3: a blank preview is worse for click-through than a generic
// branded card. Drops to the transparent pixel only if the static asset is
// also unreachable.
function fallbackImage(env: PagesEnv): Promise<Response> {
  return brandedFallbackResponse(siteUrl(env));
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

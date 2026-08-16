// US-871: dynamic branded social card.
//
// /og/social/card?ratio=&kind=&text=&stat=&product=&eyebrow= returns an
// on-brand PNG (Satori via workers-og) in any of the four aspect ratios each
// network needs. It is stateless — all content rides in the query string — so
// it never exposes an unpublished draft by id, renders deterministically, and
// edge-caches cleanly (Cloudflare keys the cache on the full URL incl. query).
//
// The social publish/generate path (content-social-publish.ts) auto-fills a URL
// to this endpoint when a post has no asset_image_url, so every webhook payload
// carries an image even when no asset was uploaded. Admins can also point a post
// at one of these URLs (or override with an upload) from the social editor.

import { siteUrl, type PagesEnv } from "../../_shared/blog-render";
import {
  buildSocialCardHtml,
  brandedFallbackResponse,
  isSocialCardRatio,
  type SocialCardKind,
  type SocialCardRatio,
  SOCIAL_CARD_SIZES,
} from "../../_shared/og-template";
import { headOf } from "../../_shared/head-of";
import { renderViaEdge } from "../../_shared/render-via-edge";

const CARD_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

const PRODUCTS = new Set(["gradethread", "flipdesk", "both"]);

export const onRequestGet: PagesFunction<PagesEnv> = async (context) => {
  const q = new URL(context.request.url).searchParams;
  // US-2108: needed for the branded og:image fallback's same-origin fetch.
  const env = context.env;

  const ratioRaw = q.get("ratio");
  const ratio: SocialCardRatio = isSocialCardRatio(ratioRaw)
    ? ratioRaw
    : "landscape";
  const size = SOCIAL_CARD_SIZES[ratio];

  const kindParam = q.get("kind");
  const kind: SocialCardKind = kindParam === "quote" || kindParam === "stat"
    ? kindParam
    : "title";

  const text = (q.get("text") ?? "").trim() ||
    "Verified condition grading for pre-owned clothing";
  const stat = q.get("stat");
  const eyebrow = q.get("eyebrow");
  const productParam = q.get("product");
  const product = productParam && PRODUCTS.has(productParam)
    ? (productParam as "gradethread" | "flipdesk" | "both")
    : "gradethread";

  try {
    const html = buildSocialCardHtml({
      ratio,
      kind,
      text,
      stat,
      product,
      eyebrow,
    });
    // US-2619: rasterised on the Deno edge, not here. workers-og inside this
    // Pages Function has never rendered this card — the markup is fine (the
    // same string produces valid SVG in satori), so the failure is downstream
    // of layout. This is the remedy og/cert, slab/cert and badge/cert already
    // use. Falls back to the branded card on any failure, which is exactly what
    // this route serves today, so it cannot regress.
    return await renderViaEdge(env, {
      markup: html,
      width: size.width,
      height: size.height,
      cacheControl: CARD_CACHE_CONTROL,
      label: "og/social/card",
    });
  } catch (err) {
    console.error("[og/social/card] render failed:", err);
    return await fallbackImage(env);
  }
};

// US-2108 AC3: a blank preview is worse for click-through than a generic
// branded card. Delegates to the shared branded fallback, which drops to the
// transparent pixel only if the static asset is also unreachable.
function fallbackImage(env: PagesEnv): Promise<Response> {
  return brandedFallbackResponse(siteUrl(env));
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

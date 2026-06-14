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

import { ImageResponse } from "workers-og";
import {
  buildSocialCardHtml,
  FALLBACK_PNG_BASE64,
  isSocialCardRatio,
  type SocialCardKind,
  type SocialCardRatio,
  SOCIAL_CARD_SIZES,
} from "../../_shared/og-template";

const CARD_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

const PRODUCTS = new Set(["gradethread", "flipdesk", "both"]);

export const onRequestGet: PagesFunction = async (context) => {
  const q = new URL(context.request.url).searchParams;

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
    return new ImageResponse(html, {
      width: size.width,
      height: size.height,
      headers: {
        "Cache-Control": CARD_CACHE_CONTROL,
        "Content-Type": "image/png",
      },
    });
  } catch (err) {
    console.error("[og/social/card] render failed:", err);
    return fallbackImage();
  }
};

function fallbackImage(): Response {
  // Valid 1x1 transparent PNG so a render error never yields a broken image; a
  // shorter cache on failure so a retry isn't pinned.
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
    },
  });
}

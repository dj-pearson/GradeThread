// US-1761: embeddable "GradeThread Verified Seller" storefront badge, keyed to
// a seller's verified handle (not a single certificate).
//
// Thin proxy: rendered on the Deno edge (full CPU) and streamed back here, for
// the same reason as the cert badge (functions/badge/cert/[id].ts) — a
// workers-og render inside a Pages Function exceeds the Free-plan Worker CPU
// limit. Sellers drop this — wrapped in a link to /verified/:handle — into a
// listing description or storefront, so it must stay a plain cacheable <img>.
// The ?format= (wide|compact|listing_header) passes through to the edge.

import { edgeApi, type PagesEnv } from "../../_shared/blog-render";
import { FALLBACK_PNG_BASE64 } from "../../_shared/og-template";

type Ctx = EventContext<PagesEnv, "handle", Record<string, unknown>>;

const BADGE_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

const ALLOWED_FORMATS = new Set(["wide", "compact", "listing_header"]);

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env, request } = context;
  const handle = String(params.handle ?? "").trim();
  if (!handle) return fallbackImage();

  const fmt = new URL(request.url).searchParams.get("format") ?? "wide";
  const format = ALLOWED_FORMATS.has(fmt) ? fmt : "wide";

  const upstreamUrl =
    `${edgeApi(env)}/api/content/public/seller-badge/${encodeURIComponent(handle)}?format=${format}`;
  try {
    const upstream = await fetch(upstreamUrl);
    if (!upstream.ok || !upstream.body) return fallbackImage();
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": BADGE_CACHE_CONTROL },
    });
  } catch {
    return fallbackImage();
  }
};

export const onRequestHead: PagesFunction<PagesEnv> = () =>
  new Response(null, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": BADGE_CACHE_CONTROL },
  });

function fallbackImage(): Response {
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" },
  });
}

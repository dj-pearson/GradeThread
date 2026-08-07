// Embeddable "GradeThread Verified" trust badge (700x180) for a graded item.
//
// Thin proxy: rendered on the Deno edge (full CPU) and streamed back here. The
// previous workers-og render inside this Pages Function exceeded the Free-plan
// Worker CPU limit (HTTP 503 "error code: 1102"). Streaming bytes is pure I/O
// and stays within the Free limit. Sellers drop this — wrapped in a link to
// /cert/:id (see functions/embed/cert/[id].ts) — into a listing description, so
// it must stay a plain cacheable <img>. On any upstream error we return the
// transparent fallback PNG.

import { edgeApi, type PagesEnv } from "../../_shared/blog-render";
import { FALLBACK_PNG_BASE64 } from "../../_shared/og-template";

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

const BADGE_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env, request } = context;
  const id = String(params.id ?? "").trim();
  if (!id) return fallbackImage();
  const upstreamUrl = `${edgeApi(env)}/api/content/public/cert-image/${encodeURIComponent(id)}?kind=badge`;
  try {
    // Forward the embedding page's Referer (US-1849): upstream reads it as the
    // `badge_embedded` signal — proof the badge is rendering somewhere we don't
    // own. It is the ONLY header we pass on; everything else about the visitor
    // stays here. Absent header → nothing forwarded → no award, which is the
    // safe default.
    const referer = request.headers.get("referer");
    const upstream = await fetch(
      upstreamUrl,
      referer ? { headers: { referer } } : undefined,
    );
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

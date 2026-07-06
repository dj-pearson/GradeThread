// US-307: dynamic Open Graph card (1200x630) for a public certificate.
//
// Thin proxy: rendered on the Deno edge (full CPU) and streamed back here. The
// previous workers-og render inside this Pages Function exceeded the Free-plan
// Worker CPU limit (HTTP 503 "error code: 1102"), which broke every shared-link
// preview. Streaming bytes is pure I/O and stays within the Free limit. On any
// upstream error we return the transparent fallback PNG (crawlers accept it).

import { edgeApi, type PagesEnv } from "../../_shared/blog-render";
import { FALLBACK_PNG_BASE64 } from "../../_shared/og-template";

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

const OG_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const id = String(params.id ?? "").trim();
  if (!id) return fallbackImage();
  const upstreamUrl = `${edgeApi(env)}/api/content/public/cert-image/${encodeURIComponent(id)}?kind=og`;
  try {
    const upstream = await fetch(upstreamUrl);
    if (!upstream.ok || !upstream.body) return fallbackImage();
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": OG_CACHE_CONTROL },
    });
  } catch {
    return fallbackImage();
  }
};

// Some social scrapers HEAD the og:image first — answer 200.
export const onRequestHead: PagesFunction<PagesEnv> = () =>
  new Response(null, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": OG_CACHE_CONTROL },
  });

function fallbackImage(): Response {
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" },
  });
}

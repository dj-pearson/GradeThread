// US-307: dynamic Open Graph card (1200x630) for a public certificate.
//
// Thin proxy: rendered on the Deno edge (full CPU) and streamed back here. The
// previous workers-og render inside this Pages Function exceeded the Free-plan
// Worker CPU limit (HTTP 503 "error code: 1102"), which broke every shared-link
// preview. Streaming bytes is pure I/O and stays within the Free limit. On any
// upstream error we return the transparent fallback PNG (crawlers accept it).

import { edgeApi, siteUrl, type PagesEnv } from "../../_shared/blog-render";
import { brandedFallbackResponse } from "../../_shared/og-template";

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

const OG_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const id = String(params.id ?? "").trim();
  if (!id) return await fallbackImage(env);
  const upstreamUrl = `${edgeApi(env)}/api/content/public/cert-image/${encodeURIComponent(id)}?kind=og`;
  try {
    const upstream = await fetch(upstreamUrl);
    if (!upstream.ok || !upstream.body) return await fallbackImage(env);
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": OG_CACHE_CONTROL },
    });
  } catch {
    return await fallbackImage(env);
  }
};

// Some social scrapers HEAD the og:image first — answer 200.
// US-2620: deliberately bespoke. The canned 200 is honest HERE and only here:
// this route's GET can never 404 — every error path returns a fallback image
// (grep: no 404 in this file), so a HEAD that always says 200 is telling the
// truth about what a GET would do. Routing it through headOf(onRequestGet)
// would run the full render on every crawler probe to learn a status that
// cannot vary. Delete this marker the moment this route can 404.
export const onRequestHead: PagesFunction<PagesEnv> = () =>
  new Response(null, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": OG_CACHE_CONTROL },
  });

// US-2108 AC3: a blank preview is worse for click-through than a generic
// branded card. Delegates to the shared branded fallback, which drops to the
// transparent pixel only if the static asset is also unreachable.
function fallbackImage(env: PagesEnv): Promise<Response> {
  return brandedFallbackResponse(siteUrl(env));
}

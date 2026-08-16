// US-1850 AC3: the public URL for an achievement-badge card,
// /badge/achievement/:key — the image a seller shares when they unlock a medal.
//
// Thin proxy, same shape and reason as the cert and verified-seller badges
// (functions/badge/cert/[id].ts, functions/badge/verified/[handle].ts): the
// satori→resvg render runs on the Deno edge, because a workers-og render inside
// a Pages Function exceeds the Free-plan Worker CPU limit. The card describes
// the BADGE (name, what earns it, tier medal) and is keyed only by the catalog
// key — whether a given user earned it is a separate, non-public read — so it
// stays a plain, long-cacheable img element.

import { edgeApi, type PagesEnv } from "../../_shared/blog-render";
import { FALLBACK_PNG_BASE64 } from "../../_shared/og-template";

type Ctx = EventContext<PagesEnv, "key", Record<string, unknown>>;

const BADGE_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const key = String(params.key ?? "").trim();
  if (!key) return fallbackImage();

  const upstreamUrl =
    `${edgeApi(env)}/api/content/public/achievement-badge/${encodeURIComponent(key)}`;
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

// US-2620: deliberately bespoke. The canned 200 is honest HERE and only here:
// this route's GET can never 404 — every error path returns a fallback image
// (grep: no 404 in this file), so a HEAD that always says 200 is telling the
// truth about what a GET would do. Routing it through headOf(onRequestGet)
// would run the full render on every crawler probe to learn a status that
// cannot vary. Delete this marker the moment this route can 404.
export const onRequestHead: PagesFunction<PagesEnv> = () =>
  new Response(null, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": BADGE_CACHE_CONTROL },
  });

// Never a broken image: an unknown key or an unreachable edge serves the
// transparent 1x1 with a short TTL, so a blip doesn't get cached for a day.
function fallbackImage(): Response {
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" },
  });
}

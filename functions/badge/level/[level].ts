// US-1857: the public URL for a reward-LEVEL card, /badge/level/:level — the
// image a seller shares when they level up.
//
// Thin proxy, identical in shape and reason to the achievement badge
// (functions/badge/achievement/[key].ts): the satori→resvg render runs on the
// Deno edge, because a workers-og render inside a Pages Function exceeds the
// Free-plan Worker CPU limit. The card describes the RUNG (level number, tier
// name, tier blurb) and is keyed only by the level — who is standing on it is a
// separate, non-public read — so it stays a plain, long-cacheable <img>.

import { edgeApi, type PagesEnv } from "../../_shared/blog-render";
import { FALLBACK_PNG_BASE64 } from "../../_shared/og-template";

type Ctx = EventContext<PagesEnv, "level", Record<string, unknown>>;

const BADGE_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const level = String(params.level ?? "").trim();
  if (!level) return fallbackImage();

  const upstreamUrl =
    `${edgeApi(env)}/api/content/public/level-badge/${encodeURIComponent(level)}`;
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

// Never a broken image: an unknown level or an unreachable edge serves the
// transparent 1x1 with a short TTL, so a blip doesn't get cached for a day.
function fallbackImage(): Response {
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" },
  });
}

// US-1761: embeddable "GradeThread Verified Seller" storefront badge, keyed to
// a seller's verified handle (not a single certificate).
//
// Thin proxy: rendered on the Deno edge (full CPU) and streamed back here, for
// the same reason as the cert badge (functions/badge/cert/[id].ts) — a
// workers-og render inside a Pages Function exceeds the Free-plan Worker CPU
// limit. Sellers drop this — wrapped in a link to /verified/:handle — into a
// listing description or storefront, so it must stay a plain cacheable img element.
// The ?format= (wide|compact|listing_header) passes through to the edge.

import { edgeApi, type PagesEnv } from "../../_shared/blog-render";
import { FALLBACK_PNG_BASE64 } from "../../_shared/og-template";

type Ctx = EventContext<PagesEnv, "handle", Record<string, unknown>>;

const BADGE_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

// US-1913 AC3: the STATUS badge carries a standing that changes, so the only
// thing bounding how long a stale tier can be shown is this header — 24h flat,
// with NO stale-while-revalidate window after it. Re-applying the 7-day SWR of
// the plain badge here would silently undo the bound the edge set upstream.
const BADGE_STATUS_CACHE_CONTROL = "public, max-age=86400, s-maxage=86400";

const ALLOWED_FORMATS = new Set(["wide", "compact", "listing_header"]);

/** `?status=1` selects the opt-in level/integrity-tier variant of the badge. */
function wantsStatus(url: URL): boolean {
  const v = (url.searchParams.get("status") ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "status" || v === "yes";
}

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env, request } = context;
  const handle = String(params.handle ?? "").trim();
  if (!handle) return fallbackImage();

  const url = new URL(request.url);
  const fmt = url.searchParams.get("format") ?? "wide";
  const format = ALLOWED_FORMATS.has(fmt) ? fmt : "wide";
  const status = wantsStatus(url);

  const upstreamUrl =
    `${edgeApi(env)}/api/content/public/seller-badge/${encodeURIComponent(handle)}?format=${format}` +
    (status ? "&status=1" : "");
  try {
    const upstream = await fetch(upstreamUrl);
    if (!upstream.ok || !upstream.body) return fallbackImage();
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": status ? BADGE_STATUS_CACHE_CONTROL : BADGE_CACHE_CONTROL,
      },
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
export const onRequestHead: PagesFunction<PagesEnv> = (context: Ctx) =>
  new Response(null, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": wantsStatus(new URL(context.request.url))
        ? BADGE_STATUS_CACHE_CONTROL
        : BADGE_CACHE_CONTROL,
    },
  });

function fallbackImage(): Response {
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" },
  });
}

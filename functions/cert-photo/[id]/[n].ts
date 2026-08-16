// US-2206: the STABLE, same-origin URL for one garment photo on a public
// certificate — `/cert-photo/:id/:n`, where `n` is the photo's position in the
// certificate gallery (display_order ascending, 0-based).
//
// Why this exists: `submission-images` is private (US-276) and the gallery the
// public cert endpoint serves is signed with a 15-minute TTL. That is fine for
// rendering and useless for structured data — a crawler that reads a signed URL
// out of the Product JSON-LD and fetches it later gets a 403. So the JSON-LD
// carries THESE urls instead, and the signing happens per-request behind the
// edge's publicity gate, server-side, where the signed URL never escapes.
//
// Thin proxy, exactly like /og/cert/:id: the gate, the storage read and the
// fallback all live on the Deno edge; this streams bytes. A private, withheld,
// missing or out-of-range photo comes back from upstream as the transparent
// fallback PNG with HTTP 200, so nothing here ever renders as a broken image.

import { edgeApi, siteUrl, type PagesEnv } from "../../_shared/blog-render";
import { brandedFallbackResponse } from "../../_shared/og-template";

type Ctx = EventContext<PagesEnv, "id" | "n", Record<string, unknown>>;

// Matches the upstream cache window. These bytes are immutable for a given
// (cert, position) — a re-grade mints a new certificate id.
const CERT_PHOTO_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const id = String(params.id ?? "").trim();
  const n = String(params.n ?? "").trim();
  // Reject anything that is not a plain non-negative integer here rather than
  // forwarding it: the position is the one part of this URL a scanner will
  // fuzz, and upstream would only answer with the same fallback anyway.
  if (!id || !/^\d{1,3}$/.test(n)) return await fallbackImage(env);

  const upstreamUrl =
    `${edgeApi(env)}/api/content/public/cert-photo/${encodeURIComponent(id)}/${n}`;
  try {
    const upstream = await fetch(upstreamUrl);
    if (!upstream.ok || !upstream.body) return await fallbackImage(env);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": CERT_PHOTO_CACHE,
      },
    });
  } catch {
    return await fallbackImage(env);
  }
};

// Image crawlers HEAD before fetching — answer 200 rather than 405.
// US-2620: deliberately bespoke. The canned 200 is honest HERE and only here:
// this route's GET can never 404 — every error path returns a fallback image
// (grep: no 404 in this file), so a HEAD that always says 200 is telling the
// truth about what a GET would do. Routing it through headOf(onRequestGet)
// would run the full render on every crawler probe to learn a status that
// cannot vary. Delete this marker the moment this route can 404.
export const onRequestHead: PagesFunction<PagesEnv> = () =>
  new Response(null, {
    status: 200,
    headers: { "Content-Type": "image/jpeg", "Cache-Control": CERT_PHOTO_CACHE },
  });

function fallbackImage(env: PagesEnv): Promise<Response> {
  return brandedFallbackResponse(siteUrl(env));
}

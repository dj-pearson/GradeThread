// US-763: the Digital Slab — a PSA-style "graded photo" for a public cert.
//
// This Function is now a THIN PROXY. The image is rendered on the Deno edge
// (functions.gradethread.com, full CPU) and stored/served from there; this
// Function just streams those bytes back on the same-origin /slab/cert/:id URL
// (printed QR codes, marketplace embeds, and GradedPhotoPanel all point here).
//
// WHY: the previous workers-og (Satori + resvg-wasm) render ran INSIDE this
// Pages Function and exceeded the Free-plan Worker CPU limit — every fresh
// render returned HTTP 503 "error code: 1102", so the graded photo was blank
// and downloads were broken. Streaming a response body is pure I/O (no WASM,
// negligible CPU), so it stays well within the Free limit.
//
// US-764: ?format= picks the aspect ratio (square/portrait/story/label). On any
// upstream error we return the transparent fallback PNG (never a broken image),
// and a HEAD handler answers 200 for marketplace reachability probes.

import { edgeApi, type PagesEnv } from "../../_shared/blog-render";
import { FALLBACK_PNG_BASE64 } from "../../_shared/og-template";

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

const SLAB_FORMATS = new Set(["square", "portrait", "story", "label"]);
const SLAB_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env, request } = context;
  const id = String(params.id ?? "").trim();
  if (!id) return fallbackImage();

  const fmtParam = new URL(request.url).searchParams.get("format") ?? "square";
  const format = SLAB_FORMATS.has(fmtParam) ? fmtParam : "square";
  const upstreamUrl = `${edgeApi(env)}/api/content/public/cert-image/${encodeURIComponent(id)}?kind=slab&format=${format}`;

  try {
    const upstream = await fetch(upstreamUrl);
    if (!upstream.ok || !upstream.body) return fallbackImage();
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "image/png", "Cache-Control": SLAB_CACHE_CONTROL },
    });
  } catch {
    return fallbackImage();
  }
};

// Reachability probes (flipdesk-ebay.ts pre-publish check, some marketplaces)
// HEAD before fetching — a GET always renders a 200 PNG, so HEAD must too.
// US-2620: deliberately bespoke. The canned 200 is honest HERE and only here:
// this route's GET can never 404 — every error path returns a fallback image
// (grep: no 404 in this file), so a HEAD that always says 200 is telling the
// truth about what a GET would do. Routing it through headOf(onRequestGet)
// would run the full render on every crawler probe to learn a status that
// cannot vary. Delete this marker the moment this route can 404.
export const onRequestHead: PagesFunction<PagesEnv> = () =>
  new Response(null, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": SLAB_CACHE_CONTROL },
  });

function fallbackImage(): Response {
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" },
  });
}

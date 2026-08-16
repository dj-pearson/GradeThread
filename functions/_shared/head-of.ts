// US-2620: one mechanism for answering HEAD on every dynamic Pages route.
//
// THE DEFECT. Cloudflare Pages selects a route handler by method, so a module
// exporting only `onRequestGet` has nothing to answer a HEAD with and Pages
// falls through to the 404 catch-all. Measured against production on
// 2026-08-15: HEAD /sitemap.xml, /rss.xml, /llms.txt, /blog and /og/social/card
// all returned 404 while GET on the same URL returned 200.
//
// THE MECHANISM IS NOT A GUESS. Seven image routes already exported
// `onRequestHead` and all seven answered HEAD 200 in the same probe, while
// every route without it 404'd. So this is the shape Pages actually dispatches,
// verified in production rather than inferred from the docs — which matters,
// because the alternative (a root `_middleware.ts` re-dispatching HEAD as GET
// via `next(request)`) is not something this checkout can prove.
//
// WHY CALL THROUGH RATHER THAN RETURN A CANNED RESPONSE. RFC 9110: a HEAD
// response must carry the same status and header fields the equivalent GET
// would, with no body. A hand-written canned handler gets that wrong the moment
// the GET can 404 or redirect — it answers 200 for a resource that is not
// there, which is worse than the 404 this replaces, because a validator now
// reports a dead URL as healthy. Running the real handler and dropping the body
// cannot drift from its GET, because it IS its GET.
//
// THE COST, stated plainly: a HEAD now does the same work as a GET. For the
// sitemaps that is a database read, and for the og/* routes it is a raster.
// That is the price of a correct status line. If a specific route ever needs a
// cheap HEAD, give that route its own handler and say why there — do not make
// this helper conditional, because a helper with two behaviours is how the
// next reader ends up with the canned one by accident.

/**
 * Wrap a GET handler so it can serve HEAD: same status, same headers, no body.
 *
 * ```ts
 * export const onRequestGet: PagesFunction<PagesEnv> = async (ctx) => { … };
 * export const onRequestHead = headOf(onRequestGet);
 * ```
 */
export function headOf<Env = unknown>(
  get: PagesFunction<Env>,
): PagesFunction<Env> {
  return async (context) => {
    const res = await get(context);
    // `new Response(null, { headers: res.headers })` copies the header list,
    // Content-Length included. That is correct for HEAD and is the one header a
    // canned handler always gets wrong.
    return new Response(null, { status: res.status, headers: res.headers });
  };
}

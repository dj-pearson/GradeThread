// Dynamic Open Graph image for a public GradeThread Verified seller profile.
//
// /og/verified/:handle returns a 1200x630 PNG (Satori via workers-og). The
// seller-profile SSR (functions/verified/[handle].ts) points og:image /
// twitter:image here so social previews show the seller's grade stats rather
// than a generic logo. Mirrors functions/og/cert/[id].ts.

import {
  fetchJson,
  siteUrl,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  type PagesEnv,
} from "../../_shared/blog-render";
import {
  brandedFallbackResponse,
  buildSellerOgHtml,
} from "../../_shared/og-template";
import { headOf } from "../../_shared/head-of";
import { renderViaEdge } from "../../_shared/render-via-edge";

interface SellerResponse {
  seller: { display_name: string };
  stats: { total_graded: number; total_is_capped: boolean; average_grade: number };
}

type Ctx = EventContext<PagesEnv, "handle", Record<string, unknown>>;

const OG_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const handle = String(params.handle ?? "").trim();
  if (!handle) return await fallbackImage(env);

  try {
    // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
    // null when it could not reach the API — so a transient failure can never
    // again be reported to a crawler as "this page is gone".
    let data: SellerResponse | null;
    try {
      data = await fetchJson<SellerResponse>(
      env,
      `/api/content/public/sellers/${encodeURIComponent(handle)}`,
    );
    } catch (e) {
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }
    if (!data?.seller) return await fallbackImage(env);

    const html = buildSellerOgHtml({
      displayName: data.seller.display_name,
      totalGraded: data.stats.total_graded,
      averageGrade: data.stats.average_grade,
      totalIsCapped: data.stats.total_is_capped,
    });

    // US-2619: bytes before responding. Same latent fault as the social card,
    // and same reason it looked fine — a handle that does not exist takes the
    // fallback branch, so the real render had never been exercised.
    return await renderViaEdge(env, {
      markup: html,
      width: 1200,
      height: 630,
      cacheControl: OG_CACHE_CONTROL,
      label: "og/verified",
    });
  } catch (err) {
    console.error("[og/verified] render failed:", err);
    return await fallbackImage(env);
  }
};

// US-2108 AC3: a blank preview is worse for click-through than a generic
// branded card. Delegates to the shared branded fallback, which drops to the
// transparent pixel only if the static asset is also unreachable.
function fallbackImage(env: PagesEnv): Promise<Response> {
  return brandedFallbackResponse(siteUrl(env));
}

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

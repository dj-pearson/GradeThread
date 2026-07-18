// Dynamic Open Graph image for a public GradeThread Verified seller profile.
//
// /og/verified/:handle returns a 1200x630 PNG (Satori via workers-og). The
// seller-profile SSR (functions/verified/[handle].ts) points og:image /
// twitter:image here so social previews show the seller's grade stats rather
// than a generic logo. Mirrors functions/og/cert/[id].ts.

import { ImageResponse } from "workers-og";
import { fetchJson, UpstreamUnavailable, upstreamUnavailableResponse, type PagesEnv } from "../../_shared/blog-render";
import { buildSellerOgHtml, FALLBACK_PNG_BASE64 } from "../../_shared/og-template";

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
  if (!handle) return fallbackImage();

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
    if (!data?.seller) return fallbackImage();

    const html = buildSellerOgHtml({
      displayName: data.seller.display_name,
      totalGraded: data.stats.total_graded,
      averageGrade: data.stats.average_grade,
      totalIsCapped: data.stats.total_is_capped,
    });

    return new ImageResponse(html, {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": OG_CACHE_CONTROL,
        "Content-Type": "image/png",
      },
    });
  } catch (err) {
    console.error("[og/verified] render failed:", err);
    return fallbackImage();
  }
};

function fallbackImage(): Response {
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
    },
  });
}

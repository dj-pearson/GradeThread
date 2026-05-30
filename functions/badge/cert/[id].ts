// Embeddable "GradeThread Verified" trust badge for a single graded item.
//
// /badge/cert/:id returns a compact 700x180 PNG (Satori via workers-og) that a
// seller drops — wrapped in a link to /cert/:id — into their eBay / Poshmark /
// Mercari / Depop listing description. Buyers see a standardized, independently
// verifiable condition grade right inside the listing; the link drives them to
// the full certificate (and back to GradeThread). This is the viral surface of
// GradeThread Verified, so it must be a plain cacheable <img> with no script.
//
// Data: the same anonymous endpoint the cert SSR uses — only certified (public)
// reports resolve, so a private/uncertified id yields the transparent fallback.

import { ImageResponse } from "workers-og";
import { fetchJson, type PagesEnv } from "../../_shared/blog-render";
import { buildCertBadgeHtml, FALLBACK_PNG_BASE64 } from "../../_shared/og-template";

interface PublicCertificate {
  id: string;
  title: string;
  overall_score: number;
  grade_tier: string;
}

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

const BADGE_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const id = String(params.id ?? "").trim();
  if (!id) return fallbackImage();

  try {
    const data = await fetchJson<{ certificate: PublicCertificate }>(
      env,
      `/api/content/public/certificates/${encodeURIComponent(id)}`,
    );
    if (!data?.certificate) return fallbackImage();
    const cert = data.certificate;

    const html = buildCertBadgeHtml({
      score: cert.overall_score,
      gradeTier: cert.grade_tier,
      title: cert.title,
    });

    return new ImageResponse(html, {
      width: 700,
      height: 180,
      headers: {
        "Cache-Control": BADGE_CACHE_CONTROL,
        "Content-Type": "image/png",
      },
    });
  } catch (err) {
    console.error("[badge/cert] render failed:", err);
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

// US-307: dynamic Open Graph image for a public grade certificate.
//
// /og/cert/:id returns a 1200x630 PNG generated server-side by Satori (via
// workers-og). The cert SSR (functions/cert/[id].ts) points og:image /
// twitter:image at this URL so social previews show the actual title +
// grade rather than a generic logo.
//
// Cache: 24h at the edge + browser. Errors fall through to a transparent
// pixel — the cert SSR's static logo fallback is the real visual safety net.

import { ImageResponse } from "workers-og";
import { fetchJson, type PagesEnv } from "../../_shared/blog-render";
import {
  buildCertOgHtml,
  FALLBACK_PNG_BASE64,
} from "../../_shared/og-template";

interface PublicCertificate {
  id: string;
  title: string;
  brand: string | null;
  overall_score: number;
  grade_tier: string;
  hero_image_url: string | null;
}

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

const OG_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const id = String(params.id ?? "");
  if (!id) return fallbackImage();

  try {
    const data = await fetchJson<{ certificate: PublicCertificate }>(
      env,
      `/api/content/public/certificates/${encodeURIComponent(id)}`,
    );
    if (!data?.certificate) return fallbackImage();
    const cert = data.certificate;

    const html = buildCertOgHtml({
      title: cert.title,
      brand: cert.brand,
      score: cert.overall_score,
      gradeTier: cert.grade_tier,
      heroImageUrl: cert.hero_image_url,
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
    console.error("[og/cert] render failed:", err);
    return fallbackImage();
  }
};

function fallbackImage(): Response {
  // 1x1 transparent PNG. Crawlers + social validators receive a valid PNG
  // (never a broken image) — the calling page's og:image still resolves and
  // the cert SSR's static fallback kicks in for human-visible previews.
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300", // shorter on failure so a retry isn't pinned
    },
  });
}

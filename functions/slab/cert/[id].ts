// US-763: the Digital Slab — a PSA-style "graded photo" for a public cert.
//
// /slab/cert/:id returns a 1080x1080 PNG (Satori via workers-og): the garment's
// hero photo with the grade burned in and a scannable QR (US-762) that links
// back to /cert/:id. A seller drops this single certified image into any
// marketplace listing so the grade rides along on the thumbnail and buyers can
// scan straight to the official certificate.
//
// Data: the same anonymous endpoint the cert SSR/OG cards use — only certified
// (public) reports resolve, so a private/uncertified id yields the transparent
// fallback (never leaks a private report, US-268). When the hero photo is
// unavailable the slab degrades to a label-only card (handled in the template).

import { ImageResponse } from "workers-og";
import { fetchJson, siteUrl, type PagesEnv } from "../../_shared/blog-render";
import { buildCertSlabHtml, FALLBACK_PNG_BASE64 } from "../../_shared/og-template";
import { qrSvgDataUri } from "../../_shared/qr";

interface PublicCertificate {
  id: string;
  title: string;
  brand: string | null;
  overall_score: number;
  grade_tier: string;
  hero_image_url: string | null;
}

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

const SLAB_SIZE = 1080;
const SLAB_CACHE_CONTROL =
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

    // The QR resolves to the public certificate; ?s=qr lets scan-sourced views
    // be told apart from link clicks later (US-769) without any buyer PII.
    const certUrl = `${siteUrl(env)}/cert/${encodeURIComponent(id)}?s=qr`;

    const html = buildCertSlabHtml({
      width: SLAB_SIZE,
      height: SLAB_SIZE,
      title: cert.title,
      brand: cert.brand,
      score: Number(cert.overall_score),
      gradeTier: cert.grade_tier,
      heroImageUrl: cert.hero_image_url,
      qrDataUri: qrSvgDataUri(certUrl),
      certId: id,
    });

    return new ImageResponse(html, {
      width: SLAB_SIZE,
      height: SLAB_SIZE,
      headers: {
        "Cache-Control": SLAB_CACHE_CONTROL,
        "Content-Type": "image/png",
      },
    });
  } catch (err) {
    console.error("[slab/cert] render failed:", err);
    return fallbackImage();
  }
};

function fallbackImage(): Response {
  // Valid 1x1 transparent PNG so callers never get a broken image; a shorter
  // cache on failure so a retry isn't pinned.
  const bytes = Uint8Array.from(atob(FALLBACK_PNG_BASE64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
    },
  });
}

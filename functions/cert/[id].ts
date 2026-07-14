// Cloudflare Pages Function: server-renders the public grade certificate at
// /cert/:id (US-294). Mirrors the blog SSR pattern (functions/_shared/blog-render).
//
// Certificates are our highest-volume organic surface — one indexable,
// AI-citable page per graded garment. The SPA route at /cert/:id still hydrates
// for humans; this Function gives crawlers (and link-preview bots) fully
// rendered HTML + a Product/Review JSON-LD grade descriptor (US-300).
//
// Data comes from the anonymous edge endpoint /api/content/public/certificates/:id,
// which hard-filters to certified (public) reports only — a private/uncertified
// report 404s there and therefore here too (US-268).

import {
  breadcrumbListLd,
  certificateProductLd,
  escape,
  fetchJson,
  notFoundResponse,
  renderBreadcrumbs,
  renderSsrResponse,
  siteUrl,
  SSR_CACHE_CONTROL,
  twitterSiteHandle,
  withEdgeCache,
  type PagesEnv,
} from "../_shared/blog-render";

interface PublicCertificate {
  id: string;
  certificate_number?: string | null;
  title: string;
  brand: string | null;
  garment_type: string | null;
  garment_category: string | null;
  description: string | null;
  overall_score: number;
  grade_tier: string;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string;
  buyer_writeup: string | null;
  created_at: string;
  hero_image_url: string | null;
  // US-1413: the full ordered gallery (signed URLs). Returned by the public
  // endpoint but previously ignored by the SSR — now rendered as a photo grid.
  images?: Array<{ id: string; image_type: string; display_order: number; url: string }>;
  // US-340: true when the seller's opt-in provenance checks passed.
  verified_capture_passed?: boolean;
  // US-861: true when the photo-reuse scan found no cross-account match.
  original_photos_verified?: boolean;
  // US-1283: true when the submission earned the fraud-proof Live-Verified badge.
  live_capture_verified?: boolean;
  // US-1281: true when the submission earned the premium 360-Verified badge.
  verified_360_badge?: boolean;
}

interface CertResponse {
  certificate: PublicCertificate;
}

// Factor labels + weights mirror src/lib/constants.ts GRADE_FACTORS. Duplicated
// here (small, stable) to keep the edge worker dependency-free.
const FACTORS: Array<{ key: keyof PublicCertificate; label: string; weight: number }> = [
  { key: "fabric_condition_score", label: "Fabric Condition", weight: 30 },
  { key: "structural_integrity_score", label: "Structural Integrity", weight: 25 },
  { key: "cosmetic_appearance_score", label: "Cosmetic Appearance", weight: 20 },
  { key: "functional_elements_score", label: "Functional Elements", weight: 15 },
  { key: "odor_cleanliness_score", label: "Odor & Cleanliness", weight: 10 },
];

type Ctx = EventContext<PagesEnv, "id", Record<string, unknown>>;

// US-1665: the "what does a {grade} grade mean?" module varies by grade band (10
// variants, not one boilerplate). Keyed by the rounded band (1–10); every variant
// links to the canonical scale (/grading/scale). Kept in sync with the SPA
// certificate page's gradeBandMeaning().
const GRADE_BAND_MEANING: Record<number, string> = {
  10: "A 10 is New With Tags (NWT): brand-new and unworn, with the original retail tags still attached.",
  9: "A 9 is New Without Tags (NWOT): new and unworn, just missing the original tags.",
  8: "An 8 is Excellent: gently used with no notable flaws — it looks nearly new.",
  7: "A 7 is Very Good: light, even wear that doesn’t affect how the garment looks or functions.",
  6: "A 6 is Good: visible but minor wear on a garment that is still very wearable.",
  5: "A 5 is Fair: a documented flaw — a stain, small hole, or clear fading — that affects appearance.",
  4: "A 4 sits at the top of the Poor band: heavy wear or damage, best sold transparently as-is.",
  3: "A 3 is Poor: significant damage such as holes, tears, large stains, or broken hardware.",
  2: "A 2 is salvage condition: heavily damaged, typically sold for parts or repair.",
  1: "A 1 is salvage: extensive damage — valued for its material or graphic, not for wear.",
};
function gradeBandMeaning(score: number): string {
  const band = Math.min(10, Math.max(1, Math.round(score)));
  return (
    GRADE_BAND_MEANING[band] ??
    "It sits on the GradeThread Scale, the standardized 1.0–10.0 system for pre-owned clothing condition."
  );
}

// PSA-style public certificate number derived from the random certificate UUID.
// The UUID stays the canonical id/URL (unguessable, non-enumerable); this is a
// clean display label only. Mirrors src/lib/cert-number.ts certificateDisplayNumber.
function certDisplayNumber(certId: string): string {
  const hex = certId.replace(/-/g, "").toUpperCase();
  return hex.length >= 8 ? `GT-${hex.slice(0, 4)}-${hex.slice(4, 8)}` : certId;
}

export const onRequestGet: PagesFunction<PagesEnv> = (context: Ctx) =>
  withEdgeCache(context, () => renderCertificate(context));

// US-1945: a DISTINCT, cert-branded 404 — never the generic/blog one — so a
// buyer following a certificate link that can't be resolved gets a clear
// "certificate not found" (and can't confuse it with a genuine verified cert).
function certNotFound(env: PagesEnv): Response {
  return notFoundResponse(env, {
    title: "Certificate not found — GradeThread",
    heading: "Certificate not found",
    message:
      "This grade certificate could not be found or verified. It may have been " +
      "removed, or the link may be incorrect. " +
      '<a href="/verified">Browse verified sellers &rarr;</a>',
    canonicalPath: "/verified",
  });
}

async function renderCertificate(context: Ctx): Promise<Response> {
  const { params, env } = context;
  const id = String(params.id ?? "");
  if (!id) return certNotFound(env);

  const data = await fetchJson<CertResponse>(
    env,
    `/api/content/public/certificates/${encodeURIComponent(id)}`,
  );
  if (!data?.certificate) return certNotFound(env);

  const cert = data.certificate;
  const certNo = cert.certificate_number || certDisplayNumber(cert.id);
  const base = siteUrl(env);
  const canonical = `${base}/cert/${cert.id}`;
  const score = cert.overall_score.toFixed(1);
  const title = `${cert.title} — Grade ${score} (${cert.grade_tier})`;
  const description =
    `Verified GradeThread condition grade: ${score}/10 (${cert.grade_tier})` +
    `${cert.brand ? ` · ${cert.brand}` : ""}. AI-graded across 5 weighted factors.`;
  // US-307: dynamic Open Graph image. /og/cert/:id renders a branded
  // 1200x630 PNG server-side via Satori; the static logo is the last-ditch
  // fallback if the OG endpoint itself errors (it returns a transparent
  // pixel which crawlers accept). Hero image is no longer the og:image —
  // dynamic grade card has higher CTR on social.
  const ogImage = `${base}/og/cert/${encodeURIComponent(cert.id)}`;

  // The branded, shareable "graded photo" (rendered on the edge, served via the
  // /slab/cert Pages proxy). A working <img> — the whole reason for this rewrite.
  const slabHtml = cert.hero_image_url
    ? `<div class="cert-slab-wrap">
      <img class="cert-slab" src="/slab/cert/${escape(cert.id)}?format=square" width="440" height="440" loading="lazy" alt="Graded photo — ${escape(cert.title)}, condition grade ${score}">
      <p class="cert-slab-note">Shareable graded photo — buyers scan the code to verify.</p>
    </div>`
    : "";

  // US-1413: the full photo gallery (was returned by the endpoint but ignored).
  const galleryHtml = cert.images && cert.images.length > 0
    ? `<h2>Garment Photos</h2><div class="cert-gallery">${
      cert.images
        .map(
          (img, i) =>
            `<a href="${escape(img.url)}" target="_blank" rel="noopener"><img src="${escape(img.url)}" loading="${i === 0 ? "eager" : "lazy"}" alt="${escape(formatLabel(img.image_type) ?? "Garment photo")}"></a>`,
        )
        .join("")
    }</div>`
    : "";

  // Factor breakdown as colored bars (was a plain table).
  const factorsHtml = `<div class="cert-factors">${
    FACTORS.map((f) => {
      const v = Number(cert[f.key]);
      const pct = Math.max(0, Math.min(100, v * 10));
      return `<div class="cert-factor"><div class="cert-factor-top"><span>${f.label} <span class="cert-factor-w">(${f.weight}%)</span></span><span class="cert-factor-score">${v.toFixed(1)}</span></div><div class="cert-factor-bar"><div class="cert-factor-fill" style="width:${pct}%;background:${scoreColor(v)}"></div></div></div>`;
    }).join("")
  }</div>`;

  // Provenance / assurance badges.
  const badges: string[] = [];
  if (cert.live_capture_verified) {
    badges.push('<span class="cert-badge cert-badge--live">&#10003; Live-Verified · un-fakeable capture</span>');
  } else if (cert.verified_capture_passed) {
    badges.push('<span class="cert-badge cert-badge--verify">&#10003; Verified Capture</span>');
  }
  if (cert.verified_360_badge) {
    badges.push('<span class="cert-badge cert-badge--premium">&#10003; 360-Verified · true geometric coverage</span>');
  }
  if (cert.original_photos_verified) {
    badges.push('<span class="cert-badge cert-badge--verify">&#10003; Original photos verified</span>');
  }
  const badgesHtml = badges.length > 0 ? `<div class="cert-badges">${badges.join("")}</div>` : "";

  const gradedOn = formatDate(cert.created_at);

  // US-760: "About this item" — the structured facts a buyer wants. Only rows
  // with a value are emitted (graceful omission).
  const aboutRows = [
    ["Brand", cert.brand],
    ["Type", formatLabel(cert.garment_type)],
    ["Category", formatLabel(cert.garment_category)],
  ]
    .filter(([, v]) => !!v)
    .map(
      ([k, v]) =>
        `<tr><td style="color:var(--muted)">${k}</td><td style="font-weight:600">${escape(v as string)}</td></tr>`,
    )
    .join("");
  const aboutHtml =
    aboutRows || cert.description
      ? `<h2>About this item</h2>${aboutRows ? `<table><tbody>${aboutRows}</tbody></table>` : ""}${cert.description ? `<p>${escape(cert.description)}</p>` : ""}`
      : "";

  // US-433: one trail for the visible breadcrumb + the BreadcrumbList JSON-LD.
  const breadcrumbItems = [
    { name: "GradeThread", url: `${base}/` },
    { name: "Grade Certificate", url: canonical },
  ];

  const bodyHtml = `${renderBreadcrumbs(breadcrumbItems, base)}
  <main class="container container--wide">
  <p class="cert-eyebrow">Verified Grade Certificate · Certificate No. <code>${escape(certNo)}</code></p>
  <h1>${escape(cert.title)}${cert.brand ? ` <span style="color:var(--muted)">— ${escape(cert.brand)}</span>` : ""}</h1>
  <div class="cert-hero">
    <div class="cert-score" style="background:${scoreColor(cert.overall_score)}">${escape(score)}</div>
    <div>
      <div class="cert-tier">${escape(cert.grade_tier)}</div>
      <div class="cert-tier-sub">Overall Condition Grade · out of 10</div>
    </div>
  </div>
  ${badgesHtml}
  ${slabHtml}
  ${galleryHtml}
  ${aboutHtml}
  <h2>What does a ${escape(score)} grade mean?</h2>
  <p>${escape(gradeBandMeaning(cert.overall_score))} It sits on the GradeThread Scale, the standardized 1.0&ndash;10.0 system for pre-owned clothing condition. <a href="/grading/scale">See the full grading scale &rarr;</a></p>
  <h2>Factor Breakdown</h2>
  ${factorsHtml}
  <h2>${cert.buyer_writeup ? "Condition Report" : "AI Analysis Summary"}</h2>
  <div class="cert-report">${escape(cert.buyer_writeup || cert.ai_summary)}</div>
  <p class="cert-eyebrow" style="margin-top:24px">Graded on ${escape(gradedOn)} · Certificate No. <code>${escape(certNo)}</code></p>
  <a class="cta" href="/?utm_source=certificate&utm_medium=organic">Grade your own garment with GradeThread &rarr;</a>
</main>`;

  // Product + expert Review/Rating so the numeric grade is machine-readable and
  // AI-citable (US-300). US-425: built from the single source-of-truth
  // certificateProductLd() so this SSR path and the SPA route (certificateLd in
  // src/lib/seo/json-ld.ts) can't drift — an equivalence test pins them equal.
  const productLd = certificateProductLd({
    id: cert.id,
    title: cert.title,
    overallScore: cert.overall_score,
    gradeTier: cert.grade_tier,
    category: cert.garment_category,
    brand: cert.brand,
    images: cert.hero_image_url ? [cert.hero_image_url] : null,
    datePublished: cert.created_at,
    siteUrl: base,
  });

  const breadcrumbLd = breadcrumbListLd(breadcrumbItems);

  return renderSsrResponse(
    {
      title,
      description,
      canonicalUrl: canonical,
      ogImage,
      twitterSite: twitterSiteHandle(env),
      // US-425: og:type=product matches the Product primary entity (and the SPA).
      ogType: "product",
      jsonLd: [productLd, breadcrumbLd],
      bodyHtml,
      // US-1665 AC4: a certificate with no garment photos is a thin page — keep
      // it out of the index (it still resolves + carries structured data).
      noindex: !cert.hero_image_url,
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

// Grade → accent colour for the score circle + factor bars. Green (excellent) →
// navy (good) → amber (fair) → crimson (poor). Brand palette (design.md).
function scoreColor(v: number): string {
  const n = Number(v);
  if (n >= 8) return "#16a34a";
  if (n >= 6) return "#0C1E36";
  if (n >= 4) return "#d97706";
  return "#F03D5F";
}

// "outerwear" / "very_good" → "Outerwear" / "Very Good". Null-safe.
function formatLabel(value: string | null): string | null {
  if (!value) return null;
  return value
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

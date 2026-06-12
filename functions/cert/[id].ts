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
  certificateProductLd,
  escape,
  fetchJson,
  notFoundResponse,
  renderLayout,
  siteUrl,
  SSR_CACHE_CONTROL,
  type PagesEnv,
} from "../_shared/blog-render";

interface PublicCertificate {
  id: string;
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
  // US-340: true when the seller's opt-in provenance checks passed.
  verified_capture_passed?: boolean;
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

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const id = String(params.id ?? "");
  if (!id) return notFoundResponse(env);

  const data = await fetchJson<CertResponse>(
    env,
    `/api/content/public/certificates/${encodeURIComponent(id)}`,
  );
  if (!data?.certificate) return notFoundResponse(env);

  const cert = data.certificate;
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

  const heroHtml = cert.hero_image_url
    ? `<img class="hero" src="${escape(cert.hero_image_url)}" alt="${escape(cert.title)}">`
    : "";

  const factorsHtml = FACTORS.map((f) => {
    const v = Number(cert[f.key]);
    return `<tr><td>${f.label} <span style="color:var(--muted)">(${f.weight}%)</span></td><td style="text-align:right;font-weight:600">${v.toFixed(1)}</td></tr>`;
  }).join("");

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

  const bodyHtml = `<main class="container">
  <p style="color:var(--muted);margin-bottom:8px">Verified Grade Certificate</p>
  <h1>${escape(cert.title)}${cert.brand ? ` <span style="color:var(--muted)">— ${escape(cert.brand)}</span>` : ""}</h1>
  <div style="display:flex;align-items:center;gap:16px;margin:16px 0 24px">
    <div style="font-size:3rem;font-weight:700;color:var(--accent)">${escape(score)}</div>
    <div><div style="font-weight:600">${escape(cert.grade_tier)}</div><div style="color:var(--muted);font-size:0.9rem">Overall Condition Grade · out of 10</div></div>
  </div>
  ${
    cert.verified_capture_passed
      ? `<p style="display:inline-block;margin:0 0 16px;padding:4px 12px;border-radius:9999px;background:#dcfce7;color:#166534;font-size:0.85rem;font-weight:600">&#10003; Verified Capture</p>`
      : ""
  }
  ${heroHtml}
  ${aboutHtml}
  <h2>Factor Breakdown</h2>
  <table><tbody>${factorsHtml}</tbody></table>
  <h2>${cert.buyer_writeup ? "Condition Report" : "AI Analysis Summary"}</h2>
  <p style="white-space:pre-wrap">${escape(cert.buyer_writeup || cert.ai_summary)}</p>
  <p style="color:var(--muted);font-size:0.85rem;margin-top:24px">Graded on ${escape(gradedOn)} · Certificate ID <code>${escape(cert.id)}</code></p>
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

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "GradeThread", item: `${base}/` },
      { "@type": "ListItem", position: 2, name: "Grade Certificate", item: canonical },
    ],
  };

  return new Response(
    renderLayout({
      title,
      description,
      canonicalUrl: canonical,
      ogImage,
      // US-425: og:type=product matches the Product primary entity (and the SPA).
      ogType: "product",
      jsonLd: [productLd, breadcrumbLd],
      bodyHtml,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": SSR_CACHE_CONTROL,
      },
    },
  );
};

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

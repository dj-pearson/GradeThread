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
  overall_score: number;
  grade_tier: string;
  fabric_condition_score: number;
  structural_integrity_score: number;
  cosmetic_appearance_score: number;
  functional_elements_score: number;
  odor_cleanliness_score: number;
  ai_summary: string;
  created_at: string;
  hero_image_url: string | null;
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
  const ogImage = cert.hero_image_url ?? `${base}/logo_icon_512.png`;

  const heroHtml = cert.hero_image_url
    ? `<img class="hero" src="${escape(cert.hero_image_url)}" alt="${escape(cert.title)}">`
    : "";

  const factorsHtml = FACTORS.map((f) => {
    const v = Number(cert[f.key]);
    return `<tr><td>${f.label} <span style="color:var(--muted)">(${f.weight}%)</span></td><td style="text-align:right;font-weight:600">${v.toFixed(1)}</td></tr>`;
  }).join("");

  const gradedOn = formatDate(cert.created_at);

  const bodyHtml = `<main class="container">
  <p style="color:var(--muted);margin-bottom:8px">Verified Grade Certificate</p>
  <h1>${escape(cert.title)}${cert.brand ? ` <span style="color:var(--muted)">— ${escape(cert.brand)}</span>` : ""}</h1>
  <div style="display:flex;align-items:center;gap:16px;margin:16px 0 24px">
    <div style="font-size:3rem;font-weight:700;color:var(--accent)">${escape(score)}</div>
    <div><div style="font-weight:600">${escape(cert.grade_tier)}</div><div style="color:var(--muted);font-size:0.9rem">Overall Condition Grade · out of 10</div></div>
  </div>
  ${heroHtml}
  <h2>Factor Breakdown</h2>
  <table><tbody>${factorsHtml}</tbody></table>
  <h2>AI Analysis Summary</h2>
  <p style="white-space:pre-wrap">${escape(cert.ai_summary)}</p>
  <p style="color:var(--muted);font-size:0.85rem;margin-top:24px">Graded on ${escape(gradedOn)} · Certificate ID <code>${escape(cert.id)}</code></p>
  <a class="cta" href="/?utm_source=certificate&utm_medium=organic">Grade your own garment with GradeThread &rarr;</a>
</main>`;

  // Product + expert Review/Rating so the numeric grade is machine-readable and
  // AI-citable (US-300). Mirrors src/lib/seo/json-ld.ts certificateLd().
  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": canonical,
    name: cert.title,
    ...(cert.garment_category ? { category: cert.garment_category } : {}),
    ...(cert.brand ? { brand: { "@type": "Brand", name: cert.brand } } : {}),
    ...(cert.hero_image_url ? { image: [cert.hero_image_url] } : {}),
    itemCondition: "https://schema.org/UsedCondition",
    review: {
      "@type": "Review",
      name: `Condition grade: ${cert.grade_tier} (${score}/10)`,
      reviewRating: {
        "@type": "Rating",
        ratingValue: cert.overall_score,
        bestRating: 10,
        worstRating: 1,
        alternateName: cert.grade_tier,
      },
      author: {
        "@type": "Organization",
        name: "GradeThread",
        url: base,
      },
      datePublished: cert.created_at,
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
  };

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

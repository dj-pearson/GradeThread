// Cloudflare Pages Function: server-renders a public GradeThread Verified
// seller profile at /verified/:handle.
//
// Mirrors the certificate SSR (functions/cert/[id].ts). A seller's profile is
// an indexable, AI-citable trust surface that aggregates every certified grade
// they've earned — the page buyers land on from a "GradeThread Verified" badge
// embedded in a marketplace listing. Humans get this fully-rendered HTML in
// production; the SPA route at /verified/:handle is the dev/in-app fallback.
//
// Data comes from the anonymous edge endpoint /api/content/public/sellers/:handle,
// which only ever returns verified_enabled profiles + certified reports (US-268).

import {
  escape,
  fetchJson,
  notFoundResponse,
  renderLayout,
  siteUrl,
  SSR_CACHE_CONTROL,
  formatDate,
  type PagesEnv,
} from "../_shared/blog-render";

interface RecentCert {
  id: string;
  title: string;
  brand: string | null;
  overall_score: number;
  grade_tier: string;
  created_at: string;
}

interface SellerResponse {
  seller: {
    handle: string;
    display_name: string;
    bio: string | null;
    verified_since: string | null;
  };
  stats: {
    total_graded: number;
    total_is_capped: boolean;
    average_grade: number;
    tier_distribution: Record<string, number>;
  };
  recent_certificates: RecentCert[];
}

type Ctx = EventContext<PagesEnv, "handle", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { params, env } = context;
  const handle = String(params.handle ?? "").trim();
  if (!handle) return notFoundResponse(env);

  const data = await fetchJson<SellerResponse>(
    env,
    `/api/content/public/sellers/${encodeURIComponent(handle)}`,
  );
  if (!data?.seller) return notFoundResponse(env);

  const { seller, stats, recent_certificates } = data;
  const base = siteUrl(env);
  const canonical = `${base}/verified/${encodeURIComponent(seller.handle)}`;
  const avg = stats.average_grade > 0 ? stats.average_grade.toFixed(1) : "—";
  const count = stats.total_is_capped
    ? `${stats.total_graded.toLocaleString()}+`
    : stats.total_graded.toLocaleString();

  const title = `${seller.display_name} — GradeThread Verified Seller`;
  const description =
    `${seller.display_name} is a GradeThread Verified seller with ${count} ` +
    `AI-graded item${stats.total_graded === 1 ? "" : "s"}` +
    `${stats.average_grade > 0 ? ` averaging ${avg}/10` : ""}. ` +
    `Every grade is independently verifiable.`;
  const ogImage = `${base}/og/verified/${encodeURIComponent(seller.handle)}`;

  const sinceHtml = seller.verified_since
    ? `<div style="color:var(--muted);font-size:0.9rem">Verified since ${escape(formatDate(seller.verified_since))}</div>`
    : "";

  const bioHtml = seller.bio
    ? `<p style="max-width:560px;color:var(--muted)">${escape(seller.bio)}</p>`
    : "";

  // Tier distribution chips, most common first.
  const tierChips = Object.entries(stats.tier_distribution)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([tier, n]) =>
        `<span class="vt-chip">${escape(tier)} <strong>${n}</strong></span>`,
    )
    .join("");

  const certCards = recent_certificates
    .map(
      (cert) =>
        `<a class="vt-card" href="/cert/${escape(cert.id)}">
          <div class="vt-card-score">${cert.overall_score.toFixed(1)}</div>
          <div class="vt-card-body">
            <div class="vt-card-title">${escape(cert.title)}</div>
            ${cert.brand ? `<div class="vt-card-brand">${escape(cert.brand)}</div>` : ""}
            <div class="vt-card-tier">${escape(cert.grade_tier)} · ${escape(formatDate(cert.created_at))}</div>
          </div>
        </a>`,
    )
    .join("");

  const certsSection = recent_certificates.length
    ? `<h2>Recent verified grades</h2><div class="vt-grid">${certCards}</div>`
    : `<p style="color:var(--muted)">No public certificates yet.</p>`;

  const extraStyles = `
    .vt-hero { display:flex; flex-direction:column; gap:8px; padding:24px 0 8px; }
    .vt-badge { display:inline-flex; align-items:center; gap:8px; align-self:flex-start; background:var(--accent); color:#fff; padding:6px 14px; border-radius:999px; font-size:0.85rem; font-weight:600; }
    .vt-stats { display:flex; gap:40px; flex-wrap:wrap; margin:24px 0 8px; }
    .vt-stat .n { font-size:2.5rem; font-weight:800; color:var(--accent); line-height:1; }
    .vt-stat .l { color:var(--muted); font-size:0.9rem; }
    .vt-chips { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 24px; }
    .vt-chip { background:#f3f4f6; border-radius:999px; padding:4px 12px; font-size:0.85rem; color:var(--muted); }
    .vt-grid { display:grid; gap:12px; grid-template-columns:1fr; }
    @media (min-width:640px){ .vt-grid { grid-template-columns:1fr 1fr; } }
    .vt-card { display:flex; align-items:center; gap:14px; padding:14px 16px; border:1px solid #e5e7eb; border-radius:10px; text-decoration:none; color:inherit; }
    .vt-card:hover { background:#f9fafb; }
    .vt-card-score { flex:0 0 auto; width:48px; height:48px; border-radius:50%; background:var(--accent); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:800; }
    .vt-card-title { font-weight:600; }
    .vt-card-brand { color:var(--muted); font-size:0.9rem; }
    .vt-card-tier { color:var(--muted); font-size:0.8rem; margin-top:2px; }
  `;

  const bodyHtml = `<main class="container">
  <style>${extraStyles}</style>
  <div class="vt-hero">
    <span class="vt-badge">✓ GradeThread Verified Seller</span>
    <h1 style="margin:8px 0 0">${escape(seller.display_name)}</h1>
    ${sinceHtml}
    ${bioHtml}
  </div>
  <div class="vt-stats">
    <div class="vt-stat"><div class="n">${escape(count)}</div><div class="l">items graded</div></div>
    <div class="vt-stat"><div class="n">${escape(avg)}</div><div class="l">average grade · out of 10</div></div>
  </div>
  ${tierChips ? `<div class="vt-chips">${tierChips}</div>` : ""}
  ${certsSection}
  <a class="cta" href="/for-resellers?utm_source=verified_profile&utm_medium=organic">Get your own GradeThread Verified profile &rarr;</a>
</main>`;

  // ProfilePage describing a verified seller; AggregateRating is REAL data
  // (count + average of certified grades), so it's policy-compliant to emit.
  const profileLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    "@id": canonical,
    name: title,
    description,
    mainEntity: {
      "@type": "Organization",
      name: seller.display_name,
      url: canonical,
      ...(stats.total_graded > 0 && stats.average_grade > 0
        ? {
            aggregateRating: {
              "@type": "AggregateRating",
              ratingValue: stats.average_grade,
              bestRating: 10,
              worstRating: 1,
              ratingCount: stats.total_graded,
            },
          }
        : {}),
    },
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "GradeThread", item: `${base}/` },
      { "@type": "ListItem", position: 2, name: "Verified Sellers", item: `${base}/for-resellers` },
      { "@type": "ListItem", position: 3, name: seller.display_name, item: canonical },
    ],
  };

  return new Response(
    renderLayout({
      title,
      description,
      canonicalUrl: canonical,
      ogImage,
      jsonLd: [profileLd, breadcrumbLd],
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

// Catch-all Pages Function for the public Durability Rankings (US-1774).
//   /durability            → hub (brands ranked by condition retention)
//   /durability/<brand>    → one brand's garment-type cohorts, most durable first
//
// Edge-SSR'd (like /condition-index) so the pages are crawlable with real,
// sample-gated data from the edge API. ONLY sufficient cohorts are surfaced
// (durability-index.ts) — thin cohorts never ship a public claim. Interlinks
// with /value and /condition-index. Only fires for /durability/*.

import {
  breadcrumbListLd,
  escape,
  fetchJson,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  formatDate,
  ga4MeasurementId,
  notFoundResponse,
  renderBreadcrumbs,
  renderSsrResponse,
  siteUrl,
  SSR_CACHE_CONTROL,
  twitterSiteHandle,
  type BreadcrumbItem,
  type PagesEnv,
} from "../_shared/blog-render";

interface HubItem {
  brandSlug: string;
  brand: string;
  cohortCount: number;
  bestRetention: number | null;
  refreshedAt: string;
}

interface Cohort {
  garmentType: string | null;
  label: string;
  garmentCount: number;
  regradedCount: number;
  avgOverallDecay: number | null;
  avgRetention: number | null;
  avgSpanDays: number | null;
  perFactorDecay: Record<string, number>;
  resaleMedianCents: number | null;
}

interface BrandDto {
  brand: string;
  brandSlug: string;
  cohorts: Cohort[];
  refreshedAt: string;
}

function pct(retention: number | null): string {
  if (retention == null) return "—";
  return `${Math.round(retention * 100)}%`;
}
function points(decay: number | null): string {
  if (decay == null) return "—";
  return `${decay.toFixed(1)} pts`;
}

const FACTOR_LABELS: Record<string, string> = {
  fabric_condition_score: "Fabric",
  structural_integrity_score: "Structural",
  cosmetic_appearance_score: "Cosmetic",
  functional_elements_score: "Functional",
  odor_cleanliness_score: "Odor & cleanliness",
};

function methodologyHtml(): string {
  return `<h2>How durability is measured</h2>
    <p class="muted">Durability here means how much of its GradeThread condition grade an item
    <em>retains</em> when the same garment is graded again over time — measured across many real,
    regraded garments in a cohort (brand &times; garment type). We only publish a cohort once it
    clears a minimum sample of garments and regrades, so no ranking rests on a handful of items.
    Retention is the share of the original grade kept on the latest regrade; decay is the average
    points lost. This is an aggregate signal from real grades, not a lab test or a guarantee.</p>`;
}

function interlinksHtml(): string {
  return `<p><a href="/condition-index">See value by condition &rarr;</a> &middot;
    <a href="/value">What's it worth? &rarr;</a> &middot;
    <a href="/snap">Grade your own item &rarr;</a></p>`;
}

type Ctx = EventContext<PagesEnv, "path", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  const ga = ga4MeasurementId(env);
  const site = siteUrl(env);

  // Detail page: /durability/<brand>
  const detailMatch = path.match(/^\/durability\/([a-z0-9-]+)$/i);
  if (detailMatch) {
    const slug = detailMatch[1];
    if (!slug) return notFoundResponse(env);
    // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
    // null when it could not reach the API — so a transient failure can never
    // again be reported to a crawler as "this page is gone".
    let dto: BrandDto | null;
    try {
      dto = await fetchJson<BrandDto>(
      env,
      `/api/grading/public/durability/${encodeURIComponent(slug)}`,
    );
    } catch (e) {
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }
    if (!dto || !dto.cohorts?.length) return notFoundResponse(env);
    const canonical = `${site}/durability/${slug}`;

    const rows = dto.cohorts
      .map((c) => {
        const worst = Object.entries(c.perFactorDecay).sort((a, b) => b[1] - a[1])[0];
        const worstLabel = worst ? `${FACTOR_LABELS[worst[0]] ?? worst[0]} (${points(worst[1])})` : "—";
        return `<tr>
          <td><strong>${escape(c.label)}</strong></td>
          <td>${pct(c.avgRetention)}</td>
          <td>${points(c.avgOverallDecay)}</td>
          <td>${worstLabel}</td>
          <td>${c.garmentCount}</td>
        </tr>`;
      })
      .join("");

    const trail: BreadcrumbItem[] = [
      { name: "GradeThread", url: `${site}/` },
      { name: "Durability", url: `${site}/durability` },
      { name: dto.brand, url: canonical },
    ];

    const body = `${renderBreadcrumbs(trail, site)}
    <main class="container">
      <h1>${escape(dto.brand)} durability — how well it holds condition</h1>
      <p>How much of its <a href="/grading-standard">GradeThread condition grade</a> a
      <strong>${escape(dto.brand)}</strong> item keeps when regraded over time, by garment type,
      from real regraded garments. Higher retention = more durable.</p>
      <table>
        <thead><tr><th>Cohort</th><th>Retention</th><th>Avg decay</th><th>Weakest factor</th><th>Garments</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${methodologyHtml()}
      ${interlinksHtml()}
    </main>`;

    const datasetLd = {
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: `${dto.brand} durability by garment type — GradeThread`,
      description: `Condition retention and decay for ${dto.brand} pre-owned clothing by garment type, from regraded garments on GradeThread's 1.0–10.0 condition standard.`,
      url: canonical,
      isAccessibleForFree: true,
      creativeWorkStatus: "Published",
      dateModified: dto.refreshedAt,
    };
    const jsonLd: unknown[] = [datasetLd, breadcrumbListLd(trail)];

    return renderSsrResponse(
      {
        title: `${dto.brand} clothing durability by condition — GradeThread`,
        description: `How well ${dto.brand} pre-owned clothing holds its condition grade over time, by garment type. Updated ${formatDate(dto.refreshedAt)}.`,
        canonicalUrl: canonical,
        bodyHtml: body,
        jsonLd,
        gaMeasurementId: ga,
        twitterSite: twitterSiteHandle(env),
      },
      { cacheControl: SSR_CACHE_CONTROL },
    );
  }

  // Hub page: /durability
  if (path === "/durability") {
    // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
    // null when it could not reach the API — so a transient failure can never
    // again be reported to a crawler as "this page is gone".
    let data: { items: HubItem[] } | null;
    try {
      data = await fetchJson<{ items: HubItem[] }>(env, `/api/grading/public/durability`);
    } catch (e) {
      if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
      throw e;
    }
    const items = data?.items ?? [];
    const rows = items
      .map(
        (it) => `<tr>
          <td><a href="/durability/${escape(it.brandSlug)}">${escape(it.brand)}</a></td>
          <td>${pct(it.bestRetention)}</td>
          <td>${it.cohortCount}</td>
        </tr>`,
      )
      .join("");

    const body = `<main class="container">
      <h1>Brand Durability Rankings</h1>
      <p>Which brands hold their condition? These rankings measure how much of its
      <a href="/grading-standard">GradeThread condition grade</a> a garment retains when the same
      item is graded again over time — a real, aggregate durability signal from regraded garments,
      not a lab test.</p>
      ${items.length === 0
        ? `<p class="muted">The durability index is warming up — rankings appear once enough garments
           have been regraded to publish an honest cohort. Check back soon.</p>`
        : `<table>
            <thead><tr><th>Brand</th><th>Best retention</th><th>Cohorts</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
      ${methodologyHtml()}
      ${interlinksHtml()}
    </main>`;

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "GradeThread Brand Durability Rankings",
      description:
        "Which pre-owned clothing brands hold their condition — brands ranked by how much of their GradeThread condition grade they retain across regraded garments.",
      url: `${site}/durability`,
    };

    return renderSsrResponse(
      {
        title: "Brand Durability Rankings — which clothing brands last · GradeThread",
        description: "Which pre-owned clothing brands hold their condition best, ranked by grade retention across regraded garments.",
        canonicalUrl: `${site}/durability`,
        bodyHtml: body,
        jsonLd: [jsonLd],
        gaMeasurementId: ga,
        twitterSite: twitterSiteHandle(env),
      },
      { cacheControl: SSR_CACHE_CONTROL },
    );
  }

  return notFoundResponse(env);
};

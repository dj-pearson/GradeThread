// Catch-all Pages Function for the public Showcase / "Finds" feed (US-1855).
//   /finds              → the feed (trending finds, facets, leaderboard)
//   /finds/b/<brand>    → one brand's finds
//   /finds/c/<category> → one garment category's finds
//
// Edge-SSR'd (Model B, like /condition-index and /verified/:handle) so the feed
// and every card on it are crawlable with real data. The SPA route at /finds is
// the in-app/dev renderer and reads the SAME payload
// (/api/content/public/finds.json), so the two can't describe different feeds.
//
// The SSR deliberately ignores QUERY parameters and renders from the path only.
// Two reasons: an edge-cached page keyed on a path must not depend on a query
// string, and a facet worth indexing deserves a real URL rather than a
// parameter no crawler will treat as its own page.

import {
  breadcrumbListLd,
  certificateProductLd,
  escape,
  fetchJson,
  formatDate,
  ga4MeasurementId,
  notFoundResponse,
  renderBreadcrumbs,
  renderSsrResponse,
  siteUrl,
  twitterSiteHandle,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  type BreadcrumbItem,
  type PagesEnv,
} from "../_shared/blog-render";

interface PublicFind {
  id: string;
  certificate_id: string;
  certificate_url: string;
  image_url: string;
  title: string;
  brand: string | null;
  brand_slug: string | null;
  category: string | null;
  overall_score: number;
  grade_tier: string;
  value_cents: number | null;
  showcased_at: string;
  seller_handle: string | null;
  seller_display_name: string | null;
  seller_url: string | null;
  reactions: number;
}

interface Facet {
  label: string;
  slug: string;
  count: number;
}

interface Leader {
  handle: string;
  display_name: string;
  finds: number;
  reactions: number;
}

interface FindsResponse {
  finds: PublicFind[];
  facets: { brands: Facet[]; categories: Facet[] };
  leaderboard: Leader[];
  total: number;
}

// A find's reaction count moves through the day, so this page is cached more
// briefly than the mostly-static SSR surfaces (SSR_CACHE_CONTROL = 1h edge).
const FINDS_CACHE_CONTROL =
  "public, max-age=120, s-maxage=600, stale-while-revalidate=86400";

// How many cards the SSR page renders. Bounded on purpose: the JSON-LD carries a
// full Product per card, so an unbounded feed would emit a very large document.
const SSR_PAGE_SIZE = 24;

function dollars(cents: number | null): string | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function renderCard(f: PublicFind): string {
  const value = dollars(f.value_cents);
  const seller = f.seller_handle && f.seller_url
    ? `<a href="${escape(f.seller_url.replace(/^https?:\/\/[^/]+/, ""))}">${
      escape(f.seller_display_name ?? f.seller_handle)
    }</a>`
    : `<span>Anonymous seller</span>`;
  const certPath = f.certificate_url.replace(/^https?:\/\/[^/]+/, "");
  return `<li class="find-card">
    <a href="${escape(certPath)}">
      <img src="${escape(f.image_url)}" alt="${
    escape(f.title)
  } — condition-graded ${f.overall_score.toFixed(1)} out of 10" width="400" height="400" loading="lazy" />
    </a>
    <div class="find-card__body">
      <h3><a href="${escape(certPath)}">${escape(f.title)}</a></h3>
      <p class="find-card__grade"><strong>${f.overall_score.toFixed(1)}</strong> / 10 &middot; ${
    escape(f.grade_tier)
  }</p>
      <p class="find-card__meta">${f.brand ? `${escape(f.brand)} &middot; ` : ""}${
    value ? `${escape(value)} &middot; ` : ""
  }${f.reactions} reaction${f.reactions === 1 ? "" : "s"}</p>
      <p class="find-card__seller">Graded for ${seller} &middot; ${
    escape(formatDate(f.showcased_at))
  }</p>
    </div>
  </li>`;
}

function renderFacets(
  brands: Facet[],
  categories: Facet[],
  activeBrand: string | null,
  activeCategory: string | null,
): string {
  const chip = (href: string, label: string, count: number, active: boolean) =>
    `<li><a href="${escape(href)}"${active ? ` aria-current="page"` : ""}>${
      escape(label)
    } <span class="muted">${count}</span></a></li>`;
  const brandChips = brands
    .slice(0, 16)
    .map((b) =>
      chip(`/finds/b/${b.slug}`, b.label, b.count, b.slug === activeBrand)
    )
    .join("");
  const categoryChips = categories
    .slice(0, 16)
    .map((cat) =>
      chip(
        `/finds/c/${cat.slug}`,
        titleCase(cat.label),
        cat.count,
        cat.slug === activeCategory,
      )
    )
    .join("");
  if (!brandChips && !categoryChips) return "";
  return `<section class="find-facets">
    ${
    brandChips
      ? `<h2>Browse by brand</h2><ul class="chips">${brandChips}</ul>`
      : ""
  }
    ${
    categoryChips
      ? `<h2>Browse by category</h2><ul class="chips">${categoryChips}</ul>`
      : ""
  }
  </section>`;
}

// AC3: the community leaderboard the Showcase feeds. Only sellers with a public
// verified profile are ranked (the edge enforces that), so every row here can
// safely link to a real profile.
function renderLeaderboard(leaders: Leader[]): string {
  if (leaders.length === 0) return "";
  const rows = leaders
    .slice(0, 10)
    .map(
      (l, i) => `<tr>
        <td>${i + 1}</td>
        <td><a href="/verified/${escape(l.handle)}">${escape(l.display_name)}</a></td>
        <td>${l.finds}</td>
        <td>${l.reactions}</td>
      </tr>`,
    )
    .join("");
  return `<section class="find-leaderboard">
    <h2>This week's most-loved sellers</h2>
    <p>Ranked by the reactions their showcased finds earned. Every seller here
    runs a public <a href="/verified">GradeThread Verified</a> profile.</p>
    <table>
      <thead><tr><th>#</th><th>Seller</th><th>Finds</th><th>Reactions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

/**
 * ItemList + a full Product per entry.
 *
 * The Product is built with the SAME `certificateProductLd` the certificate SSR
 * uses, and its `@id` is the certificate URL — so a crawler that has already
 * seen the certificate page merges the two rather than treating the feed as a
 * second, competing description of the same garment.
 */
function findsItemListLd(
  finds: PublicFind[],
  canonical: string,
  site: string,
  name: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    url: canonical,
    numberOfItems: finds.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: finds.map((f, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: f.certificate_url,
      item: certificateProductLd({
        id: f.certificate_id,
        title: f.title,
        overallScore: f.overall_score,
        gradeTier: f.grade_tier,
        category: f.category,
        brand: f.brand,
        images: [f.image_url],
        datePublished: f.showcased_at,
        siteUrl: site,
      }),
    })),
  };
}

type Ctx = EventContext<PagesEnv, "path", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = async (context: Ctx) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/finds";
  const ga = ga4MeasurementId(env);
  const site = siteUrl(env);

  let brandSlug: string | null = null;
  let categorySlug: string | null = null;

  if (path !== "/finds") {
    const brandMatch = path.match(/^\/finds\/b\/([a-z0-9-]+)$/);
    const categoryMatch = path.match(/^\/finds\/c\/([a-z0-9_]+)$/);
    if (brandMatch) brandSlug = brandMatch[1] ?? null;
    else if (categoryMatch) categorySlug = categoryMatch[1] ?? null;
    else return notFoundResponse(env);
  }

  const params = new URLSearchParams({ limit: String(SSR_PAGE_SIZE) });
  if (brandSlug) params.set("brand_slug", brandSlug);
  if (categorySlug) params.set("category", categorySlug);

  // US-2044: a transient upstream failure must never be reported to a crawler as
  // "this page is gone".
  let data: FindsResponse | null;
  try {
    data = await fetchJson<FindsResponse>(
      env,
      `/api/content/public/finds.json?${params.toString()}`,
    );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }

  const finds = data?.finds ?? [];
  const brands = data?.facets?.brands ?? [];
  const categories = data?.facets?.categories ?? [];

  // A facet page with nothing on it is a genuine 404 — an empty brand page is a
  // thin, duplicate page that should never be indexed. The hub, by contrast,
  // stays live and explains itself while the feed is warming up.
  if (finds.length === 0 && (brandSlug || categorySlug)) {
    return notFoundResponse(env);
  }

  const brandLabel = brandSlug
    ? brands.find((b) => b.slug === brandSlug)?.label ??
      finds[0]?.brand ?? titleCase(brandSlug)
    : null;
  const categoryLabel = categorySlug ? titleCase(categorySlug) : null;
  const facetLabel = brandLabel ?? categoryLabel;

  const canonical = `${site}${path}`;
  const heading = facetLabel
    ? `${facetLabel} finds, condition-graded`
    : "The Finds feed";

  const trail: BreadcrumbItem[] = [
    { name: "GradeThread", url: `${site}/` },
    { name: "Finds", url: `${site}/finds` },
    ...(facetLabel ? [{ name: facetLabel, url: canonical }] : []),
  ];

  const intro = facetLabel
    ? `<p>Real ${escape(facetLabel)} pieces sellers showcased after grading them on
      <a href="/grading-standard">GradeThread's 1.0&ndash;10.0 condition standard</a>.
      Every card links to the full certificate &mdash; the same report a buyer sees.</p>`
    : `<p>Finds is the public feed of graded pieces resellers are proud of. Every item
      here was independently condition-graded on
      <a href="/grading-standard">GradeThread's objective 1.0&ndash;10.0 standard</a> and
      published by its seller, and every card links straight to the certificate.</p>`;

  const body = `${renderBreadcrumbs(trail, site)}
    <main class="container">
      <h1>${escape(heading)}</h1>
      ${intro}
      ${
    finds.length === 0
      ? `<p class="muted">No finds have been showcased yet &mdash; grade something great and be the first.</p>`
      : `<ul class="find-grid">${finds.map(renderCard).join("")}</ul>`
  }
      ${renderFacets(brands, categories, brandSlug, categorySlug)}
      ${renderLeaderboard(data?.leaderboard ?? [])}
      <p class="muted">Sellers choose which of their graded items appear here. A grade is an
      independent condition assessment, not a valuation or an authentication.</p>
      <p><a href="/snap">Grade your own find &rarr;</a> &middot;
      <a href="/verified">Browse verified sellers &rarr;</a></p>
    </main>`;

  const listName = facetLabel
    ? `${facetLabel} finds on GradeThread`
    : "Graded finds on GradeThread";

  const jsonLd: unknown[] = [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: listName,
      description:
        "A public feed of pre-owned clothing finds, each independently condition-graded on GradeThread's 1.0–10.0 standard and published by its seller.",
      url: canonical,
    },
    breadcrumbListLd(trail),
    ...(finds.length > 0
      ? [findsItemListLd(finds, canonical, site, listName)]
      : []),
  ];

  return renderSsrResponse(
    {
      title: facetLabel
        ? `${facetLabel} finds by condition grade · GradeThread`
        : "Finds — condition-graded thrift and resale finds · GradeThread",
      description: facetLabel
        ? `Condition-graded ${facetLabel} finds shared by GradeThread sellers, each with a full certificate showing the 1.0–10.0 grade.`
        : "A public feed of pre-owned clothing finds, each independently condition-graded 1.0–10.0 with a shareable certificate.",
      canonicalUrl: canonical,
      bodyHtml: body,
      jsonLd,
      gaMeasurementId: ga,
      twitterSite: twitterSiteHandle(env),
    },
    { cacheControl: FINDS_CACHE_CONTROL },
  );
};

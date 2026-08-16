// Cloudflare Pages Function: server-renders the public Garment Passport at
// /passport/:slug (US-1093). Mirrors the cert SSR pattern (functions/cert/[id]).
//
// The passport is the marquee buyer-facing provenance surface — one indexable,
// AI-citable page per garment showing a confidence-scored timeline of grades,
// listings, sales, and ownership transfers. The SPA route at /passport/:slug
// still renders for humans; this Function gives crawlers (and link-preview
// bots) fully rendered HTML + a Product/Review JSON-LD grade descriptor.
//
// Data comes from the anonymous edge endpoint /api/passport/:slug, which is
// PII-free by construction: actors are pseudonymous labels only and payloads
// are sanitized server-side (services/edge-functions/src/routes/passport.ts).

import {
  breadcrumbListLd,
  escape,
  fetchJson,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  notFoundResponse,
  passportProductLd,
  renderBreadcrumbs,
  renderSsrResponse,
  siteUrl,
  SSR_CACHE_CONTROL,
  twitterSiteHandle,
  withEdgeCache,
  type PagesEnv,
} from "../_shared/blog-render";
import { headOf } from "../_shared/head-of";

interface PassportEvent {
  event_type: string;
  confidence: string;
  actor: string | null;
  // US-1105: present only when this hop's owner opted to reveal their Verified
  // identity. null = pseudonymous (the default).
  actor_revealed?: { handle: string; display_name: string | null } | null;
  source: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}
interface PassportResponse {
  slug: string;
  sku_class: Record<string, unknown>;
  status: string;
  created_at: string;
  origin_verified_seller?: {
    handle: string;
    display_name: string | null;
    since: string | null;
  } | null;
  events: PassportEvent[];
}

const EVENT_LABELS: Record<string, string> = {
  graded: "Condition graded",
  listed: "Listed for sale",
  sold: "Sold",
  ownership_transfer: "Ownership transferred",
  fingerprinted: "Fingerprinted",
  // US-2142 (00488) — keep in step with EVENT_META in src/pages/passport.tsx.
  authenticity_assessed: "Authenticity assessed",
};
const CONFIDENCE_LABELS: Record<string, string> = {
  deterministic: "Verified",
  probable: "Probable",
  unknown: "Unknown",
};

type Ctx = EventContext<PagesEnv, "slug", Record<string, unknown>>;

export const onRequestGet: PagesFunction<PagesEnv> = (context: Ctx) =>
  withEdgeCache(context, () => renderPassport(context));

async function renderPassport(context: Ctx): Promise<Response> {
  const { params, env } = context;
  const slug = String(params.slug ?? "");
  if (!slug) return notFoundResponse(env);

  // US-2044: fetchJson now THROWS UpstreamUnavailable rather than returning
  // null when it could not reach the API — so a transient failure can never
  // again be reported to a crawler as "this page is gone".
  let data: PassportResponse | null;
  try {
    data = await fetchJson<PassportResponse>(
    env,
    `/api/passport/${encodeURIComponent(slug)}`,
  );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) return upstreamUnavailableResponse();
    throw e;
  }
  if (!data?.slug) return notFoundResponse(env);

  const base = siteUrl(env);
  const canonical = `${base}/passport/${data.slug}`;

  const brand = strOf(data.sku_class.brand);
  const garmentType = strOf(data.sku_class.garment_type);
  const category = strOf(data.sku_class.category);
  const name = [brand, garmentType ? formatLabel(garmentType) : null]
    .filter(Boolean)
    .join(" ") || "Graded garment";

  // Latest 'graded' event → header score + JSON-LD review.
  const graded = data.events.filter((e) => e.event_type === "graded");
  const latest = graded[graded.length - 1];
  const latestScore = latest ? numOf(latest.payload.overall_score) : null;
  const latestTier = latest ? strOf(latest.payload.grade_tier) : null;

  const title = latestScore !== null && latestTier
    ? `Garment Passport — ${name} (Grade ${latestScore.toFixed(1)})`
    : `Garment Passport — ${name}`;
  const description =
    `Provenance and condition history for ${name}: a confidence-scored, ` +
    `pseudonymous timeline of grades, listings, sales, and ownership on GradeThread.`;
  // US-2195: only use the /og/cert card when the latest grade actually carries
  // a certificate id — otherwise `/og/cert/` (empty id) 404s and unfurls a
  // broken card. Fall back to the 1200x630 default OG asset.
  const latestCertId = latest ? (strOf(latest.payload.certificate) ?? "") : "";
  const ogImage = latestCertId
    ? `${base}/og/cert/${encodeURIComponent(latestCertId)}`
    : `${base}/og-image.png`;

  const breadcrumbItems = [
    { name: "GradeThread", url: `${base}/` },
    { name: "Garment Passport", url: canonical },
  ];

  const headerScoreHtml = latestScore !== null && latestTier
    ? `<div style="display:flex;align-items:center;gap:16px;margin:16px 0 24px">
        <div style="font-size:3rem;font-weight:700;color:var(--accent)">${escape(latestScore.toFixed(1))}</div>
        <div><div style="font-weight:600">${escape(latestTier)}</div><div style="color:var(--muted);font-size:0.9rem">Latest condition grade · out of 10</div></div>
      </div>`
    : "";

  const eventsHtml = data.events
    .map((e) => {
      const label = EVENT_LABELS[e.event_type] ?? formatLabel(e.event_type);
      const conf = CONFIDENCE_LABELS[e.confidence] ?? "Unknown";
      const score = numOf(e.payload.overall_score);
      const tier = strOf(e.payload.grade_tier);
      const certificate = strOf(e.payload.certificate);
      const gradeLine = score !== null && tier
        ? `<div style="font-size:0.9rem"><strong style="color:var(--accent)">${escape(score.toFixed(1))}/10</strong> — ${escape(tier)}</div>`
        : "";
      const certLink = certificate
        ? `<div style="margin-top:6px"><a href="/cert/${escape(certificate)}">View grade certificate &rarr;</a></div>`
        : "";
      // US-1105: a revealed hop links to the actor's public Verified profile;
      // otherwise show only the pseudonymous label.
      const rev = e.actor_revealed;
      const actor = rev?.handle
        ? ` · <a href="/verified/${escape(rev.handle)}"><strong>${
          escape(rev.display_name || "@" + rev.handle)
        }</strong></a> <span style="font-size:0.75rem">(Verified)</span>`
        : e.actor
        ? ` · ${escape(e.actor)}`
        : "";
      return `<li style="margin:0 0 16px;padding:12px 16px;border:1px solid var(--border,#e2e8f0);border-radius:8px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <strong>${escape(label)}</strong>
          <span style="font-size:0.8rem;color:var(--muted)">${escape(conf)}</span>
        </div>
        ${gradeLine}
        <div style="font-size:0.8rem;color:var(--muted)">${escape(formatDate(e.created_at))}${actor}</div>
        ${certLink}
      </li>`;
    })
    .join("");

  // US-1101: origin-seller Verified badge (public, opt-in) + the buyer-guarantee
  // "transfers on claim" trust callout — the incentive to claim the chain.
  const v = data.origin_verified_seller;
  const verifiedHtml = v?.handle
    ? `<p style="margin:8px 0 0;font-size:0.9rem">Originally graded &amp; sold by
        <a href="/verified/${escape(v.handle)}"><strong>${escape(v.display_name || "@" + v.handle)}</strong></a>
        <span style="font-size:0.8rem;color:var(--muted)">· Verified Seller</span></p>`
    : "";
  const guaranteeHtml = `<div style="margin:20px 0;padding:14px 16px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:rgba(15,52,96,0.05)">
    <strong>The buyer guarantee transfers when you claim this passport.</strong>
    <p style="margin:6px 0 0;color:var(--muted);font-size:0.9rem">A passported item carries GradeThread's condition-backed buyer guarantee. Claim ownership after you buy and the guarantee — and the item's full, confidence-scored history — follows you. <a href="/buyer-guarantee">How the buyer guarantee works &rarr;</a></p>
  </div>`;

  const bodyHtml = `${renderBreadcrumbs(breadcrumbItems, base)}
  <main class="container">
  <p style="color:var(--muted);margin-bottom:8px">Garment Passport — pseudonymous, confidence-scored provenance</p>
  <h1>${escape(name)}</h1>
  <p style="color:var(--muted)">${category ? escape(formatLabel(category)) : "Pre-owned garment"} · First graded ${escape(formatDate(data.created_at))}</p>
  ${verifiedHtml}
  ${headerScoreHtml}
  ${guaranteeHtml}
  <h2>Provenance timeline</h2>
  <ul style="list-style:none;padding:0">${eventsHtml || "<li style='color:var(--muted)'>No history recorded yet.</li>"}</ul>
  <p style="color:var(--muted);font-size:0.85rem;margin-top:24px">Each entry is labeled with how certain its link in the chain is. Participants are shown as pseudonymous labels only — GradeThread never exposes personal information on a public passport.</p>
  <a class="cta" href="/?utm_source=passport&utm_medium=organic">Grade your own garment with GradeThread &rarr;</a>
</main>`;

  // US-1093: Product + Review JSON-LD built from the shared passportProductLd()
  // so this SSR path and the SPA route (passportLd) can't drift (equivalence
  // test in json-ld.test.ts pins them equal).
  const productLd = passportProductLd({
    slug: data.slug,
    name,
    category,
    brand,
    latestGrade:
      latestScore !== null && latestTier
        ? { score: latestScore, tier: latestTier, datePublished: latest?.created_at ?? null }
        : null,
    siteUrl: base,
  });
  const breadcrumbLd = breadcrumbListLd(breadcrumbItems);

  return renderSsrResponse(
    {
      title,
      description,
      canonicalUrl: canonical,
      ogImage,
      // US-2195: both branches (/og/cert card and og-image.png) are 1200x630.
      ogImageWidth: 1200,
      ogImageHeight: 630,
      twitterSite: twitterSiteHandle(env),
      ogType: "product",
      jsonLd: [productLd, breadcrumbLd],
      bodyHtml,
    },
    { cacheControl: SSR_CACHE_CONTROL },
  );
}

function strOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function numOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function formatLabel(value: string): string {
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

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

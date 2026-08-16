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
  certGalleryImageUrls,
  certificateProductLd,
  escape,
  fetchJson,
  UpstreamUnavailable,
  upstreamUnavailableResponse,
  renderBreadcrumbs,
  renderSsrResponse,
  siteUrl,
  SSR_CACHE_CONTROL,
  twitterSiteHandle,
  withEdgeCache,
  type PagesEnv,
} from "../_shared/blog-render";
import { certNotFoundResponse, certRevisedResponse } from "./cert-not-found";
import { aiDisclosureNoticeHtml } from "../_shared/ai-disclosure";
import { conditionAuthenticityNoticeHtml } from "../_shared/condition-authenticity";
import { INTEGRITY_TIER_BASIS, LEVEL_FLAIR_BASIS } from "../_shared/status-basis";
import { headOf } from "../_shared/head-of";

interface PublicCertificate {
  id: string;
  certificate_number?: string | null;
  title: string;
  /** US-2613: `title` with condition claims stripped. Optional — see below. */
  display_title?: string | null;
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
  // US-2392: when the certified content was last rewritten in place by a
  // human-review adjustment. Absent/null on an unrevised certificate.
  certified_content_updated_at?: string | null;
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
  // US-1762: true when the grade was produced from frames the server extracted
  // from one continuous walk-around clip.
  video_capture_verified?: boolean;
  // US-1766: true when that clip was recorded live in the in-app recorder.
  video_live_capture_verified?: boolean;
  // US-2399: drives the AI-disclosure variant. Optional so a partial payload
  // degrades to the stricter AI-only wording rather than silently claiming a
  // human reviewed the grade.
  human_reviewed?: boolean | null;
  // US-1912: the grader's Grade Integrity tier — how often buyers confirmed on
  // arrival that a grade of theirs matched. Null unless the seller publishes a
  // verified profile AND their standing clears the anti-gaming display floor;
  // the edge decides both, so "present" means "earned".
  seller_integrity?: {
    tier: string;
    label: string;
    handle: string;
    // US-1913: the grader's level flair beside the tier. Null below level 1.
    level?: { level: number; tier_name: string; tier_blurb: string } | null;
  } | null;
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

export const onRequestGet: PagesFunction<PagesEnv> = (context: Ctx) =>
  withEdgeCache(context, () => renderCertificate(context));

// US-1945: a DISTINCT, cert-branded 404 — never the generic/blog one — so a
// buyer following a certificate link that can't be resolved gets a clear
// "certificate not found" (and can't confuse it with a genuine verified cert).
async function renderCertificate(context: Ctx): Promise<Response> {
  const { params, env } = context;
  const id = String(params.id ?? "");
  if (!id) return certNotFoundResponse(env);

  // US-2044: distinguish "this certificate does not exist" from "we could not
  // reach the API". Serving a 404 for the latter DEINDEXES real certificates —
  // and certificates are the distribution flywheel, since every shared cert link
  // is a backlink. A 503 + Retry-After makes Googlebot back off and keep the URL.
  let data: CertResponse | null;
  try {
    data = await fetchJson<CertResponse>(
      env,
      `/api/content/public/certificates/${encodeURIComponent(id)}`,
    );
  } catch (e) {
    if (e instanceof UpstreamUnavailable) {
      console.warn(`[cert ssr] upstream unavailable for ${id}: ${e.reason}`);
      return upstreamUnavailableResponse();
    }
    throw e;
  }
  // US-2569: a REVISED certificate is not a missing one. The upstream answers
  // 200 with `revised: true` when a regrade retired this number, and the buyer
  // holding the hangtag it is printed on deserves to be told where the current
  // grade is rather than shown a 404 that reads as "this was never real".
  const revised = data as unknown as {
    revised?: boolean;
    message?: string;
    current_certificate_id?: string | null;
    current_certificate_number?: string | null;
  } | null;
  if (revised?.revised) {
    return certRevisedResponse(env, {
      message: revised.message ?? "This certificate was replaced.",
      current_certificate_id: revised.current_certificate_id ?? null,
      current_certificate_number: revised.current_certificate_number ?? null,
    });
  }

  // Reaching here means the upstream ANSWERED and the cert genuinely is not
  // there (or is withheld) — the one case that deserves the branded 404.
  if (!data?.certificate) return certNotFoundResponse(env);

  const cert = data.certificate;
  // US-1945: only the stored, verifiable certificate_number is shown as
  // "Certificate No." — never a UUID-derived look-alike that /verify can't
  // resolve. Absent a real number the cert is identified by its URL + QR.
  const certNo = cert.certificate_number || null;
  const certNoSuffix = certNo
    ? ` · Certificate No. <code>${escape(certNo)}</code>`
    : "";
  const base = siteUrl(env);
  const canonical = `${base}/cert/${cert.id}`;
  const score = cert.overall_score.toFixed(1);
  // US-2613: display_title is the seller's title with condition claims removed.
  // A live certificate read "…Made in Italy NWT — Grade 9.2 (NWOT)": the seller
  // says tags on, our grade says tags off, both in the search snippet and every
  // social preview. The stripping happens once on the edge (cert-display-title.ts)
  // because this page and the OG card are different runtimes and two copies
  // would drift.
  //
  // `?? cert.title` is not defensive habit — it is the deploy order. The edge
  // and Pages ship separately, so a Pages build can be live against an edge that
  // predates the field, and the honest fallback is the seller's title unchanged.
  const headline = cert.display_title ?? cert.title;
  const title = `${headline} — Grade ${score} (${cert.grade_tier})`;
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
  // /slab/cert Pages proxy). A working img element — the whole reason for this rewrite.
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

  // US-2225 AC3: the condition-vs-authenticity separation, rendered INSIDE the
  // factor breakdown rather than in a footer — it has to sit beside the number
  // it qualifies or it is a disclaimer nobody reaches. Empty string for every
  // rubric that does not need one, so clothing certificates are byte-identical.
  const conditionOnlyHtml = conditionAuthenticityNoticeHtml(
    (cert as { rubric_key?: string | null }).rubric_key,
  );

  // Factor breakdown as colored bars (was a plain table).
  const factorsHtml = `${conditionOnlyHtml}<div class="cert-factors">${
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
  if (cert.video_capture_verified) {
    // US-1766: one badge either way — the live reading just tells it in full.
    badges.push(
      cert.video_live_capture_verified
        ? '<span class="cert-badge cert-badge--verify">&#10003; Video-Verified · recorded live, frames from one clip</span>'
        : '<span class="cert-badge cert-badge--verify">&#10003; Video-Verified · frames from one clip</span>',
    );
  }
  if (cert.original_photos_verified) {
    badges.push('<span class="cert-badge cert-badge--verify">&#10003; Original photos verified</span>');
  }
  const badgesHtml = badges.length > 0 ? `<div class="cert-badges">${badges.join("")}</div>` : "";

  // US-1912: who graded it, and how often they have been proven right. Kept
  // separate from the provenance badges above on purpose — those describe THIS
  // capture, while this describes the grader's track record across every item a
  // buyer has confirmed after delivery. Linked to the public profile so the
  // claim is checkable rather than decorative.
  //
  // US-1913 AC2 adds the grader's LEVEL beside the tier, each carrying its own
  // tooltip. The two are easy to read as one thing, and they are not: a level
  // counts activity, a tier counts proven accuracy. Rendered only when the edge
  // sent it (level 0 is the un-earned rung and never crosses the boundary), so
  // there is no threshold to re-decide here.
  const graderStanding = cert.seller_integrity;
  const graderLevel = graderStanding?.level ?? null;
  const graderLevelHtml = graderLevel
    ? ` <span class="cert-grader-lvl" title="${escape(LEVEL_FLAIR_BASIS)}">Level ${graderLevel.level} · ${escape(graderLevel.tier_name)}</span>`
    : "";
  const graderHtml = graderStanding
    ? `<p class="cert-grader" title="${escape(INTEGRITY_TIER_BASIS)}">Graded by a <a href="${base}/verified/${encodeURIComponent(graderStanding.handle)}">` +
      `${escape(graderStanding.label)}</a> — ${escape(INTEGRITY_TIER_BASIS)}${graderLevelHtml}</p>`
    : "";

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

  // US-2399: the SSR page renders the full grade to anyone whose SPA bundle
  // hasn't mounted yet (and to every crawler), so the AI disclosure has to be in
  // these bytes too — not only in the React certificate page that replaces them.
  // Same shared copy, so the two can't say different things about one grade.
  //
  // US-2400: the block itself is built in _shared/ai-disclosure.ts. This file
  // can't be imported from a Vitest test (it uses the worker globals), so an
  // inline template here was wording nothing could assert — which is how the
  // variant shipped unrenderable in the first place.
  const aiDisclosureHtml = aiDisclosureNoticeHtml(cert.human_reviewed === true);

  const bodyHtml = `${renderBreadcrumbs(breadcrumbItems, base)}
  <main class="container container--wide">
  <p class="cert-eyebrow">Verified Grade Certificate${certNoSuffix}</p>
  <h1>${escape(cert.title)}${cert.brand ? ` <span style="color:var(--muted)">— ${escape(cert.brand)}</span>` : ""}</h1>
  <div class="cert-hero">
    <div class="cert-score" style="background:${scoreColor(cert.overall_score)}">${escape(score)}</div>
    <div>
      <div class="cert-tier">${escape(cert.grade_tier)}</div>
      <div class="cert-tier-sub">Overall Condition Grade · out of 10</div>
    </div>
  </div>
  ${badgesHtml}
  ${graderHtml}
  ${slabHtml}
  ${galleryHtml}
  ${aboutHtml}
  <h2>What does a ${escape(score)} grade mean?</h2>
  <p>${escape(gradeBandMeaning(cert.overall_score))} It sits on the GradeThread Scale, the standardized 1.0&ndash;10.0 system for pre-owned clothing condition. <a href="/grading/scale">See the full grading scale &rarr;</a></p>
  <h2>Factor Breakdown</h2>
  ${factorsHtml}
  <h2>${cert.buyer_writeup ? "Condition Report" : "AI Analysis Summary"}</h2>
  <div class="cert-report">${escape(cert.buyer_writeup || cert.ai_summary)}</div>
  ${aiDisclosureHtml}
  <p class="cert-eyebrow" style="margin-top:24px">Graded on ${escape(gradedOn)}${certNoSuffix}</p>
  <a class="cta" href="/?utm_source=certificate&utm_medium=organic">Grade your own garment with GradeThread &rarr;</a>
  <!--
    US-2108 AC2. This href is INTENTIONALLY free of the visitor's ?ref=, and
    that is not the leak it looks like.

    THIS RESPONSE IS SHARED-CACHED. withEdgeCache keys on origin+pathname and
    DROPS the query string (blog-render.ts), so varying this href by the
    visitor's ?ref= would cache the first arriver's referral code and serve it
    to every subsequent visitor of the same certificate — silently crediting one
    seller for everyone else's traffic. That is worse than the leak it closes.
    Do not "fix" it into a cache-poisoning bug.

    Attribution IS preserved, by a mechanism that keeps the HTML identical for
    every visitor: renderLayout emits affiliateCaptureSnippet(), which reads the
    ref off the visitor's OWN URL at runtime and banks it in localStorage under
    the key the SPA's redeem path reads. Nothing in the cached bytes varies by
    referral code. See functions/_shared/affiliate-capture.ts — including why an
    earlier note here wrongly claimed the SPA already handled this (it does not;
    these pages never mount it).
  -->
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
    // US-2206: the FULL ordered gallery, as stable /cert-photo urls. The
    // signed `cert.images[].url` values render the grid above but expire in 15
    // minutes, so they could never go in structured data — a crawler fetching
    // one later gets a 403. Falls back to nothing (not the signed hero) when
    // the cert has no photos: an expiring URL in JSON-LD is worse than no
    // image field, which the builder omits gracefully.
    images: certGalleryImageUrls(base, cert.id, cert.images?.length ?? 0),
    datePublished: cert.created_at,
    // US-2392 / US-2071 AC3: mirrors the SPA exactly — see the note there. The
    // byte-equality test in json-ld.test.ts exercises both the present and the
    // absent case, because a fixture that omits the field cannot catch a
    // divergence in it.
    dateModified: cert.certified_content_updated_at ?? null,
    siteUrl: base,
  });

  const breadcrumbLd = breadcrumbListLd(breadcrumbItems);

  return renderSsrResponse(
    {
      title,
      description,
      canonicalUrl: canonical,
      ogImage,
      // US-2186: /og/cert/:id is a fixed 1200x630 PNG card.
      ogImageWidth: 1200,
      ogImageHeight: 630,
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
// navy (good) → amber (fair) → crimson (poor). Brand palette (vault/20-domain/brand-design-system.md).
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

// US-2620: HEAD answers with the GET's status and headers, no body.
export const onRequestHead = headOf(onRequestGet);

// Typed JSON-LD (schema.org) builders for both traditional rich results and
// AI answer engines (PRD: tasks/prd-seo-hardening.md, US-298/299/300).
//
// These return plain objects; the <SEO> component serializes them into
// <script type="application/ld+json"> tags. Only mark up data that is also
// visible on the page (Google structured-data policy).

import { SITE_URL } from "./public-routes";
import {
  socialProfileUrls,
  contactEmail,
  foundingDate,
} from "./social";
import { GRADETHREAD_TIERS } from "@/lib/constants";

const LOGO_URL = `${SITE_URL}/logo_icon_512.png`;

// Stable @id for the Organization so other nodes can reference it as a graph.
const ORG_ID = `${SITE_URL}/#organization`;
const WEBSITE_ID = `${SITE_URL}/#website`;

export interface JsonLd {
  "@context": "https://schema.org";
  "@type": string;
  [key: string]: unknown;
}

/** Core entity. The single most important node for entity recognition. */
export function organizationLd(): JsonLd {
  // US-428: strengthen entity disambiguation. sameAs lists every LIVE external
  // profile (config-driven — only real URLs ever appear); contactPoint and
  // foundingDate are emitted only when the corresponding env value is set, so we
  // never assert an unmanned mailbox or a guessed date.
  const email = contactEmail();
  const founded = foundingDate();
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": ORG_ID,
    name: "GradeThread",
    legalName: "Pearson Media LLC",
    url: `${SITE_URL}/`,
    logo: LOGO_URL,
    slogan: "The standard for pre-owned clothing condition grading.",
    description:
      "GradeThread is the trusted standard for pre-owned clothing condition grading — objective, AI-powered, and verifiable. Sellers get a 1.0–10.0 condition grade and a shareable certificate buyers trust, plus FlipDesk to run their whole reselling workflow.",
    // knowsAbout asserts the topics GradeThread is authoritative on, so AI
    // answer engines treat us as THE entity behind clothing condition grading
    // (the lead identity) while still surfacing the reseller workflow we run.
    knowsAbout: [
      "Pre-owned clothing condition grading",
      "The 1.0–10.0 clothing condition grade scale",
      "Clothing condition tiers (NWT, NWOT, Excellent, Very Good, Good, Fair, Poor)",
      "Garment grading factors: fabric condition, structural integrity, cosmetic appearance, functional elements, odor and cleanliness",
      "Reselling pre-owned clothing on eBay, Poshmark, Mercari, Depop, and Grailed",
      "Reducing returns and disputes on resold apparel",
    ],
    ...(founded ? { foundingDate: founded } : {}),
    ...(email
      ? {
          contactPoint: {
            "@type": "ContactPoint",
            contactType: "customer support",
            email,
            url: `${SITE_URL}/`,
          },
        }
      : {}),
    sameAs: socialProfileUrls(),
  };
}

/**
 * WebSite node. Pass `searchUrlTemplate` (a URL with `{search_term_string}`)
 * only if a real site-search endpoint exists — claiming a SearchAction with no
 * working search violates Google's guidelines.
 */
export function webSiteLd(searchUrlTemplate?: string): JsonLd {
  const ld: JsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: `${SITE_URL}/`,
    name: "GradeThread",
    publisher: { "@id": ORG_ID },
  };
  if (searchUrlTemplate) {
    ld.potentialAction = {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: searchUrlTemplate,
      },
      "query-input": "required name=search_term_string",
    };
  }
  return ld;
}

/** The product itself, for SaaS Product/SoftwareApplication rich results. */
export function softwareApplicationLd(): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "GradeThread",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: `${SITE_URL}/`,
    publisher: { "@id": ORG_ID },
    description:
      "The trusted standard for pre-owned clothing condition grading: upload garment photos and get an objective 1.0–10.0 grade, a detailed report, and a shareable verification certificate. FlipDesk adds a full reseller workflow on top.",
    // featureList encodes the dual offering — grading authority first, reseller
    // workflow second — so the secondary capability is machine-readable too.
    featureList: [
      "AI-powered clothing condition grading on a standardized 1.0–10.0 scale",
      "Detailed factor-by-factor condition reports",
      "Shareable, publicly verifiable condition certificates",
      "FlipDesk reseller workflow: source, catalog, list, sell, and reconcile",
    ],
    offers: {
      "@type": "Offer",
      // Free to start; per-grade pricing begins at the Standard tier.
      price: (GRADETHREAD_TIERS.standard.priceCents / 100).toFixed(2),
      priceCurrency: "USD",
      category: "per grade",
    },
  };
}

/**
 * FAQPage. Google dropped FAQ *rich results* in May 2026, but AI answer
 * engines still extract and cite these Q&A pairs — keep it for GEO.
 */
export function faqPageLd(faqs: ReadonlyArray<{ q: string; a: string }>): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

/**
 * Dataset descriptor for the public transparency report (US-326). Models the
 * published accuracy figures as a schema.org Dataset so AI answer engines can
 * cite GradeThread's measured grading quality as a real, maintained data
 * source — the authority signal behind "trusted, self-improving grading".
 * Only static facts are encoded (what is measured + how); the live numbers
 * render on the page itself.
 */
export function transparencyDatasetLd(): JsonLd {
  const canonical = `${SITE_URL}/transparency`;
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${canonical}#dataset`,
    name: "GradeThread Grading Accuracy & Transparency Report",
    description:
      "Platform-wide measures of GradeThread's clothing condition grading quality: AI-vs-human agreement rate, mean absolute error against expert reviewers, intentional-design misread rate, model confidence, and post-sale buyer dispute rate. Updated continuously as new grades and reviews accrue.",
    url: canonical,
    creator: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    isAccessibleForFree: true,
    license: "https://gradethread.com/terms",
    measurementTechnique:
      "Comparison of AI condition grades against expert human reviewer corrections (agreement within 0.5 points, mean absolute error) plus post-sale buyer dispute tracking on opted-in graded items.",
    variableMeasured: [
      "AI-vs-human grade agreement rate",
      "Mean absolute error vs. expert reviewers",
      "Intentional-design misread rate",
      "Average model confidence",
      "Buyer dispute rate on graded sales",
    ],
  };
}

/**
 * Article node for the cornerstone pillar pages (US-855). These are durable,
 * hand-curated authority pages, so we model each as an Article authored and
 * published by the GradeThread Organization (referenced by @id — the page's
 * layout already emits the Organization node, so the graph resolves). Dates are
 * passed in as fixed YYYY-MM-DD strings (never a build timestamp) so the
 * prerendered head and the live SPA emit byte-identical structured data.
 */
export function articleLd(opts: {
  headline: string;
  description: string;
  url: string;
  datePublished: string;
  dateModified: string;
  image?: string;
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: opts.headline,
    description: opts.description,
    mainEntityOfPage: { "@type": "WebPage", "@id": opts.url },
    author: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    datePublished: opts.datePublished,
    dateModified: opts.dateModified,
    image: opts.image ?? `${SITE_URL}${"/og-image.png"}`,
    isAccessibleForFree: true,
  };
}

/** BreadcrumbList for hierarchy/topical-authority signals. */
export function breadcrumbLd(
  items: ReadonlyArray<{ name: string; url: string }>,
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

/** HowTo, for step-by-step pages like /how-it-works. */
export function howToLd(opts: {
  name: string;
  description?: string;
  steps: ReadonlyArray<{ name: string; text: string; url?: string }>;
}): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    step: opts.steps.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.name,
      text: s.text,
      ...(s.url ? { url: s.url } : {}),
    })),
  };
}

/**
 * Certificate grade descriptor. Models the graded garment as a Product and the
 * GradeThread condition grade as a single expert Review/Rating (1–10), so the
 * exact numeric grade is machine-readable and AI-citable.
 */
export function certificateLd(cert: {
  id: string;
  title: string;
  overallScore: number;
  gradeTier: string;
  category?: string | null;
  brand?: string | null;
  images?: string[];
  datePublished?: string | null;
  dateModified?: string | null;
}): JsonLd {
  const canonical = `${SITE_URL}/cert/${cert.id}`;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": canonical,
    name: cert.title,
    ...(cert.category ? { category: cert.category } : {}),
    ...(cert.brand ? { brand: { "@type": "Brand", name: cert.brand } } : {}),
    ...(cert.images && cert.images.length ? { image: cert.images } : {}),
    itemCondition: "https://schema.org/UsedCondition",
    review: {
      "@type": "Review",
      // US-425: score formatted to one decimal so the SPA and the cert SSR
      // Pages Function (functions/cert/[id].ts) emit a byte-identical Review
      // name — see the SSR/SPA equivalence test in json-ld.test.ts.
      name: `Condition grade: ${cert.gradeTier} (${cert.overallScore.toFixed(1)}/10)`,
      reviewRating: {
        "@type": "Rating",
        ratingValue: cert.overallScore,
        bestRating: 10,
        worstRating: 1,
        alternateName: cert.gradeTier,
      },
      // US-425: inline Organization (not an @id graph reference). The cert page
      // emits only the Product + Breadcrumb nodes, so a bare {"@id"} author
      // would dangle; this keeps the node self-contained and matches the SSR.
      author: { "@type": "Organization", name: "GradeThread", url: SITE_URL },
      ...(cert.datePublished ? { datePublished: cert.datePublished } : {}),
    },
    ...(cert.dateModified ? { dateModified: cert.dateModified } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
  };
}

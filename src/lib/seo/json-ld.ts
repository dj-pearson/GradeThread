// Typed JSON-LD (schema.org) builders for both traditional rich results and
// AI answer engines (PRD: tasks/prd-seo-hardening.md, US-298/299/300).
//
// These return plain objects; the <SEO> component serializes them into
// <script type="application/ld+json"> tags. Only mark up data that is also
// visible on the page (Google structured-data policy).

import { SITE_URL } from "./public-routes";
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
    sameAs: ["https://github.com/dj-pearson/GradeThread"],
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
      name: `Condition grade: ${cert.gradeTier} (${cert.overallScore}/10)`,
      reviewRating: {
        "@type": "Rating",
        ratingValue: cert.overallScore,
        bestRating: 10,
        worstRating: 1,
        alternateName: cert.gradeTier,
      },
      author: { "@id": ORG_ID },
      ...(cert.datePublished ? { datePublished: cert.datePublished } : {}),
    },
    ...(cert.dateModified ? { dateModified: cert.dateModified } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
  };
}

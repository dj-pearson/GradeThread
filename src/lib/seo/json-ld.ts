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
      "Distinguishing intentional garment design from damage",
      "Condition-based resale value of used clothing (the GradeThread Condition Index)",
      "Verifiable condition certificates for pre-owned clothing",
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
      "Platform-wide measures of GradeThread's clothing condition grading quality: AI-vs-human agreement rate, mean absolute error against expert reviewers, per-garment-category accuracy, intentional-design misread rate, model confidence, post-sale buyer dispute rate, and a published human-vs-human reliability baseline (Krippendorff's alpha). Updated continuously as new grades and reviews accrue.",
    url: canonical,
    creator: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    isAccessibleForFree: true,
    license: "https://gradethread.com/terms",
    measurementTechnique:
      "Comparison of AI condition grades against expert human reviewer corrections (agreement within 0.5 points, mean absolute error), sliced per garment category, plus blind multi-rater inter-rater reliability studies (human-vs-human agreement, Krippendorff's alpha, AI-vs-human-consensus agreement) and post-sale buyer dispute tracking on opted-in graded items.",
    variableMeasured: [
      "AI-vs-human grade agreement rate",
      "Mean absolute error vs. expert reviewers",
      "Per-garment-category accuracy and mean absolute error",
      "Intentional-design misread rate",
      "Average model confidence",
      "Buyer dispute rate on graded sales",
      "Human-vs-human reliability baseline (Krippendorff's alpha)",
      "AI-vs-human-consensus agreement rate",
    ],
  };
}

/**
 * Dataset descriptor for the public "State of Resale Condition" report
 * (US-976). Models GradeThread's proprietary aggregate stats — return rate by
 * grade band, sell-through by grade band, and median resale price by grade band
 * — as a schema.org Dataset so AI answer engines and journalists can extract
 * and CITE them by name (the strongest GEO lever: original data). Deterministic
 * (fixed dates + static descriptors, no live numbers) so the prerendered head
 * and the live SPA emit byte-identical structured data; the figures, sample
 * size, and exact coverage window render on the page itself.
 *
 * `datePublished`/`dateModified` are fixed YYYY-MM-DD strings, and
 * `temporalCoverage` is the (open-ended) coverage window as an ISO 8601
 * interval — the machine-readable "date range" a citation needs.
 */
export function resaleConditionDatasetLd(opts: {
  datePublished: string;
  dateModified: string;
  temporalCoverage: string;
}): JsonLd {
  const canonical = `${SITE_URL}/resale-condition-report`;
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${canonical}#dataset`,
    name: "The State of Resale Condition — GradeThread Data Report",
    description:
      "Proprietary, platform-wide statistics on how a pre-owned garment's condition grade relates to real-world resale outcomes: buyer return rate by grade band, sell-through rate by grade band, and median resale price by grade band, on the standardized GradeThread 1.0–10.0 condition scale. Aggregate-only (no per-seller or per-item data) and sample-gated; refreshed continuously as new sales and listings are recorded. The page states the exact sample size and coverage window.",
    url: canonical,
    creator: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    isAccessibleForFree: true,
    license: "https://creativecommons.org/licenses/by/4.0/",
    datePublished: opts.datePublished,
    dateModified: opts.dateModified,
    temporalCoverage: opts.temporalCoverage,
    measurementTechnique:
      "Platform-wide aggregation of reseller sales and listings (the items_full fact view) bucketed by GradeThread condition-grade band. Return rate = refunded fulfilled sales / fulfilled sales; sell-through = sold listings / listed items; resale value = median sold price; each rate published only when its band clears a minimum sample size.",
    variableMeasured: [
      "Buyer return rate by condition-grade band",
      "Sell-through rate by condition-grade band",
      "Median resale price by condition-grade band",
      "Median days to sell by condition-grade band",
      "Resale value premium of the highest vs. lowest condition band",
      "Graded vs. ungraded buyer return rate",
      "Resale value range by condition-grade band, by brand and category (Condition Index price guide)",
    ],
    keywords: [
      "pre-owned clothing resale",
      "condition grading",
      "return rate by condition",
      "sell-through by condition",
      "resale value by condition",
      "resale price guide",
    ],
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: "https://functions.gradethread.com/api/grading/public/resale-condition-report",
      },
      {
        // US-1285: the queryable Resale Condition Index price-guide API — value
        // range + sell-through by grade band, per brand/category. Scoped behind
        // an API key (Business plan); a free deterministic sandbox mirrors it.
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: "https://functions.gradethread.com/api/v1/price-guide",
      },
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

/**
 * Person node for a blog author entity (US-874). E-E-A-T: a named author with a
 * profile page, jobTitle, sameAs, and credentials carries far more weight than a
 * byline string. The canonical implementation that the blog/author SSR uses is
 * authorPersonLd() in functions/_shared/blog-render.ts; this typed builder
 * mirrors it for any SPA-side surface that needs the same node. Omits empty
 * optional fields so we never assert a blank jobTitle / image / sameAs.
 */
export function personLd(opts: {
  name: string;
  slug: string;
  title?: string | null;
  avatarUrl?: string | null;
  sameAs?: string[];
  credentials?: string[];
}): JsonLd {
  const node: JsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: opts.name,
    url: `${SITE_URL}/authors/${opts.slug}`,
  };
  if (opts.title?.trim()) node.jobTitle = opts.title.trim();
  if (opts.avatarUrl?.trim()) node.image = opts.avatarUrl.trim();
  const sameAs = (opts.sameAs ?? [])
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u));
  if (sameAs.length) node.sameAs = sameAs;
  const knows = (opts.credentials ?? []).map((c) => c.trim()).filter(Boolean);
  if (knows.length) node.knowsAbout = knows;
  return node;
}

/** ProfilePage node wrapping a Person, emitted on the author page itself (US-874). */
export function profilePageLd(opts: Parameters<typeof personLd>[0]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url: `${SITE_URL}/authors/${opts.slug}`,
    mainEntity: personLd(opts),
  };
}

// ── Condition glossary: DefinedTerm / DefinedTermSet (US-973) ────────
// schema.org DefinedTerm makes each condition abbreviation (NWT, NWOT, …) and
// grading factor machine-extractable as a *term*, and the DefinedTermSet groups
// them into the one canonical glossary AI answer-engines can cite — so
// GradeThread reads as the structured source behind "nwt vs nwot meaning"-style
// queries. Every DefinedTerm references the set via inDefinedTermSet (the set's
// @id), so a term never dangles outside its set even on a page that only emits
// the single term (the glossary spoke).

/** Stable @id for the condition-glossary DefinedTermSet (the /condition-grading hub). */
export const CONDITION_GLOSSARY_SET_ID = `${SITE_URL}/#condition-glossary`;

export interface DefinedTermInput {
  /** Display term, e.g. "NWT" or "Fabric Condition". */
  term: string;
  /** Full expansion, e.g. "New With Tags" (tiers that have one). */
  expansion?: string;
  /** Answer-first definition. */
  definition: string;
  /** Absolute path of the term's page, e.g. "/grading/nwt". */
  path: string;
}

/**
 * A bare DefinedTerm node (no @context) for nesting inside a DefinedTermSet's
 * hasDefinedTerm. inDefinedTermSet carries the set's @id URL (not an @id graph
 * ref) so the term resolves whether or not the set node is on the same page.
 */
function definedTermNode(entry: DefinedTermInput): Record<string, unknown> {
  return {
    "@type": "DefinedTerm",
    name: entry.term,
    ...(entry.expansion ? { alternateName: entry.expansion } : {}),
    description: entry.definition,
    url: `${SITE_URL}${entry.path}`,
    inDefinedTermSet: CONDITION_GLOSSARY_SET_ID,
  };
}

/**
 * DefinedTerm for a single glossary entry (US-973), emitted on its
 * /grading/:slug page. ALWAYS links back to the hub DefinedTermSet via
 * inDefinedTermSet — never emit a DefinedTerm without it.
 */
export function definedTermLd(entry: DefinedTermInput): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: entry.term,
    ...(entry.expansion ? { alternateName: entry.expansion } : {}),
    description: entry.definition,
    url: `${SITE_URL}${entry.path}`,
    inDefinedTermSet: CONDITION_GLOSSARY_SET_ID,
  };
}

/**
 * DefinedTermSet for the condition glossary (US-973), emitted on the
 * /condition-grading hub. hasDefinedTerm lists every glossary term so the whole
 * vocabulary is extractable as one canonical, named set.
 */
export function definedTermSetLd(
  entries: ReadonlyArray<DefinedTermInput>,
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": CONDITION_GLOSSARY_SET_ID,
    name: "GradeThread Clothing Condition Grading Glossary",
    description:
      "The canonical glossary of pre-owned clothing condition terms: the grade tiers (NWT, NWOT, Excellent, Very Good, Good, Fair, Poor) on the standardized 1.0–10.0 scale and the five weighted grading factors GradeThread assesses.",
    url: `${SITE_URL}/condition-grading`,
    hasDefinedTerm: entries.map(definedTermNode),
  };
}

// ── Reseller condition-vocabulary glossary DefinedTermSet (US-1671) ──
// A THIRD named set, distinct from the vocabulary-hub set (/condition-grading)
// and the grade-scale set (/grading/scale): the reseller-lingo glossary
// (/grading/glossary — EUC, VGUC, death pile, comps, SNAD…). Its own @id so AI
// answer engines can cite the whole reseller vocabulary as one canonical set.
export const RESELLER_GLOSSARY_SET_ID = `${SITE_URL}/grading/glossary#glossary`;

export interface ResellerDefinedTermInput {
  term: string;
  alternateNames?: string[];
  definition: string;
  /** Absolute path of the term page, e.g. "/grading/glossary/euc". */
  path: string;
}

function resellerDefinedTermNode(
  e: ResellerDefinedTermInput,
): Record<string, unknown> {
  return {
    "@type": "DefinedTerm",
    name: e.term,
    ...(e.alternateNames && e.alternateNames.length
      ? { alternateName: e.alternateNames.length === 1 ? e.alternateNames[0] : e.alternateNames }
      : {}),
    description: e.definition,
    url: `${SITE_URL}${e.path}`,
    inDefinedTermSet: RESELLER_GLOSSARY_SET_ID,
  };
}

/** DefinedTerm for a single reseller-glossary term page (US-1671). */
export function resellerDefinedTermLd(e: ResellerDefinedTermInput): JsonLd {
  return { "@context": "https://schema.org", ...resellerDefinedTermNode(e) } as JsonLd;
}

/** DefinedTermSet for the reseller glossary hub (US-1671). */
export function resellerGlossarySetLd(
  entries: ReadonlyArray<ResellerDefinedTermInput>,
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": RESELLER_GLOSSARY_SET_ID,
    name: "GradeThread Reseller Condition Glossary",
    description:
      "The reseller's glossary of pre-owned clothing condition vocabulary — condition abbreviations (EUC, VGUC, GUC, NWT, NWOT), selling-workflow terms, and marketplace lingo, each mapped to the standardized GradeThread 1.0–10.0 grade scale.",
    url: `${SITE_URL}/grading/glossary`,
    hasDefinedTerm: entries.map(resellerDefinedTermNode),
  };
}

// ── Flaw library DefinedTermSet (US-1683) ───────────────────────────
// The clothing-flaw vocabulary (pilling, moth holes, crocking…) as one named,
// citable set, anchored on the /grading/flaws hub. Each flaw page emits its own
// DefinedTerm (linked here) alongside an Article.
export const FLAW_LIBRARY_SET_ID = `${SITE_URL}/grading/flaws#flaws`;

/** DefinedTerm for a single flaw page, linked to the flaw-library set. */
export function flawDefinedTermLd(e: ResellerDefinedTermInput): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: e.term,
    ...(e.alternateNames && e.alternateNames.length
      ? { alternateName: e.alternateNames.length === 1 ? e.alternateNames[0] : e.alternateNames }
      : {}),
    description: e.definition,
    url: `${SITE_URL}${e.path}`,
    inDefinedTermSet: FLAW_LIBRARY_SET_ID,
  } as JsonLd;
}

/** DefinedTermSet for the flaw-library hub. */
export function flawLibrarySetLd(
  entries: ReadonlyArray<ResellerDefinedTermInput>,
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": FLAW_LIBRARY_SET_ID,
    name: "GradeThread Clothing Flaw Library",
    description:
      "The vocabulary of clothing flaws GradeThread's condition grading detects — pilling, moth holes, sun fading, pit stains, crocking, seam stress and more — each with how it affects the 1.0–10.0 condition grade.",
    url: `${SITE_URL}/grading/flaws`,
    hasDefinedTerm: entries.map((e) => ({
      "@type": "DefinedTerm",
      name: e.term,
      ...(e.alternateNames && e.alternateNames.length
        ? { alternateName: e.alternateNames.length === 1 ? e.alternateNames[0] : e.alternateNames }
        : {}),
      description: e.definition,
      url: `${SITE_URL}${e.path}`,
      inDefinedTermSet: FLAW_LIBRARY_SET_ID,
    })),
  };
}

// ── The named Grading Scale: its own DefinedTermSet (US-1664) ────────
// Stable @id for the canonical scale set, anchored on the /grading/scale pillar.
// Distinct from the /condition-grading vocabulary glossary set above: this set IS
// the published 1.0–10.0 standard (the seven grade bands), the schema-level
// statement that GradeThread publishes the scale everyone else references.
export const GRADE_SCALE_SET_ID = `${SITE_URL}/grading/scale#scale`;

/**
 * DefinedTermSet for the GradeThread Clothing Condition Grading Scale (US-1664),
 * emitted on /grading/scale. hasDefinedTerm lists each grade band as a
 * DefinedTerm (name = the band label, description = its meaning + numeric anchor,
 * url = its /grading/<slug> spoke), so the whole scale is extractable as one
 * canonical, named, AI-citable standard.
 */
export function gradeScaleDefinedTermSetLd(
  entries: ReadonlyArray<DefinedTermInput>,
): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "DefinedTermSet",
    "@id": GRADE_SCALE_SET_ID,
    name: "The GradeThread Clothing Condition Grading Scale",
    alternateName: "The GradeThread Scale",
    description:
      "The canonical 1.0–10.0 standard for grading the condition of pre-owned clothing: seven named tiers (NWT, NWOT, Excellent, Very Good, Good, Fair, Poor) scored across five weighted factors, published by GradeThread.",
    url: `${SITE_URL}/grading/scale`,
    hasDefinedTerm: entries.map((entry) => ({
      "@type": "DefinedTerm",
      name: entry.term,
      ...(entry.expansion ? { alternateName: entry.expansion } : {}),
      description: entry.definition,
      url: `${SITE_URL}${entry.path}`,
      inDefinedTermSet: GRADE_SCALE_SET_ID,
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

/**
 * AboutPage node for the company/about page (US-868). Models the page as an
 * AboutPage whose `mainEntity` is the GradeThread Organization (referenced by
 * @id — MarketingLayout already emits the Organization node, so the graph
 * resolves), giving search and AI answer engines an explicit, machine-readable
 * authority surface for the entity. Deterministic (no dates) so the prerendered
 * head and the live SPA emit byte-identical structured data.
 */
export function aboutPageLd(url: string): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "AboutPage",
    "@id": `${url}#aboutpage`,
    url,
    name: "About GradeThread",
    description:
      "About GradeThread and Pearson Media LLC: the mission to make pre-owned clothing condition objective and verifiable, the published grading methodology behind every grade, and the team standardizing condition grading.",
    mainEntity: { "@id": ORG_ID },
    publisher: { "@id": ORG_ID },
    isAccessibleForFree: true,
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
/**
 * schema.org OfferItemCondition for a 1.0–10.0 GradeThread grade (US-1665). The
 * NWT/NWOT bands (≥ 9) read as new; the Poor band (< 4) as damaged; everything
 * between as used — so the exact grade maps into the web's shared condition
 * vocabulary. Mirrored byte-for-byte by the SSR certificateProductLd().
 */
export function offerItemConditionForScore(score: number): string {
  if (score >= 9) return "https://schema.org/NewCondition";
  if (score < 4) return "https://schema.org/DamagedCondition";
  return "https://schema.org/UsedCondition";
}

/**
 * The GradeThread grade as a schema.org PropertyValue (US-1665) — the
 * proprietary 1.0–10.0 grade expressed in shared vocabulary, so search engines
 * and LLM crawlers ingest the exact number as structured fact. propertyID + name
 * match the published open grade-field spec (src/lib/grade-standard.ts). Mirrored
 * byte-for-byte by the SSR certificateProductLd().
 */
export function gradePropertyValueLd(
  score: number,
  tier: string,
): Record<string, unknown> {
  return {
    "@type": "PropertyValue",
    propertyID: "https://gradethread.com/grading-standard#grade",
    name: "GradeThread Grade",
    value: Number(score.toFixed(1)),
    minValue: 1,
    maxValue: 10,
    alternateName: tier,
  };
}

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
    // US-1665: itemCondition mapped from the grade band; additionalProperty puts
    // the exact GradeThread grade into the web's shared vocabulary.
    itemCondition: offerItemConditionForScore(cert.overallScore),
    additionalProperty: gradePropertyValueLd(cert.overallScore, cert.gradeTier),
    review: {
      "@type": "Review",
      // US-425: score formatted to one decimal so the SPA and the cert SSR
      // Pages Function (functions/cert/[id].ts) emit a byte-identical Review
      // name — see the SSR/SPA equivalence test in json-ld.test.ts.
      name: `Condition grade: ${cert.gradeTier} (${cert.overallScore.toFixed(1)}/10)`,
      reviewRating: {
        "@type": "Rating",
        // US-1464: normalize to one decimal so float noise never leaks into the
        // rating value (kept byte-identical with the SSR certificateProductLd).
        ratingValue: Number(cert.overallScore.toFixed(1)),
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

// US-1093: Garment Passport public timeline (/passport/:slug). The passport
// centers on a single physical garment with an append-only provenance history,
// so it markup as a Product (the garment) carrying its latest condition grade
// as an expert Review — the AI-citable, buyer-trust signal. PII-free: the
// timeline's pseudonymous actors are NOT part of the markup (they're not a
// schema.org entity and would add no machine value). Mirrored byte-for-byte by
// the SSR Pages Function via passportProductLd() in functions/_shared (an
// equivalence test pins them equal so crawler markup can't drift).
export function passportLd(opts: {
  slug: string;
  name: string;
  category?: string | null;
  brand?: string | null;
  latestGrade?: { score: number; tier: string; datePublished?: string | null } | null;
}): JsonLd {
  const canonical = `${SITE_URL}/passport/${opts.slug}`;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": canonical,
    name: opts.name,
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.brand ? { brand: { "@type": "Brand", name: opts.brand } } : {}),
    itemCondition: "https://schema.org/UsedCondition",
    ...(opts.latestGrade
      ? {
          review: {
            "@type": "Review",
            name: `Condition grade: ${opts.latestGrade.tier} (${opts.latestGrade.score.toFixed(1)}/10)`,
            reviewRating: {
              "@type": "Rating",
              ratingValue: opts.latestGrade.score,
              bestRating: 10,
              worstRating: 1,
              alternateName: opts.latestGrade.tier,
            },
            author: { "@type": "Organization", name: "GradeThread", url: SITE_URL },
            ...(opts.latestGrade.datePublished
              ? { datePublished: opts.latestGrade.datePublished }
              : {}),
          },
        }
      : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
  };
}

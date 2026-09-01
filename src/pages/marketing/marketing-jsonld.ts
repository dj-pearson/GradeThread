// Page-specific JSON-LD + the FAQ/step data behind it, in a non-component module
// so (a) the marketing page .tsx files stay components-only (react-refresh lint)
// and (b) the prerender head-builder (US-292) imports the SAME builders the live
// pages use — guaranteeing the prerendered <head> and the runtime SPA emit
// identical structured data.

import {
  howToLd,
  faqPageLd,
  articleLd,
  aboutPageLd,
  breadcrumbLd,
  transparencyDatasetLd,
  resaleConditionDatasetLd,
  definedTermLd,
  definedTermSetLd,
  gradeScaleDefinedTermSetLd,
  resellerDefinedTermLd,
  resellerGlossarySetLd,
  flawDefinedTermLd,
  flawLibrarySetLd,
  videoObjectLd,
  type JsonLd,
} from "@/lib/seo/json-ld";
import {
  FLAW_ENTRIES,
  FLAW_LIBRARY_HUB_PATH,
  flawPath,
  getFlawBySlug,
  flawTrail,
  type FlawEntry,
} from "@/lib/seo/flaw-library";
import { matrixPath, type MatrixEntry } from "@/lib/seo/care-matrix";
import {
  GARMENT_GUIDES_HUB_PATH,
  guidePath,
  guideTrail,
  type GarmentGuide,
} from "@/lib/seo/garment-guides";
import {
  publishedShort,
  shortTitle,
  shortDescription,
  shortTranscript,
  shortDurationIso,
  shortEmbedUrl,
  shortWatchUrl,
  shortThumbnailUrl,
} from "@/lib/seo/grading-videos";
import { scaleDefinedTerms } from "@/lib/seo/grading-scale";
import {
  RESELLER_TERMS,
  RESELLER_GLOSSARY_HUB_PATH,
  resellerTermPath,
  resellerTermTrail,
  type ResellerTerm,
} from "@/lib/seo/reseller-glossary";
import { FLIPDESK_PLANS } from "@/lib/constants";
import type { FlipdeskLanding } from "@/lib/seo/flipdesk-landing";
import {
  RESELLING_PILLAR,
  RESELLING_PILLAR_PATH,
  resellingGuidePath,
  type ResellingGuide,
} from "@/lib/seo/reselling-guides";
import {
  COMPARE_HUB_PATH,
  COMPARISONS,
  comparePath,
  type Comparison,
} from "@/lib/seo/comparison-guides";
import { type OpportunistGuide } from "@/lib/seo/opportunist-guides";
import { RETURNS_SPINE, RETURNS_SPINE_PATH } from "@/lib/seo/returns-spine";
import {
  PLATFORM_STANDARDS,
  PLATFORM_STANDARDS_HUB_PATH,
  platformStandardPath,
  type PlatformStandard,
} from "@/lib/seo/platform-standards";
import {
  WHERE_TO_SELL,
  WHERE_TO_SELL_PATH,
  SELLING_VENUES,
} from "@/lib/seo/where-to-sell";
import {
  CROSSLIST_APPS,
  CROSSLIST_APPS_PAGE,
  CROSSLIST_APPS_PATH,
} from "@/lib/seo/crosslisting-apps";
import {
  alternativePath,
  type CompetitorAlternative,
} from "@/lib/seo/competitor-alternatives";
import { CONDITION_CHART_META, CONDITION_CHART_PATH } from "@/lib/seo/condition-chart";
import { GRADE_CHECKER_META, GRADE_CHECKER_PATH } from "@/lib/seo/grade-checker";
import {
  CALCULATOR_HUB_META,
  CALCULATOR_HUB_PATH,
  calculatorContent,
  calculatorPath,
  liveCalculators,
  type Calculator,
} from "@/lib/seo/calculators";
import {
  AUTHENTICITY_CHECK_META,
  AUTHENTICITY_CHECK_PATH,
} from "@/lib/seo/authenticity-check";
import { FIT_CHECKER_META, FIT_CHECKER_PATH } from "@/lib/seo/fit-checker";
import { RN_LOOKUP_META, RN_LOOKUP_PATH } from "@/lib/seo/rn-lookup";
import { absoluteUrl } from "@/lib/seo/site";
import { switchFromPath, type SwitchFromPage } from "@/lib/seo/switch-from";
import { LANDING_FAQS } from "@/pages/landing-faqs";
import { SITE_URL } from "@/lib/seo/site";
// US-2103: the canonical entity ids, so brand nodes here MERGE with the
// site-wide Organization/WebSite instead of minting anonymous duplicates.
import { ORG_ID, WEBSITE_ID } from "@/lib/seo/json-ld";
import { FOR_BRANDS_META } from "@/lib/seo/for-brands";
import {
  glossaryTrail,
  GLOSSARY_ENTRIES,
  type GlossaryEntry,
} from "@/lib/seo/glossary";
import { gradeStandardSpecJsonLd } from "@/lib/grade-standard";

// ── /how-it-works ──────────────────────────────────────────────────
export const HOW_IT_WORKS_STEPS = [
  {
    name: "Upload garment photos",
    text: "Photograph the item front, back, and label, plus at least one detail shot. Clear, well-lit photos on a plain background give the most accurate grade.",
  },
  {
    name: "AI analyzes 5 weighted factors",
    text: "Claude Vision inspects fabric condition, structural integrity, cosmetic appearance, functional elements, and odor & cleanliness, then combines them into one standardized 1.0–10.0 score.",
  },
  {
    name: "Get your grade and report",
    text: "Within minutes you receive an overall condition grade, a tier label (NWT through Poor), a factor-by-factor breakdown, and a written summary explaining the result.",
  },
  {
    name: "Share a verified certificate",
    text: "Every grade gets a public certificate with a unique URL and QR code that buyers can scan to verify condition — building trust and reducing returns.",
  },
];

const HOW_IT_WORKS_FAQS = [
  {
    q: "How long does grading take?",
    a: "Most grades complete within minutes. Premium and Express tiers carry faster service-level targets when you need a guaranteed turnaround.",
  },
  {
    q: "What photos do I need?",
    a: "Front, back, and label are required, plus at least one detail shot. You can add up to three extra defect close-ups to document specific flaws.",
  },
];

export function howItWorksJsonLd(): JsonLd[] {
  return [
    howToLd({
      name: "How to grade pre-owned clothing with GradeThread",
      description:
        "Upload garment photos and receive a standardized 1.0–10.0 AI condition grade, a detailed report, and a shareable verification certificate.",
      steps: HOW_IT_WORKS_STEPS,
    }),
    faqPageLd(HOW_IT_WORKS_FAQS),
  ];
}

// ── /pricing ───────────────────────────────────────────────────────
export const PRICING_FAQS = [
  {
    q: "Is there a free plan?",
    a: "Yes. The Free plan includes 3 Standard grades every month at no cost, plus a 14-day Pro trial on signup with no card required.",
  },
  {
    q: "Do credits expire?",
    a: "No. Credits you buy in a pack stay in your account until you use them — no monthly minimum, no auto-debit, no expiry.",
  },
  {
    q: "What's the difference between per-grade tiers?",
    a: "Standard, Premium, and Express differ by turnaround time (service-level target) and credit cost. The grade itself is produced the same way; faster tiers are prioritized.",
  },
  {
    q: "Can I cancel or pause a FlipDesk subscription?",
    a: "Yes. You can cancel anytime, and you can pause a paid plan for up to 3 months while keeping your data and credits; your caps fall back to Free while paused.",
  },
];

/**
 * US-2105 AC4: Product + Offer on the actual commercial page.
 *
 * Product markup existed only on cert/passport/value SSR — i.e. everywhere
 * EXCEPT the page where someone decides to buy. /pricing shipped FAQPage alone,
 * so a search engine had no structured statement of what is sold or what it
 * costs.
 *
 * Every figure is derived from FLIPDESK_PLANS, the single source of truth the
 * page itself renders from. Hardcoding prices here would create a second place
 * for them to live and a silent way for search results to advertise a price we
 * no longer charge — the US-2123 defect (advertised ≠ granted) in a surface we
 * do not control the cache of.
 *
 * The free plan is deliberately excluded: an Offer at price 0 competes with the
 * paid tiers in rich results for no commercial gain.
 */
export function pricingOfferLd(): JsonLd {
  const paid = (Object.keys(FLIPDESK_PLANS) as Array<keyof typeof FLIPDESK_PLANS>)
    .map((k) => FLIPDESK_PLANS[k])
    .filter((p) => p.priceMonthlyCents > 0);

  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "GradeThread",
    description:
      "AI-powered condition grading for pre-owned clothing: an objective " +
      "1.0–10.0 grade, a condition report, and a shareable verification " +
      "certificate — plus FlipDesk, the full reseller workflow, which works " +
      "with eBay.",
    brand: { "@type": "Brand", name: "GradeThread" },
    // Required by the US-1681 schema lint (Google's Product requirements). A
    // subscription is always sold new; there is no used-license market.
    itemCondition: "https://schema.org/NewCondition",
    offers: paid.map((p) => ({
      "@type": "Offer",
      name: `${p.name} (monthly)`,
      price: (p.priceMonthlyCents / 100).toFixed(2),
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: `${SITE_URL}/pricing`,
      // Recurring subscription, so the unit has to be stated or the price reads
      // as one-off.
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: (p.priceMonthlyCents / 100).toFixed(2),
        priceCurrency: "USD",
        billingIncrement: 1,
        unitCode: "MON",
      },
    })),
  } as JsonLd;
}

export function pricingJsonLd(): JsonLd[] {
  return [pricingOfferLd(), faqPageLd(PRICING_FAQS)];
}

// ── /faq ───────────────────────────────────────────────────────────
const FAQ_EXTRA = [
  {
    q: "What does the 1.0–10.0 grade mean?",
    a: "The scale runs from 1.0 (salvage/parts only) to 10.0 (new with tags). It maps to seven named tiers — NWT, NWOT, Excellent, Very Good, Good, Fair, and Poor — so condition is comparable across every item and seller.",
  },
  {
    q: "How accurate is AI grading?",
    a: "Each grade includes a confidence score. When confidence is below our threshold, the submission is routed for human review before the grade is finalized, so low-confidence cases don't ship a questionable result.",
  },
  {
    q: "Can buyers verify a certificate?",
    a: "Yes. Every certificate has a unique public URL and QR code. Anyone can open it to see the overall score, tier, factor breakdown, and garment photos — no account required.",
  },
  {
    q: "Why do I have to manage my eBay listings in FlipDesk?",
    a: "Once you publish an item to eBay through FlipDesk, FlipDesk is the source of truth for that listing. FlipDesk syncs with eBay through the eBay API, so changes you make directly on eBay — editing photos, price, the title or item specifics, or ending and relisting — can be overwritten on the next sync or leave the two sides out of step. To avoid that, make every change in FlipDesk (Pipeline → the item) and let it push the update to eBay. Use eBay directly only for things FlipDesk doesn't manage, like answering buyer messages.",
  },
];

export const ALL_FAQS = [...LANDING_FAQS, ...FAQ_EXTRA];

export function faqJsonLd(): JsonLd[] {
  return [faqPageLd(ALL_FAQS)];
}

// ── /condition-grading ─────────────────────────────────────────────
export const CONDITION_GRADING_FAQS = [
  {
    q: "What is clothing condition grading?",
    a: "Condition grading assigns a standardized score to a pre-owned garment based on its wear, damage, and overall state — so 'Excellent' or '8/10' means the same thing regardless of who is selling.",
  },
  {
    q: "What does NWOT mean?",
    a: "NWOT stands for 'New Without Tags' — an item that is new and unworn but no longer has its original retail tags. It anchors a 9 on the GradeThread 1.0–10.0 scale.",
  },
  {
    q: "How is the overall grade calculated?",
    a: "The overall grade is a weighted blend of five factors: Fabric Condition (30%), Structural Integrity (25%), Cosmetic Appearance (20%), Functional Elements (15%), and Odor & Cleanliness (10%).",
  },
];

export function conditionGradingJsonLd(): JsonLd[] {
  // The /condition-grading hub emits the DefinedTermSet (US-973) listing every
  // glossary term, so the whole condition vocabulary is one machine-extractable,
  // citable set. Each glossary spoke emits its own DefinedTerm pointing back here.
  return [definedTermSetLd(GLOSSARY_ENTRIES), faqPageLd(CONDITION_GRADING_FAQS)];
}

// ── /grading-standard ──────────────────────────────────────────────
// The methodology pillar that substantiates the "the standard" positioning:
// a published, objective rubric rather than a subjective eyeball judgement.
export const GRADING_STANDARD_FAQS = [
  {
    q: "What makes GradeThread a grading standard rather than an opinion?",
    a: "Every item is scored against one published rubric: five weighted factors combined into a single 1.0–10.0 grade mapped to seven named tiers. Because the factors and weights are fixed and disclosed, two different items in the same condition receive the same grade — the defining property of a standard.",
  },
  {
    q: "How is the overall grade calculated?",
    a: "The grade is a weighted blend of five factors — Fabric Condition (30%), Structural Integrity (25%), Cosmetic Appearance (20%), Functional Elements (15%), and Odor & Cleanliness (10%) — expressed on a 1.0–10.0 scale in half-point increments so graders can place an item precisely between tiers.",
  },
  {
    q: "How does GradeThread keep grades consistent and objective?",
    a: "The same rubric and weights are applied to every submission, and each grade carries a confidence score. When confidence falls below our threshold, the submission is routed for human review before the grade is finalized, so low-confidence cases never ship an unchecked result.",
  },
  {
    q: "Is a GradeThread grade verifiable by buyers?",
    a: "Yes. Every grade produces a public certificate with a unique URL and QR code showing the overall score, tier, factor-by-factor breakdown, and garment photos — so a buyer can independently confirm the condition against the standard, no account required.",
  },
  {
    q: "Can other platforms or partners use the GradeThread Grade field?",
    a: "Yes. The GradeThread Grade is published as an open, versioned specification: a machine-readable field expressed as a schema.org PropertyValue (additionalProperty), documented on this page and as a stable JSON Schema at /grade-standard.schema.json under a CC BY 4.0 license. Anyone can read and implement it to carry a grade in a listing or ingest it from one. It describes the open standard only — we make no claim that any third party has adopted it.",
  },
];

export function gradingStandardJsonLd(): JsonLd[] {
  // US-1284: publish the open grade-field spec (a TechArticle linking the JSON
  // Schema + a worked PropertyValue example) alongside the FAQ, so the
  // "GradeThread Grade" field is discoverable + citable from this page's
  // structured data.
  return [gradeStandardSpecJsonLd(), faqPageLd(GRADING_STANDARD_FAQS)];
}

// ── /grading/scale (US-1664, SEO 2.0 keystone) ──────────────────────
// The named standard itself: the DefinedTermSet that declares the GradeThread
// 1.0–10.0 scale (each grade band a DefinedTerm), plus a question-phrased FAQ for
// snippet + AI-citation extraction. The DefinedTerms are sourced from the
// canonical scale data, so the structured data mirrors the visible table.
export const GRADING_SCALE_FAQS = [
  {
    q: "What is the clothing condition grading scale?",
    a: "The GradeThread Scale is a standardized 1.0–10.0 system for grading the condition of pre-owned clothing. Every garment is scored across five weighted factors — fabric condition, structural integrity, cosmetic appearance, functional elements, and odor & cleanliness — and mapped to one of seven named tiers, from New With Tags (10) down to Poor (3–4). Because the rubric is fixed and published, a grade means the same thing on every item, for every seller and buyer.",
  },
  {
    q: "What do the clothing grades from 1 to 10 mean?",
    a: "10 is New With Tags (NWT) and 9 is New Without Tags (NWOT) — both unworn. 8 is Excellent (gently used, no notable flaws), 7 is Very Good (light, even wear), and 6 is Good (visible but minor wear). 5 is Fair (a documented flaw that affects appearance), and 3–4 is Poor (significant damage, sold as-is). Each whole number anchors a named tier, and half-point grades place an item precisely between them.",
  },
  {
    q: "How does the GradeThread scale map to eBay and Poshmark conditions?",
    a: "The scale is finer-grained than a marketplace dropdown, and it maps cleanly onto their vocabulary: 10/9 are eBay’s “New with tags” / “New without tags”; 8 corresponds to Excellent Used Condition (EUC); 7 to Very Good Used Condition (VGUC); 6 to Good Used Condition (GUC); 5 to a pre-owned listing with disclosed flaws; and 3–4 to “For parts or not working” or a distressed/for-repair listing. The grade gives buyers the resolution a three-option dropdown can’t.",
  },
  {
    q: "Is there a printable clothing condition grade chart?",
    a: "Yes. GradeThread publishes a free, printable one-page chart of the full 1.0–10.0 condition scale — every grade band with its label, criteria, typical flaws, and marketplace equivalent — that resellers can keep at their sorting station or share. It carries the GradeThread name and is free to download and print.",
  },
];

export function gradingScaleJsonLd(): JsonLd[] {
  return [
    gradeScaleDefinedTermSetLd(scaleDefinedTerms()),
    faqPageLd(GRADING_SCALE_FAQS),
  ];
}

// ── /grading/glossary + /grading/glossary/{term} (US-1671) ──────────
// The reseller condition-vocabulary glossary. The hub emits the DefinedTermSet
// (every term) + a hub FAQ; each term page emits its own DefinedTerm (linked to
// the set) + the term's FAQ. Breadcrumb + Organization are emitted by the layout
// / head-builder (once), matching the glossary-spoke pattern.

/** Absolute breadcrumb items for a reseller-glossary term page (3-level). */
export function resellerTermBreadcrumbItems(
  term: ResellerTerm,
): Array<{ name: string; url: string }> {
  return resellerTermTrail(term).map((t) => ({
    name: t.name,
    url: t.path === "/" ? `${SITE_URL}/` : `${SITE_URL}${t.path}`,
  }));
}

/** Page JSON-LD for a single reseller-glossary term (DefinedTerm + FAQPage). */
export function resellerTermJsonLd(term: ResellerTerm): JsonLd[] {
  return [
    resellerDefinedTermLd({
      term: term.term,
      alternateNames: term.alternateNames,
      definition: term.definition,
      path: resellerTermPath(term.slug),
    }),
    faqPageLd(term.faqs),
  ];
}

export const RESELLER_GLOSSARY_HUB_FAQS = [
  {
    q: "What do the clothing condition abbreviations mean?",
    a: "Resellers use shorthand for condition: NWT (New With Tags), NWOT (New Without Tags), EUC (Excellent Used Condition), VGUC (Very Good Used Condition), and GUC (Good Used Condition). GradeThread maps each to a point on the standardized 1.0–10.0 condition scale, so a grade means the same thing across every seller and marketplace.",
  },
  {
    q: "Why does a condition glossary matter for reselling?",
    a: "Vague or inconsistent condition words are the top cause of 'not as described' returns. A shared vocabulary — and a standardized 1.0–10.0 grade behind it — lets buyers trust the listing and lets sellers price accurately, whether they're on eBay, Poshmark, Mercari, or Depop.",
  },
];

/** Hub JSON-LD (the full DefinedTermSet + hub FAQPage). */
export function resellerGlossaryHubJsonLd(): JsonLd[] {
  return [
    resellerGlossarySetLd(
      RESELLER_TERMS.map((t) => ({
        term: t.term,
        alternateNames: t.alternateNames,
        definition: t.definition,
        path: resellerTermPath(t.slug),
      })),
    ),
    faqPageLd(RESELLER_GLOSSARY_HUB_FAQS),
  ];
}

/** Breadcrumb items for the hub (2-level: GradeThread → Condition glossary). */
export function resellerGlossaryHubBreadcrumbItems(): Array<{
  name: string;
  url: string;
}> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Condition glossary", url: `${SITE_URL}${RESELLER_GLOSSARY_HUB_PATH}` },
  ];
}

// ── /flipdesk/* landing pages (US-1675 money + US-1676 feature) ─────
// Each emits a SoftwareApplication (its own @id, applicationCategory
// BusinessApplication, offers = the real FlipDesk price range; NO aggregateRating
// — we have no real reviews) + an FAQPage + a 3-level breadcrumb.

/** Absolute breadcrumb items for a FlipDesk landing page (GradeThread → FlipDesk → page). */
export function flipdeskLandingBreadcrumbItems(
  landing: FlipdeskLanding,
): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "FlipDesk", url: `${SITE_URL}/flipdesk` },
    { name: landing.h1, url: `${SITE_URL}${landing.path}` },
  ];
}

/** SoftwareApplication offers range, derived from the real FLIPDESK_PLANS tiers. */
function flipdeskOffers(): Record<string, unknown> {
  const prices = Object.values(FLIPDESK_PLANS).map(
    (p) => p.priceMonthlyCents / 100,
  );
  return {
    "@type": "AggregateOffer",
    priceCurrency: "USD",
    lowPrice: String(Math.min(...prices)),
    highPrice: String(Math.max(...prices)),
    offerCount: prices.length,
  };
}

export function flipdeskLandingJsonLd(landing: FlipdeskLanding): JsonLd[] {
  const url = absoluteUrl(landing.path);
  const app: JsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${url}#software`,
    name: landing.appName,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url,
    description: landing.appDescription,
    isPartOf: { "@type": "WebSite", "@id": WEBSITE_ID, name: "GradeThread", url: `${SITE_URL}/` },
    publisher: { "@id": ORG_ID },
    featureList: landing.featureList,
    offers: flipdeskOffers(),
  };
  // NB: the BreadcrumbList is emitted ONCE by MarketingLayout (live) / head-builder
  // (prerender) via flipdeskLandingBreadcrumbItems() — not here — to avoid a
  // double breadcrumb (US-423 pattern).
  return [app, faqPageLd(landing.faqs)];
}

// ── /grading/graded-clothing-meaning + /grading/vs-authentication (US-1684) ──
// Disambiguation pages. Article + FAQPage, fixed dates (prerender == SPA).
const DISAMBIG_PUBLISHED = "2026-07-06";
const DISAMBIG_MODIFIED = "2026-07-06";

export const GRADED_CLOTHING_FAQS = [
  {
    q: "What does 'graded clothing' mean?",
    a: "'Graded clothing' has two different meanings. In the wholesale secondhand trade it means bulk used clothing sorted into Grade A, B, or C bales by overall quality and resaleability. In resale, it increasingly means a single garment given a per-item condition grade — like GradeThread's standardized 1.0–10.0 grade with a verifiable certificate. They are not the same thing.",
  },
  {
    q: "What are Grade A, B, and C clothing?",
    a: "Grade A/B/C are wholesale bale grades: Grade A is the best, most resaleable used clothing; Grade B has more wear or minor flaws; Grade C is lower quality, often destined for reuse markets or recycling. They describe an entire bale's average quality, not any one item's condition — which is what a per-item condition grade measures.",
  },
  {
    q: "Is a per-item condition grade better than a bale grade?",
    a: "They answer different questions. A bale grade rates a bulk lot for wholesale buyers; a per-item condition grade rates one specific garment for a retail buyer. If you're selling individual pieces online, a per-item condition grade and certificate is what builds buyer trust and reduces returns.",
  },
];

export function gradedClothingMeaningJsonLd(): JsonLd[] {
  return [
    articleLd({
      headline: "Graded Clothing: Bale Grades vs Per-Item Condition Grading",
      description:
        "'Graded clothing' means two different things: wholesale Grade A/B/C bales, and per-item condition grading. Here's the difference and which one you mean.",
      url: absoluteUrl("/grading/graded-clothing-meaning"),
      datePublished: DISAMBIG_PUBLISHED,
      dateModified: DISAMBIG_MODIFIED,
    }),
    faqPageLd(GRADED_CLOTHING_FAQS),
  ];
}

export const VS_AUTH_FAQS = [
  {
    q: "What is the difference between condition grading and authentication?",
    a: "Condition grading and authentication are distinct trust services. Grading assesses a garment's physical condition — wear, damage, function — on a standardized scale (GradeThread's 1.0–10.0). Authentication verifies that an item is genuine and not a counterfeit. GradeThread grades condition; it does not authenticate. A buyer often wants both answers, but they come from different checks.",
  },
  {
    q: "Does a GradeThread grade prove an item is authentic?",
    a: "No. A GradeThread grade certifies condition, not authenticity. It documents how worn or flawed a specific garment is, on a published rubric, with a verifiable certificate. It does not verify the brand or that the item is genuine — that is authentication, a separate service.",
  },
  {
    q: "Do I need both grading and authentication?",
    a: "It depends on what you sell. For most pre-owned clothing, condition is the buyer's main risk — 'is it as described?' — so a standardized condition grade and certificate is the trust signal that matters. For high-value designer or hyped items where counterfeits circulate, authentication is also worth it. Grading and authentication complement each other; neither replaces the other.",
  },
];

export function vsAuthenticationJsonLd(): JsonLd[] {
  return [
    articleLd({
      headline: "Condition Grading vs. Authentication",
      description:
        "Condition grading and authentication are distinct trust services: grading rates a garment's condition, authentication verifies it's genuine. Here's how they differ.",
      url: absoluteUrl("/grading/vs-authentication"),
      datePublished: DISAMBIG_PUBLISHED,
      dateModified: DISAMBIG_MODIFIED,
    }),
    faqPageLd(VS_AUTH_FAQS),
  ];
}

// ── /grading/flaws hub + /grading/flaws/{flaw} (US-1683) ────────────
const FLAW_PUBLISHED = "2026-07-06";
const FLAW_MODIFIED = "2026-07-06";

export function flawBreadcrumbItems(
  flaw: FlawEntry,
): Array<{ name: string; url: string }> {
  return flawTrail(flaw).map((t) => ({
    name: t.name,
    url: t.path === "/" ? `${SITE_URL}/` : `${SITE_URL}${t.path}`,
  }));
}

export function flawHubBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Flaw library", url: `${SITE_URL}${FLAW_LIBRARY_HUB_PATH}` },
  ];
}

/** A single flaw page: Article + DefinedTerm + FAQPage. */
/**
 * US-9014. Article + breadcrumb for a flaw-and-fibre page.
 *
 * No HowTo here even though the page has numbered steps, and that is
 * deliberate. The parent flaw page already claims the HowTo for this task where
 * one exists, and two HowTo nodes competing for one procedure is the kind of
 * over-marking Google's own guidance warns about. This page is the fibre-
 * specific variation, which is an Article.
 */
export function careMatrixJsonLd(entry: MatrixEntry): JsonLd[] {
  return [
    articleLd({
      headline: entry.h1,
      description: entry.description,
      url: absoluteUrl(matrixPath(entry)),
      datePublished: FLAW_PUBLISHED,
      dateModified: FLAW_MODIFIED,
    }),
  ];
}

export function careMatrixBreadcrumbItems(
  entry: MatrixEntry,
): Array<{ name: string; url: string }> {
  const parent = getFlawBySlug(entry.flaw);
  const abs = (p: string) => (p === "/" ? `${SITE_URL}/` : `${SITE_URL}${p}`);
  return [
    { name: "GradeThread", url: abs("/") },
    { name: "Care", url: abs(FLAW_LIBRARY_HUB_PATH) },
    ...(parent ? [{ name: parent.name, url: abs(flawPath(parent.slug)) }] : []),
    { name: entry.h1, url: abs(matrixPath(entry)) },
  ];
}

export function flawJsonLd(flaw: FlawEntry): JsonLd[] {
  const url = absoluteUrl(flawPath(flaw.slug));
  return [
    articleLd({
      headline: flaw.h1,
      description: flaw.description,
      url,
      datePublished: FLAW_PUBLISHED,
      dateModified: FLAW_MODIFIED,
    }),
    flawDefinedTermLd({
      term: flaw.name,
      alternateNames: flaw.alternateNames,
      definition: flaw.definition,
      path: flawPath(flaw.slug),
    }),
    // US-9013: HowTo only where a real repair guide exists. Seven of the 32
    // carry one. Emitting a HowTo built from the removal prose on the other
    // 25 would be marking up steps that are not steps, which is the failure
    // Google's own documentation names first.
    ...(flaw.repair
      ? [
          howToLd({
            name: flaw.repair.name,
            description: flaw.description,
            url,
            minutes: flaw.repair.minutes,
            cost: flaw.repair.cost,
            tools: flaw.repair.tools,
            supplies: flaw.repair.supplies,
            steps: flaw.repair.steps,
          }),
        ]
      : []),
    faqPageLd(flaw.faqs),
  ];
}

export const FLAW_HUB_FAQS = [
  {
    q: "What clothing flaws lower a condition grade the most?",
    a: "Structural damage — holes, tears, blown seams, moth holes, and broken hardware — weighs heaviest because it caps how usable a garment is. Fabric flaws like heavy pilling, thinning, and pronounced fading come next. Minor cosmetic marks move the grade least. Each flaw is assessed under one of the five weighted factors on the 1.0–10.0 scale.",
  },
  {
    q: "How should I disclose a flaw in a listing?",
    a: "Name it plainly, show a close-up photo with a scale reference, and place it where the buyer will see it. A disclosed, photographed flaw rarely causes a return; the same flaw hidden in a 'like new' listing does. A standardized condition grade captures the flaw's impact objectively.",
  },
];

/** The flaw-library hub: DefinedTermSet + FAQPage. */
export function flawHubJsonLd(): JsonLd[] {
  return [
    flawLibrarySetLd(
      FLAW_ENTRIES.map((f) => ({
        term: f.name,
        alternateNames: f.alternateNames,
        definition: f.definition,
        path: flawPath(f.slug),
      })),
    ),
    faqPageLd(FLAW_HUB_FAQS),
  ];
}

// ── /grading/guides hub + /grading/guides/{garment} (US-1682) ───────

export function guideBreadcrumbItems(
  guide: GarmentGuide,
): Array<{ name: string; url: string }> {
  return guideTrail(guide).map((t) => ({
    name: t.name,
    url: t.path === "/" ? `${SITE_URL}/` : `${SITE_URL}${t.path}`,
  }));
}

export function guideHubBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Grading guides", url: `${SITE_URL}${GARMENT_GUIDES_HUB_PATH}` },
  ];
}

/**
 * A garment guide page: HowTo (grade this garment) + FAQPage, plus a
 * VideoObject when this guide has a PUBLISHED grading short (US-1689).
 *
 * The video node is appended only for a short that is actually live on
 * YouTube. head-builder.ts calls this same function, so the prerendered head
 * and the SPA emit the identical set — and an unfilmed short produces no
 * markup on either path.
 */
export function garmentGuideJsonLd(guide: GarmentGuide): JsonLd[] {
  const nodes: JsonLd[] = [
    howToLd({
      name: `How to grade a used ${guide.garment.toLowerCase()}`,
      description: guide.description,
      steps: guide.steps.map((s) => ({ name: s.name, text: s.text })),
    }),
    faqPageLd(guide.faqs),
  ];
  const short = publishedShort(guide.slug);
  if (short) {
    nodes.push(
      videoObjectLd({
        name: shortTitle(short),
        description: shortDescription(short),
        uploadDate: short.uploadDate,
        duration: shortDurationIso(short),
        thumbnailUrl: shortThumbnailUrl(short.youtubeId),
        embedUrl: shortEmbedUrl(short.youtubeId),
        contentUrl: shortWatchUrl(short.youtubeId),
        transcript: shortTranscript(short),
        pageUrl: `${SITE_URL}${guidePath(guide.slug)}`,
      }),
    );
  }
  return nodes;
}

export const GARMENT_HUB_FAQS = [
  {
    q: "Does condition grading work the same for every garment type?",
    a: "The 1.0–10.0 scale and the five weighted factors stay constant, but what counts as wear differs by garment. Pilling matters most on knits, seam slippage and inseam blowouts on denim, sole and crease wear on shoes, lining and structure on tailoring. The factors are universal; the failure modes are garment-specific — which is what these guides cover.",
  },
  {
    q: "How do I grade a specific garment?",
    a: "Start from the garment's known failure points, check them in order, and score against the standardized rubric. Each guide gives the garment-specific criteria, an ordered checklist, and graded examples, so the same evidence produces the same grade whoever inspects the item.",
  },
];

/** The garment-guides hub: FAQPage (the guide index is the visible content). */
export function garmentHubJsonLd(): JsonLd[] {
  return [faqPageLd(GARMENT_HUB_FAQS)];
}

// ── /reselling pillar + guides (US-1688) ────────────────────────────
const RESELLING_PUBLISHED = "2026-07-06";
const RESELLING_MODIFIED = "2026-07-06";

export function resellingPillarBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Reselling", url: `${SITE_URL}${RESELLING_PILLAR_PATH}` },
  ];
}

export function resellingGuideBreadcrumbItems(
  guide: ResellingGuide,
): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Reselling", url: `${SITE_URL}${RESELLING_PILLAR_PATH}` },
    { name: guide.h1, url: `${SITE_URL}${resellingGuidePath(guide.slug)}` },
  ];
}

/** Pillar JSON-LD: the workflow as a HowTo + the pillar FAQ. */
export function resellingPillarJsonLd(): JsonLd[] {
  return [
    howToLd({
      name: "How to Resell Clothes: the Full Workflow",
      description: RESELLING_PILLAR.description,
      steps: RESELLING_PILLAR.steps.map((s) => ({ name: s.name, text: s.text })),
    }),
    faqPageLd(RESELLING_PILLAR.faqs),
  ];
}

/** Guide JSON-LD: Article + the guide FAQ. */
export function resellingGuideJsonLd(guide: ResellingGuide): JsonLd[] {
  return [
    articleLd({
      headline: guide.h1,
      description: guide.description,
      url: absoluteUrl(resellingGuidePath(guide.slug)),
      datePublished: RESELLING_PUBLISHED,
      dateModified: RESELLING_MODIFIED,
    }),
    faqPageLd(guide.faqs),
  ];
}

// ── /compare marketplace comparisons (US-1667) ──────────────────────
const COMPARISON_PUBLISHED = "2026-07-06";
const COMPARISON_MODIFIED = "2026-07-06";

export function compareHubBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Comparisons", url: `${SITE_URL}${COMPARE_HUB_PATH}` },
  ];
}

export function comparisonBreadcrumbItems(
  cmp: Comparison,
): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Comparisons", url: `${SITE_URL}${COMPARE_HUB_PATH}` },
    { name: `${cmp.platformA} vs ${cmp.platformB}`, url: `${SITE_URL}${comparePath(cmp.slug)}` },
  ];
}

/**
 * Hub JSON-LD: a real CollectionPage + ItemList enumerating the comparisons.
 *
 * US-2072: this returned [] — the hub declared `jsonLdType: "CollectionPage"` in
 * the route registry and emitted nothing on either the SPA or the prerender
 * path, so the declaration was decorative.
 *
 * An enumerated ItemList is the point: a hub's value to an AI answer engine is
 * that it can be READ AS A SET ("which marketplace comparisons does this site
 * have?") rather than scraped out of prose. Organization + breadcrumb still
 * come from the layout.
 */
export function compareHubJsonLd(): JsonLd[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "@id": `${SITE_URL}${COMPARE_HUB_PATH}#collection`,
      name: "Marketplace comparisons for resellers",
      description:
        "Side-by-side comparisons of the marketplaces resellers sell used clothes on — fees, reach, shipping, payout speed, and how each handles condition disputes.",
      url: `${SITE_URL}${COMPARE_HUB_PATH}`,
      mainEntity: {
        "@type": "ItemList",
        itemListOrder: "https://schema.org/ItemListUnordered",
        numberOfItems: COMPARISONS.length,
        itemListElement: COMPARISONS.map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: `${c.platformA} vs ${c.platformB}`,
          url: `${SITE_URL}${comparePath(c.slug)}`,
        })),
      },
    },
  ];
}

/** Comparison JSON-LD: Article + the comparison FAQ. */
export function comparisonJsonLd(cmp: Comparison): JsonLd[] {
  return [
    articleLd({
      headline: cmp.h1,
      description: cmp.description,
      url: absoluteUrl(comparePath(cmp.slug)),
      datePublished: COMPARISON_PUBLISHED,
      dateModified: COMPARISON_MODIFIED,
    }),
    faqPageLd(cmp.faqs),
  ];
}

// ── Opportunist mid-tail guides (US-1668) ───────────────────────────
const OPPORTUNIST_PUBLISHED = "2026-07-06";
const OPPORTUNIST_MODIFIED = "2026-07-06";

export function opportunistGuideBreadcrumbItems(
  guide: OpportunistGuide,
): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Reselling", url: `${SITE_URL}${RESELLING_PILLAR_PATH}` },
    { name: guide.h1, url: `${SITE_URL}${guide.path}` },
  ];
}

/** Opportunist guide JSON-LD: HowTo + Article + the guide FAQ. */
export function opportunistGuideJsonLd(guide: OpportunistGuide): JsonLd[] {
  return [
    howToLd({
      name: guide.h1,
      description: guide.description,
      steps: guide.steps.map((s) => ({ name: s.name, text: s.text })),
    }),
    articleLd({
      headline: guide.h1,
      description: guide.description,
      url: absoluteUrl(guide.path),
      datePublished: OPPORTUNIST_PUBLISHED,
      dateModified: OPPORTUNIST_MODIFIED,
    }),
    faqPageLd(guide.faqs),
  ];
}

// ── Returns spine (US-1673) ─────────────────────────────────────────
const RETURNS_SPINE_PUBLISHED = "2026-07-06";
const RETURNS_SPINE_MODIFIED = "2026-07-06";

export function returnsSpineBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Reselling", url: `${SITE_URL}${RESELLING_PILLAR_PATH}` },
    { name: "Reduce eBay returns", url: `${SITE_URL}${RETURNS_SPINE_PATH}` },
  ];
}

/** Returns-spine JSON-LD: Article + the FAQ. */
export function returnsSpineJsonLd(): JsonLd[] {
  return [
    articleLd({
      headline: RETURNS_SPINE.h1,
      description: RETURNS_SPINE.description,
      url: absoluteUrl(RETURNS_SPINE_PATH),
      datePublished: RETURNS_SPINE_PUBLISHED,
      dateModified: RETURNS_SPINE_MODIFIED,
    }),
    faqPageLd(RETURNS_SPINE.faqs),
  ];
}

// ── Platform condition-standard pages (US-1672) ─────────────────────
const PLATFORM_STANDARDS_PUBLISHED = "2026-07-06";
const PLATFORM_STANDARDS_MODIFIED = "2026-07-06";

export function platformStandardsHubBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Grading scale", url: `${SITE_URL}/grading/scale` },
    { name: "Condition standards", url: `${SITE_URL}${PLATFORM_STANDARDS_HUB_PATH}` },
  ];
}

export function platformStandardBreadcrumbItems(
  std: PlatformStandard,
): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Condition standards", url: `${SITE_URL}${PLATFORM_STANDARDS_HUB_PATH}` },
    { name: std.name, url: `${SITE_URL}${platformStandardPath(std.slug)}` },
  ];
}

/** Hub JSON-LD: Organization + breadcrumb come from the layout; nothing extra. */
export function platformStandardsHubJsonLd(): JsonLd[] {
  // US-2072: see compareHubJsonLd — same reasoning. This hub enumerates how
  // each marketplace defines condition, which is exactly the kind of set an AI
  // assistant should be able to read whole rather than infer from prose.
  return [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "@id": `${SITE_URL}${PLATFORM_STANDARDS_HUB_PATH}#collection`,
      name: "Condition standards by marketplace",
      description:
        "How each resale marketplace defines and labels item condition, and how those labels map onto the GradeThread 1.0–10.0 scale.",
      url: `${SITE_URL}${PLATFORM_STANDARDS_HUB_PATH}`,
      mainEntity: {
        "@type": "ItemList",
        itemListOrder: "https://schema.org/ItemListUnordered",
        numberOfItems: PLATFORM_STANDARDS.length,
        itemListElement: PLATFORM_STANDARDS.map((ps, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: ps.name,
          url: `${SITE_URL}${platformStandardPath(ps.slug)}`,
        })),
      },
    },
  ];
}

/** Platform-standard JSON-LD: Article + the FAQ. */
export function platformStandardJsonLd(std: PlatformStandard): JsonLd[] {
  return [
    articleLd({
      headline: std.h1,
      description: std.description,
      url: absoluteUrl(platformStandardPath(std.slug)),
      datePublished: PLATFORM_STANDARDS_PUBLISHED,
      dateModified: PLATFORM_STANDARDS_MODIFIED,
    }),
    faqPageLd(std.faqs),
  ];
}

// ── Where-to-sell mega-guide (US-1693) ──────────────────────────────
const WHERE_TO_SELL_PUBLISHED = "2026-07-06";
const WHERE_TO_SELL_MODIFIED = "2026-07-06";

export function whereToSellBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Where to sell used clothes", url: `${SITE_URL}${WHERE_TO_SELL_PATH}` },
  ];
}

/** Mega-guide JSON-LD: Article + an ItemList of venues + the FAQ. */
export function whereToSellJsonLd(): JsonLd[] {
  const itemList: JsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Where to sell used clothes",
    itemListElement: SELLING_VENUES.map((v, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: v.name,
    })),
  };
  return [
    articleLd({
      headline: WHERE_TO_SELL.h1,
      description:
        "Where to sell used clothes in 2026 — eBay, Poshmark, Depop, Mercari, Vinted, ThredUp, and consignment compared by fees, effort, and payout.",
      url: absoluteUrl(WHERE_TO_SELL_PATH),
      datePublished: WHERE_TO_SELL_PUBLISHED,
      dateModified: WHERE_TO_SELL_MODIFIED,
    }),
    itemList,
    faqPageLd(WHERE_TO_SELL.faqs),
  ];
}

// ── Best crosslisting apps listicle (US-1686) ───────────────────────
const CROSSLIST_APPS_PUBLISHED = "2026-07-06";
const CROSSLIST_APPS_MODIFIED = "2026-07-06";

export function crosslistAppsBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Reselling", url: `${SITE_URL}${RESELLING_PILLAR_PATH}` },
    { name: "Best crosslisting apps", url: `${SITE_URL}${CROSSLIST_APPS_PATH}` },
  ];
}

/** Listicle JSON-LD: Article + an ItemList of apps + the FAQ. */
export function crosslistAppsJsonLd(): JsonLd[] {
  const itemList: JsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Best crosslisting apps for resellers (2026)",
    itemListElement: CROSSLIST_APPS.map((app, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: app.name,
    })),
  };
  return [
    articleLd({
      headline: CROSSLIST_APPS_PAGE.h1,
      description:
        "The best crosslisting apps for resellers in 2026 — List Perfectly, Vendoo, Crosslist, Flyp, and FlipDesk compared on marketplaces, pricing, and returns.",
      url: absoluteUrl(CROSSLIST_APPS_PATH),
      datePublished: CROSSLIST_APPS_PUBLISHED,
      dateModified: CROSSLIST_APPS_MODIFIED,
    }),
    itemList,
    faqPageLd(CROSSLIST_APPS_PAGE.faqs),
  ];
}

// ── Competitor alternative pages ────────────────────────────────────
const ALTERNATIVES_PUBLISHED = "2026-07-20";
const ALTERNATIVES_MODIFIED = "2026-07-20";

export function alternativeBreadcrumbItems(
  alt: CompetitorAlternative,
): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Reselling", url: `${SITE_URL}${RESELLING_PILLAR_PATH}` },
    {
      name: `${alt.competitor} alternatives`,
      url: `${SITE_URL}${alternativePath(alt.slug)}`,
    },
  ];
}

/**
 * Article + an ItemList of the options + the FAQ.
 *
 * The ItemList deliberately carries every option INCLUDING the competitors, in
 * the same order as the page. A list that named only our own tool would not
 * match the visible content, which is both a structured-data mismatch and the
 * kind of thing that makes an AI engine distrust the page it is quoting.
 */
export function alternativeJsonLd(alt: CompetitorAlternative): JsonLd[] {
  const itemList: JsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${alt.competitor} alternatives for resellers (2026)`,
    itemListElement: alt.options.map((opt, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: opt.name,
    })),
  };
  return [
    articleLd({
      headline: alt.h1,
      description: alt.description,
      url: absoluteUrl(alternativePath(alt.slug)),
      datePublished: ALTERNATIVES_PUBLISHED,
      dateModified: ALTERNATIVES_MODIFIED,
    }),
    itemList,
    faqPageLd(alt.faqs),
  ];
}

// ── Free printable condition chart (US-1678) ────────────────────────
const CONDITION_CHART_PUBLISHED = "2026-07-06";
const CONDITION_CHART_MODIFIED = "2026-07-06";

export function conditionChartBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Grading scale", url: `${SITE_URL}/grading/scale` },
    { name: "Condition chart", url: `${SITE_URL}${CONDITION_CHART_PATH}` },
  ];
}

/** Chart JSON-LD: Article (the reference asset). */
export function conditionChartJsonLd(): JsonLd[] {
  return [
    articleLd({
      headline: CONDITION_CHART_META.h1,
      description: CONDITION_CHART_META.description,
      url: absoluteUrl(CONDITION_CHART_PATH),
      datePublished: CONDITION_CHART_PUBLISHED,
      dateModified: CONDITION_CHART_MODIFIED,
    }),
  ];
}

// ── Free grade-checker tool (US-1687) ───────────────────────────────
export function gradeCheckerBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Tools", url: `${SITE_URL}/tools/grade-checker` },
    { name: "Grade checker", url: `${SITE_URL}${GRADE_CHECKER_PATH}` },
  ];
}

/** Tool JSON-LD: a free WebApplication + the FAQ. */
export function gradeCheckerJsonLd(): JsonLd[] {
  const app: JsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Free Clothing Condition Grade Checker",
    url: absoluteUrl(GRADE_CHECKER_PATH),
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    description: GRADE_CHECKER_META.description,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    isAccessibleForFree: true,
    provider: { "@id": ORG_ID },
  };
  return [app, faqPageLd(GRADE_CHECKER_META.faqs)];
}

// ── Free authenticity-check tool (US-1771) ──────────────────────────
export function authenticityCheckBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Tools", url: `${SITE_URL}/tools/authenticity-check` },
    { name: "Authenticity checker", url: `${SITE_URL}${AUTHENTICITY_CHECK_PATH}` },
  ];
}
export function authenticityCheckJsonLd(): JsonLd[] {
  const app: JsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Free Brand Authenticity Checker for Clothing",
    url: absoluteUrl(AUTHENTICITY_CHECK_PATH),
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    description: AUTHENTICITY_CHECK_META.description,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    isAccessibleForFree: true,
    provider: { "@id": ORG_ID },
  };
  return [app, faqPageLd(AUTHENTICITY_CHECK_META.faqs)];
}

// ── Free fit-checker tool (US-1780) ──────────────────────────────────
export function fitCheckerBreadcrumbItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Tools", url: `${SITE_URL}/tools/fit-checker` },
    { name: "Fit checker", url: `${SITE_URL}${FIT_CHECKER_PATH}` },
  ];
}
export function fitCheckerJsonLd(): JsonLd[] {
  const app: JsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Will It Fit Me? Free Clothing Fit Checker",
    url: absoluteUrl(FIT_CHECKER_PATH),
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    description: FIT_CHECKER_META.description,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    isAccessibleForFree: true,
    provider: { "@id": ORG_ID },
  };
  return [app, faqPageLd(FIT_CHECKER_META.faqs)];
}

// ── Free RN number lookup (US-9033) ──────────────────────────────────
// US-2044's lesson, applied rather than repeated: a tool page that declares a
// jsonLdType and never prerenders it has the markup in the SPA only, where no
// non-JS crawler — Google's HTML pass, GPTBot, ClaudeBot, PerplexityBot — can
// read it. WebApplication is what makes a free tool machine-readable as one,
// and this is the highest-volume tool term we own.
export function rnLookupJsonLd(): JsonLd[] {
  const app: JsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Free RN Number Lookup",
    url: absoluteUrl(RN_LOOKUP_PATH),
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    description: RN_LOOKUP_META.description,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    isAccessibleForFree: true,
    provider: { "@id": ORG_ID },
  };
  return [app, faqPageLd(RN_LOOKUP_META.faqs)];
}

// -- The calculator family (US-9002/9007) ----------------------------
// Each live calculator is a free WebApplication + its FAQ, matching the three
// tools above. The hub is a CollectionPage carrying an ItemList of whatever is
// live, so the family is machine-readable as a set rather than as loose pages.
export function calculatorHubBreadcrumbLdItems(): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Calculators", url: `${SITE_URL}${CALCULATOR_HUB_PATH}` },
  ];
}

export function calculatorBreadcrumbLdItems(
  calc: Calculator,
): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Calculators", url: `${SITE_URL}${CALCULATOR_HUB_PATH}` },
    { name: calc.h1, url: `${SITE_URL}${calculatorPath(calc.slug)}` },
  ];
}

export function calculatorHubJsonLd(): JsonLd[] {
  const live = liveCalculators();
  const page: JsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: CALCULATOR_HUB_META.title,
    url: absoluteUrl(CALCULATOR_HUB_PATH),
    description: CALCULATOR_HUB_META.description,
    isPartOf: { "@type": "WebSite", "@id": WEBSITE_ID, name: "GradeThread", url: `${SITE_URL}/` },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: live.length,
      itemListElement: live.map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.h1,
        url: absoluteUrl(calculatorPath(c.slug)),
      })),
    },
  };
  return [page, faqPageLd(CALCULATOR_HUB_META.faqs)];
}

export function calculatorJsonLd(calc: Calculator): JsonLd[] {
  const { faqs } = calculatorContent(calc);
  const app: JsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: calc.title,
    url: absoluteUrl(calculatorPath(calc.slug)),
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web",
    description: calc.description,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    isAccessibleForFree: true,
    provider: { "@id": ORG_ID },
  };
  return [app, faqPageLd(faqs)];
}

// ── /grading/methodology (US-1677, E-E-A-T) ─────────────────────────
// First-hand-experience trust collateral: what actually produces a grade, what
// the grade does and doesn't claim, error handling, and the human-review loop.
// Article + FAQPage (fixed dates so prerender == SPA).
//
// US-2107 AC3: this block carried BOTH claims the page copy was corrected for —
// that the model is "trained" on our corpus, and the absolute "every new model
// version must clear a fixed eval gate ... before it can grade live" that
// US-2500 banned from the two .tsx pages. The ban never reached here, and this
// is the file crawlers and LLM answer engines actually ingest, so the wrong
// sentence outlived its own guard in the place it travelled furthest.
// eval-gate-claims.test.ts now scans this file too.
const METHODOLOGY_PUBLISHED = "2026-07-06";
const METHODOLOGY_MODIFIED = "2026-07-06";

export const METHODOLOGY_FAQS = [
  {
    q: "Does GradeThread train its own grading model?",
    a: "No, and the distinction is worth stating. Photos are read by a general-purpose vision model built by Anthropic, directed by GradeThread's own versioned rubric — five weighted factors (fabric, structure, cosmetics, function, odor) combined into a 1.0–10.0 score. Nothing about a graded garment adjusts that model's weights. Expert reviewer corrections and post-sale outcomes feed a continuous accuracy loop as scored reference examples and as cases in the golden set that tests each new rubric version. A version promoted through our admin flow cannot serve live traffic unless its most recent run against that golden set cleared fixed error and agreement thresholds, measured on the same model that will run it. The rubric shipped inside the service is the fallback when no promoted version is active; it follows the same shadow, eval and canary sequence as policy rather than as an automatic refusal.",
  },
  {
    q: "What does a GradeThread grade claim — and not claim?",
    a: "A grade is an assessment of a garment's physical CONDITION against a published rubric: wear, damage, structural soundness, function, and cleanliness. It is not an authentication (it doesn't verify a brand or that an item is genuine — see grading vs. authentication), not an appraisal of monetary value, and not a guarantee of fit. It grades condition, objectively and reproducibly, and nothing more.",
  },
  {
    q: "How does GradeThread handle grading errors?",
    a: "Every grade carries a confidence score. When confidence falls below threshold, the submission is routed to human review before the grade is finalized, so low-confidence cases never ship unchecked. Buyers can dispute a grade, reviewer corrections feed back into the accuracy loop, and platform-wide agreement and error rates are published on the transparency report.",
  },
  {
    q: "Are humans involved in grading?",
    a: "Yes. Human reviewers correct low-confidence grades before they finalize, adjudicate disputes, and maintain the golden set that gates every promoted rubric version. The AI does the volume; humans hold the standard.",
  },
];

export function methodologyJsonLd(): JsonLd[] {
  return [
    articleLd({
      headline: "How GradeThread Grades: Methodology",
      description:
        "What produces a GradeThread condition grade, how each rubric version is evaluated before it can serve, what a grade claims, and where human review fits.",
      url: absoluteUrl("/grading/methodology"),
      datePublished: METHODOLOGY_PUBLISHED,
      dateModified: METHODOLOGY_MODIFIED,
    }),
    faqPageLd(METHODOLOGY_FAQS),
  ];
}

// ── /transparency (US-326) ──────────────────────────────────────────
// The accuracy report that substantiates "trusted, self-improving grading"
// with published numbers instead of marketing claims.
export const TRANSPARENCY_FAQS = [
  {
    q: "How accurate is GradeThread's AI grading?",
    a: "We publish it. Every grade a human reviewer checks is compared to the AI's grade, and we report the agreement rate (share within half a point) and mean absolute error against expert reviewers on this page — updated continuously as more grades are reviewed.",
  },
  {
    q: "How does GradeThread improve over time?",
    a: "Reviewer corrections and post-sale buyer disputes feed an accuracy loop, and every new grading model version must clear a fixed eval gate — a maximum error and minimum agreement against a golden set of expert-graded garments — before it can grade live items. The model changelog on this page lists versions that passed.",
  },
  {
    q: "What stops a grading model from getting worse?",
    a: "An automated monitor re-checks the live grader on a schedule against the same golden set and against production reviews and disputes. If accuracy drifts below threshold, the team is alerted before quality slips further.",
  },
  {
    q: "Do buyers have to trust a black box?",
    a: "No. The rubric and weights are published, every grade carries a confidence score, low-confidence grades are routed to human review, and these platform-wide accuracy figures are public — so the standard is verifiable, not opaque.",
  },
];

export function transparencyJsonLd(): JsonLd[] {
  return [transparencyDatasetLd(), faqPageLd(TRANSPARENCY_FAQS)];
}

// ── /resale-condition-report (US-976) ───────────────────────────────
// The public "State of Resale Condition" data report — proprietary, citable
// aggregate stats (return rate / sell-through / resale value by grade band).
// The single strongest GEO lever: LLMs disproportionately quote original data,
// so this gets GradeThread NAMED in AI answers. The JSON-LD is DETERMINISTIC
// (fixed dates + static descriptors) so prerender and SPA stay byte-identical
// and the parity test passes; the live figures, sample size, and exact coverage
// window render on the page. RESALE_REPORT_PUBLISHED is fixed (never the build
// timestamp) for the same reason.
export const RESALE_REPORT_PUBLISHED = "2026-06-18";
// US-1691 added the grading half of the report (average grade by garment type,
// most common flaws) + the quotable "by the numbers" block, so the asset was
// materially revised on this date. Bump this WITH src/lib/seo/public-routes.ts's
// lastmod entry for the same route — they are two mirrors of one fact.
export const RESALE_REPORT_MODIFIED = "2026-08-07";
// Open-ended ISO 8601 interval — the coverage window starts at the platform's
// first recorded resale data and runs to "now". The visible page states the
// exact observed min/max dates from the live data.
const RESALE_REPORT_TEMPORAL_COVERAGE = "2026-01-01/..";

export const RESALE_REPORT_FAQS = [
  {
    q: "Do lower-graded clothing items get returned more often?",
    a: "In GradeThread's platform-wide resale data, return rate rises as condition grade falls: items in the lowest grade band are returned more often than those graded Excellent or better. Because every item is scored on the same published 1.0–10.0 condition scale, the comparison is apples-to-apples across sellers and marketplaces — which is why a standardized, disclosed condition grade is the most effective lever for cutting 'not as described' returns.",
  },
  {
    q: "Does a higher condition grade increase resale value?",
    a: "Yes. Median resale price climbs with condition grade across GradeThread's aggregate sold data, and the lift is non-linear — each step down toward the lower bands tends to take a larger bite out of price. The report publishes the median resale price for each grade band so the relationship is visible rather than assumed.",
  },
  {
    q: "How is the State of Resale Condition report calculated?",
    a: "It aggregates platform-wide reseller sales and listings, bucketed by GradeThread condition-grade band. Return rate is refunded fulfilled sales divided by fulfilled sales; sell-through is sold listings divided by listed items; resale value is the median sold price. Every figure is aggregate-only — no per-seller or per-item data — and a band's rate is published only once it clears a minimum sample size, so a thinly-sampled band never prints a misleading number.",
  },
  {
    q: "What are the most common flaws in secondhand clothing?",
    a: "GradeThread records every genuine flaw it finds against a published defect taxonomy — stains, holes and punctures, rips and tears, seam failure, pilling, abrasion and thinning, fading, discoloration, snags and pulls, broken zippers, broken or missing buttons, missing hardware, stretched or misshapen shape, odor indicators, and set-in wrinkles. The report ranks them by how many GRADED GARMENTS carry each kind, so an item with three stains counts once toward stains rather than three times. Intentional design features such as distressing or raw hems are classified as style attributes, not damage, so they never appear as flaws.",
  },
  {
    q: "What is the average condition grade of used clothing?",
    a: "The report publishes the mean overall grade on GradeThread's standardized 1.0–10.0 condition scale, both platform-wide and broken out by garment type — tops, bottoms, outerwear, dresses, footwear, and accessories — so the types are directly comparable. Only finalized grades count, and a garment type's average is published only once enough items of that type have been graded to state it truthfully; below that bar the report shows the count and withholds the figure.",
  },
  {
    q: "Can I cite this data?",
    a: "Yes. The report is published under a CC BY 4.0 license with a canonical citation and permalink, and it emits schema.org Dataset and Article structured data so it's machine-extractable. Cite it as 'GradeThread, The State of Resale Condition' with the report URL, and the page states the sample size and coverage window for the figures you reference. The 'By the numbers' section carries each headline finding as a complete, self-contained sentence with its own sample size, ready to quote verbatim.",
  },
];

// US-1775: "State of Secondhand Durability" report. Fixed publish date (never
// the build timestamp); the visible page states the live sample.
export const DURABILITY_REPORT_PUBLISHED = "2026-07-09";
const DURABILITY_REPORT_MODIFIED = "2026-07-09";

export const DURABILITY_REPORT_FAQS = [
  {
    q: "Which clothing brands are most durable?",
    a: "GradeThread ranks brand durability by how much of its condition grade a garment retains when the same item is graded again over time, on the standardized 1.0–10.0 condition scale. A brand only appears once its cohort clears a minimum sample of garments and regrades, so the ranking reflects real, repeated measurement rather than a handful of items. The report publishes the retention percentage and the sample behind each brand.",
  },
  {
    q: "How is clothing durability measured?",
    a: "Durability here is condition RETENTION: the share of a garment's original GradeThread grade it keeps on its latest regrade, averaged across many garments in a cohort (brand × garment type). We also report which of the five condition factors — fabric, structural, cosmetic, functional, odor & cleanliness — decays fastest. It is an aggregate signal from real grades, not a lab stress test, and thinly-sampled cohorts are withheld.",
  },
  {
    q: "Can I cite the State of Secondhand Durability report?",
    a: "Yes. It emits schema.org Dataset and Article structured data and states the sample size behind each figure. Cite it as 'GradeThread, The State of Secondhand Durability' with the report URL. Figures update as more garments are regraded.",
  },
];

export function durabilityReportJsonLd(): JsonLd[] {
  const dataset: JsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "The State of Secondhand Durability",
    description:
      "GradeThread's proprietary, aggregate data on which pre-owned clothing brands hold their condition best and which condition factors decay fastest, measured by grade retention across regraded garments on the 1.0–10.0 condition scale.",
    url: absoluteUrl("/state-of-durability"),
    isAccessibleForFree: true,
    creativeWorkStatus: "Published",
    datePublished: DURABILITY_REPORT_PUBLISHED,
    dateModified: DURABILITY_REPORT_MODIFIED,
    license: "https://creativecommons.org/licenses/by/4.0/",
    creator: { "@id": ORG_ID },
  };
  return [
    dataset,
    articleLd({
      headline: "The State of Secondhand Durability: Which Clothing Brands Hold Their Condition",
      description:
        "GradeThread's original data on brand durability — which pre-owned clothing brands retain their condition grade best across regraded garments, and which condition factors decay fastest.",
      url: absoluteUrl("/state-of-durability"),
      datePublished: DURABILITY_REPORT_PUBLISHED,
      dateModified: DURABILITY_REPORT_MODIFIED,
    }),
    faqPageLd(DURABILITY_REPORT_FAQS),
  ];
}

export function resaleConditionReportJsonLd(): JsonLd[] {
  return [
    resaleConditionDatasetLd({
      datePublished: RESALE_REPORT_PUBLISHED,
      dateModified: RESALE_REPORT_MODIFIED,
      temporalCoverage: RESALE_REPORT_TEMPORAL_COVERAGE,
    }),
    articleLd({
      headline: "The State of Resale Condition: Return Rate, Sell-Through & Value by Grade",
      description:
        "GradeThread's proprietary, platform-wide data on how a pre-owned garment's condition grade relates to buyer return rate, sell-through, and resale value — original statistics on the standardized 1.0–10.0 condition scale.",
      url: absoluteUrl("/resale-condition-report"),
      datePublished: RESALE_REPORT_PUBLISHED,
      dateModified: RESALE_REPORT_MODIFIED,
    }),
    faqPageLd(RESALE_REPORT_FAQS),
  ];
}

// ── /verify (US-593) ────────────────────────────────────────────────
// Buyer-facing "verify this grade" entry point: how a buyer confirms a
// GradeThread condition grade before they pay, on or off eBay.
export const VERIFY_STEPS = [
  {
    name: "Scan the QR code or open the certificate link",
    text: "Every GradeThread certificate carries a QR code and a unique link. Scan the code on the listing, badge, or item tag with your phone camera, or tap the seller's certificate link.",
  },
  {
    name: "Or enter the certificate code",
    text: "No link handy? Paste the certificate URL or its code into the verify box on gradethread.com/verify to pull up the official certificate.",
  },
  {
    name: "Check the grade against the photos",
    text: "The certificate shows the overall 1.0–10.0 grade, its tier, a factor-by-factor breakdown, and the actual garment photos — so you can confirm the condition matches what you're buying.",
  },
  {
    name: "Confirm it's authentic",
    text: "Each certificate is tamper-evident: GradeThread re-derives its integrity signature on load and shows a verified check, so you know the grade hasn't been altered.",
  },
];

const VERIFY_FAQS = [
  {
    q: "How do I verify a GradeThread grade as a buyer?",
    a: "Scan the QR code on the listing or item, open the seller's certificate link, or paste the certificate URL or code at gradethread.com/verify. The official certificate shows the grade, factor breakdown, and garment photos so you can confirm condition before you pay — no account needed.",
  },
  {
    q: "Does this work for Poshmark, Mercari, Depop, or an in-person sale?",
    a: "Yes. A GradeThread certificate isn't tied to eBay. The QR code and verify link work on any marketplace and for face-to-face sales — scan or open it from wherever the seller shared the grade.",
  },
  {
    q: "How do I know the certificate is genuine and not edited?",
    a: "Certificates are tamper-evident. When a certificate loads, GradeThread re-derives its content hash and signature on the server and displays a verified check. An altered grade fails that check, and a certificate that was withdrawn or never existed simply won't resolve.",
  },
  {
    q: "Do I need an account to verify a grade?",
    a: "No. Verifying a grade is free and requires no login. Only the seller who graded the item needs a GradeThread account.",
  },
];

export function verifyJsonLd(): JsonLd[] {
  return [
    howToLd({
      name: "How to verify a GradeThread condition grade",
      description:
        "Scan the QR code or enter the certificate code to confirm a pre-owned clothing condition grade before you buy — on or off eBay, no account required.",
      steps: VERIFY_STEPS,
    }),
    faqPageLd(VERIFY_FAQS),
  ];
}

// ── /scan (US-1106) — buyer-facing "scan before you buy" passport lookup ──────

export const SCAN_STEPS = [
  {
    name: "Scan the tag QR code or open the passport link",
    text: "If the item carries a GradeThread passport tag or the seller shared a passport link, scan the QR with your phone camera or tap the link — it opens the item's full history instantly.",
  },
  {
    name: "Or enter the passport slug or tag code",
    text: "No QR handy? Paste the passport URL, its slug, or the printed tag code (like ABCD-EFGH-JK) into the box on gradethread.com/scan to pull up the item's passport.",
  },
  {
    name: "Read the garment's history before you buy",
    text: "The passport shows a confidence-scored timeline — every grade, listing, sale, and ownership handoff — so you can see how the item was described over time and whether the condition holds up.",
  },
  {
    name: "Buy with the history behind you",
    text: "Participants stay pseudonymous and no personal data is shown. You just get the provenance: an independent record of what this specific garment has been through.",
  },
];

const SCAN_FAQS = [
  {
    q: "How do I look up a garment's passport before buying?",
    a: "Scan the GradeThread passport QR on the item or listing, open the seller's passport link, or paste the passport slug or printed tag code at gradethread.com/scan. The public passport shows the item's confidence-scored grade, listing, and ownership history — free and with no account.",
  },
  {
    q: "What's the difference between a passport and a certificate?",
    a: "A certificate is the grade for one inspection. A Garment Passport is the item's whole story over time — every grade, listing, sale, and ownership transfer linked to the same physical garment — so you can see provenance, not just a single snapshot.",
  },
  {
    q: "Does looking up a passport reveal who owned the item?",
    a: "No. Passports are pseudonymous by design — participants appear only as ordinal labels like 'Seller A' or 'Buyer B'. A past owner only ever appears by name if they personally opted in to be shown. No personal information is exposed.",
  },
  {
    q: "I'm a seller — how do my items get a passport?",
    a: "Grade an item with GradeThread and it gets a passport automatically. Add a physical QR tag so buyers can scan it in hand, and the item's verified history travels with it across every marketplace.",
  },
];

export function passportScanJsonLd(): JsonLd[] {
  return [
    howToLd({
      name: "How to look up a Garment Passport before you buy",
      description:
        "Scan the passport QR code or enter the slug/tag code to see a pre-owned garment's full, confidence-scored history before you buy — free, no account.",
      steps: SCAN_STEPS,
    }),
    faqPageLd(SCAN_FAQS),
  ];
}

// ── /whats-it-worth (US-849) ─────────────────────────────────────────
// Public "what's my item worth?" condition-value tool — a top-of-funnel lead
// magnet for a high-intent query. The estimate is read live from the public
// Condition Index curve (real eBay comps), so the JSON-LD here stays GENERIC
// (it must be deterministic and data-free: the prerender head-builder calls
// this with no live curve data, and the parity test compares it to the SPA).
const WHATS_IT_WORTH_FAQS = [
  {
    q: "How much is my used clothing worth?",
    a: "Resale value depends mostly on the brand, the item, and its condition. Pick an item and a 1.0–10.0 condition grade in the What's It Worth tool and we show the typical resale value at that grade, drawn from the GradeThread Condition Index — real eBay sold-comparable data, not a guess.",
  },
  {
    q: "How does the What's It Worth estimate work?",
    a: "Each estimate comes from the Condition Index: we track sold comparables for popular brand-and-item combinations and fit a value-versus-condition curve. You select an item and a grade, and we return the median resale value at that grade plus the number of comparables behind it and when it was last refreshed. Combinations without enough recent data are not shown rather than guessed.",
  },
  {
    q: "Does an estimate replace a real GradeThread grade?",
    a: "No. The estimate tells you roughly what an item in a given condition tends to sell for. To prove that condition to buyers you still need a real grade: upload photos and GradeThread returns an objective 1.0–10.0 grade and a shareable certificate buyers can verify, which helps items sell faster and with fewer disputes.",
  },
  {
    q: "Why don't I see my exact item?",
    a: "We only publish a value curve when it's backed by enough recent sold comparables, so the tool covers popular brand-and-item combinations rather than every garment. If yours isn't listed, the most reliable signal is still a real condition grade and certificate.",
  },
];

export function whatsItWorthJsonLd(): JsonLd[] {
  return [faqPageLd(WHATS_IT_WORTH_FAQS)];
}

// ── Cornerstone pillar pages (US-855) ───────────────────────────────
// Durable, hand-curated authority pages on the queries GradeThread uniquely
// owns. Each emits an Article + FAQPage node. Dates are FIXED (never the build
// timestamp) so prerender and SPA structured data stay byte-identical and the
// sitemap <lastmod> in ROUTE_LAST_MODIFIED matches what crawlers see.
const CORNERSTONE_PUBLISHED = "2026-06-13";
const CORNERSTONE_MODIFIED = "2026-06-13";

/** Build the [Article, FAQPage] node pair shared by every cornerstone page. */
function cornerstoneJsonLd(opts: {
  path: string;
  headline: string;
  description: string;
  faqs: ReadonlyArray<{ q: string; a: string }>;
}): JsonLd[] {
  return [
    articleLd({
      headline: opts.headline,
      description: opts.description,
      url: absoluteUrl(opts.path),
      datePublished: CORNERSTONE_PUBLISHED,
      dateModified: CORNERSTONE_MODIFIED,
    }),
    faqPageLd(opts.faqs),
  ];
}

// ── /reduce-returns ─────────────────────────────────────────────────
export const REDUCE_RETURNS_FAQS = [
  {
    q: "Why do most clothing returns happen?",
    a: "On pre-owned apparel, the top reason is 'not as described' — the buyer's read of the condition didn't match the seller's. A vague 'good used condition' invites that gap. A standardized 1.0–10.0 grade and a verifiable certificate close it by giving both sides the same definition of condition.",
  },
  {
    q: "Does a condition grade actually reduce disputes?",
    a: "It removes the most common argument: what 'good' or 'excellent' means. When the listing carries an objective grade across five weighted factors plus a certificate the buyer can open and check, there's far less room for a not-as-described claim — the condition was disclosed and proven up front.",
  },
  {
    q: "How is a graded condition different from writing my own description?",
    a: "Your description is your opinion; a GradeThread grade is the same published rubric applied to every item, so '8/10 Excellent' means the same thing on your listing as on anyone else's. Buyers learn to trust the number instead of decoding each seller's adjectives.",
  },
  {
    q: "What do I show the buyer to prevent a return?",
    a: "Share the certificate link or QR code in the listing. It shows the overall grade, the factor-by-factor breakdown, and the actual garment photos, with a tamper-evident verified check — so the buyer confirms condition before they pay, not after it arrives.",
  },
];

export function reduceReturnsJsonLd(): JsonLd[] {
  return cornerstoneJsonLd({
    path: "/reduce-returns",
    headline: "Reduce Returns and Disputes with Condition Proof",
    description:
      "Most pre-owned clothing returns are 'not as described.' A standardized condition grade and a verifiable certificate close the gap between what you listed and what the buyer expected.",
    faqs: REDUCE_RETURNS_FAQS,
  });
}

// ── /reseller-grading-guide ─────────────────────────────────────────
export const RESELLER_GUIDE_FAQS = [
  {
    q: "When should a reseller grade an item?",
    a: "Grade the pieces where condition drives the price — your higher-value, brand-name, or vintage items, and anything a buyer might dispute. For a $6 fast-fashion tee the grade rarely moves the needle; for a $120 jacket, a verified 9/10 versus a guessed 'great condition' is the difference between a fast sale and a haggle.",
  },
  {
    q: "How do I photograph an item for an accurate grade?",
    a: "Shoot front, back, and the label on a plain, well-lit background, plus a detail shot of any wear. Add close-ups of specific flaws — pilling, a mark, a repair — so the grader sees what you see. Sharp, honest photos produce a higher-confidence grade; blurry or hidden flaws lower it.",
  },
  {
    q: "Does grading help with marketplace-specific selling?",
    a: "Yes. Drop the grade and certificate link into your eBay item specifics and description, your Poshmark listing, or a Mercari note. The standardized number translates across platforms, so the same proof of condition works whether you're selling on eBay, Poshmark, Mercari, Depop, or Grailed.",
  },
  {
    q: "How does a grade affect my pricing?",
    a: "Condition is one of the strongest levers on resale value. The Condition Index tracks real eBay sold comparables and shows how price moves with grade for popular brand-and-item combinations, so you can price an Excellent piece for what Excellent actually sells for instead of leaving money on the table.",
  },
];

export function resellerGuideJsonLd(): JsonLd[] {
  return cornerstoneJsonLd({
    path: "/reseller-grading-guide",
    headline: "A Reseller's Guide to Condition Grading",
    description:
      "What to grade, how to shoot it, and how to turn a standardized condition grade into faster sales and fewer disputes across eBay, Poshmark, Mercari, Depop, and Grailed.",
    faqs: RESELLER_GUIDE_FAQS,
  });
}

// ── /design-vs-damage ───────────────────────────────────────────────
export const DESIGN_VS_DAMAGE_FAQS = [
  {
    q: "How do you tell intentional distressing from real damage?",
    a: "Intentional design is consistent and deliberate: factory-placed rips, even whiskering, an acid wash, raw hems that were finished that way. Damage is incidental and uneven — a single blown-out seam, a stain, a moth hole, fraying where the garment was stressed in wear. Design is a feature of the item; damage is a deviation from its made condition.",
  },
  {
    q: "Does distressed clothing get a lower grade?",
    a: "Not for the distressing itself. A garment is graded against its intended, as-made state, so factory-distressed denim isn't penalized for the rips it was designed with. It loses points only for wear or damage on top of the design — a torn pocket, a stain, or fading the maker never intended.",
  },
  {
    q: "Why does this distinction matter for resale?",
    a: "Misreading design as damage underprices a perfectly good item, and misreading damage as 'styling' gets you a not-as-described return. Calling it correctly — and documenting it on a certificate — protects both your price and your rating.",
  },
  {
    q: "How does GradeThread handle this?",
    a: "The grade is assessed against the garment's intended construction, and intentional-design misreads are one of the error rates we measure and publish on our transparency report. When the model isn't confident an effect is design rather than damage, the grade is routed for human review before it's finalized.",
  },
];

export function designVsDamageJsonLd(): JsonLd[] {
  return cornerstoneJsonLd({
    path: "/design-vs-damage",
    headline: "Intentional Design vs. Damage in Clothing Grading",
    description:
      "Factory distressing, raw hems, and acid washes are design — not flaws. Here's how to tell intentional design from real damage so you don't underprice an item or earn a return.",
    faqs: DESIGN_VS_DAMAGE_FAQS,
  });
}

// ── /resale-value-by-condition ──────────────────────────────────────
export const RESALE_VALUE_FAQS = [
  {
    q: "How much does condition affect resale value?",
    a: "A lot, and it's non-linear. The drop from New With Tags to Excellent is usually small, but each step down toward Fair tends to take a larger bite — a documented flaw can halve what an otherwise desirable piece fetches. The Condition Index fits this value-versus-grade curve from real eBay sold comparables.",
  },
  {
    q: "What is the Condition Index?",
    a: "It's GradeThread's published value-by-condition data: for popular brand-and-item combinations we track sold comparables and show the typical resale value at each grade, the number of comparables behind it, and when it was last refreshed. Combinations without enough recent data aren't shown rather than guessed.",
  },
  {
    q: "How do I use condition to price an item?",
    a: "Start from the grade, then read the curve. Look up the brand-and-item combination in the Condition Index, find your grade, and price to the median resale value at that grade. A verified grade also lets you hold that price with less haggling, because the buyer can see the condition is real.",
  },
  {
    q: "Does a higher grade really sell faster?",
    a: "A proven high grade reduces the buyer's risk, which is what usually stalls a pre-owned sale. When condition is documented and verifiable, buyers commit sooner and dispute less — so you realize more of the value the curve says the item is worth.",
  },
];

export function resaleValueJsonLd(): JsonLd[] {
  return cornerstoneJsonLd({
    path: "/resale-value-by-condition",
    headline: "Resale Value by Condition Grade",
    description:
      "Condition is one of the biggest levers on what used clothing sells for. See how resale value moves with each grade, drawn from real eBay sold comparables in the Condition Index.",
    faqs: RESALE_VALUE_FAQS,
  });
}

// ── /grading-by-category ────────────────────────────────────────────
export const GRADING_BY_CATEGORY_FAQS = [
  {
    q: "Does condition grading work the same for every garment type?",
    a: "The 1.0–10.0 scale and the five weighted factors stay constant, but what counts as wear differs by category. Pilling matters most on knits, seam slippage and inseam blowouts on denim, sole and crease wear on shoes, lining and structure on tailoring. The factors are universal; the failure modes are category-specific.",
  },
  {
    q: "What lowers a denim or knit grade fastest?",
    a: "On denim, structural integrity does the damage — blown inseams, frayed belt loops, and stress at the crotch — alongside fading the design didn't intend. On knits, fabric condition leads: pilling, felting, thinning at the elbows, and snags pull the grade down even when the garment looks fine on the hanger.",
  },
  {
    q: "How are vintage items graded differently?",
    a: "Vintage is still graded against its as-made condition, but age-appropriate character — a soft hand, gentle fading, a single-stitch tee's patina — isn't treated as damage. Holes, stains, brittleness, and repairs are. That's why getting the design-versus-damage call right matters most on vintage.",
  },
  {
    q: "Does category change how I should photograph for a grade?",
    a: "Yes — shoot the parts that fail for that category. For denim, capture the inseam, hem, and waistband; for knits, a close-up of the surface and cuffs; for shoes, the soles, toe box, and heel. Showing the category's known wear points gives a higher-confidence, more accurate grade.",
  },
];

export function gradingByCategoryJsonLd(): JsonLd[] {
  return cornerstoneJsonLd({
    path: "/grading-by-category",
    headline: "Condition Grading by Category: Denim, Knits, Vintage & More",
    description:
      "The 1.0–10.0 scale is universal, but wear isn't. How condition grading plays out for denim, knits, leather, shoes, outerwear, and vintage — and what to photograph for each.",
    faqs: GRADING_BY_CATEGORY_FAQS,
  });
}

// ── /buyer-guarantee (US-867) ───────────────────────────────────────
// The condition-backed buyer trust guarantee + mediation policy. Article +
// FAQPage, like the cornerstone pages, but its own published/modified date.
const BUYER_GUARANTEE_PUBLISHED = "2026-06-13";
// US-1298: rewritten to the grade-fee-back + coverage-gated remedy model.
const BUYER_GUARANTEE_MODIFIED = "2026-06-27";

export const BUYER_GUARANTEE_FAQS = [
  {
    q: "What does the GradeThread buyer guarantee cover?",
    a: "The Grade Accuracy Guarantee covers an item that arrives 'materially not as graded' on an area the certificate documented — where the actual condition is meaningfully worse than the certified grade and its disclosed defects. The certificate's structured disclosure (the documented flaws and the 1.0–10.0 grade across five factors), plus the coverage map showing which zones the photos documented, is the reference point. When an approved claim falls within that documented scope, we refund the grading fee and grant a free re-grade.",
  },
  {
    q: "What does 'materially not as graded' mean?",
    a: "A difference big enough to change the deal: a significant defect that wasn't disclosed on the certificate, or wear well beyond what the grade represents — on an area the certificate's photos actually documented. Normal, already-disclosed flaws and intentional design features (factory distressing, raw hems) are not covered, and neither are defects in zones the photos never showed (every certificate marks its coverage), because the grade never claimed to cover them.",
  },
  {
    q: "How do I file a claim?",
    a: "Open the item's certificate, note its certificate number, and submit a claim with your contact email, a description of how the item differs from its grade, and any supporting photo links. You don't need a GradeThread account. A reviewer compares your claim against the certified disclosure and coverage map and records a decision.",
  },
  {
    q: "Does GradeThread issue refunds?",
    a: "Yes — but specifically a grade-fee-back remedy, not item value. When a claim is approved and the issue falls on a documented area, GradeThread refunds the grading fee the seller paid and grants a free re-grade. We do not refund the item's purchase price or shipping — those are covered by the marketplace's buyer protection, which this guarantee complements rather than replaces. Our remedy is scoped to what we're responsible for: the accuracy of the grade.",
  },
  {
    q: "Who can file — do I need an account?",
    a: "Any buyer of a graded item can file, with no account required. We only collect the contact details and evidence needed to review the claim, and that information is kept private to the review process.",
  },
];

export function buyerGuaranteeJsonLd(): JsonLd[] {
  return [
    articleLd({
      headline: "The GradeThread Buyer Trust Guarantee & Mediation Policy",
      description:
        "What the condition-backed buyer guarantee covers, what 'materially not as graded' means, and how to file a mediation claim against a certified grade.",
      url: absoluteUrl("/buyer-guarantee"),
      datePublished: BUYER_GUARANTEE_PUBLISHED,
      dateModified: BUYER_GUARANTEE_MODIFIED,
    }),
    faqPageLd(BUYER_GUARANTEE_FAQS),
  ];
}

// ── /flipdesk (US-1397, SEO) ────────────────────────────────────────
// FlipDesk's public surface: a dedicated SoftwareApplication node (the reseller
// suite, distinct from the grading SoftwareApplication emitted site-wide) + an
// FAQ block targeting reseller-tool questions + breadcrumb. Answers are framed
// around the grading differentiator (the moat) and use first-party capability,
// not generic listicle copy, per the SEO strategy.
export const FLIPDESK_FAQS = [
  {
    q: "What is FlipDesk?",
    a: "FlipDesk is GradeThread's reseller-management suite, and it works with eBay. It runs the full pipeline — sourcing and cost basis, measurements, guided photos, condition grading, sold comps and pricing, AI-assisted listing, rules-based repricing, and payout reconciliation — in one workspace. What sets it apart from a standalone crosslister or repricer is that a standardized 1.0–10.0 condition grade and a verifiable certificate are built into every listing.",
  },
  {
    q: "How is FlipDesk different from a crosslister like Vendoo or List Perfectly?",
    a: "Crosslisters move a listing across marketplaces; repricers adjust price. FlipDesk covers the whole reseller workflow AND adds the one thing those tools can't: an objective, third-party condition grade and a public certificate. Buyers can verify the grade, which builds trust and reduces 'not as described' returns, and the comps are condition-aware so you price to what your grade actually sells for.",
  },
  {
    q: "Does FlipDesk help me price items?",
    a: "Yes. FlipDesk pulls real eBay sold comps and keeps them condition-aware, so an item graded Excellent (8) is priced against what comparable Excellent items actually sold for — not a blind average. Rules-based repricing then keeps stale inventory moving without racing to the bottom.",
  },
  {
    q: "Do I have to grade every item to use FlipDesk?",
    a: "No — FlipDesk's sourcing, measurements, listing, repricing, and reconciliation work on their own. But grading is the differentiator: a standardized condition grade and certificate are the trust signal a raw listing photo can't fake, and they drive condition-aware pricing.",
  },
  {
    q: "Which marketplaces does FlipDesk support?",
    a: "FlipDesk works with eBay and covers the full listing lifecycle — listing, repricing, sold comps, and payout reconciliation. The condition grade and verifiable certificate travel with the item, so the trust they build applies wherever you sell.",
  },
];

export function flipdeskJsonLd(): JsonLd[] {
  const url = absoluteUrl("/flipdesk");
  const flipdeskApp: JsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${url}#flipdesk`,
    name: "FlipDesk",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url,
    description:
      "FlipDesk is GradeThread's reseller-management suite and works with eBay: source, measure, photograph, grade, comp, list, reprice, and reconcile in one workspace — with a standardized condition grade and verifiable certificate built into every listing.",
    isPartOf: { "@type": "WebSite", "@id": WEBSITE_ID, name: "GradeThread", url: `${SITE_URL}/` },
    publisher: { "@id": ORG_ID },
    featureList: [
      "Listing management and AI-assisted drafting that works with eBay",
      "Cross-listing and inventory management",
      "Condition-aware sold comps and pricing",
      "Rules-based repricing",
      "Measurements and guided photo capture",
      "Standardized 1.0–10.0 condition grading + verifiable certificates",
      "Payout, fee, and shipping reconciliation",
    ],
  };
  return [
    flipdeskApp,
    faqPageLd(FLIPDESK_FAQS),
    breadcrumbLd([
      { name: "Home", url: `${SITE_URL}/` },
      { name: "FlipDesk", url },
    ]),
  ];
}

// ── /sell-used-clothes-ebay (US-1401, SEO) ──────────────────────────
// A non-commodity guide for the "how to sell used clothes on eBay" cluster,
// framed through condition/grading (first-party authority) + FlipDesk. Article +
// FAQPage + BreadcrumbList; answer-capsule FAQ for AI citation.
export const EBAY_GUIDE_FAQS = [
  {
    q: "How do I sell used clothes on eBay for more money?",
    a: "Compete on condition, not just price. Buyers can't trust a vague 'Pre-owned' label, so used clothing sells below its worth. Grade the item on a standardized 1.0–10.0 scale, attach a verifiable certificate, map the grade to eBay's condition field, and price it against sold comps in the same condition. The objective grade justifies a higher price and reduces 'not as described' returns.",
  },
  {
    q: "What condition should I list used clothes as on eBay?",
    a: "eBay offers New with tags, New without tags, and Pre-owned. Those are coarse, so pair the eBay field with a precise condition grade in the listing (e.g. an item specific reading 'Condition Grade 8.0 (Excellent)' plus the certificate number). The grade gives buyers the resolution eBay's three-option dropdown can't.",
  },
  {
    q: "How do I price used clothes on eBay?",
    a: "Use sold comps, but filter them by condition — average the listings in your item's actual condition, not a blur of mint and worn. A condition-aware comp tells you what an Excellent (8) piece really sold for, which is how you avoid both underpricing and pricing yourself unsold.",
  },
  {
    q: "How do I reduce returns when selling used clothes on eBay?",
    a: "Most clothing returns come from two questions a listing fails to answer: what condition is it really in, and will it fit. A factor-by-factor condition grade with photos and real measurements sets accurate expectations up front, so fewer items come back.",
  },
];

const EBAY_GUIDE_MODIFIED = "2026-06-27";

export function sellOnEbayJsonLd(): JsonLd[] {
  const url = absoluteUrl("/sell-used-clothes-ebay");
  return [
    articleLd({
      headline: "How to Sell Used Clothes on eBay",
      description:
        "A condition-first guide to selling used clothes on eBay: grade the condition, map it to eBay's fields, price to real sold comps, and cut returns.",
      url,
      datePublished: "2026-06-27",
      dateModified: EBAY_GUIDE_MODIFIED,
    }),
    faqPageLd(EBAY_GUIDE_FAQS),
    breadcrumbLd([
      { name: "Home", url: `${SITE_URL}/` },
      { name: "How to Sell Used Clothes on eBay", url },
    ]),
  ];
}

// ── /about (US-868) ─────────────────────────────────────────────────
// The company/about page that strengthens entity-level authority for E-E-A-T:
// who runs GradeThread (Pearson Media LLC), the mission, and the published
// methodology behind every grade. Emits an AboutPage (mainEntity = the
// Organization) plus an FAQPage of company Q&A for AI answer engines.
export const ABOUT_FAQS = [
  {
    q: "Who is behind GradeThread?",
    a: "GradeThread is built and operated by Pearson Media LLC. We set out to fix a single problem in resale: condition is described in vague, inconsistent words. GradeThread replaces those words with one objective, published 1.0–10.0 standard and a certificate buyers can verify.",
  },
  {
    q: "What is GradeThread's mission?",
    a: "To make the condition of pre-owned clothing objective, comparable, and verifiable — so a grade means the same thing on every item, for every seller and buyer. That standard is what lets resellers build trust, cut returns, and sell faster.",
  },
  {
    q: "What makes GradeThread an authority on condition grading?",
    a: "We publish our methodology rather than asking you to trust a black box: a fixed rubric of five weighted factors on a 1.0–10.0 scale, confidence scoring with human review for low-confidence cases, and a public transparency report measuring our accuracy against expert reviewers. The standard is documented, measured, and open to inspection.",
  },
  {
    q: "How does GradeThread keep grades objective?",
    a: "Every submission is scored against the same published rubric and weights, each grade carries a confidence score, and low-confidence grades are routed for human review before they finalize. Reviewer corrections and buyer disputes feed an accuracy loop, and the results are published on our transparency report.",
  },
];

export function aboutJsonLd(): JsonLd[] {
  return [aboutPageLd(absoluteUrl("/about")), faqPageLd(ABOUT_FAQS)];
}

// ── /grading/* glossary hub (US-303) ────────────────────────────────
// Absolute breadcrumb trail (GradeThread → Condition grading → <term>) for a
// glossary entry. Shared by the live page (via MarketingLayout's `breadcrumbs`
// override) and the prerender head-builder so both emit identical structure.
export function glossaryBreadcrumbItems(
  entry: GlossaryEntry,
): Array<{ name: string; url: string }> {
  return glossaryTrail(entry).map((t) => ({
    name: t.name,
    url: t.path === "/" ? `${SITE_URL}/` : `${SITE_URL}${t.path}`,
  }));
}

/**
 * Page-specific JSON-LD for a glossary entry: an FAQPage from the entry's
 * visible Q&A. Organization AND the 3-level BreadcrumbList are added separately
 * — by MarketingLayout's `breadcrumbs` override on the live page and by the
 * prerender head-builder — so the breadcrumb is emitted EXACTLY ONCE. (US-423:
 * this used to also return breadcrumbLd() here, which double-emitted the
 * BreadcrumbList on the live page since the layout already emits one.)
 *
 * US-973: also emits a DefinedTerm for the entry (name=term, alternateName=
 * expansion, description=definition, url=absolute path) linked to the hub's
 * DefinedTermSet via inDefinedTermSet, so the definition is machine-extractable.
 * Defined here (not in the page) so the live <SEO> and the prerender head-builder
 * emit byte-identical structured data (parity test covers it).
 */
export function glossaryJsonLd(entry: GlossaryEntry): JsonLd[] {
  return [
    definedTermLd({
      term: entry.term,
      expansion: entry.expansion,
      definition: entry.definition,
      path: entry.path,
    }),
    faqPageLd(entry.faqs),
  ];
}

// ── US-2105 AC1: page-level schema for four commercially important routes ──
//
// /for-brands, /for-resellers, /developers and /verified declared no jsonLdType
// and shipped only the layout's Organization + a 2-level BreadcrumbList. The
// for-brands route file was explicit about it ("No jsonLdType: the page passes
// no jsonLd"), and that refusal was right — declaring a decorative type would
// have claimed markup that was never emitted. This wires the real markup so the
// declaration becomes true.
//
// Everything below is derived from the registry meta these pages already
// render. In particular there is NO FAQPage on any of them: none of the three
// marketing pages carries FAQ content, and authoring Q&A purely to earn a rich
// result would be inventing claims the page does not make.

/** /for-brands — a Service offered to brands, not an article. */
export function forBrandsJsonLd(): JsonLd[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "Service",
      "@id": `${SITE_URL}/for-brands#service`,
      name: "GradeThread for Brands — resale condition & circularity",
      serviceType: "Resale condition grading and circularity reporting",
      description: FOR_BRANDS_META.description,
      url: `${SITE_URL}/for-brands`,
      provider: { "@id": ORG_ID },
      audience: { "@type": "BusinessAudience", name: "Brands running resale or trade-in programs" },
      areaServed: "US",
    } as JsonLd,
  ];
}

/** /for-resellers — the same shape, aimed at individual sellers. */
export function forResellersJsonLd(): JsonLd[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "Service",
      "@id": `${SITE_URL}/for-resellers#service`,
      name: "GradeThread for Resellers",
      serviceType: "Clothing condition grading for resale listings",
      description:
        "Standardized condition grades that build buyer trust, cut returns, and speed up sales for eBay, Poshmark, Mercari, Depop, and Grailed sellers.",
      url: `${SITE_URL}/for-resellers`,
      provider: { "@id": ORG_ID },
      audience: { "@type": "Audience", name: "Clothing resellers" },
      areaServed: "US",
    } as JsonLd,
  ];
}

/**
 * /developers — APIReference (a schema.org subtype of TechArticle), which is
 * the type that actually describes an API surface rather than a marketing page.
 */
export function developersJsonLd(): JsonLd[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "APIReference",
      "@id": `${SITE_URL}/developers#api`,
      name: "GradeThread Grading API",
      headline: "Grading API for Developers",
      description:
        "Embed GradeThread AI clothing condition grading via a REST API and JavaScript SDK — free sandbox, white-label embeds, documented rate limits and pricing.",
      url: `${SITE_URL}/developers`,
      programmingModel: "REST",
      publisher: { "@id": ORG_ID },
    } as JsonLd,
  ];
}

/**
 * /verified — a CollectionPage over the seller directory.
 *
 * Deliberately NO ItemList: the sellers are fetched at runtime, so this
 * build-time prerender cannot enumerate them. An ItemList with zero members, or
 * one built from a stale snapshot, would be a structured claim about a
 * collection we are not actually listing here. The CollectionPage itself is
 * true unconditionally.
 */
export function verifiedJsonLd(): JsonLd[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "@id": `${SITE_URL}/verified#collection`,
      name: "GradeThread Verified Seller Directory",
      description:
        "Browse trusted GradeThread Verified sellers, ranked by graded volume and average condition grade. Every item is independently AI condition-graded.",
      url: `${SITE_URL}/verified`,
      isPartOf: { "@type": "WebSite", "@id": WEBSITE_ID, name: "GradeThread", url: SITE_URL },
    } as JsonLd,
  ];
}

// ── US-9209: switch-from pages ────────────────────────────────────────────
const SWITCH_FROM_PUBLISHED = "2026-09-01";

export function switchFromBreadcrumbItems(page: SwitchFromPage): Array<{ name: string; url: string }> {
  return [
    { name: "GradeThread", url: `${SITE_URL}/` },
    { name: "Reselling", url: `${SITE_URL}${RESELLING_PILLAR_PATH}` },
    { name: `Switching from ${page.competitor}`, url: `${SITE_URL}${switchFromPath(page.slug)}` },
  ];
}

/** Article + the FAQ. No ItemList: the page compares nothing, it lists what moves. */
export function switchFromJsonLd(page: SwitchFromPage): JsonLd[] {
  return [
    articleLd({
      headline: page.h1,
      description: page.description,
      url: absoluteUrl(switchFromPath(page.slug)),
      datePublished: SWITCH_FROM_PUBLISHED,
      dateModified: SWITCH_FROM_PUBLISHED,
    }),
    faqPageLd(page.faqs),
  ];
}

// Page-specific JSON-LD + the FAQ/step data behind it, in a non-component module
// so (a) the marketing page .tsx files stay components-only (react-refresh lint)
// and (b) the prerender head-builder (US-292) imports the SAME builders the live
// pages use — guaranteeing the prerendered <head> and the runtime SPA emit
// identical structured data.

import { howToLd, faqPageLd, breadcrumbLd, type JsonLd } from "@/lib/seo/json-ld";
import { LANDING_FAQS } from "@/pages/landing-faqs";
import { SITE_URL } from "@/lib/seo/public-routes";
import { glossaryTrail, type GlossaryEntry } from "@/lib/seo/glossary";

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

export const HOW_IT_WORKS_FAQS = [
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

export function pricingJsonLd(): JsonLd[] {
  return [faqPageLd(PRICING_FAQS)];
}

// ── /faq ───────────────────────────────────────────────────────────
export const FAQ_EXTRA = [
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
  return [faqPageLd(CONDITION_GRADING_FAQS)];
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
 * Page-specific JSON-LD for a glossary entry: a 3-level BreadcrumbList back to
 * the pillar + an FAQPage from the entry's visible Q&A. Organization is added
 * separately by the layout/head-builder, matching the other marketing pages.
 */
export function glossaryJsonLd(entry: GlossaryEntry): JsonLd[] {
  return [
    breadcrumbLd(glossaryBreadcrumbItems(entry)),
    faqPageLd(entry.faqs),
  ];
}

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
  transparencyDatasetLd,
  resaleConditionDatasetLd,
  definedTermLd,
  definedTermSetLd,
  type JsonLd,
} from "@/lib/seo/json-ld";
import { absoluteUrl } from "@/lib/seo/public-routes";
import { LANDING_FAQS } from "@/pages/landing-faqs";
import { SITE_URL } from "@/lib/seo/public-routes";
import {
  glossaryTrail,
  GLOSSARY_ENTRIES,
  type GlossaryEntry,
} from "@/lib/seo/glossary";

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
];

export function gradingStandardJsonLd(): JsonLd[] {
  return [faqPageLd(GRADING_STANDARD_FAQS)];
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
export const RESALE_REPORT_MODIFIED = "2026-06-18";
// Open-ended ISO 8601 interval — the coverage window starts at the platform's
// first recorded resale data and runs to "now". The visible page states the
// exact observed min/max dates from the live data.
export const RESALE_REPORT_TEMPORAL_COVERAGE = "2026-01-01/..";

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
    q: "Can I cite this data?",
    a: "Yes. The report is published under a CC BY 4.0 license with a canonical citation and permalink, and it emits schema.org Dataset and Article structured data so it's machine-extractable. Cite it as 'GradeThread, The State of Resale Condition' with the report URL, and the page states the sample size and coverage window for the figures you reference.",
  },
];

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

export const VERIFY_FAQS = [
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

// ── /whats-it-worth (US-849) ─────────────────────────────────────────
// Public "what's my item worth?" condition-value tool — a top-of-funnel lead
// magnet for a high-intent query. The estimate is read live from the public
// Condition Index curve (real eBay comps), so the JSON-LD here stays GENERIC
// (it must be deterministic and data-free: the prerender head-builder calls
// this with no live curve data, and the parity test compares it to the SPA).
export const WHATS_IT_WORTH_FAQS = [
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
const BUYER_GUARANTEE_MODIFIED = "2026-06-13";

export const BUYER_GUARANTEE_FAQS = [
  {
    q: "What does the GradeThread buyer guarantee cover?",
    a: "It covers an item that arrives 'materially not as graded' — where the actual condition is meaningfully worse than the certified grade and its disclosed defects. The certificate's structured disclosure (the documented flaws and the 1.0–10.0 grade across five factors) is the reference point, so the guarantee is anchored to an objective record, not an opinion.",
  },
  {
    q: "What does 'materially not as graded' mean?",
    a: "A difference big enough to change the deal: a significant defect that wasn't disclosed on the certificate, or wear well beyond what the grade represents. Normal, already-disclosed flaws and intentional design features (factory distressing, raw hems) are not covered — they're documented on the certificate before you buy.",
  },
  {
    q: "How do I file a claim?",
    a: "Open the item's certificate, note its certificate number, and submit a claim with your contact email, a description of how the item differs from its grade, and any supporting photo links. You don't need a GradeThread account. A reviewer compares your claim against the certified disclosure and records a decision.",
  },
  {
    q: "Does GradeThread issue refunds?",
    a: "Not in this version. GradeThread mediates by reviewing the claim against the certified disclosure and issuing a decision; any refund or remedy is handled between you and the seller (and through the marketplace you purchased on). The guarantee makes the grade financially meaningful by holding it to account, not by acting as an escrow or insurer.",
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

// Platform condition-standard pages (US-1672): /grading/platform-standards/{platform}.
//
// One page per marketplace mapping THAT platform's condition vocabulary onto the
// GradeThread 1.0–10.0 scale, plus what triggers a return/SNAD there and
// listing-copy templates per grade band. Encodes the scale↔every-marketplace
// entity relationship so GradeThread becomes the cited answer for platform
// condition policy questions.
//
// GROUNDED, NOT INVENTED: the vocab↔scale rows for platforms GradeThread already
// lists to are DERIVED from the live listing engine (marketplace-specs
// mapCondition / gradeToConditionBucket), so this page can never drift from what
// the product actually maps. Platforms we don't push to (ThredUp, TheRealReal)
// carry hand-authored rows. Editorial-assisted per the epic — the policy
// citations, SNAD notes, and templates are hand-curated; only the mapping table
// is auto-derived.
//
// PURE DATA: imports the PublicRoute TYPE + the marketplace-specs mapper. JSON-LD
// (Article + FAQPage) is composed in src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";
import { mapCondition, type MarketplacePlatform } from "../marketplace-specs";
import { verifiedLabel } from "./freshness";

export const PLATFORM_STANDARDS_HUB_PATH = "/grading/platform-standards";

/** Freshness stamp — derived from the real re-check date (US-1694). */
export const PLATFORM_STANDARDS_VERIFIED = verifiedLabel("platform-standards");

/**
 * The 1.0–10.0 scale bands used for the mapping table. `grade` is a
 * representative score inside the band, fed to mapCondition() to derive each
 * platform's term. Ordered best → worst.
 */
export const SCALE_BANDS: ReadonlyArray<{
  tier: string;
  range: string;
  grade: number;
  /** One-line description of the band, reused in listing-copy templates. */
  blurb: string;
}> = [
  { tier: "New With Tags", range: "9.75–10.0", grade: 9.9, blurb: "brand new, unworn, with original tags attached" },
  { tier: "New Without Tags", range: "9.0–9.5", grade: 9.2, blurb: "unworn or as-new, no tags" },
  { tier: "Excellent", range: "7.5–8.5", grade: 8.0, blurb: "very light wear, no notable flaws" },
  { tier: "Very Good", range: "6.0–7.0", grade: 6.5, blurb: "light, honest wear with minor cosmetic signs" },
  { tier: "Good", range: "4.5–5.5", grade: 5.0, blurb: "clear wear or a minor flaw, fully wearable" },
  { tier: "Fair", range: "3.0–4.0", grade: 3.5, blurb: "significant wear or a disclosed defect" },
  { tier: "Poor", range: "1.0–2.5", grade: 2.0, blurb: "heavy wear or damage; sold as-is for parts/repair" },
];

/** A hand-authored vocab row for a platform GradeThread doesn't push to. */
export interface ManualRow {
  tier: string;
  range: string;
  /** The platform's own condition wording (or a note when it won't accept the band). */
  platformTerm: string;
}

export interface PlatformStandard {
  slug: string;
  /** Display name, e.g. "eBay". */
  name: string;
  /** <title> without the " | GradeThread" suffix — ≤ 46, unique. */
  title: string;
  /** Meta description — 70–160, unique. */
  description: string;
  h1: string;
  /** Quotable one-paragraph answer block (AI-citable). */
  definition: string;
  intro: string;
  /** Cite the platform's published condition/returns policy. */
  policyName: string;
  policyUrl: string;
  /** When set, rows are DERIVED from marketplace-specs mapCondition (single source of truth). */
  specPlatform?: MarketplacePlatform;
  /** When specPlatform is unset, hand-authored rows (ThredUp, TheRealReal). */
  rows?: ManualRow[];
  /** What triggers a return / "significantly not as described" on this platform. */
  snad: string;
  /** Platform-specific listing-copy guidance. */
  listingTips: string;
  faqs: Array<{ q: string; a: string }>;
}

export function platformStandardPath(slug: string): string {
  return `${PLATFORM_STANDARDS_HUB_PATH}/${slug}`;
}

/** Resolve the vocab↔scale rows: derived from the listing engine, or hand-authored. */
export function platformScaleRows(std: PlatformStandard): ManualRow[] {
  if (std.rows) return std.rows;
  if (std.specPlatform) {
    const platform = std.specPlatform;
    return SCALE_BANDS.map((b) => ({
      tier: b.tier,
      range: b.range,
      platformTerm: mapCondition(platform, b.grade, b.tier)?.label ?? "—",
    }));
  }
  return [];
}

export const PLATFORM_STANDARDS: PlatformStandard[] = [
  {
    slug: "ebay",
    name: "eBay",
    title: "eBay Conditions: Which One Avoids Returns",
    description:
      "How eBay's item conditions map to a 1.0–10.0 grade, what triggers a not-as-described return, and the listing copy that matches the condition you picked.",
    h1: "eBay condition standards mapped to the 1.0–10.0 scale",
    definition:
      "eBay uses a fixed set of item conditions — New, New other, and the Used tiers (Excellent, Very Good, Good, Acceptable) for pre-owned clothing. Each maps cleanly onto a band of the GradeThread 1.0–10.0 scale, so an objective grade tells you exactly which eBay condition to select and backs it up.",
    intro:
      "eBay's condition field is a required, structured value — and picking the wrong one is a direct path to a 'not as described' case. This page maps every eBay clothing condition to the GradeThread scale, shows what triggers a return, and gives listing copy for each grade.",
    policyName: "eBay Money Back Guarantee & item condition guidelines",
    policyUrl: "https://www.ebay.com/help/policies",
    specPlatform: "ebay",
    snad: "On eBay, a buyer opens an 'item not as described' case when the garment's real condition is worse than the selected condition or the photos implied. eBay resolves these in the buyer's favor by default and counts them against your seller metrics, so never select a condition better than the item's actual grade.",
    listingTips:
      "Select the eBay condition that matches the item's grade band, then use the condition-description field to state the grade and disclose every flaw. A stated grade plus a certificate link is the strongest defense against a condition case.",
    faqs: [
      {
        q: "What does 'Used - Very Good' mean on eBay?",
        a: "eBay's 'Used - Very Good' is a pre-owned item with light, honest wear and no major flaws — equivalent to roughly 6.0–7.0 on the GradeThread 1.0–10.0 scale. Select it only when the item's actual condition matches; overstating it invites a 'not as described' case.",
      },
      {
        q: "How do I avoid 'not as described' returns on eBay?",
        a: "Pick the eBay condition that matches the item's real grade, disclose every flaw with photos, and state the grade in the condition description. eBay sides with buyers on condition disputes, so accurate, verifiable condition up front is your best protection.",
      },
    ],
  },
  {
    slug: "poshmark",
    name: "Poshmark",
    title: "Poshmark Condition Standards, Mapped",
    description:
      "How Poshmark condition wording (NWT, EUC, VGUC, GUC) maps to a 1.0–10.0 grade, what triggers a Posh Protect case, and listing copy per grade.",
    h1: "Poshmark condition standards mapped to the 1.0–10.0 scale",
    definition:
      "Poshmark structures only 'New With Tags' — every other condition is free text, and sellers lean on community shorthand: EUC (Excellent Used Condition), VGUC (Very Good Used Condition), GUC (Good Used Condition). Mapping that shorthand to the GradeThread 1.0–10.0 scale turns fuzzy adjectives into a verifiable grade.",
    intro:
      "Because Poshmark leaves condition to the description, the acronym you choose sets the buyer's expectation — and a mismatch triggers a Posh Protect case. This page maps Poshmark's condition shorthand to the GradeThread scale with listing copy for each grade.",
    policyName: "Posh Protect buyer protection",
    policyUrl: "https://support.poshmark.com",
    specPlatform: "poshmark",
    snad: "Poshmark buyers open a Posh Protect case for an item 'not as described' — most often condition worse than the EUC/VGUC/GUC claim or an undisclosed flaw. Poshmark reviews photos and descriptions, so an accurate acronym backed by a grade and flaw photos is what protects the sale.",
    listingTips:
      "Use the NWT toggle only for genuinely tagged-new items. For everything else, state the acronym AND the grade in the description ('VGUC — graded 6.5/10, light pilling at cuffs, see photos'), which removes the ambiguity buyers dispute.",
    faqs: [
      {
        q: "What does VGUC mean on Poshmark?",
        a: "VGUC means 'Very Good Used Condition' — a pre-owned item with light wear and minor cosmetic signs, roughly 6.0–7.0 on the GradeThread 1.0–10.0 scale. Because Poshmark condition is free text, pairing the acronym with a grade makes it verifiable.",
      },
      {
        q: "Can a buyer return an item on Poshmark?",
        a: "Poshmark doesn't allow returns for fit or change-of-mind, but a buyer can open a Posh Protect case if an item is not as described — including condition worse than stated or an undisclosed flaw. Accurate condition and disclosed flaws are what prevent these.",
      },
    ],
  },
  {
    slug: "mercari",
    name: "Mercari",
    title: "Mercari Condition Standards, Mapped",
    description:
      "How Mercari's 5-step condition scale (New to Poor) maps to a 1.0–10.0 grade, what triggers a Mercari return, and listing copy per grade.",
    h1: "Mercari condition standards mapped to the 1.0–10.0 scale",
    definition:
      "Mercari uses a five-step condition selector — New, Like new, Good, Fair, Poor. Each step spans a band of the GradeThread 1.0–10.0 scale, so a grade tells you which step to pick and gives you the evidence to back it if a buyer disputes it.",
    intro:
      "Mercari's five-step condition is required and coarse, which makes the description carry the nuance. This page maps each Mercari step to the GradeThread scale, shows what triggers a return, and provides listing copy per grade.",
    policyName: "Mercari Buyer Protection & return policy",
    policyUrl: "https://www.mercari.com/help_center/",
    specPlatform: "mercari",
    snad: "Mercari buyers can request a return within the rating window if an item is not as described — condition worse than the selected step or an undisclosed flaw. Mercari holds payment until the buyer confirms, so accurate condition and clear flaw photos prevent the dispute before it reaches that gate.",
    listingTips:
      "Pick the Mercari step that matches the grade band, then use the description to state the grade and disclose specifics ('Good — graded 5.0/10, small mark on hem shown in photo 3'). The coarser the selector, the more the description has to carry.",
    faqs: [
      {
        q: "What does 'Good' condition mean on Mercari?",
        a: "On Mercari's five-step scale, 'Good' is a used item with clear but acceptable wear — roughly 4.5–5.9 on the GradeThread 1.0–10.0 scale. Because the scale is coarse, describe the specific wear and state the grade so the buyer knows exactly what to expect.",
      },
      {
        q: "How do Mercari returns work?",
        a: "A Mercari buyer can request a return within the rating window if the item is not as described. Mercari holds the payment until the buyer confirms the order, so accurate condition disclosure up front is what keeps a sale from turning into a return.",
      },
    ],
  },
  {
    slug: "depop",
    name: "Depop",
    title: "Depop Conditions: Which to Pick, and Why",
    description:
      "How Depop's wording (Brand new down to Used–fair) maps to a 1.0–10.0 grade, what triggers a Buyer Protection claim, and the listing copy for each grade.",
    h1: "Depop condition standards mapped to the 1.0–10.0 scale",
    definition:
      "Depop uses a short condition list — Brand new, Like new, Used – excellent, Used – good, Used – fair. Each maps to a band of the GradeThread 1.0–10.0 scale, so a grade removes the guesswork from which Depop condition to choose.",
    intro:
      "Depop's young, style-driven buyers rely on the condition tag and your photos. Overstating condition is the fast track to a Buyer Protection claim. This page maps Depop's conditions to the GradeThread scale with listing copy per grade.",
    policyName: "Depop Buyer Protection",
    policyUrl: "https://depophelp.zendesk.com",
    specPlatform: "depop",
    snad: "A Depop buyer opens a Buyer Protection claim when an item arrives not as described — condition worse than the tag or an undisclosed flaw. Depop reviews the listing and messages, so an accurate condition tag plus flaw photos and a grade is what resolves it in your favor.",
    listingTips:
      "Choose the Depop condition that matches the grade band, and put the grade plus any flaws in the description and photos. Depop is photo-first, so a clear flaw shot does more than a paragraph.",
    faqs: [
      {
        q: "What does 'Used – excellent' mean on Depop?",
        a: "Depop's 'Used – excellent' is a pre-owned item with very light wear and no notable flaws — roughly 7.5–8.5 on the GradeThread 1.0–10.0 scale. Pair the tag with a grade and clear photos so the buyer's expectation matches what ships.",
      },
      {
        q: "Does Depop accept returns?",
        a: "Depop doesn't require sellers to accept change-of-mind returns, but a buyer can open a Buyer Protection claim for an item not as described, including condition worse than stated. Accurate condition and disclosed flaws prevent these claims.",
      },
    ],
  },
  {
    slug: "grailed",
    name: "Grailed",
    title: "Grailed Condition Standards, Mapped",
    description:
      "How Grailed's condition tiers (New to Very worn) map to a 1.0–10.0 grade, what triggers a Grailed Buyer Protection dispute, and listing copy per grade.",
    h1: "Grailed condition standards mapped to the 1.0–10.0 scale",
    definition:
      "Grailed uses a four-step condition scale — New/New with tags, Gently used, Used, Very worn — for a discerning menswear and designer audience. Mapping it to the GradeThread 1.0–10.0 scale gives buyers who scrutinize condition an objective, verifiable read.",
    intro:
      "Grailed buyers are condition-obsessed and higher-spend, so an overstated condition costs more when it goes wrong. This page maps Grailed's four steps to the GradeThread scale with listing copy for each grade.",
    policyName: "Grailed Buyer Protection & condition guidelines",
    policyUrl: "https://www.grailed.com/help",
    specPlatform: "grailed",
    snad: "A Grailed buyer opens a dispute through Buyer Protection when a piece is not as described — condition below the stated step or undisclosed flaws on a high-value item. Detailed flaw photos and a grade are what carry a designer-piece dispute in your favor.",
    listingTips:
      "Select the Grailed condition matching the grade, then over-document: on higher-value designer pieces, buyers expect flaw-level photos and a precise grade. State the grade and link the certificate.",
    faqs: [
      {
        q: "What does 'Gently used' mean on Grailed?",
        a: "Grailed's 'Gently used' is a pre-owned piece with light wear and no significant flaws — roughly 6.0–8.5 on the GradeThread 1.0–10.0 scale. Grailed buyers scrutinize condition, so a precise grade and flaw photos matter more here than on most platforms.",
      },
      {
        q: "How does Grailed Buyer Protection handle condition disputes?",
        a: "Grailed Buyer Protection lets a buyer dispute an item that's not as described, and reviews the listing, photos, and messages. On higher-value designer pieces, detailed flaw photos and an objective grade are the evidence that resolves a condition dispute.",
      },
    ],
  },
  {
    slug: "vinted",
    name: "Vinted",
    title: "Vinted Condition Standards, Mapped",
    description:
      "How Vinted's condition options (New to Satisfactory) map to a 1.0–10.0 grade, what triggers a Buyer Protection claim, and listing copy per grade.",
    h1: "Vinted condition standards mapped to the 1.0–10.0 scale",
    definition:
      // Names re-read 2026-09-05 from https://www.vinted.com/help/50-choosing-item-condition.
      // They used to say "New with tags / New without tags", which is eBay's
      // vocabulary; Vinted splits its two unworn options on packaging instead.
      "Vinted uses five condition options — New, Like new, Very good, Good, Satisfactory. Each maps to a band of the GradeThread 1.0–10.0 scale, so a grade tells you which Vinted option is honest and gives you evidence if it's questioned.",
    intro:
      "Vinted's Buyer Protection fee makes buyers expect the item to match the listing exactly. This page maps Vinted's condition options to the GradeThread scale with listing copy for each grade.",
    policyName: "Vinted Buyer Protection",
    policyUrl: "https://www.vinted.com/help",
    specPlatform: "vinted",
    snad: "Vinted buyers raise an issue under Buyer Protection when an item isn't as described — condition below the selected option or an undisclosed flaw — and Vinted can refund from held funds. Accurate condition and flaw photos prevent the hold from turning into a refund.",
    listingTips:
      "Choose the Vinted option that matches the grade band and describe the specific wear. Vinted is a manual, photo-led platform, so put the grade in the description and show every flaw.",
    faqs: [
      {
        q: "What does 'Satisfactory' mean on Vinted?",
        a: "Vinted's 'Satisfactory' is its lowest listable condition — a used item with clear or significant wear, roughly 3.0–4.5 on the GradeThread 1.0–10.0 scale. Describe the wear precisely and show it in photos, because buyers hold Vinted listings to the exact condition stated.",
      },
      {
        q: "How does Vinted Buyer Protection handle not-as-described items?",
        a: "Vinted holds the payment until the buyer accepts the order; if the item isn't as described, the buyer can raise an issue and Vinted may refund from the held funds. Accurate condition disclosure up front is what prevents that outcome.",
      },
    ],
  },
  {
    slug: "whatnot",
    name: "Whatnot",
    title: "Whatnot Condition Standards, Mapped",
    description:
      "How Whatnot's condition options map to a 1.0–10.0 grade, what triggers a Whatnot return, and how to state condition clearly in live sales.",
    h1: "Whatnot condition standards mapped to the 1.0–10.0 scale",
    definition:
      "Whatnot's live-selling format uses condition options from new to fair, but the real condition signal is what you say and show on stream. Mapping Whatnot's conditions to the GradeThread 1.0–10.0 scale gives live buyers a fast, objective read in a fast-moving format.",
    intro:
      "In a live Whatnot sale, buyers commit in seconds, so a clear condition call on stream prevents post-sale returns. This page maps Whatnot's conditions to the GradeThread scale with guidance for stating condition live.",
    policyName: "Whatnot returns & buyer protection",
    policyUrl: "https://help.whatnot.com",
    specPlatform: "whatnot",
    snad: "A Whatnot buyer can request a return when an item is not as described — condition worse than stated on stream or in the listing. Because live sales move fast, calling the grade out loud and showing flaws on camera is what prevents a not-as-described return.",
    listingTips:
      "State the condition option and the grade on stream and in the listing, and hold flaws up to the camera. In a live format, an out-loud grade ('this one's an 8, light wear on the hem') sets the expectation before the buyer commits.",
    faqs: [
      {
        q: "How is condition handled on Whatnot?",
        a: "Whatnot listings carry a condition option, but in live sales the spoken and on-camera condition call is what buyers act on. Mapping to an objective 1.0–10.0 grade lets you state condition fast and consistently, which reduces post-sale returns.",
      },
      {
        q: "Can you return an item bought on a Whatnot live?",
        a: "A Whatnot buyer can request a return if an item is not as described, including condition worse than stated on stream. Calling out the grade and showing flaws on camera before the sale is the best way to prevent it.",
      },
    ],
  },
  {
    slug: "thredup",
    name: "ThredUp",
    title: "ThredUp Condition Standards, Mapped",
    description:
      "How ThredUp's condition standards map to a 1.0–10.0 grade, why ThredUp rejects lower-condition items, and what its quality bar means for sellers.",
    h1: "ThredUp condition standards mapped to the 1.0–10.0 scale",
    definition:
      "ThredUp is a managed consignment marketplace that inspects and grades items itself, listing them as New With Tags, Like New, or Gently Used — and rejecting anything below its quality bar. Mapping those labels to the GradeThread 1.0–10.0 scale shows exactly where ThredUp's cutoff falls.",
    intro:
      "Unlike peer-to-peer platforms, ThredUp grades items for you and won't accept lower-condition pieces at all. This page maps ThredUp's condition labels to the GradeThread scale so you know what will pass before you send it in.",
    policyName: "ThredUp condition standards",
    policyUrl: "https://support.thredup.com",
    rows: [
      { tier: "New With Tags", range: "9.75–10.0", platformTerm: "New With Tags" },
      { tier: "New Without Tags", range: "9.0–9.5", platformTerm: "Like New" },
      { tier: "Excellent", range: "7.5–8.5", platformTerm: "Like New" },
      { tier: "Very Good", range: "6.0–7.0", platformTerm: "Gently Used" },
      { tier: "Good", range: "4.5–5.5", platformTerm: "Gently Used" },
      { tier: "Fair", range: "3.0–4.0", platformTerm: "Typically not accepted" },
      { tier: "Poor", range: "1.0–2.5", platformTerm: "Not accepted" },
    ],
    snad: "Because ThredUp inspects and grades items itself, the 'dispute' happens at intake: items below its quality bar (roughly Fair and below) are rejected or recycled rather than listed. Knowing where the cutoff sits saves you the shipping on items that won't make it.",
    listingTips:
      "You don't write the ThredUp listing — ThredUp grades and lists the item. The lever you control is what you send: grade items first and only send those that clear the Gently Used bar (roughly 6.0+), so your payout isn't eaten by rejects.",
    faqs: [
      {
        q: "What condition does ThredUp accept?",
        a: "ThredUp accepts items in roughly Gently Used condition or better — about 6.0 and up on the GradeThread 1.0–10.0 scale — and rejects heavily worn or flawed pieces at intake. Grading before you send avoids paying to ship items that won't be listed.",
      },
      {
        q: "Does ThredUp grade condition for you?",
        a: "Yes. ThredUp is a managed marketplace that inspects and grades each item itself, listing it as New With Tags, Like New, or Gently Used. Sellers don't set the condition — the value of grading first is knowing what will clear ThredUp's bar.",
      },
    ],
  },
  {
    slug: "therealreal",
    name: "The RealReal",
    title: "The RealReal Condition Standards, Mapped",
    description:
      "How The RealReal's condition scale (Pristine to Fair) maps to a 1.0–10.0 grade, plus what its luxury-consignment quality bar means for sellers.",
    h1: "The RealReal condition standards mapped to the 1.0–10.0 scale",
    definition:
      "The RealReal is a luxury consignment marketplace that authenticates and condition-grades items itself, using a scale of New With Tags, Pristine, Excellent, Very Good, Good, and Fair. Mapping it to the GradeThread 1.0–10.0 scale shows how its luxury bar lines up with an objective grade.",
    intro:
      "The RealReal grades condition for you and reserves its top tiers for near-flawless luxury pieces. This page maps its condition scale to the GradeThread scale so you know how a piece is likely to be graded before you consign it.",
    policyName: "The RealReal condition guidelines",
    policyUrl: "https://www.therealreal.com/customer_service",
    rows: [
      { tier: "New With Tags", range: "9.75–10.0", platformTerm: "New With Tags" },
      { tier: "New Without Tags", range: "9.0–9.5", platformTerm: "Pristine" },
      { tier: "Excellent", range: "7.5–8.5", platformTerm: "Excellent" },
      { tier: "Very Good", range: "6.0–7.0", platformTerm: "Very Good" },
      { tier: "Good", range: "4.5–5.5", platformTerm: "Good" },
      { tier: "Fair", range: "3.0–4.0", platformTerm: "Fair" },
      { tier: "Poor", range: "1.0–2.5", platformTerm: "Below consignment bar" },
    ],
    snad: "The RealReal condition-grades items at intake, so condition 'disputes' are really its graders assigning a lower tier than you expected — which lowers your payout — or rejecting a piece below its bar. An objective grade beforehand sets a realistic expectation.",
    listingTips:
      "You don't write The RealReal listing — its experts authenticate and grade the item. Grade it yourself first so you can predict which tier it lands in and price your expectations accordingly; luxury 'Pristine' maps to near-new (9.0+) only.",
    faqs: [
      {
        q: "What does 'Pristine' mean on The RealReal?",
        a: "The RealReal's 'Pristine' is a never-worn or as-new luxury item — roughly 9.0–9.5 on the GradeThread 1.0–10.0 scale. It's a top tier reserved for near-flawless pieces, below only New With Tags.",
      },
      {
        q: "Does The RealReal grade condition itself?",
        a: "Yes. The RealReal authenticates and condition-grades every item at intake using its own scale (Pristine, Excellent, Very Good, Good, Fair). Grading a piece yourself first helps you predict the tier it will land in and set realistic payout expectations.",
      },
    ],
  },
];

const STANDARD_BY_PATH = new Map(
  PLATFORM_STANDARDS.map((s) => [platformStandardPath(s.slug), s]),
);

export function getPlatformStandardBySlug(slug: string): PlatformStandard | undefined {
  return PLATFORM_STANDARDS.find((s) => s.slug === slug);
}

export function getPlatformStandardByPath(path: string): PlatformStandard | undefined {
  return STANDARD_BY_PATH.get(path.replace(/\/+$/, ""));
}

export function isPlatformStandardsHubPath(path: string): boolean {
  return path.replace(/\/+$/, "") === PLATFORM_STANDARDS_HUB_PATH;
}

export function platformStandardsRoutes(): PublicRoute[] {
  const hub: PublicRoute = {
    path: PLATFORM_STANDARDS_HUB_PATH,
    title: "Marketplace Condition Standards",
    description:
      "How each marketplace's condition vocabulary maps to the 1.0–10.0 scale — eBay, Poshmark, Mercari, Depop, Grailed, Vinted, Whatnot, ThredUp, and more.",
    changefreq: "monthly",
    priority: 0.6,
    // US-2044: jsonLdType must describe what is ACTUALLY prerendered — it is
    // now enforced by jsonld-parity.test.tsx, so a decorative value fails the
    // build rather than quietly misinforming the next reader.
    // US-2072: now emits a real CollectionPage + ItemList enumerating this
    // hub's children, so an AI answer engine can read the set whole rather
    // than scrape it out of prose. Declaring it here makes the US-2044 parity
    // test enforce that the markup keeps being prerendered.
    jsonLdType: "CollectionPage",
  };
  const pages: PublicRoute[] = PLATFORM_STANDARDS.map((s) => ({
    path: platformStandardPath(s.slug),
    title: s.title,
    description: s.description,
    changefreq: "monthly",
    priority: 0.6,
    jsonLdType: "Article",
  }));
  return [hub, ...pages];
}

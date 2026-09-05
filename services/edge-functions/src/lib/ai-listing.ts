// FlipDesk AutoLister (US-311): eBay listing generation prompt + structured schema.
//
// This is DISTINCT from clothing grading (ai-grading.ts) and from the
// attribute extractor / copywriter (ai-extract.ts): it turns a grouped item's
// photos directly into a complete, publish-ready eBay listing object —
// title, description, a category *query* to resolve against the Taxonomy API,
// eBay condition + narrative, item specifics, and a suggested price.
//
// US-311 ships the prompt, the tool schema, the version constant, the
// DB-driven prompt resolver (mirrors ai-grading.ts:resolveActivePrompt), and
// the core Claude call. US-312 layers the orchestration on top: photo
// download, category/aspect resolution, comp-based pricing, and the draft
// write. Activation of a DB override is gated by the eval harness + the
// listing_gen seed row in migration 00053.

import Anthropic from "@anthropic-ai/sdk";
import {
  ASPECT_REGISTRY,
  type RegistryAspect,
  type RegistryItem,
  resolveItemAspects,
} from "./aspect-registry.ts";
import {
  getAiTemperature,
  getAnthropicClient,
  getPlatformVariantModel,
  isCachingEnabled,
} from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { getActionCascadeConfig, runActionCascade } from "./ai-action-cascade.ts";
import {
  estimateCost,
  extractEbayAspects,
  getHaikuModel,
  type AspectValueSuggestion,
  type EbayAspectSpec,
  type ResearchIdentification,
} from "./ai-extract.ts";
import {
  isEasyAspectCategory,
  selectAspectPhotos,
  selectListingPhotos,
} from "./listing-photo-budget.ts";
import {
  type BrowseCompCategoryVote,
  type CategorySuggestion,
  fetchCategoryLeafStatus,
  getCategoryAspects,
  getItemConditionPolicies,
  searchBrowseComps,
} from "./ebay-client.ts";
// US-3043: the batch path decides the category and pre-fills specifics from
// the visual pass the same way the one-item path (routes/flipdesk-ai.ts) has
// since US-2765/US-2770. It computed both and threw them away until now.
import {
  type CategoryDecision,
  type DecideCategoryArgs,
  decideCategory,
} from "./category-decision.ts";
import { visualAspectPrefill } from "./visual-aspect-prefill.ts";
// 2026-09-02: the 12-hour suggestion cache the Scout path already used. A
// 300-item batch of the same garment word was asking eBay the same question
// 300 times.
import { cachedSuggestCategories } from "./taxonomy-cache.ts";
// The kit's source description is the rendered eBay HTML; the model gets the
// words, not the markup.
import { htmlToPlainText } from "./cert-description.ts";
// US-3031: settles the generated condition against the leaf's allow-list. The
// type-only edge of this pair (publish-preflight imports EbayCondition from
// here) is erased at compile time, so there is no runtime import cycle.
import { resolveDraftCondition } from "./publish-preflight.ts";
import {
  filterListablePhotos,
  type ItemPhotoUrlRow,
  itemPhotoAiUrls,
} from "./item-photo-storage.ts";
import {
  buildCandidateBlock,
  type CandidateRuling,
  dropUnevidenced,
  EVIDENCE_PRECEDENCE,
  parseRulings,
  type VisualCandidate,
} from "./visual-candidates.ts";
import { startVisualPass } from "./visual-identify-pass.ts";
import { corroborateStyleName } from "./visual-style-names.ts";
import {
  type BrandKnowledgePack,
  resolveBrandKnowledgePack,
} from "./brand-knowledge.ts";
import {
  applyLearnedStyleToListing,
  learnedStyleForListing,
  type LearnedStyleForListing,
  resolveListingStyleCode,
} from "./listing-style-code.ts";
import {
  planListingRegisteredNumber,
  RN_CONTRADICTION_BRAND_CONFIDENCE,
} from "./listing-registered-number.ts";
import {
  assessRegisteredNumber,
  getRegisteredNumberContext,
  recordRegisteredNumberSighting,
} from "./registered-numbers.ts";
import {
  lookupLearnedStyle,
  recordStyleCodeObservations,
} from "./style-code-observations.ts";
import {
  recordCategoryDecision,
  recordExtractionProvenance,
} from "./identification-provenance.ts";
import { withTemplateBlock } from "./listing-template.ts";
import { withRetry } from "./retry.ts";
import { supabaseAdmin } from "./supabase.ts";
import { ensurePassportForGradeReport } from "./passport-write.ts";
import {
  type AspectSourceMap,
  mergeSources,
  type RankedAspectSpec,
  recommendedAspectCoverage,
  type RequiredAspectSpec,
  requiredMissingAspects,
  sourcesFor,
} from "./aspect-provenance.ts";
import {
  MAX_ALLOWED_VALUES_PER_ASPECT,
  prioritizeByDemand,
} from "./aspect-priority.ts";
import {
  type AspectReviewEntry,
  reconcileGeneratedAspects,
  specsFromEbayAspectSpecs,
} from "./aspect-reconcile.ts";
import {
  buildPlainMeasurementsText,
  hasCalibratedMeasurements,
  resolveMeasurementAspects,
} from "./measurements.ts";
// US-2595: the two passes that make a MeasureCard shot one-and-done — the
// calibrated measurement extraction, and the size estimate that used to require
// pressing "Estimate" on the composer.
import { autofillMeasurementsFromCard } from "./measure-autofill.ts";
import { estimateSize } from "./ai-size-estimate.ts";
import {
  prioritizeMeasurementPhotos,
  SIZE_ESTIMATE_LOW_CONFIDENCE,
} from "./ai-size-estimate-core.ts";
import {
  buildDisclosure,
  type DisclosureInput,
  type PerImageAnalysisLike,
} from "./disclosure.ts";
import {
  loadSellerCredential,
  loadSellerCredentialBlock,
} from "./seller-credentials-job.ts";
import {
  getMarketplaceSpec,
  type MarketplacePlatform,
} from "./marketplace-specs.ts";
import { resolveMarketplaceCategory } from "./marketplace-category-resolve.ts";
import { EBAY_TITLE_MAX, trimTitleToLimit } from "./title-trim.ts";
import {
  getEbaySearchDemandTermsDetailed,
  type TitleVariant,
} from "./demand-terms.ts";
import { getRealizedComps } from "./sold-comps.ts";
import {
  extractTagGroundTruth,
  mergeTagGroundTruth,
  planTagRoleWriteback,
  selectTagOcrPhotos,
  shouldRunTagRolePass,
  tagAttributeFill,
  tagImageSource,
  type TagGroundTruth,
} from "./ai-tag-ocr.ts";
import { classifyPhotoRoles } from "./ai-photo-roles.ts";
import {
  applyCanonicalBrandAndStyle,
  brandKey,
  canonicalizeBrand,
  resolveStyleCode,
  type StyleResolution,
} from "./brand-normalize.ts";
// US-2682: the machine-readable facts block. Emitted last and exactly once, so
// a revise replaces it rather than stacking a second copy.
// disclosedFlawsToFacts and measurementsToFacts left with the facts block
// (US-2959): renderDescription builds the facts from the RenderContext now, so
// the generation path no longer assembles them itself.
import {
  factorScoresToFacts,
  type FactsGradeFactor,
} from "./listing-facts-block.ts";
// US-2959: the one renderer. The generation path builds blocks and renders
// them; it no longer concatenates a description of its own.
import {
  defaultBlocks,
  renderDescription,
  type RenderContext,
  scrubRestatedFacts,
} from "./description-blocks.ts";

// US-542: where a draft's suggested price came from. Only the sold-backed
// sources (private_sales, ebay_sold) justify price_is_estimated=false.
export type PriceCompSource =
  | "ai_estimate"
  | "active_asking"
  | "private_sales"
  | "ebay_sold";

// Active-comp confidence: lower than realized-comp confidence because asking
// prices over-state value. Caps below the sold-backed floor so the UI can rank
// a sold-backed price above an asking-based one.
function activeCompConfidence(count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(0.6, 0.15 + count * 0.03));
}

// Bump when the prompt or tool schema changes in a way that should be tracked
// for accuracy/eval attribution. Mirrors PER_IMAGE_PROMPT_VERSION etc.
export const LISTING_GEN_PROMPT_VERSION = "listing_gen_v1";

// US-1900: the v-next challenger. Registered as an INACTIVE ai_prompt_versions
// row (migration 00446) so it can be eval-gated and A/B-trialed via the
// existing lifecycle WITHOUT hot-swapping the live v1 prompt. Its text lives in
// code (LISTING_GEN_SYSTEM_PROMPT_V2) and the DB row carries empty prompt_text —
// resolvePromptText() maps the version_name back to the code constant.
export const LISTING_GEN_PROMPT_VERSION_V2 = "listing_gen_v2";

// eBay Sell API condition enum values. Kept in sync with mapEbayCondition in
// flipdesk-ebay.ts so generated drafts publish without a translation step.
export const EBAY_CONDITION_VALUES = [
  "NEW",
  // NEW_OTHER ("New without tags", id 1500) + NEW_WITH_DEFECTS ("New with
  // defects", id 1750) are eBay's apparel-specific new conditions. Without them
  // the grade-9 NWOT tier mismapped to LIKE_NEW (2750), which most apparel
  // categories reject → publish error 25021.
  "NEW_OTHER",
  "NEW_WITH_DEFECTS",
  "LIKE_NEW",
  // eBay's granular PRE-OWNED apparel conditions (ids 2990 / 3010). Many clothing
  // leaves (Dresses, Women's Sweaters, …) accept ONLY {1000,1500,1750,2990,3000,
  // 3010} and reject the legacy USED_VERY_GOOD/GOOD/ACCEPTABLE (4000/5000/6000),
  // so without these two enums a genuinely pre-owned garment had no acceptable
  // condition to publish. 2990 = "Pre-owned - Excellent", 3010 = "Pre-owned -
  // Fair"; the middle tier "Pre-owned - Good" reuses USED_EXCELLENT (id 3000).
  "PRE_OWNED_EXCELLENT",
  "USED_EXCELLENT",
  "PRE_OWNED_FAIR",
  "USED_VERY_GOOD",
  "USED_GOOD",
  "USED_ACCEPTABLE",
  "FOR_PARTS_OR_NOT_WORKING",
] as const;

export type EbayCondition = (typeof EBAY_CONDITION_VALUES)[number];

// The structured listing object the AI must return. item_specifics is an
// open map of aspect name -> value(s); US-312 constrains it to the resolved
// category's allowed aspects on a second pass.
export interface GeneratedListing {
  title: string;
  // US-546 (AC3): an OPTIONAL alternate title (variant "B") the model returns in
  // the same tool call (zero extra cost). Empty when the model didn't supply a
  // distinct variant. The primary `title` is variant "A".
  title_variant: string;
  // US-2959: the description as its three PROSE parts. Facts live in their own
  // blocks (lib/description-blocks.ts) and are never repeated here.
  description_intro: string;
  description_features: string;
  description_condition: string;
  /**
   * The whole-description fallback, kept for one release so an active DB prompt
   * version written against the old contract still works. Empty once the model
   * fills the three fields above; when it is the only thing returned, it maps
   * to the intro.
   */
  description: string;
  // A short query (e.g. "men's denim jeans") resolved to a real eBay leaf
  // category via the Taxonomy API in US-312 — the model does NOT invent ids.
  suggested_category_query: string;
  ebay_condition: EbayCondition;
  condition_description: string;
  item_specifics: Record<string, string[]>;
  suggested_price_cents: number;
  confidence: number; // 0..1
}

export interface ListingGenPhoto {
  url: string;
  // flipdesk_photo_type hint, e.g. front | back | tag | tag_2 | detail |
  // detail_2..4 | interior | defect | flatlay | on_model | measurement_*
  type?: string;
  /** item_photos.id, when the photo came off the item (generation path). */
  id?: string;
}

export interface ListingGenInput {
  photos: ListingGenPhoto[];
  // Optional known attributes (brand/size/etc.) already captured for the item.
  knownFields?: Record<string, unknown>;
  // US-543: fields read VERBATIM off the garment's tag/care label by the
  // dedicated tag-OCR pass. Surfaced to the model as authoritative ground truth
  // (weighted above its own visual inference) so listings don't hallucinate
  // brand/size/fiber/style. Keyed like knownFields (brand/size/material/style).
  tagGroundTruth?: Record<string, string>;
  // Optional measurements (inches) to fold into the description.
  measurements?: Record<string, unknown>;
  // Optional: the resolved category's allowed aspects, used to steer
  // item_specifics on a constrained second pass (US-312). Aspect name ->
  // allowed values ([] = free text).
  allowedAspects?: Record<string, string[]>;
  // US-546 (AC2): high-demand eBay SEARCH terms mined from current listings for
  // this brand/category. Fed to the model to fold into the title/description
  // where they truthfully apply to THIS item. Ranked highest-demand first.
  demandTerms?: string[];
  // US-547: deterministic A/B key (the item id). Decides champion-vs-challenger
  // when a listing_gen challenger is in trial. Omit to force the champion.
  promptSelectKey?: string | null;
  // US-3088: spend-attribution slug for the AI ledger. Defaults to "autolister"
  // so every existing caller stays in the bucket it has always been in; the
  // free /listing-draft tool passes its own so an anonymous surface's Vision
  // spend is separable from a paying seller's.
  feature?: string;
  // US-1529: the research-tier identification persisted on the item's
  // attributes (US-1527/1528). When present, the title leads with the
  // identified style and the description gets line/fabric/MSRP context.
  // Absent → the prompt is byte-identical to today.
  identification?: ListingIdentification | null;
  // US-2778: what eBay's visual search thinks this garment is.
  //
  // NOT ground truth, and deliberately not merged into knownFields or
  // tagGroundTruth, which are the blocks that mean "do not contradict". These
  // get their own block with the opposite instruction, rendered by the same
  // buildCandidateBlock the extract path uses — see the reasoning at the top of
  // visual-candidates.ts. Empty or absent leaves the prompt untouched.
  visualCandidates?: VisualCandidate[];
}

// US-1529: identification context for listing generation, parsed from the
// item's attributes column (written by the extract pass).
export interface ListingIdentification {
  style: string;
  productLine: string | null;
  fabricTechnology: string | null;
  msrpCents: number | null;
  /** US-1528: true when the identification was verified against live eBay. */
  verified: boolean;
  /** US-1528: recurring market title tokens (colorways, fabric tech, fit). */
  marketKeywords: string[];
}

/**
 * Parse the persisted research identification off inventory_items.attributes.
 * Null when the item was never identified — callers then behave exactly as
 * before this feature existed.
 */
export function identificationFromAttributes(
  attributes: Record<string, string | string[]> | null | undefined,
): ListingIdentification | null {
  const attrs = attributes ?? {};
  const scalar = (v: string | string[] | undefined): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  const style = scalar(attrs.identified_style);
  if (!style) return null;
  const msrpRaw = Number(scalar(attrs.identification_msrp_cents));
  return {
    style,
    productLine: scalar(attrs.product_line),
    fabricTechnology: scalar(attrs.fabric_technology),
    msrpCents: Number.isFinite(msrpRaw) && msrpRaw > 0 ? Math.round(msrpRaw) : null,
    verified: scalar(attrs.identification_verified) === "true",
    marketKeywords: Array.isArray(attrs.market_title_keywords)
      ? attrs.market_title_keywords.filter((k) => typeof k === "string" && k !== "")
      : [],
  };
}

/**
 * US-1529: prompt lines for the identification block. Empty array when null —
 * the regression guarantee that unidentified items build today's exact prompt.
 */
export function identificationPromptLines(
  identification: ListingIdentification | null | undefined,
): string[] {
  if (!identification) return [];
  const facts = [`style: ${identification.style}`];
  if (identification.productLine) {
    facts.push(`product line: ${identification.productLine}`);
  }
  if (identification.fabricTechnology) {
    facts.push(`fabric technology: ${identification.fabricTechnology}`);
  }
  if (identification.msrpCents) {
    facts.push(`estimated original retail: $${Math.round(identification.msrpCents / 100)}`);
  }
  const lines = [
    `IDENTIFIED PRODUCT (${
      identification.verified
        ? "verified against live eBay listings"
        : "research-tier identification — phrase as 'identified as', not certainty"
    }):\n${facts.join("\n")}\n` +
      "LEAD the title with brand + this style name (a top buyer search token), " +
      "and give the description the product line / fabric / retail context. " +
      "Never fabricate specifics beyond these facts, and never let them soften " +
      "the honest condition statement.",
  ];
  if (identification.marketKeywords.length > 0) {
    lines.push(
      "MARKET TITLE KEYWORDS (recurring tokens on live listings of this exact " +
        "product — fold the ones that truthfully describe THIS item into the " +
        "title/description):\n" +
        identification.marketKeywords.map((k) => `- ${k}`).join("\n"),
    );
  }
  return lines;
}

/**
 * US-2419: adapt the persisted identification to the shape the ASPECTS pass
 * takes (ai-extract.ts researchAspectContext).
 *
 * The copy pass has had this context since US-1529 — the aspects pass on THIS
 * path never did, even though the one-item route (flipdesk-ai.ts) has always
 * passed it. That asymmetry is why AutoLister drafts come back with Model,
 * Product Line and Fabric Type empty on items the extract pass had already
 * identified: nothing in the aspects prompt ever named the product, and the
 * never-guess rule then (correctly) omitted those aspects.
 *
 * Only identifiedStyle / productLine / fabricTechnology are read downstream;
 * the remaining ResearchIdentification fields are carried at their neutral
 * values purely to satisfy the type. Returns null for an unidentified item, so
 * researchAspectContext returns "" and the prompt stays byte-identical.
 */
export function researchFromIdentification(
  identification: ListingIdentification | null | undefined,
): ResearchIdentification | null {
  if (!identification?.style) return null;
  return {
    identifiedStyle: identification.style,
    productLine: identification.productLine,
    fabricTechnology: identification.fabricTechnology,
    msrpEstimateCents: identification.msrpCents,
    rationale: null,
    confidence: 1,
  };
}

export interface ListingGenResult {
  listing: GeneratedListing;
  model: string;
  promptVersion: string;
  tokensIn: number;
  tokensOut: number;
  // US-2778: the model's verdict on each visual candidate it was shown. Empty
  // when no block was rendered AND when one was rendered and ignored — the two
  // are told apart by identification_provenance, which keeps both what was
  // offered and what came back.
  visualRulings: CandidateRuling[];
}

// Exported for US-2674: the v2 rollout tests compare v1 against v2 directly,
// because two version names pointing at one constant makes every downstream
// comparison pass while measuring nothing.
export const LISTING_GEN_SYSTEM_PROMPT =
  `You are an expert eBay listing creator for FlipDesk, a reseller tool. Given
photos of a single second-hand item (and optionally known attributes and
measurements), produce a complete, accurate, publish-ready eBay listing by
calling the create_ebay_listing tool.

Hard rules:
- TAG GROUND TRUTH (when supplied) is read verbatim off the garment's care/brand
  label and is AUTHORITATIVE. Use those brand/size/fiber/style values exactly,
  weighted ABOVE your own visual inference — never contradict, "correct", or
  override them, and never substitute a value you merely think you see.
- title: <= 80 characters (eBay's hard limit). Lead with brand, then item type,
  then the most search-relevant attributes (size, color, model, style code).
  No ALL-CAPS spam, no emoji, no keyword stuffing of unrelated terms.
- HIGH-DEMAND SEARCH TERMS (when supplied) are the words buyers actually search
  for this brand/category, mined from live eBay listings. Prefer them in the
  title and description WHERE THEY TRUTHFULLY DESCRIBE THIS ITEM — they rank and
  convert. Never add a term that doesn't match the item just because it's
  popular (that's keyword stuffing and causes returns).
- title_variant: OPTIONAL. A second, meaningfully DIFFERENT <=80-char title for
  the same item (e.g. lead with a different high-demand term or reorder the
  keywords) so its sell-through can be compared against the primary title. Leave
  it empty only if you genuinely cannot phrase a distinct, equally-accurate
  alternative. Must obey every title rule above.
- suggested_category_query: a short natural-language category for this item
  (e.g. "men's athletic shoes", "vintage advertising sign"). Do NOT invent an
  eBay category id — the system resolves the real leaf category from this query.
- ebay_condition: choose the single best value from the allowed enum based on
  what the photos actually show.
- condition_description: a short, buyer-facing, HONEST condition narrative.
  Only state condition facts visible in the photos or supplied in known
  attributes. Never invent or upgrade condition — over-promising causes returns.
  Call out visible flaws plainly.
- item_specifics: fill aspects you can determine from the photos/attributes
  (Brand, Size, Color, Material, Style, Department, etc.). When an allowed-aspect
  list is provided, use ONLY those aspect names and prefer their allowed values.
  Omit any aspect you cannot determine — never guess. EXCEPTION: for clothing,
  "Department" (Men / Women / Unisex Adult / Boys / Girls / Unisex Kids / Baby /
  Maternity) is almost always required by eBay and is usually evident from the
  garment's cut, styling, and labeling — set it whenever the photos support a
  confident read rather than omitting it.
- THE DESCRIPTION IS THREE SEPARATE PROSE FIELDS, and none of them lists facts.
  Brand, size, color, material, the condition grade and every measurement are
  rendered SEPARATELY from the item's own data. Repeating one here creates a
  duplicate the seller cannot fix: they correct the measurement, the block
  updates, and your sentence goes on advertising the old number. So NEVER write
  "Brand: X", "Size: 8", "Measurements (laid flat): ..." or any labelled fact,
  in any of the three. Describe the garment; do not list it.
  - description_intro: one or two sentences. The garment and the single thing
    that makes it worth buying. No greeting, no sales pitch, no emoji.
  - description_features: construction and styling the photos actually show —
    closure, pockets, trim, cuffs, lining, hardware, drape, pattern.
  - description_condition: an honest condition narrative, consistent with the
    ebay_condition tier. Say plainly what is worn or flawed.
  NEVER mention, describe, or disclaim a thrift/retail price tag, price
  sticker, or any original/sticker price visible in a photo — a price shown in
  a photo is NOT a listing fact; ignore it entirely and never add "for
  reference only" notes about it.
- description: DEPRECATED. Leave it empty. It exists only so an older prompt
  version keeps working, and anything you put here is treated as the intro.
- suggested_price_cents: a reasonable starting price in US cents based on the
  item, brand, and condition. The system may refine this from comparable sales.
- confidence: your overall confidence (0..1) that this listing is accurate.
- Do not fabricate attributes, brands, sizes, or model numbers not supported by
  the photos or supplied attributes.`;

// US-1900: listing_gen_v2 — the policy/AI-summary-era challenger. Adds the
// verified eBay policy title rules (no cross-brand comparison, no duplicate
// title token, prefer buyer-typed qualifiers) and description guidance for the
// era where eBay AI-summarizes descriptions for buyers. Ships through the
// eval gate + acceptance loop before it can go active; never hot-swaps v1.
// See vault/30-platform/ebay-ranking-playbook.md §2/§3.
export const LISTING_GEN_SYSTEM_PROMPT_V2 =
  `You are an expert eBay listing creator for FlipDesk, a reseller tool. Given
photos of a single second-hand item (and optionally known attributes and
measurements), produce a complete, accurate, publish-ready eBay listing by
calling the create_ebay_listing tool.

Hard rules:
- TAG GROUND TRUTH (when supplied) is read verbatim off the garment's care/brand
  label and is AUTHORITATIVE. Use those brand/size/fiber/style values exactly,
  weighted ABOVE your own visual inference — never contradict, "correct", or
  override them, and never substitute a value you merely think you see.
- title: <= 80 characters (eBay's hard limit). Lead with brand, then item type,
  then the most search-relevant attributes (size, color, model, style code).
  No ALL-CAPS spam, no emoji, no keyword stuffing of unrelated terms.
- title — NEVER compare to another brand. Comparison phrases like "style of
  <brand>", "similar to <brand>", "inspired by <brand>", or "fits like <brand>"
  hijack another brand's search traffic and are an eBay search-manipulation
  policy violation for clothing. State only THIS item's actual brand. (Benign
  fit phrasing like "fits like a glove" is fine — the ban is on naming another
  brand.)
- title — NEVER repeat a word/token within the title. eBay's search gives no
  ranking benefit to a duplicated keyword, and it wastes the 80-char surface.
  Each token earns its place once; spend the freed space on a NEW qualifier.
- title — when space is tight, PREFER buyer-typed qualifiers (era, fit, pattern,
  silhouette, named style/model) over repeating a token an item specific already
  carries. The aspects (Brand, Size, Color, Material, Department, …) are indexed
  separately, so a word already living in a filled aspect adds little in the
  title; a distinctive buyer-search qualifier adds more.
- HIGH-DEMAND SEARCH TERMS (when supplied) are the words buyers actually search
  for this brand/category, mined from live eBay listings. Prefer them in the
  title and description WHERE THEY TRUTHFULLY DESCRIBE THIS ITEM — they rank and
  convert. Never add a term that doesn't match the item just because it's
  popular (that's keyword stuffing and causes returns).
- title_variant: OPTIONAL. A second, meaningfully DIFFERENT <=80-char title for
  the same item (e.g. lead with a different high-demand term or reorder the
  keywords) so its sell-through can be compared against the primary title. Leave
  it empty only if you genuinely cannot phrase a distinct, equally-accurate
  alternative. Must obey every title rule above.
- suggested_category_query: a short natural-language category for this item
  (e.g. "men's athletic shoes", "vintage advertising sign"). Do NOT invent an
  eBay category id — the system resolves the real leaf category from this query.
- ebay_condition: choose the single best value from the allowed enum based on
  what the photos actually show.
- condition_description: a short, buyer-facing, HONEST condition narrative.
  Only state condition facts visible in the photos or supplied in known
  attributes. Never invent or upgrade condition — over-promising causes returns.
  Call out visible flaws plainly. Keep the wording CONSISTENT with the chosen
  ebay_condition tier: a "New with tags"/like-new tier must not describe wear,
  and a used tier must not read as flawless.
- item_specifics: fill aspects you can determine from the photos/attributes
  (Brand, Size, Color, Material, Style, Department, etc.). When an allowed-aspect
  list is provided, use ONLY those aspect names and prefer their allowed values.
  Omit any aspect you cannot determine — never guess. EXCEPTION: for clothing,
  "Department" (Men / Women / Unisex Adult / Boys / Girls / Unisex Kids / Baby /
  Maternity) is almost always required by eBay and is usually evident from the
  garment's cut, styling, and labeling — set it whenever the photos support a
  confident read rather than omitting it.
- THE DESCRIPTION IS THREE SEPARATE PROSE FIELDS, and none of them lists facts.
  Brand, size, color, material, the condition grade and every measurement are
  rendered SEPARATELY from the item's own data. Repeating one here creates a
  duplicate the seller cannot fix: they correct the measurement, the block
  updates, and your sentence goes on advertising the old number. So NEVER write
  "Brand: X", "Size: 8", "Measurements (laid flat): ..." or any labelled fact,
  in any of the three. Describe the garment; do not list it.
  - description_intro: one or two sentences. The garment and the single thing
    that makes it worth buying. No greeting, no sales pitch, no emoji.
  - description_features: construction and styling the photos actually show —
    closure, pockets, trim, cuffs, lining, hardware, drape, pattern.
  - description_condition: an honest condition narrative, consistent with the
    ebay_condition tier. Say plainly what is worn or flawed.
  Write FACTUAL, SCANNABLE prose. eBay now AI-SUMMARIZES descriptions for
  buyers, so plain accurate sentences summarize well; a keyword list or repeated
  phrases do not — never dump a block of comma-separated keywords. NEVER
  mention, describe, or disclaim a thrift/retail price tag, price sticker, or
  any original/sticker price visible in a photo — a price shown in a photo is
  NOT a listing fact; ignore it entirely and never add "for reference only"
  notes about it.
- description: DEPRECATED. Leave it empty. It exists only so an older prompt
  version keeps working, and anything you put here is treated as the intro.
- MEASUREMENTS: do NOT write them into any description field. Supplied
  measurements are rendered verbatim into their own block, which is what makes
  them survive a later correction — writing them in prose as well is the one
  thing that breaks that.
- suggested_price_cents: a reasonable starting price in US cents based on the
  item, brand, and condition. The system may refine this from comparable sales.
- confidence: your overall confidence (0..1) that this listing is accurate.
- Do not fabricate attributes, brands, sizes, or model numbers not supported by
  the photos or supplied attributes.`;

// US-1900: registry mapping a listing_gen version_name -> its in-code prompt
// text. A DB ai_prompt_versions row with EMPTY prompt_text resolves its text
// through this map by version_name (so a version can be registered/eval-gated
// via a lightweight row without duplicating the prompt into SQL). Unknown
// names fall back to the v1 code default. Keep this the single source of truth
// for which versions are "code-backed".
const CODE_PROMPT_TEXT: Record<string, string> = {
  [LISTING_GEN_PROMPT_VERSION]: LISTING_GEN_SYSTEM_PROMPT,
  [LISTING_GEN_PROMPT_VERSION_V2]: LISTING_GEN_SYSTEM_PROMPT_V2,
};

export const LISTING_GEN_TOOL: Anthropic.Tool = {
  name: "create_ebay_listing",
  description: "Return a complete, publish-ready eBay listing for the item.",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Search-friendly eBay title, <= 80 characters",
      },
      title_variant: {
        type: "string",
        description:
          "Optional second <=80-char title (a distinct keyword ordering/lead term) for A/B sell-through comparison. Empty if none.",
      },
      // US-2959: the description arrives as THREE prose fields, not one blob.
      // Everything factual — brand, size, colour, material, measurements, the
      // grade — is rendered from its own block by lib/description-blocks.ts, so
      // a model restating it here creates a duplicate that only the block half
      // can ever update. That is the whole defect this epic exists to remove.
      description_intro: {
        type: "string",
        description:
          "One or two sentences opening the listing: the garment and what makes it worth buying. No labelled facts.",
      },
      description_features: {
        type: "string",
        description:
          "Construction and styling the photos show: closure, pockets, trim, cuffs, lining, hardware, drape, pattern. No labelled facts.",
      },
      description_condition: {
        type: "string",
        description:
          "Honest condition narrative. Say plainly what is worn or flawed. Never upgrade the condition.",
      },
      // Kept for ONE release as a fallback, so an active DB prompt version
      // written against the old contract still produces a working listing. It
      // maps to the intro when the three fields all come back empty.
      description: {
        type: "string",
        description:
          "DEPRECATED, use description_intro/features/condition. Whole-description fallback.",
      },
      suggested_category_query: {
        type: "string",
        description:
          "Short natural-language category to resolve to an eBay leaf category. Not an id.",
      },
      ebay_condition: {
        type: "string",
        enum: [...EBAY_CONDITION_VALUES],
        description: "Best-fit eBay condition enum value",
      },
      condition_description: {
        type: "string",
        description: "Honest, buyer-facing condition narrative",
      },
      item_specifics: {
        type: "object",
        description:
          "Aspect name -> array of value(s). Only aspects you can determine.",
        additionalProperties: { type: "array", items: { type: "string" } },
      },
      suggested_price_cents: {
        type: "integer",
        description: "Suggested starting price in US cents",
        minimum: 0,
      },
      confidence: {
        type: "number",
        description: "Overall confidence 0..1",
        minimum: 0,
        maximum: 1,
      },
      // US-2778. The extract tool has had this since US-2767; without it here,
      // the candidate block asks for a decision and gives it nowhere to go —
      // exactly the failure recorded at visual-candidates.ts:113. Optional, so
      // a generation that never saw the block still satisfies the tool.
      visual_rulings: {
        type: "array",
        description:
          "One entry per candidate in the UNVERIFIED EXTERNAL GUESS block, if that block was present. An acceptance with no evidence is discarded server-side.",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            value: { type: "string" },
            verdict: { type: "string", enum: ["accepted", "rejected"] },
            evidence: { type: "string", enum: [...EVIDENCE_PRECEDENCE] },
          },
          required: ["field", "value", "verdict"],
        },
      },
    },
    required: [
      "title",
      // description_intro rather than description (US-2959). Required so a
      // generation always has an opening line; features and condition are
      // optional because a plain item legitimately has little to say about
      // either, and an empty block renders to nothing rather than a heading
      // over blank space.
      "description_intro",
      "suggested_category_query",
      "ebay_condition",
      "condition_description",
      "item_specifics",
      "suggested_price_cents",
      "confidence",
    ],
  },
};

// ── DB-driven prompt override (mirrors ai-grading.ts:resolveActivePrompt) ──
// An active ai_prompt_versions row with stage='listing_gen' OVERRIDES the code
// prompt text at runtime, while still attributing to its version_name. Empty
// prompt_text means "use the code default text under this version name" — that
// is how the seeded listing_gen_v1 row (migration 00053) behaves. Never throws.

export interface ResolvedListingPrompt {
  text: string;
  versionName: string;
}

// US-547: champion (active) + optional A/B challenger (eval-passed, in_trial).
// When a challenger exists, ~50% of generations use it — split deterministically
// on the item id so the SAME item always gets the SAME prompt (a re-generate
// doesn't flip variants mid-flight, and the acceptance attribution stays stable).
interface ListingPromptBundle {
  champion: ResolvedListingPrompt;
  challenger: ResolvedListingPrompt | null;
}

const PROMPT_CACHE_TTL_MS = 60_000;
let cachedBundle: { value: ListingPromptBundle; expiresAt: number } | null = null;

// Resolve the effective prompt text for a DB ai_prompt_versions row: a non-empty
// prompt_text wins (a fully DB-authored override), otherwise the row's
// version_name is looked up in the in-code registry (US-1900), falling back to
// the v1 code default for any unknown/legacy version_name. This is how an
// empty-text row like seeded listing_gen_v1 / listing_gen_v2 gets its text.
// US-2674 exported it. It is the hinge the whole listing_gen_v2 rollout turns
// on: the seeded v2 row (migration 00446) carries EMPTY prompt_text, so if this
// mapping is wrong then activating v2 silently serves v1 and the eval, the
// canary and the acceptance stats all measure the champion against itself.
// That failure is invisible from every surface -- version_name says v2
// everywhere -- so it is asserted directly rather than through the bundle.
export function resolvePromptText(
  promptText: string | null,
  versionName: string,
): string {
  if (promptText && promptText.trim().length > 0) return promptText;
  return CODE_PROMPT_TEXT[versionName] ?? LISTING_GEN_SYSTEM_PROMPT;
}

// FNV-1a → unit float in [0,1). Deterministic (no Math.random) so the same key
// always lands the same side of the A/B split across calls and deploys.
function hashKeyToUnit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

async function loadListingPromptBundle(): Promise<ListingPromptBundle> {
  const codeDefault: ResolvedListingPrompt = {
    text: LISTING_GEN_SYSTEM_PROMPT,
    versionName: LISTING_GEN_PROMPT_VERSION,
  };
  const now = Date.now();
  if (cachedBundle && cachedBundle.expiresAt > now) return cachedBundle.value;

  let champion = codeDefault;
  let challenger: ResolvedListingPrompt | null = null;
  try {
    const { data: activeData, error } = await supabaseAdmin
      .from("ai_prompt_versions")
      .select("version_name, prompt_text")
      .eq("stage", "listing_gen")
      .eq("is_active", true)
      .limit(1);
    if (!error && Array.isArray(activeData) && activeData.length > 0) {
      const picked = activeData[0] as { version_name: string; prompt_text: string | null };
      champion = {
        text: resolvePromptText(picked.prompt_text, picked.version_name),
        versionName: picked.version_name,
      };
    }

    // The A/B challenger: an eval-passed, in_trial row that is NOT the active
    // champion. activatePromptVersion clears in_trial when it promotes a winner.
    const { data: trialData } = await supabaseAdmin
      .from("ai_prompt_versions")
      .select("version_name, prompt_text")
      .eq("stage", "listing_gen")
      .eq("in_trial", true)
      .eq("eval_passed", true)
      .eq("is_active", false)
      .limit(1);
    if (Array.isArray(trialData) && trialData.length > 0) {
      const picked = trialData[0] as { version_name: string; prompt_text: string | null };
      challenger = {
        text: resolvePromptText(picked.prompt_text, picked.version_name),
        versionName: picked.version_name,
      };
    }
  } catch (err) {
    console.error(
      "[AI Listing] loadListingPromptBundle fallback:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const value: ListingPromptBundle = { champion, challenger };
  cachedBundle = { value, expiresAt: now + PROMPT_CACHE_TTL_MS };
  return value;
}

/**
 * Resolve the listing_gen prompt for this generation. `selectKey` (the item id)
 * drives the deterministic 50/50 A/B split when a challenger is in trial; omit
 * it (e.g. eval runs) to always get the champion.
 */
export async function resolveListingPrompt(
  selectKey?: string | null,
): Promise<ResolvedListingPrompt> {
  const bundle = await loadListingPromptBundle();
  if (bundle.challenger && selectKey && hashKeyToUnit(selectKey) < 0.5) {
    return bundle.challenger;
  }
  return bundle.champion;
}

function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function coerceItemSpecifics(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      const vals = v.map((x) => String(x).trim()).filter((x) => x.length > 0);
      if (vals.length > 0) out[k] = vals;
    } else if (typeof v === "string" && v.trim().length > 0) {
      out[k] = [v.trim()];
    }
  }
  return out;
}

/**
 * The user-turn text blocks, in order, as one pure function (US-2778).
 *
 * Lifted out of generateListingFields unchanged so the prompt can be asserted
 * without a network or an API key. That matters more than usual here: the
 * flag-off guarantee for the visual pass is "byte-identical to today", and a
 * guarantee nobody can test is a hope.
 *
 * ORDER IS DELIBERATE at exactly one point. The visual block goes LAST, after
 * the tag ground truth it must never override. The precedence ladder inside
 * the block is what actually enforces that, but printing an unverified guess
 * above the ground truth reads as the more authoritative of the two and costs
 * nothing to get right.
 */
export function buildListingUserLines(input: ListingGenInput): string[] {
  const lines: string[] = [];
  if (input.tagGroundTruth && Object.keys(input.tagGroundTruth).length > 0) {
    lines.push(
      "TAG GROUND TRUTH (read verbatim off the garment's tag/care label — " +
        "AUTHORITATIVE. Weight these ABOVE your own visual inference; use them " +
        "exactly and NEVER contradict or override them):\n" +
        JSON.stringify(input.tagGroundTruth, null, 2),
    );
  }
  if (input.knownFields && Object.keys(input.knownFields).length > 0) {
    lines.push(`KNOWN ATTRIBUTES:\n${JSON.stringify(input.knownFields, null, 2)}`);
  }
  // US-1529: identified-product context (empty array when unidentified).
  lines.push(...identificationPromptLines(input.identification));
  if (input.measurements && Object.keys(input.measurements).length > 0) {
    lines.push(`MEASUREMENTS:\n${JSON.stringify(input.measurements, null, 2)}`);
  }
  // The allowed-aspects block is NOT here any more (2026-09-02). It is a
  // property of the CATEGORY, not the item, so it rides in the cached system
  // prefix - see buildListingSystemBlocks. Emitting it here too would send a
  // second, uncached copy behind the photos on every call.
  if (input.demandTerms && input.demandTerms.length > 0) {
    lines.push(
      "HIGH-DEMAND eBAY SEARCH TERMS (mined from live eBay listings for this " +
        "brand/category, highest demand first — fold the ones that TRUTHFULLY " +
        "describe this item into the title and description; never force an " +
        "irrelevant term):\n" +
        input.demandTerms.map((t) => `- ${t}`).join("\n"),
    );
  }
  // US-2778. buildCandidateBlock returns "" when there is nothing to
  // adjudicate, which is what makes an empty array and an absent field the
  // same prompt.
  const candidateBlock = buildCandidateBlock(input.visualCandidates ?? []);
  if (candidateBlock) lines.push(candidateBlock);

  lines.push("Call create_ebay_listing with the finished listing.");
  return lines;
}

/**
 * The category's allowed item-specific aspects as prompt text, "" when none.
 *
 * Header wording is the one the user turn carried since US-312, so a DB prompt
 * override written against it still reads the same block. Pure.
 */
export function allowedAspectsBlock(
  allowed: Record<string, string[]> | null | undefined,
): string {
  if (!allowed || Object.keys(allowed).length === 0) return "";
  return (
    "ALLOWED ITEM-SPECIFIC ASPECTS (use only these aspect names; [] = free text):\n" +
    JSON.stringify(allowed, null, 2)
  );
}

/**
 * The system prefix for one generation call: the versioned prompt, then the
 * category's allowed aspects as a SECOND block (2026-09-02).
 *
 * Why a second system block rather than a line in the user turn. Anthropic's
 * cache is a prefix cache: tools, then system, then messages, and a breakpoint
 * caches everything before it. The user turn opens with the item's photos,
 * which differ on every call, so nothing placed after them is ever read from
 * cache. The aspect list is the largest text we send - forty-odd aspects with
 * up to 300 values each, Country of Origin alone is 244 - and it is identical
 * for every item in the same leaf. In the system prefix it is written once per
 * category per batch and read at a tenth of the price for the rest. Two
 * breakpoints, one per block, so a batch that spans categories still shares
 * the prompt half.
 *
 * Both breakpoints, or neither, follow `caching`. The order (prompt first) is
 * what keeps the prompt half shared across categories. Pure.
 */
export function buildListingSystemBlocks(
  promptText: string,
  allowedAspects: Record<string, string[]> | null | undefined,
  caching: boolean,
): Anthropic.TextBlockParam[] {
  const block = (text: string): Anthropic.TextBlockParam =>
    caching
      ? { type: "text", text, cache_control: { type: "ephemeral" } }
      : { type: "text", text };
  const blocks = [block(promptText)];
  const aspects = allowedAspectsBlock(allowedAspects);
  if (aspects) blocks.push(block(aspects));
  return blocks;
}

/**
 * Core Claude call: photos (+ optional context) -> a structured eBay listing
 * object. Uses the listing_gen prompt (DB override or code default) and forces
 * the create_ebay_listing tool. Orchestration (category resolution, pricing,
 * draft write, quota/logging) lives in US-312's generateListing.
 */
export async function generateListingFields(
  input: ListingGenInput,
): Promise<ListingGenResult> {
  enterAiFeature(input.feature ?? "autolister"); // US-894 spend attribution
  if (!input.photos || input.photos.length === 0) {
    throw new Error("generateListingFields requires at least one photo");
  }

  const client = getAnthropicClient();
  const temperature = getAiTemperature();
  const prompt = await resolveListingPrompt(input.promptSelectKey ?? null);

  const content: Anthropic.ContentBlockParam[] = [];
  input.photos.forEach((photo, i) => {
    content.push({
      type: "text",
      text: `Photo ${i + 1}${photo.type ? ` (${photo.type})` : ""}:`,
    });
    // US-3088: a photo may arrive as a data URI rather than a fetchable URL -
    // the free listing-draft tool holds the bytes in memory and never stores
    // them, so there is no URL to give. tagImageSource is the same sniff the
    // tag-OCR pass uses; it is not tag-specific, and a plain https URL comes
    // back untouched, so every existing caller is byte-identical.
    content.push({ type: "image", source: tagImageSource(photo.url) });
  });

  content.push({ type: "text", text: buildListingUserLines(input).join("\n\n") });

  const systemBlocks = buildListingSystemBlocks(
    prompt.text,
    input.allowedAspects,
    isCachingEnabled(),
  );

  // US-1065: quality-gated Haiku→Sonnet cascade (config-driven, OFF by default,
  // so behavior is a single default-model pass until an operator enables it).
  // Runs the cheap model first and re-runs on the stronger model ONLY when the
  // first pass is low-confidence, missing a category, has no item-specifics, or
  // errored. Both passes are tagged to the "autolister" feature for spend
  // attribution (enterAiFeature above wraps this whole call).
  const cascade = await getActionCascadeConfig();
  const { result } = await runActionCascade<ListingGenResult>({
    config: cascade,
    runOn: (model) =>
      callListingModel(model, {
        client,
        content,
        systemBlocks,
        temperature,
        promptVersion: prompt.versionName,
      }),
    assess: (r) => {
      if (r.listing.confidence < cascade.confidenceThreshold) {
        return {
          sufficient: false,
          reason: `low_confidence:${r.listing.confidence.toFixed(2)}`,
        };
      }
      if (!r.listing.suggested_category_query) {
        return { sufficient: false, reason: "missing_category" };
      }
      if (Object.keys(r.listing.item_specifics).length === 0) {
        return { sufficient: false, reason: "no_item_specifics" };
      }
      return { sufficient: true, reason: "ok" };
    },
    onEscalate: ({ from, to, reason }) =>
      console.warn(`[AI Listing][cascade] escalate ${from} → ${to} (${reason})`),
  });
  return result;
}

// One tool-forced create_ebay_listing call on `model`, parsed into a
// ListingGenResult. Extracted so the cascade in generateListingFields can run it
// on the cheap model first and re-run on the stronger model when needed; the
// prompt/content/system are built once by the caller and passed in.
interface ListingCallInputs {
  client: Anthropic;
  content: Anthropic.ContentBlockParam[];
  systemBlocks: Anthropic.TextBlockParam[];
  temperature: number | undefined;
  promptVersion: string;
}

async function callListingModel(
  model: string,
  { client, content, systemBlocks, temperature, promptVersion }: ListingCallInputs,
): Promise<ListingGenResult> {
  // Retry transient Anthropic rate-limit / overload (429/529/5xx) with
  // exponential backoff so one momentary limit doesn't fail the whole batch.
  const response = await withRetry(
    () =>
      client.messages.create({
        model,
        max_tokens: 1536,
        ...(temperature !== undefined ? { temperature } : {}),
        system: systemBlocks,
        tools: [LISTING_GEN_TOOL],
        tool_choice: { type: "tool", name: "create_ebay_listing" },
        messages: [{ role: "user", content }],
      }),
    {
      onRetry: ({ attempt, delayMs }) =>
        console.warn(
          `[AI Listing] Anthropic call retry #${attempt} after ${delayMs}ms backoff`,
        ),
    },
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return a listing");
  }
  const raw = toolUse.input as Record<string, unknown>;

  // US-546: keyword-priority trim (never mid-word) instead of a blind slice(0,80).
  // Leading keywords (brand → item type → modifiers) are the highest-priority,
  // so dropping whole trailing words keeps the terms that actually rank.
  const title =
    typeof raw.title === "string" ? trimTitleToLimit(raw.title, EBAY_TITLE_MAX) : "";
  const legacyDescription =
    typeof raw.description === "string" ? raw.description.trim() : "";
  const introField =
    typeof raw.description_intro === "string" ? raw.description_intro.trim() : "";
  const features =
    typeof raw.description_features === "string" ? raw.description_features.trim() : "";
  const conditionProse =
    typeof raw.description_condition === "string" ? raw.description_condition.trim() : "";
  // US-2959: the fallback. A DB-overridden prompt still written against the old
  // contract returns `description` alone, and mapping it to the intro keeps
  // that generation working rather than producing an empty listing.
  const intro = introField || legacyDescription;
  if (!title || !intro) {
    throw new Error("AI returned an incomplete listing (missing title/description)");
  }

  // US-546 (AC3): the optional alternate title, also keyword-priority trimmed.
  // Only keep it when it's distinct from the primary (a duplicate is no A/B).
  const rawVariant =
    typeof raw.title_variant === "string"
      ? trimTitleToLimit(raw.title_variant, EBAY_TITLE_MAX)
      : "";
  const titleVariant =
    rawVariant && rawVariant.toLowerCase() !== title.toLowerCase() ? rawVariant : "";

  const condition = EBAY_CONDITION_VALUES.includes(raw.ebay_condition as EbayCondition)
    ? (raw.ebay_condition as EbayCondition)
    : "USED_GOOD";

  const priceCents =
    typeof raw.suggested_price_cents === "number" &&
      Number.isFinite(raw.suggested_price_cents)
      ? Math.max(0, Math.round(raw.suggested_price_cents))
      : 0;

  const listing: GeneratedListing = {
    title,
    title_variant: titleVariant,
    description_intro: intro,
    description_features: features,
    description_condition: conditionProse,
    description: legacyDescription,
    suggested_category_query:
      typeof raw.suggested_category_query === "string"
        ? raw.suggested_category_query.trim()
        : "",
    ebay_condition: condition,
    condition_description:
      typeof raw.condition_description === "string"
        ? raw.condition_description.trim()
        : "",
    item_specifics: coerceItemSpecifics(raw.item_specifics),
    suggested_price_cents: priceCents,
    confidence: clampConfidence(raw.confidence),
  };

  return {
    listing,
    model,
    promptVersion,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
    // US-2778: same parse as the extract path, same discard rule. An
    // acceptance that names no evidence is dropped — the block's whole demand
    // is "say what accepted it", and an unevidenced yes is the model being
    // agreeable, which is the failure the block exists to prevent.
    visualRulings: dropUnevidenced(parseRulings(raw.visual_rulings)),
  };
}

/**
 * Decide which mined style names may be offered, and file the rest (US-2781).
 *
 * ── The two outcomes, and why the second is not "drop it" ────────────────────
 * A name backed by something that is not a title becomes a candidate the model
 * still has to accept. A name backed only by titles cannot become one - that is
 * the rule visual-style-names.ts exists to enforce - but it is not worthless
 * either: several sellers holding the garment wrote the same words.
 *
 * So when the tag gave us a STYLE CODE, an unconfirmed name is filed against
 * that code in the existing US-2216 observation queue, where a human decides
 * whether it becomes permanent brand_styles knowledge. Approved, it corroborates
 * the next garment by itself, and the knowledge base gets denser from real
 * listings without a machine ever promoting its own guess.
 *
 * With no style code there is nothing to file it UNDER, and an observation with
 * no key is a row nobody can ever adjudicate. Those are dropped and counted, so
 * a silent zero stays visible in the log.
 *
 * Best-effort throughout: a queue write must never fail a generation.
 */
async function corroborateMinedStyleNames(args: {
  mined: readonly { name: string; support: number }[];
  aspectProductNames: readonly string[];
  brand: string | null;
  decodedStyleName: string | null;
  styleCodeRaw: string | null;
}): Promise<VisualCandidate[]> {
  if (args.mined.length === 0) return [];

  // brand_styles for this brand, via the cached pack. A read failure is an
  // empty list: one fewer corroborating source, not a failed generation.
  let knownStyleNames: string[] = [];
  if (args.brand) {
    try {
      const pack = await resolveBrandKnowledgePack(args.brand);
      knownStyleNames = (pack?.styles ?? []).flatMap(
        (st) => [st.styleName, ...st.aliases],
      );
    } catch (err) {
      console.error("[AI Listing] brand pack read failed (non-fatal):", err);
    }
  }

  const offered: VisualCandidate[] = [];
  const unconfirmed: Array<{ title: string }> = [];
  for (const candidate of args.mined) {
    const backing = corroborateStyleName(candidate.name, {
      knownStyleNames,
      decodedStyleName: args.decodedStyleName,
      aspectProductNames: args.aspectProductNames,
    });
    if (!backing) {
      unconfirmed.push({ title: candidate.name });
      continue;
    }
    offered.push({
      field: "style",
      value: candidate.name,
      support: candidate.support,
      // Mined names are counted over listings that CARRIED the phrase, so the
      // denominator is the same population as the numerator.
      outOf: candidate.support,
    });
    // One is enough. A second style name would be a second answer to a
    // question with one right answer, and the block has no way to say "or".
    break;
  }

  if (unconfirmed.length > 0) {
    if (args.styleCodeRaw && args.brand) {
      try {
        await recordStyleCodeObservations({
          brandKey: args.brand.toLowerCase().replace(/[^a-z0-9]+/g, ""),
          styleCodeRaw: args.styleCodeRaw,
          titles: unconfirmed,
          source: "market_verify",
        });
      } catch (err) {
        console.error("[AI Listing] style-name queue write failed:", err);
      }
    } else {
      console.log(
        `[AI Listing] ${unconfirmed.length} mined style name(s) dropped: ` +
          "no style code to file them under",
      );
    }
  }

  return offered;
}

/** The slice of the Supabase client ownEbayListingIds uses, so a test can be one. */
export interface OwnListingReader {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        eq(col: string, val: unknown): {
          not(col: string, op: string, val: unknown): {
            limit(n: number): Promise<
              { data: unknown; error: { message: string } | null }
            >;
          };
        };
      };
    };
  };
}

/**
 * This workspace's own live eBay listing ids (US-2778).
 *
 * Our sellers publish to eBay with titles and item specifics our own AI wrote.
 * Reading those back as independent market corroboration counts three copies of
 * one guess as three witnesses — the same trap style-code-aspects.ts documents,
 * and the consensus threshold does nothing about it because the copies
 * genuinely agree.
 *
 * SCOPED TO THE OWNER (US-268). `listings` has no user_id; it descends from
 * inventory_items, so the ownership filter goes through the join. The
 * platform-wide read that jobs-style-code-sweep.ts does is right for a
 * background sweep and wrong here, where this runs inside one seller's request.
 *
 * A read failure returns an EMPTY set rather than throwing. Losing the
 * exclusion weakens the evidence; losing the pass removes it.
 */
export async function ownEbayListingIds(
  ownerId: string,
  // Injected for tests. The scoping is the whole point of this function, and a
  // scoping rule that cannot be asserted is a comment.
  client: OwnListingReader = supabaseAdmin as unknown as OwnListingReader,
): Promise<ReadonlySet<string>> {
  const { data, error } = await client
    .from("listings")
    .select("platform_listing_id, inventory_items!inner(user_id)")
    .eq("platform", "ebay")
    .eq("inventory_items.user_id", ownerId)
    .not("platform_listing_id", "is", null)
    .limit(OWN_LISTING_SCAN_LIMIT);
  if (error) {
    console.error("[AI Listing] own-listing read failed:", error.message);
    return new Set();
  }
  return new Set(
    ((data ?? []) as Array<{ platform_listing_id: string | null }>)
      .map((r) => (r.platform_listing_id ?? "").trim())
      .filter(Boolean),
  );
}

/**
 * How many of the seller's own eBay listings to load for the exclusion.
 *
 * A cap rather than the full set: the visual search returns at most
 * VISUAL_SEARCH_LIMIT matches and only MAX_ASPECT_READS of them are read, so
 * the exclusion only has to cover ids that could plausibly come back. A seller
 * with more live listings than this is the case where a truncated set costs one
 * excluded listing, not the case where it costs the identification.
 */
const OWN_LISTING_SCAN_LIMIT = 500;

// ── US-312: end-to-end single-item generation orchestration ───────────
// photos → generateListingFields → resolve real eBay leaf category →
// constrain item specifics → comp-based price (AI fallback, flagged) →
// write a tenant-scoped draft listing + log usage.

// eBay Sell condition enum → Browse API conditionId for comp searches.
function conditionIdForComps(condition: EbayCondition): string {
  switch (condition) {
    case "NEW":
    case "NEW_OTHER":
    case "NEW_WITH_DEFECTS":
    case "LIKE_NEW":
      return "1000";
    case "FOR_PARTS_OR_NOT_WORKING":
      return "7000";
    default:
      return "3000"; // Used — the common pre-owned resale case.
  }
}

// getCategoryAspects(categoryId) → { aspects: { aspects: EbayRawAspect[] } }.
// Flatten to aspect name -> allowed values ([] = free text).
function extractAllowedAspects(aspectsResponse: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const top = (aspectsResponse as { aspects?: unknown } | null)?.aspects;
  const raw = (top as { aspects?: unknown } | null)?.aspects;
  if (!Array.isArray(raw)) return out;
  for (const a of raw as Array<Record<string, unknown>>) {
    const name = typeof a.localizedAspectName === "string"
      ? a.localizedAspectName.trim()
      : "";
    if (!name) continue;
    const values = Array.isArray(a.aspectValues)
      ? (a.aspectValues as Array<Record<string, unknown>>)
        .map((v) => (typeof v.localizedValue === "string" ? v.localizedValue : ""))
        .filter((v) => v.length > 0)
      : [];
    out[name] = values;
  }
  return out;
}

// US-312: convert eBay's getCategoryAspects raw payload to EbayAspectSpec[] so
// the second-pass call to extractEbayAspects can constrain VALUES (not just
// names) to what eBay accepts for this category. Mirrors flipdesk-ai.ts
// toAspectSpecs but lives here to avoid pulling a route module into a lib.
export function buildAspectSpecsForCategory(
  aspectsResponse: unknown,
): EbayAspectSpec[] {
  const top = (aspectsResponse as { aspects?: unknown } | null)?.aspects;
  const raw = (top as { aspects?: unknown } | null)?.aspects;
  if (!Array.isArray(raw)) return [];

  type RawAspect = {
    localizedAspectName?: string;
    aspectConstraint?: {
      aspectRequired?: boolean;
      aspectMode?: string;
      itemToAspectCardinality?: string;
      aspectUsage?: string;
      /** "STRING" | "NUMBER" | "DATE" — drives numeric value validation. */
      aspectDataType?: string;
    };
    aspectValues?: Array<{ localizedValue?: string }>;
  };

  const specs: EbayAspectSpec[] = [];
  for (const a of raw as RawAspect[]) {
    const name = typeof a.localizedAspectName === "string"
      ? a.localizedAspectName.trim()
      : "";
    if (!name) continue;
    const c = a.aspectConstraint ?? {};
    const mode = (c.aspectMode === "SELECTION_ONLY" ||
        c.aspectMode === "SUGGESTED" ||
        c.aspectMode === "FREE_TEXT")
      ? c.aspectMode
      : "FREE_TEXT";
    const cardinality = c.itemToAspectCardinality === "MULTI" ? "MULTI" : "SINGLE";
    const required = !!c.aspectRequired;
    // Cap to a sensible per-aspect allowed-value count so the tool schema
    // doesn't balloon for categories that ship hundreds of values per aspect.
    // US-2420: the limit is shared with the one-item path (aspect-priority.ts).
    const allowedValues = (a.aspectValues ?? [])
      .map((v) => (typeof v.localizedValue === "string" ? v.localizedValue : ""))
      .filter((v): v is string => v.length > 0)
      .slice(0, MAX_ALLOWED_VALUES_PER_ASPECT);
    specs.push({
      name,
      required,
      cardinality,
      mode,
      allowedValues: allowedValues.length > 0 ? allowedValues : undefined,
      dataType: c.aspectDataType,
      usage: c.aspectUsage,
    });
  }

  // US-2420: required first, then by eBay's own 30-day buyer-search volume.
  // The old sort was required → RECOMMENDED → OPTIONAL, which cut Theme,
  // Accents and Occasion out of the schema before the model could fill them.
  return prioritizeByDemand(specs, raw);
}

/**
 * The name -> allowed-values map the GENERATION prompt gets, built from the
 * demand-ranked, capped specs rather than the raw payload (2026-09-02).
 *
 * extractAllowedAspects flattens everything eBay returns, with no cap on
 * aspects or values. The refine schema has been capped at MAX_AI_ASPECTS /
 * MAX_ALLOWED_VALUES_PER_ASPECT since US-2420, but the generation prompt on a
 * re-generate (an item that already carries ebay_category_id) still dumped the
 * whole payload: on the two leaves carrying Silhouette that was 7,286 values,
 * roughly 25k tokens, in front of a call whose item_specifics the refine pass
 * re-derives anyway. Same ranking as the schema, so the two calls now agree on
 * which aspects exist. Pure.
 */
export function promptAllowedAspects(
  specs: EbayAspectSpec[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const spec of specs) out[spec.name] = spec.allowedValues ?? [];
  return out;
}

// Collapse extractEbayAspects's suggestion map back to the plain name -> values
// shape the listing schema and DB columns expect.
function suggestionsToSpecifics(
  suggestions: Record<string, { values: string[] }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, sug] of Object.entries(suggestions)) {
    if (Array.isArray(sug.values) && sug.values.length > 0) {
      out[name] = sug.values;
    }
  }
  return out;
}

// US-541: confidence at/below which an AutoLister draft is routed to review.
export const LISTING_REVIEW_CONFIDENCE = 0.7;

// US-956: at/above this listing_price confidence we trust the generated price
// enough to NOT flag it as estimated (hides the "est." badge in drafts/bulk-edit
// so sellers only review prices the AI is unsure about). Single source of truth
// for the threshold — do not scatter the 0.85 literal.
export const PRICE_ESTIMATED_CONFIDENCE_THRESHOLD = 0.85;

/**
 * US-956: a generated price stops being flagged "estimated" once its confidence
 * meets the threshold. Sold-backed prices are already non-estimated; this lets a
 * high-confidence AI/comp price clear the flag too. Pure, so it's unit-tested.
 */
export function priceConfidenceClearsEstimated(
  priceConfidence: number | null,
  threshold: number = PRICE_ESTIMATED_CONFIDENCE_THRESHOLD,
): boolean {
  return priceConfidence != null && priceConfidence >= threshold;
}

/**
 * US-541: a generated draft needs a human look when the model's OVERALL
 * confidence is low, or ANY refined per-aspect confidence is low. Pure, so the
 * triage rule is unit-tested.
 */
// AutoLister items are seeded with a placeholder name ("Item 12" / "Untitled")
// by the web grouping flow. Once generation produces a real title, fold it
// into inventory_items.title so Inventory → Drafts (and the item page) show
// the actual garment instead of "Item 12" — but NEVER clobber a title the
// seller typed themselves. Pure + exported for tests.
export function shouldAdoptGeneratedTitle(
  storedTitle: string | null | undefined,
  generatedTitle: string | null | undefined,
): boolean {
  if (!generatedTitle || !generatedTitle.trim()) return false;
  const stored = (storedTitle ?? "").trim();
  if (stored === "") return true;
  return /^item\s+\d+$/i.test(stored) || /^untitled\b/i.test(stored);
}

// US-1567: the AutoLister -> Inventory carry-over. Generation extracts
// Brand/Size/Color/Type/etc. but historically parked them ONLY in the eBay
// aspect stores (listings.item_specifics_override + inventory_items.
// ebay_aspects), so the item detail page and inventory grid showed blank
// columns for AI-processed drafts. This maps well-known aspects onto the
// item's OWN columns and attributes via the canonical ASPECT_REGISTRY (the
// same table the composer's reverse write-back and the publish projection
// use, so the mapping can never drift) — STRICTLY FILL-ONLY: a value the
// seller already typed is never overwritten. Brand is excluded here; it
// carries via the existing normalizedBrand path. Pure + exported for tests.
export function aspectCarryOver(
  item: Pick<
    ItemRow,
    "size" | "color" | "material" | "style" | "attributes"
  > & { item_category?: string | null },
  aspects: Record<string, string[]>,
): Record<string, unknown> {
  // Case-insensitive aspect lookup (mirrors reverseProjectAspectColumns).
  const byLower = new Map<string, string[]>();
  for (const [key, values] of Object.entries(aspects)) {
    const l = key.trim().toLowerCase();
    if (l && !byLower.has(l)) byLower.set(l, values);
  }
  // ONE aspect feeds ONE canonical field. Registry entries deliberately share
  // candidate names — the `material` column and the `fabric_type` attribute both
  // list "Material"/"Fabric Type", because a leaf exposing both means different
  // things by them (fiber vs cloth construction). Without this claim set, a
  // single "Material: Wool" aspect would be copied onto the material column AND
  // the fabric_type attribute, writing one fact twice. Entry order decides who
  // wins, exactly as ownedAspectName does in the forward projection.
  const claimed = new Set<string>();
  const valuesFor = (names: string[]): { name: string; values: string[] } | null => {
    for (const name of names) {
      const l = name.toLowerCase();
      if (claimed.has(l)) continue;
      const vals = (byLower.get(l) ?? [])
        .map((v) => v.trim())
        .filter((v) => v !== "");
      if (vals.length > 0) return { name: l, values: vals };
    }
    return null;
  };

  const update: Record<string, unknown> = {};
  const existingAttrs = (item.attributes ?? {}) as Record<string, unknown>;
  const attrFill: Record<string, string> = {};

  // Per-vertical names apply only to THEIR vertical when we know which one this
  // item is. Flattening every byCategory list unconditionally is how the
  // shoes-only "Width" candidate captured a handbag leaf's numeric Width (in
  // inches) into attributes.shoe_width. When item_category is unknown we still
  // fall back to the union, because that is all a category-less caller can do —
  // the same spec-less compromise reverseColumnAspects makes.
  const vertical = item.item_category ?? null;
  const verticalExtras = (entry: (typeof ASPECT_REGISTRY.entries)[number]): string[] =>
    vertical
      ? entry.byCategory?.[vertical] ?? []
      : Object.values(entry.byCategory ?? {}).flat();

  for (const entry of ASPECT_REGISTRY.entries) {
    if (entry.key === "brand") continue; // normalizedBrand path owns it
    // All candidate names for this item's vertical — the aspect map is keyed by
    // the REAL names the model emitted, so scan every alternate that applies.
    const candidates = [...entry.aspects, ...verticalExtras(entry)];
    const hit = valuesFor(candidates);
    if (!hit) continue;
    claimed.add(hit.name);
    const values = hit.values;

    if (entry.source === "column" && entry.column) {
      const stored = item[entry.column as keyof typeof item];
      if (typeof stored === "string" && stored.trim() !== "") continue;
      if (stored != null && typeof stored !== "string") continue;
      update[entry.column] = values[0];
    } else if (entry.source === "attribute" && entry.attribute) {
      const stored = existingAttrs[entry.attribute];
      if (typeof stored === "string" && stored.trim() !== "") continue;
      if (Array.isArray(stored) && stored.length > 0) continue;
      if (stored != null && typeof stored !== "string" && !Array.isArray(stored)) continue;
      attrFill[entry.attribute] = entry.multi ? values.join(", ") : values[0];
    }
  }

  if (Object.keys(attrFill).length > 0) {
    update.attributes = { ...existingAttrs, ...attrFill };
  }
  return update;
}

/**
 * The item's attributes with the label reads filled in, for the registry.
 * Null in, nothing read -> null out, so a caller that never ran the tag pass
 * sees the same shape as before. Pure.
 */
export function withTagAttributes(
  attributes: Record<string, string | string[]> | null | undefined,
  tagAttributes: Record<string, string>,
): Record<string, string | string[]> | null {
  if (Object.keys(tagAttributes).length === 0) return attributes ?? null;
  return { ...(attributes ?? {}), ...tagAttributes };
}

export function listingNeedsReview(
  overallConfidence: number,
  fieldConfidence: Record<string, number>,
  threshold: number = LISTING_REVIEW_CONFIDENCE,
): boolean {
  if (overallConfidence < threshold) return true;
  return Object.values(fieldConfidence).some((c) => c < threshold);
}

// ── US-2423: captured attributes reach the DRAFT, not just the publish ──────

/**
 * The category spec in the shape the aspect registry resolver expects.
 * `EbayAspectSpec` is the extract-pass view of the same eBay payload — same
 * names, different field names for cardinality — so this is a rename, not a
 * reinterpretation.
 */
export function registryAspectsFromSpecs(specs: EbayAspectSpec[]): RegistryAspect[] {
  return specs.map((s) => ({
    name: s.name,
    mode: s.mode,
    multi: s.cardinality === "MULTI",
    allowedValues: s.allowedValues,
  }));
}

/**
 * US-2423: project the item's own captured attributes (US-821/US-2421) onto the
 * category's aspects at GENERATION time.
 *
 * The registry projection already ran at publish, which meant a seller opening a
 * fresh AutoLister draft saw blank specifics for facts the extract pass had
 * read off the tag hours earlier — and either retyped them or shipped without
 * them. Running it here puts the answer on the draft the seller actually looks
 * at.
 *
 * FILL-ONLY by construction: resolveItemAspects returns only names absent from
 * `existing`, so nothing the model or the refine pass decided is touched.
 */
export function deriveInventoryAspects(
  item: RegistryItem,
  specs: EbayAspectSpec[],
  existing: Record<string, string[]>,
): Record<string, string[]> {
  if (specs.length === 0) return {};
  return resolveItemAspects(item, registryAspectsFromSpecs(specs), existing);
}

// ── US-2425: how complete IS this draft? ────────────────────────────────────

/** One tier of eBay-aspect coverage for a draft. */
export interface AspectCoverageTier {
  filled: number;
  total: number;
  /** The unfilled aspect names — ranked by buyer search volume for the
   *  recommended tier, in category-spec order for the required one. */
  missing: string[];
}

/** What US-2425 stores on `listings.aspect_coverage`. */
export interface DraftAspectCoverage {
  categoryId: string | null;
  /** A gap here BLOCKS the publish. */
  required: AspectCoverageTier;
  /** A gap here only costs search placement. */
  recommended: AspectCoverageTier;
  computedAt: string;
}

/**
 * The raw eBay Taxonomy aspect array, which carries two fields the flattened
 * `EbayAspectSpec` drops and the coverage metric needs: `aspectUsage`
 * (REQUIRED / RECOMMENDED / OPTIONAL) and `relevanceIndicator.searchCount`.
 */
export function rankedAspectSpecs(aspectsResponse: unknown): RankedAspectSpec[] {
  const top = (aspectsResponse as { aspects?: unknown } | null)?.aspects;
  const raw = (top as { aspects?: unknown } | null)?.aspects;
  return Array.isArray(raw) ? (raw as RankedAspectSpec[]) : [];
}

/**
 * US-2425: score a finished draft against its category's aspect spec.
 *
 * The two tiers stay separate because they mean different things to a seller: a
 * missing REQUIRED aspect is a publish blocker they must clear today, a missing
 * RECOMMENDED one is search placement they are leaving on the table. Blending
 * them into one percentage would hide exactly the distinction that decides
 * whether a draft can ship. Pure and deterministic — the same draft always
 * scores the same, which is the point of having a number at all.
 */
export function buildAspectCoverage(
  specs: RankedAspectSpec[],
  aspectMap: Record<string, string[]>,
  categoryId: string | null,
  computedAt: string,
): DraftAspectCoverage {
  const requiredTotal = specs.filter(
    (s) => s.aspectConstraint?.aspectRequired && (s.localizedAspectName ?? "").length > 0,
  ).length;
  const requiredMissing = requiredMissingAspects(specs, aspectMap);
  const recommended = recommendedAspectCoverage(specs, aspectMap);
  return {
    categoryId,
    required: {
      filled: requiredTotal - requiredMissing.length,
      total: requiredTotal,
      missing: requiredMissing,
    },
    recommended,
    computedAt,
  };
}

// ── US-2424: pick the leaf the item can actually FILL ───────────────────────

/** How many of eBay's own suggestions we score. Each costs one cached Taxonomy
 *  read and no AI; past ~5 the suggestions stop being plausible leaves. */
export const CATEGORY_CANDIDATE_LIMIT = 5;

/** What a scored candidate contributes, persisted on the draft so the composer
 *  can offer a one-click switch without re-running generation. */
export interface CategoryCandidateScore {
  categoryId: string;
  categoryPath: string | null;
  /** eBay's own position in the suggestion list (0 = its top hit). */
  rank: number;
  /** REQUIRED aspects of this leaf the item can already fill. */
  requiredFilled: number;
  /** REQUIRED aspects this leaf has in total. */
  requiredTotal: number;
  /** The required aspects still unfilled — what the seller would owe. */
  requiredMissing: string[];
}

/** EbayAspectSpec → the minimal shape requiredMissingAspects reads, so the
 *  scorer routes through the ONE canonical required-aspect rule rather than
 *  re-deciding what "required" means. */
function toRequiredSpecs(specs: EbayAspectSpec[]): RequiredAspectSpec[] {
  return specs.map((s) => ({
    localizedAspectName: s.name,
    aspectConstraint: { aspectRequired: s.required },
  }));
}

/**
 * The aspect map a candidate leaf would START with: the generated specifics
 * whose names this leaf actually has, plus everything the registry can derive
 * from the item's own columns and captured attributes.
 *
 * Names are matched case-insensitively and rewritten to the leaf's own casing —
 * a generated "color" and eBay's "Color" are the same aspect, and counting them
 * as different is how a leaf looks emptier than it is.
 */
export function projectedAspectsForCategory(
  item: RegistryItem,
  generated: Record<string, string[]>,
  specs: EbayAspectSpec[],
): Record<string, string[]> {
  const canonical = new Map<string, string>();
  for (const s of specs) {
    const l = s.name.trim().toLowerCase();
    if (l && !canonical.has(l)) canonical.set(l, s.name);
  }
  const map: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(generated)) {
    const hit = canonical.get(name.trim().toLowerCase());
    if (hit && values.length > 0) map[hit] = values;
  }
  return { ...map, ...deriveInventoryAspects(item, specs, map) };
}

/**
 * US-2424: score ONE candidate leaf by how much of its REQUIRED specifics the
 * item can already satisfy. Pure and deterministic — no AI call, no network.
 */
export function scoreCategoryCandidate(
  candidate: { categoryId: string; categoryPath: string | null; rank: number },
  item: RegistryItem,
  generated: Record<string, string[]>,
  specs: EbayAspectSpec[],
): CategoryCandidateScore {
  const projected = projectedAspectsForCategory(item, generated, specs);
  const required = toRequiredSpecs(specs);
  const requiredTotal = required.filter(
    (r) => r.aspectConstraint?.aspectRequired,
  ).length;
  const requiredMissing = requiredMissingAspects(required, projected);
  return {
    categoryId: candidate.categoryId,
    categoryPath: candidate.categoryPath,
    rank: candidate.rank,
    requiredFilled: requiredTotal - requiredMissing.length,
    requiredTotal,
    requiredMissing,
  };
}

/**
 * Rank scored candidates best-first.
 *
 * Order, and why:
 *  1. MORE required aspects filled. A required gap is a hard publish blocker,
 *     so the leaf that leaves fewest of them is the one the seller can actually
 *     list today.
 *  2. Fewer required aspects still missing — separates a 5-of-5 leaf from a
 *     5-of-9 one when both filled five.
 *  3. eBay's own suggestion order. Every tie ends here, which is what makes the
 *     whole thing deterministic: identical inputs always yield the same leaf,
 *     and a single-candidate result behaves exactly as it did before US-2424.
 */
export function rankCategoryCandidates(
  scores: CategoryCandidateScore[],
): CategoryCandidateScore[] {
  return [...scores].sort(
    (a, b) =>
      b.requiredFilled - a.requiredFilled ||
      a.requiredMissing.length - b.requiredMissing.length ||
      a.rank - b.rank,
  );
}

/**
 * US-2423: the provenance map for a freshly generated draft. Every aspect the
 * model or refiner produced is `ai_extracted`; the ones the registry filled
 * from the item's stored attributes are `inventory_derived`.
 *
 * The split matters downstream: `reverseColumnAspects` writes an `ai_extracted`
 * or `manual` aspect back onto the item's columns but deliberately never writes
 * back an `inventory_derived` one — because that value CAME from the item, and
 * echoing it back could resurrect data the seller has since changed.
 */
export function buildAspectSources(
  aspects: Record<string, string[]>,
  inventoryDerived: Set<string>,
  // US-3043: names the visual consensus filled. Lowest rung of the ladder.
  visualConsensus: Set<string> = new Set(),
): AspectSourceMap {
  const aiNames = Object.keys(aspects).filter(
    (n) => !inventoryDerived.has(n) && !visualConsensus.has(n),
  );
  return mergeSources(
    mergeSources(
      sourcesFor(aiNames, "ai_extracted"),
      sourcesFor(inventoryDerived, "inventory_derived"),
    ),
    sourcesFor(visualConsensus, "visual_consensus"),
    aspects,
  );
}

// ── US-3043: the category decision on the batch path ─────────────────────────

/** The network the decision needs, injected so a test can hand it fakes. */
export interface BatchCategoryDeps {
  leafStatus: DecideCategoryArgs["leafStatus"];
  suggest: (query: string) => Promise<CategorySuggestion[]>;
  /** The category's spec, already demand-ranked (buildAspectSpecsForCategory). */
  specsFor: (categoryId: string) => Promise<EbayAspectSpec[]>;
}

export interface BatchCategoryResult {
  decision: CategoryDecision;
  categoryId: string | null;
  /** Only the keyword branch knows the ancestry; a vote knows the leaf alone. */
  categoryPath: string | null;
  /** The scored keyword shortlist; empty when the keyword branch did not run. */
  candidates: CategoryCandidateScore[];
}

/**
 * Decide the draft's eBay leaf: a saved category, else the leaf that visually
 * similar live listings sit in, else the keyword search on the model's phrase.
 *
 * The keyword branch is exactly the US-2424 scoring that ran here before:
 * the top CATEGORY_CANDIDATE_LIMIT suggestions ranked by how many of their
 * REQUIRED specifics the item can already fill, eBay's order as tie-break. It
 * is now the floor under decideCategory rather than the whole answer, and it
 * only runs when the vote did not settle - so a visual win costs no aspect
 * reads at all.
 *
 * A candidate whose spec cannot be read scores zero rather than dropping out,
 * as before. Everything else that throws (the suggestion call itself) is the
 * caller's to catch, so a network failure reads as "no category" and not as a
 * failed draft.
 */
export async function resolveBatchCategory(
  args: {
    savedCategoryId: string | null;
    query: string;
    leafVotes: readonly BrowseCompCategoryVote[];
    registryItem: RegistryItem;
    itemSpecifics: Record<string, string[]>;
    itemId: string;
  },
  deps: BatchCategoryDeps,
): Promise<BatchCategoryResult> {
  let candidates: CategoryCandidateScore[] = [];
  const decision = await decideCategory({
    savedCategoryId: args.savedCategoryId,
    leafVotes: args.leafVotes,
    leafStatus: deps.leafStatus,
    keywordSuggest: async () => {
      const query = args.query.trim();
      if (!query) return [];
      const suggestions = await deps.suggest(query);
      if (suggestions.length === 0) return [];
      const shortlist = suggestions.slice(0, CATEGORY_CANDIDATE_LIMIT);
      const scored: CategoryCandidateScore[] = [];
      for (const [rank, s] of shortlist.entries()) {
        try {
          scored.push(
            scoreCategoryCandidate(
              { categoryId: s.categoryId, categoryPath: s.categoryTreePath, rank },
              args.registryItem,
              args.itemSpecifics,
              await deps.specsFor(s.categoryId),
            ),
          );
        } catch (err) {
          console.error(
            `[AI Listing] category candidate ${s.categoryId} spec read failed:`,
            err,
          );
          scored.push({
            categoryId: s.categoryId,
            categoryPath: s.categoryTreePath,
            rank,
            requiredFilled: 0,
            requiredTotal: 0,
            requiredMissing: [],
          });
        }
      }
      candidates = rankCategoryCandidates(scored);
      const nameById = new Map(shortlist.map((s) => [s.categoryId, s.categoryName]));
      return candidates.map((c) => ({
        categoryId: c.categoryId,
        categoryName: nameById.get(c.categoryId) ?? "",
      }));
    },
  });
  return {
    decision,
    categoryId: decision.categoryId,
    categoryPath: decision.method === "keyword"
      ? candidates[0]?.categoryPath ?? null
      : null,
    candidates,
  };
}

/**
 * Fold the visual prefill's suggestions into the draft's specifics.
 *
 * visualAspectPrefill has already refused everything that should be refused
 * (a value the model gave, a value already set, a value the leaf does not
 * allow), so this only copies. Returned rather than mutated so the caller's
 * "what came from where" bookkeeping is one assignment. Pure.
 */
export function applyVisualPrefill(
  aspects: Record<string, string[]>,
  suggestions: Record<string, AspectValueSuggestion>,
): {
  aspects: Record<string, string[]>;
  confidence: Record<string, number>;
  names: string[];
} {
  const out = { ...aspects };
  const confidence: Record<string, number> = {};
  const names: string[] = [];
  for (const [name, sug] of Object.entries(suggestions)) {
    const values = (sug.values ?? []).map((v) => v.trim()).filter(Boolean);
    if (values.length === 0) continue;
    if ((out[name] ?? []).length > 0) continue;
    out[name] = values;
    confidence[name] = sug.confidence;
    names.push(name);
  }
  return { aspects: out, confidence, names };
}

export interface GenerateListingOptions {
  // Associate the produced draft with a generation batch (US-313).
  batchId?: string | null;
  // When false, skip the comp lookup (e.g. very large batches). Defaults true.
  useComps?: boolean;
  // US-2967: the batch's listing template, so its boilerplate becomes one of
  // the blocks written by the upsert below. It arrives here rather than being
  // patched on afterwards because a second write would leave the row holding a
  // `listing_description` its `description_blocks` do not produce — briefly on
  // the happy path, permanently if the patch fails.
  templateBoilerplate?: string | null;
}

export interface GenerateListingResult {
  listingId: string;
  listing: GeneratedListing;
  categoryId: string | null;
  categoryPath: string | null;
  priceCents: number;
  priceIsEstimated: boolean;
  model: string;
  promptVersion: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

interface ItemRow {
  id: string;
  user_id: string;
  title: string | null;
  brand: string | null;
  style: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  description: string | null;
  condition_notes: string | null;
  measurements: Record<string, unknown> | null;
  ebay_category_id: string | null;
  attributes: Record<string, unknown> | null;
  // US-2423: the vertical drives the registry's per-category aspect names
  // (shoes "Heel Style", bags "Handle/Strap Type"), so the projection needs it.
  item_category: string | null;
  // US-2595: the garment word. `item_category` alone is "clothing", which is
  // too coarse to pick a measurement template — a blazer and a pair of shorts
  // are both "clothing" and share no measurement at all.
  garment_category: string | null;
  garment_type: string | null;
}

// The tag-OCR ground-truth pass reads every tag/care-label photo; more than a
// handful is pathological (mis-roled shots), so bound the pass rather than the
// whole photo set.
const MAX_TAG_OCR_PHOTOS = 4;

// The size-estimate pass reads a ruler off the measurement / flat-lay shots and
// a fit off the rest; it was sent EVERY photo on the item, uncapped, when the
// tag had no size. Six, measurement-first, is the listing-pass budget and more
// than the ruler needs (2026-09-02).
const MAX_SIZE_ESTIMATE_PHOTOS = 6;

// Returns ALL listable photos in sort_order — deliberately uncapped. The
// vision-pass count discipline lives in selectListingPhotos (US-545), which
// picks a role-diverse capped subset; a positional pre-slice here would let
// gallery order (especially a manual reorder, US-1543) hide tag/defect shots
// from the role budget and the tag-OCR pass entirely.
async function loadItemPhotoUrls(itemId: string): Promise<ListingGenPhoto[]> {
  const { data } = await supabaseAdmin
    .from("item_photos")
    .select("id, photo_type, photo_role, storage_path, sort_order, photo_url")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });
  // US-1549: 'internal' photos (price tags, receipts) are seller-reference
  // only — the AI must never read them (they'd leak cost basis into copy).
  const listable = filterListablePhotos(
    (data ?? []) as (ItemPhotoUrlRow & { id: string })[],
  );
  // US-2265: the sensitive types (tag / tag_2 / certificate) live in the PRIVATE
  // bucket when the photo was captured on iOS, so a public URL 404s and the
  // model silently reads the item without its care/size label. Resolve each row
  // to a fetchable URL instead — sort_order is preserved, which selectListingPhotos
  // and the tag-OCR pass both depend on.
  const resolved = await itemPhotoAiUrls(listable);
  return resolved.map(({ row, url }) => ({
    url,
    type: row.photo_type ?? "",
    id: row.id,
  }));
}

/**
 * Generate a complete eBay draft listing for one inventory item and persist it.
 *
 * Tenant safety (CLAUDE.md US-268): the item is loaded scoped to `ownerId` and
 * the draft is written against that verified-owned item; callers MUST pass the
 * workspace owner id. The monthly AI-action GATE (checkQuota) is enforced by
 * the calling route (US-313/US-323); this function records the usage.
 */
export async function generateListing(
  itemId: string,
  ownerId: string,
  opts: GenerateListingOptions = {},
): Promise<GenerateListingResult> {
  const useComps = opts.useComps ?? true;

  // 1. Ownership-scoped item load.
  const { data: itemData, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(
      "id, user_id, title, brand, style, size, color, material, description, condition_notes, measurements, ai_field_sources, ebay_category_id, grade_report_id, attributes, item_category, garment_category, garment_type",
    )
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .single();
  if (itemErr || !itemData) {
    throw new Error(`Item ${itemId} not found for this workspace`);
  }
  const item = itemData as ItemRow;
  // US-1529: the research identification persisted by the extract pass (null
  // for never-identified items → generation behaves exactly as before).
  const identification = identificationFromAttributes(
    (itemData as { attributes?: Record<string, string | string[]> | null })
      .attributes,
  );
  const gradeReportId =
    (itemData as { grade_report_id?: string | null }).grade_report_id ?? null;

  // 1b. US-2595: the MeasureCard is one-and-done, and it runs BEFORE the photo
  // load on purpose. Finding the card retags that shot 'measurement', which is
  // what keeps the branded card out of the listing gallery and out of the vision
  // budget below — load the photos first and the card ships to eBay.
  let itemMeasurements = (item.measurements ?? {}) as Record<string, unknown>;
  let itemAiSources =
    ((item as { ai_field_sources?: Record<string, unknown> | null })
      .ai_field_sources ?? null) as Record<string, unknown> | null;
  let measureTokensIn = 0;
  let measureTokensOut = 0;
  let measureCost = 0;
  try {
    const measured = await autofillMeasurementsFromCard(itemId, ownerId, {
      id: item.id,
      title: item.title,
      // US-3034: the pass now files what it measures into the Fit &
      // Measurement Index, and a cohort is keyed on brand and style. Passing
      // them through is what lets a listing generated here contribute; leaving
      // them null would measure the garment and drop the result on the floor.
      brand: item.brand ?? null,
      style: (item as { style?: string | null }).style ?? null,
      size: item.size,
      measurements: itemMeasurements,
      ai_field_sources: itemAiSources,
      item_category: item.item_category,
      garment_category: item.garment_category,
      garment_type: item.garment_type,
    });
    if (measured.ran) {
      // The pass stamps 'ai_measured' provenance on what it wrote, which is
      // what hasCalibratedMeasurements reads to earn the method note below.
      itemMeasurements = measured.measurements;
      itemAiSources = measured.aiFieldSources;
      measureTokensIn = measured.tokensIn;
      measureTokensOut = measured.tokensOut;
      measureCost = measured.model
        ? estimateCost(measured.model, measured.tokensIn, measured.tokensOut)
        : 0;
    } else if (measured.reason === "calibration_failed") {
      console.warn(
        `[AI Listing] MeasureCard not readable on item ${itemId}: ${measured.message}`,
      );
    }
  } catch (err) {
    // Non-fatal by design: a bad card shot must never block a listing.
    console.error("[AI Listing] measurement autofill failed:", err);
  }
  const measurements = Object.keys(itemMeasurements).length > 0
    ? itemMeasurements
    : undefined;
  // US-1578: values that came from the calibrated MeasureCard pipeline get a
  // one-line method note inside the measurements block (text only).
  const calibratedMeasurements = hasCalibratedMeasurements(itemAiSources);


  // 2. Photos. US-545: the vision passes (generation + aspect refine) send a
  // cost-disciplined subset — exact-duplicate and near-identical same-role
  // shots dropped, count capped, defect/tag roles prioritized — since image
  // tokens dominate per-item cost. Tag-OCR scans the tag set below (bounded
  // separately; tags are cheap and authoritative).
  const photos = await loadItemPhotoUrls(itemId);
  if (photos.length === 0) {
    throw new Error(`Item ${itemId} has no photos to generate a listing from`);
  }
  const visionPhotos = selectListingPhotos(photos);

  // 2a. US-2778: start the eBay visual pass NOW, and do not await it here.
  //
  // Everything between this line and step 4 is network-bound and already runs:
  // the MeasureCard autofill, the tag-OCR pass, the size estimate, the category
  // aspect fetch, the demand-term mine. The pass overlaps all of it, so on the
  // common path it costs no wall clock at all. Bolting it on in front of them
  // would cost a full second per item across a 300-item batch.
  //
  // Flag off returns immediately without fetching a byte. Every failure path
  // inside returns an empty result whose only content is WHY, so the worst case
  // here is the prompt AutoLister builds today.
  // The own-listing read is handed over UNAWAITED for the same reason. It is
  // only needed once the search comes back, so awaiting it here would put a
  // database round trip in front of a call that has not started yet.
  const visualPass = startVisualPass(visionPhotos, {
    ownItemIds: ownEbayListingIds(ownerId),
  });

  const knownFields: Record<string, unknown> = {};
  for (
    const [k, v] of Object.entries({
      title: item.title,
      brand: item.brand,
      style: item.style,
      size: item.size,
      color: item.color,
      material: item.material,
      condition_notes: item.condition_notes,
    })
  ) {
    if (v != null && String(v).trim() !== "") knownFields[k] = v;
  }
  // 2b. US-543: dedicated tag-OCR ground-truth pass. When a tag/care-label
  // photo exists, run a focused vision pass over ONLY the tag(s) to read
  // brand/size/fiber/style/RN verbatim, then fold confident reads into
  // knownFields (tag WINS) and flag them as authoritative for the listing call
  // so brand/size aren't hallucinated from a busy garment shot.
  let tagGroundTruth: Record<string, string> | undefined;
  // 2026-09-02: the label facts that belong on inventory_items.attributes
  // (garment_care, country_of_manufacture, product_line, mpn), fill-only. They
  // feed the registry projection below AND the item write, so the label is
  // read once and lands on the category's real aspect names without the model
  // having to copy it.
  let tagAttributes: Record<string, string> = {};
  let tagOcrTokensIn = 0;
  let tagOcrTokensOut = 0;
  let tagOcrCost = 0;
  let tagOcrModel: string | null = null;
  let tagOcrFields: TagGroundTruth | null = null;
  // US-3047: the role pass is a real vision call and its spend belongs in this
  // item's row like every other bundled pass. It was billed to the ledger under
  // "photo_roles" but never reached ai_enrichment_log, so the per-item cost
  // understated what a tag-less item actually charged.
  let roleTokensIn = 0;
  let roleTokensOut = 0;
  let roleCost = 0;
  let roleModel: string | null = null;
  let tagPhotos = selectTagOcrPhotos(photos, MAX_TAG_OCR_PHOTOS);
  // 2026-09-02: on prod, 150 of 1001 items had a tag-typed photo and OCR ran
  // on 11 of ~300 generations - the label was usually sitting under `detail`.
  // When nothing is typed tag, ask the holistic role pass (US-533) which photo
  // is the label, read THAT, and relabel only rows still on the detail
  // default. One vision call, only on this branch, metered as photo_roles.
  // US-3047: …and only when a photo could still be MISLABELLED. An item whose
  // photos all carry a deliberate role, none of them tag, has no label for the
  // classifier to find, and the call would return what we already know.
  if (tagPhotos.length === 0 && shouldRunTagRolePass(photos)) {
    const candidates = photos.filter(
      (p): p is ListingGenPhoto & { id: string } => !!p.id,
    );
    if (candidates.length >= 2) {
      try {
        const rolePass = await classifyPhotoRoles(
          candidates.map((p) => ({ id: p.id, url: p.url })),
        );
        roleModel = rolePass.model;
        roleTokensIn = rolePass.tokensIn;
        roleTokensOut = rolePass.tokensOut;
        roleCost = estimateCost(rolePass.model, rolePass.tokensIn, rolePass.tokensOut);
        const plan = planTagRoleWriteback(candidates, rolePass.roles);
        tagPhotos = plan.tagPhotos.slice(0, MAX_TAG_OCR_PHOTOS);
        if (plan.writeback.length > 0) {
          const { error } = await supabaseAdmin
            .from("item_photos")
            .update({ photo_type: "tag" })
            .in("id", plan.writeback)
            .eq("inventory_item_id", itemId);
          if (error) {
            console.warn("[AI Listing] tag role writeback failed:", error.message);
          }
        }
        console.log(
          `[AI Listing] tag search on item ${itemId}: ${tagPhotos.length} label photo(s) found by role pass`,
        );
      } catch (err) {
        console.error("[AI Listing] tag role pass failed (non-fatal):", err);
      }
    }
  }
  if (tagPhotos.length > 0) {
    try {
      const ocr = await extractTagGroundTruth(
        tagPhotos.map((p) => ({ url: p.url, type: p.type })),
      );
      const { merged, groundTruth } = mergeTagGroundTruth(knownFields, ocr.fields);
      Object.assign(knownFields, merged);
      tagOcrFields = ocr.fields;
      if (Object.keys(groundTruth).length > 0) tagGroundTruth = groundTruth;
      tagAttributes = tagAttributeFill(ocr.fields, item.attributes);
      tagOcrModel = ocr.model;
      tagOcrTokensIn = ocr.tokensIn;
      tagOcrTokensOut = ocr.tokensOut;
      tagOcrCost = estimateCost(ocr.model, ocr.tokensIn, ocr.tokensOut);
    } catch (err) {
      // Non-fatal: fall back to implicit inference from the full photo set.
      console.error("[AI Listing] tag-OCR ground-truth pass failed:", err);
    }
  }

  // 2b-ii. US-2595: the size, without a second button.
  //
  // Thrifted stock routinely has a cut-off, faded or missing size label, so the
  // tag-OCR pass above comes back with no size and the draft published a blank
  // Size specific — the single most-asked question on a resale listing. The
  // seller's only recourse was the composer's "Estimate" button, which is the
  // same vision pass this now runs on its own. It only fires when the size is
  // STILL unknown after the tag read, so an item with a legible label costs
  // nothing extra, and a low-confidence guess is discarded rather than written.
  let sizeTokensIn = 0;
  let sizeTokensOut = 0;
  let sizeCost = 0;
  let estimatedSize: string | null = null;
  if (String(knownFields.size ?? "").trim() === "") {
    try {
      const est = await estimateSize({
        photos: prioritizeMeasurementPhotos(
          photos.map((p) => ({ url: p.url, type: p.type })),
        ).slice(0, MAX_SIZE_ESTIMATE_PHOTOS),
        brand: typeof knownFields.brand === "string"
          ? (knownFields.brand as string)
          : item.brand,
        category: item.item_category,
      });
      sizeTokensIn = est.tokensIn;
      sizeTokensOut = est.tokensOut;
      sizeCost = estimateCost(est.model, est.tokensIn, est.tokensOut);
      const guess = (est.size ?? "").trim();
      if (guess !== "" && est.confidence >= SIZE_ESTIMATE_LOW_CONFIDENCE) {
        knownFields.size = guess;
        estimatedSize = guess;
      }
    } catch (err) {
      // Non-fatal: a listing without a size is worse than one with a guess, but
      // both beat no listing at all.
      console.error("[AI Listing] size estimate failed:", err);
    }
  }

  // 2c. US-544: canonicalize the brand and resolve a style code. The model/tag
  // brand is free text ("Levis"), but the eBay Browse/Insights comp filter is an
  // EXACT-match `Brand:{...}` aspect — a non-canonical value drops the filter and
  // prices off the unfiltered category. canonicalizeBrand maps it to eBay's
  // spelling; resolveStyleCode turns a sneaker/streetwear style code into the
  // authoritative brand + an EXACT comp query (the code returns the same shoe)
  // + auto-fillable specifics. The tag read (knownFields) wins over the prior
  // item column. styleResolution.brand (resolved from the code) outranks the
  // text brand when present.
  const rawBrand = typeof knownFields.brand === "string"
    ? (knownFields.brand as string)
    : item.brand;
  const canonicalBrand = canonicalizeBrand(rawBrand);
  const rawStyle = typeof knownFields.style === "string"
    ? (knownFields.style as string)
    : item.style;
  const styleResolution: StyleResolution | null = resolveStyleCode(
    rawStyle,
    canonicalBrand,
  );
  const normalizedBrand = styleResolution?.brand ?? canonicalBrand;

  // 2026-09-02: the code the LISTING files under, decoded inside the brand's
  // own pack (lib/listing-style-code.ts). resolveStyleCode above is the sneaker
  // resolver and returns null for every apparel brand; it used to be the only
  // source, which is why prod had zero Style Code aspects.
  let brandPack: BrandKnowledgePack | null = null;
  try {
    brandPack = await resolveBrandKnowledgePack(normalizedBrand, {
      category: item.garment_type ?? item.garment_category ?? null,
    });
  } catch (err) {
    console.error("[AI Listing] brand pack read failed (non-fatal):", err);
  }
  const listingCode = resolveListingStyleCode({
    ocr: tagOcrFields,
    itemAttributes: item.attributes as Record<string, unknown> | null,
    sneakerStyleCode: styleResolution?.styleCode ?? null,
    brand: normalizedBrand,
    pack: brandPack,
  });
  if (listingCode.styleCodeRaw) {
    // The canonical spelling is what lands on attributes.mpn and therefore on
    // the Style Code / MPN aspect (US-2714: one spelling per garment).
    tagAttributes = {
      ...tagAttributes,
      mpn: listingCode.styleCodeNorm || listingCode.styleCodeRaw,
    };
    knownFields.style_code = listingCode.styleCodeRaw;
  }

  // 2026-09-02: what the style-code index knows this code to be. A resolved
  // name (a source in a position to know) becomes a title fact and the Model
  // aspect; an observation-only name is offered to the model as an unverified
  // candidate and written nowhere.
  let learnedForListing: LearnedStyleForListing = {
    resolvedName: null,
    resolvedSource: null,
    candidateName: null,
    confidence: 0,
  };
  if (listingCode.styleCodeRaw && (brandPack?.key || normalizedBrand)) {
    try {
      const learned = await lookupLearnedStyle(
        brandPack?.key ?? brandKey(normalizedBrand as string),
        listingCode.styleCodeRaw,
      );
      learnedForListing = learnedStyleForListing(
        learned,
        normalizedBrand,
        listingCode.styleCodeRaw,
      );
      const applied = applyLearnedStyleToListing({
        learned: learnedForListing,
        knownFields,
        tagGroundTruth,
        tagAttributes,
        sellerTypedStyle: item.style ?? null,
      });
      Object.assign(knownFields, applied.knownFields);
      tagGroundTruth = applied.tagGroundTruth;
      tagAttributes = applied.tagAttributes;
    } catch (err) {
      console.error("[AI Listing] learned style lookup failed (non-fatal):", err);
    }
  }
  // 2026-09-02: the RN off the label, checked against the registry. Read on
  // every item since US-543 and discarded until now. A contradiction caps the
  // brand's confidence below the review threshold; it never changes the brand.
  // fieldConfidence is declared here (it used to be declared at the refine
  // step) so the cap exists before the refine pass adds its own entries.
  const fieldConfidence: Record<string, number> = {};
  let rnOutcome = "none";
  const rnRead = typeof knownFields.rn_number === "string"
    ? knownFields.rn_number
    : null;
  if (rnRead) {
    try {
      const ctx = await getRegisteredNumberContext();
      const assessment = assessRegisteredNumber(
        rnRead,
        normalizedBrand,
        ctx.index,
        ctx.registrants,
      );
      const rnPlan = planListingRegisteredNumber({
        rn: rnRead,
        declaredBrand: normalizedBrand,
        existingAttributes: item.attributes as Record<string, unknown> | null,
        assessment,
      });
      rnOutcome = rnPlan.outcome;
      tagAttributes = { ...tagAttributes, ...rnPlan.attributes };
      if (rnPlan.brandConfidenceCap != null) {
        fieldConfidence.brand = Math.min(
          fieldConfidence.brand ?? 1,
          rnPlan.brandConfidenceCap,
        );
        console.warn(
          `[AI Listing] RN contradicts brand on item ${itemId}: ${rnPlan.note}`,
        );
      }
      if (rnPlan.recordSighting) {
        void recordRegisteredNumberSighting(assessment, normalizedBrand);
      }
    } catch (err) {
      console.error("[AI Listing] RN cross-check failed (non-fatal):", err);
    }
  }

  // 2026-09-02: one line per generation for the tag-to-listing chain, so the
  // next measurement (US-3044's report reads the aspects; this reads the path)
  // can say WHERE a code was lost: no tag photo, no read, no decode, no name.
  console.log(
    `[listing-tag-metric] item=${itemId} brand=${JSON.stringify(normalizedBrand)} ` +
      `tag_photos=${tagPhotos.length} code=${JSON.stringify(listingCode.styleCodeRaw)} ` +
      `code_source=${listingCode.source ?? "none"} decoded=${listingCode.decoded ? 1 : 0} ` +
      `named=${learnedForListing.resolvedName ? 1 : 0} rn=${rnOutcome}`,
  );

  const learnedCandidate: VisualCandidate[] = learnedForListing.candidateName
    ? [{
      field: "style",
      value: learnedForListing.candidateName,
      // One index observation is one listing's word for it.
      support: 1,
      outOf: 1,
    }]
    : [];

  // 3. If the item already has a category, constrain item_specifics up front.
  let categoryId = item.ebay_category_id;
  let categoryPath: string | null = null;
  let allowedAspects: Record<string, string[]> = {};
  let aspectsAlreadyConstrained = false;

  if (categoryId) {
    try {
      // Demand-ranked and capped, the same list the refine schema gets - not
      // the raw payload (see promptAllowedAspects).
      allowedAspects = promptAllowedAspects(
        buildAspectSpecsForCategory(await getCategoryAspects(categoryId)),
      );
      aspectsAlreadyConstrained = Object.keys(allowedAspects).length > 0;
    } catch (err) {
      console.error("[AI Listing] getCategoryAspects (pre) failed:", err);
    }
  }

  // 3b. US-546 (AC2): mine high-demand eBay search terms for this item's
  // brand/category from live comp titles and feed them into the generation
  // prompt so the title/description lead with words buyers actually search.
  // NON-THROWING (returns [] on any failure) and free of Anthropic cost — one
  // Browse (app-token) call keyed on the normalized brand + category. The query
  // hint folds in the item's existing title and any resolved style code.
  const demandQueryHint = [
    item.title,
    styleResolution?.compQuery && styleResolution.compQuery !== normalizedBrand
      ? styleResolution.compQuery
      : null,
  ]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .join(" ")
    .trim();
  // US-2675: the detailed form, so the draft records whether each term came
  // from items that SOLD or merely from what other sellers are asking. The
  // prompt still gets plain words -- the model has no use for the provenance,
  // and the seller looking at the chip is the one who does.
  const demandTermDetail = await getEbaySearchDemandTermsDetailed({
    // US-2683: so the seller's own eBay search terms lead the pool.
    ownerId,
    brand: normalizedBrand,
    categoryId,
    query: demandQueryHint || null,
    size: item.size,
  });
  const demandTerms = demandTermDetail.map((t) => t.term);

  // 4. Generate (on the cost-disciplined photo subset).
  //
  // US-2778: the visual pass is awaited HERE, at the last possible moment, so
  // everything above overlapped it. `declined` is logged rather than swallowed:
  // role_not_identifying and no_matches are different findings with different
  // fixes, and a run that produced nothing must not look like a run that never
  // happened.
  const visual = await visualPass;
  if (visual.declined) {
    console.log(
      `[AI Listing] visual pass declined on item ${itemId}: ${visual.declined}`,
    );
  }

  // US-2781: the style line, if anything that is not a title backs it.
  const styleFromVisual = await corroborateMinedStyleNames({
    mined: visual.styleNameCandidates,
    aspectProductNames: visual.aspectProductNames,
    brand: normalizedBrand,
    decodedStyleName: learnedForListing.resolvedName ??
      styleResolution?.aspects.Model?.[0] ?? null,
    styleCodeRaw: listingCode.styleCodeRaw,
  });

  const gen = await generateListingFields({
    photos: visionPhotos,
    knownFields: Object.keys(knownFields).length > 0 ? knownFields : undefined,
    tagGroundTruth,
    measurements,
    allowedAspects: aspectsAlreadyConstrained ? allowedAspects : undefined,
    demandTerms: demandTerms.length > 0 ? demandTerms : undefined,
    // US-1529: identified-product context (title leads with the style name).
    identification,
    // US-2778: eBay's guess, in its own block, under the precedence ladder.
    // US-2781 appends any style name a non-title source confirmed; the model
    // can still reject it against the photos, like every other candidate.
    visualCandidates: [
      ...visual.candidates,
      ...styleFromVisual,
      ...learnedCandidate,
    ],
    // US-547: split this item between champion / A/B-challenger prompt.
    promptSelectKey: itemId,
  });
  const listing = gen.listing;

  // The item as the aspect registry sees it — its columns plus everything the
  // capture pass stored on `attributes`. Built once here because BOTH the
  // category choice (step 5, US-2424) and the draft projection (step 6c-bis,
  // US-2423) score/fill from exactly the same picture of the item.
  const registryItem: RegistryItem = {
    item_category: item.item_category,
    brand: normalizedBrand ?? item.brand,
    size: item.size,
    color: item.color,
    material: item.material,
    style: item.style,
    title: item.title,
    description: item.description,
    condition_notes: item.condition_notes,
    attributes: withTagAttributes(
      item.attributes as Record<string, string | string[]> | null,
      tagAttributes,
    ),
  };

  // 5. Resolve a real eBay leaf category when the item didn't have one.
  //
  // US-2424: eBay's Taxonomy suggestions are keyword hits, not judgments about
  // THIS item. Taking suggestions[0] on faith regularly landed a leaf whose
  // required specifics the item could not fill — and every one of those is a
  // publish blocker the seller has to clear by hand. So score the top few
  // instead: which leaf can the item already satisfy? No extra AI — the score
  // is a deterministic count over the cached category specs, and eBay's own
  // order is the tie-break, so one candidate behaves exactly as before.
  //
  // US-3043: the visual pass's leaf votes decide FIRST. Where two or more
  // visually similar live listings sit in the same leaf, that leaf wins over
  // the keyword search on the model's phrase - the same precedence the
  // one-item path has used since US-2765. A saved category still wins
  // outright, and the keyword scoring above is the floor when the vote did
  // not settle. resolveBatchCategory carries the whole rule and its fakes.
  let categoryCandidates: CategoryCandidateScore[] = [];
  let categoryDecision: CategoryDecision | null = null;
  try {
    const resolved = await resolveBatchCategory(
      {
        savedCategoryId: categoryId,
        query: listing.suggested_category_query ?? "",
        leafVotes: visual.leafCategoryVotes,
        registryItem,
        itemSpecifics: listing.item_specifics,
        itemId,
      },
      {
        leafStatus: fetchCategoryLeafStatus,
        suggest: async (q) => (await cachedSuggestCategories(q)).result,
        specsFor: async (id) => buildAspectSpecsForCategory(await getCategoryAspects(id)),
      },
    );
    categoryDecision = resolved.decision;
    categoryCandidates = resolved.candidates;
    if (!categoryId) {
      categoryId = resolved.categoryId;
      categoryPath = resolved.categoryPath;
    }
    if (resolved.decision.method === "visual_consensus") {
      console.log(
        `[AI Listing] category ${resolved.categoryId} chosen for item ${itemId} ` +
          `by visual consensus (${resolved.decision.support} similar listings)`,
      );
    } else if (resolved.decision.rejectedReason) {
      // A vote that lost is worth a line: an ignored vote and an absent vote
      // are indistinguishable in the data otherwise.
      console.log(
        `[AI Listing] visual category vote rejected (${resolved.decision.rejectedReason}) ` +
          `for item ${itemId}; fell back to ${resolved.decision.method}`,
      );
    }
    if (categoryCandidates.length > 1 && resolved.decision.method === "keyword") {
      const best = categoryCandidates[0]!;
      console.log(
        `[AI Listing] category ${best.categoryId} chosen for item ${itemId}: ` +
          `${best.requiredFilled}/${best.requiredTotal} required aspects fillable ` +
          `(eBay rank ${best.rank})`,
      );
    }
  } catch (err) {
    console.error("[AI Listing] category resolve failed:", err);
  }

  // 5b. US-3031: settle the condition against the leaf we just resolved.
  //
  // The model picks a condition from the full enum before anything knows which
  // category the item lands in, so on a clothing leaf it lands on a rejected
  // tier (LIKE_NEW / USED_VERY_GOOD / USED_GOOD / USED_ACCEPTABLE) most of the
  // time. Until this ran here, the first anyone heard of it was the composer's
  // red "not accepted by this category" warning, and the publish it blocked.
  //
  // Deliberately placed BEFORE the comp search in step 7: comps are filtered on
  // the condition id, so pricing should reflect the condition we will actually
  // publish, not the one eBay would have bounced.
  //
  // Best-effort. A policy-fetch failure or an unrestricted category leaves the
  // model's pick exactly as it was.
  let conditionUnresolved = false;
  if (categoryId) {
    try {
      const { conditionIds } = await getItemConditionPolicies(categoryId);
      const resolved = resolveDraftCondition(listing.ebay_condition, conditionIds);
      conditionUnresolved = resolved.unresolved;
      if (resolved.changed) {
        console.log(
          `[AI Listing] condition "${listing.ebay_condition}" resolved to ` +
            `"${resolved.condition}" for category ${categoryId} (item ${itemId})`,
        );
        listing.ebay_condition = resolved.condition;
      } else if (resolved.unresolved) {
        console.warn(
          `[AI Listing] category ${categoryId} accepts no honest stand-in for ` +
            `condition "${listing.ebay_condition}" (item ${itemId}) — draft sent to review`,
        );
      }
    } catch (err) {
      console.warn(
        "[AI Listing] condition-policy resolve (non-blocking):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 6. US-312: second pass — constrain item_specifics VALUES (not just names)
  //    to the category's allowed aspect set via extractEbayAspects' dynamic
  //    tool schema. Photos + the AI-generated specifics ("known aspects")
  //    drive the call; eBay-rejected free-text values for SELECTION_ONLY
  //    aspects get dropped, required gaps get filled when supported.
  let itemSpecifics: Record<string, string[]> = listing.item_specifics;
  // US-828: the resolved category aspect spec, lifted so the generation-time
  // reconciliation pass (step 6d) can validate names+values against it after the
  // brand/measurement folds have run.
  let aspectSpecs: EbayAspectSpec[] = [];
  // US-541: per-aspect confidence from the refine pass, for needs_review triage.
  // US-3043: what the refine pass answered, so the visual prefill below can
  // stand down on every aspect the model looked at the actual garment for.
  let refineSuggestions: Record<string, AspectValueSuggestion> = {};
  let extractCost = 0;
  let extractTokensIn = 0;
  let extractTokensOut = 0;
  // US-2425: the RAW category payload, kept because the coverage metric reads
  // two fields the flattened EbayAspectSpec drops — `aspectUsage` (REQUIRED vs
  // RECOMMENDED) and `relevanceIndicator.searchCount` (what buyers filter on).
  let rawAspectsResponse: unknown = null;
  if (categoryId) {
    try {
      rawAspectsResponse = await getCategoryAspects(categoryId);
    } catch (err) {
      console.error("[AI Listing] getCategoryAspects (post) failed:", err);
    }
    if (rawAspectsResponse) {
      // Keep the name-keyed map for legacy paths that read allowedAspects.
      allowedAspects = extractAllowedAspects(rawAspectsResponse);
      const specs = buildAspectSpecsForCategory(rawAspectsResponse);
      aspectSpecs = specs;
      if (specs.length > 0) {
        try {
          // US-545: on common apparel categories the item-specifics are
          // unambiguous enough to refine on the cheap model. Route those to
          // Haiku; everything else (designer/vintage/non-apparel) stays on the
          // default vision model. The signal is the resolved category path,
          // falling back to the model's own natural-language category query.
          const easyCategory = isEasyAspectCategory(
            categoryPath ?? listing.suggested_category_query,
          );
          const refined = await extractEbayAspects({
            text: [item.title, normalizedBrand, item.size, item.color, item.material]
              .filter((v): v is string => !!v && v.length > 0)
              .join(" • "),
            // 2026-09-02: the defect close-ups stay home. No item specific is
            // read off a stain, and each one was ~1,500 image tokens on this
            // call. See selectAspectPhotos.
            photos: selectAspectPhotos(visionPhotos).map((p) => ({
              url: p.url,
              type: p.type,
            })),
            knownAspects: listing.item_specifics,
            aspects: specs,
            categoryPath,
            // What the care label said, in words, so Country of Origin, Garment
            // Care and Material fill from the read rather than from a label
            // photo that may no longer be in the set.
            tagGroundTruth: tagGroundTruth ?? null,
            modelOverride: easyCategory ? getHaikuModel() : undefined,
            // US-2419: name the identified product so Style/Model/Product Line/
            // Fabric Type can be filled instead of omitted under the never-guess
            // rule. No extra AI call — this is the SAME second pass, told what
            // the first pass already worked out. Null identification → the
            // prompt is byte-identical to before.
            research: researchFromIdentification(identification),
            // US-3047: bill the refine pass under its own slug. It shared
            // "catalog_extract" with the one-item extract path, so the ledger
            // could not answer what a DRAFT's refine costs, which is the number
            // US-3045 is argued from.
            feature: "autolister_refine",
          });
          refineSuggestions = refined.suggestions;
          const refinedSpecifics = suggestionsToSpecifics(refined.suggestions);
          // US-541: capture each refined aspect's confidence (0..1) for triage.
          for (const [name, sug] of Object.entries(refined.suggestions)) {
            if (typeof sug.confidence === "number") {
              fieldConfidence[name] = sug.confidence;
            }
          }
          // Merge: refined values WIN (they're constrained to eBay's allowed
          // set); fall back to the original AI generation for any aspect the
          // refiner didn't return (e.g. extractEbayAspects intentionally omits
          // SELECTION_ONLY aspects when no allowed value matches — keep the
          // original in case it's a synonym we can clean up later).
          itemSpecifics = { ...listing.item_specifics, ...refinedSpecifics };
          extractCost = estimateCost(refined.model, refined.tokensIn, refined.tokensOut);
          extractTokensIn = refined.tokensIn;
          extractTokensOut = refined.tokensOut;
        } catch (err) {
          console.error("[AI Listing] extractEbayAspects (second pass) failed:", err);
          // Fall back to the name-only filter so we never publish aspects the
          // category doesn't accept, even if the value-constrain call fails.
          if (Object.keys(allowedAspects).length > 0) {
            const allowedNames = new Map(
              Object.keys(allowedAspects).map((n) => [n.toLowerCase(), n]),
            );
            const filtered: Record<string, string[]> = {};
            for (const [name, values] of Object.entries(listing.item_specifics)) {
              const canonical = allowedNames.get(name.toLowerCase());
              if (canonical) filtered[canonical] = values;
            }
            itemSpecifics = filtered;
          }
        }
      }
    }
  }

  // 6b. US-544: force the canonical Brand specific (so the published Brand aspect
  // matches what eBay indexes on, not "Levis") and fold in any style-resolved
  // product aspects the category permits. Constrained to allowedAspects so we
  // never push an aspect the category would reject at publish; product aspects
  // never clobber a value the model already determined.
  itemSpecifics = applyCanonicalBrandAndStyle(
    itemSpecifics,
    normalizedBrand,
    styleResolution,
    Object.keys(allowedAspects),
  );

  // 6c. US-827: fold captured measurements into the category's eBay measurement
  // aspects (Inseam, Chest Size, Sleeve Length, …) via the registry mapping —
  // only onto free-text aspects the category actually exposes, never clobbering
  // a value the model/refiner already set. Stored values are inches.
  if (measurements && Object.keys(allowedAspects).length > 0) {
    const measurementAspects = resolveMeasurementAspects(
      measurements,
      allowedAspects,
      itemSpecifics,
    );
    if (Object.keys(measurementAspects).length > 0) {
      itemSpecifics = { ...itemSpecifics, ...measurementAspects };
    }
  }

  // 6c-bis. US-2423: fill what the item ALREADY knows. Everything the capture
  // pass read (pattern, fit, neckline, and the US-2421 widening — accents,
  // occasion, heel type, strap type …) lives on inventory_items.attributes, but
  // until now it only reached eBay at PUBLISH. So a fresh draft showed those
  // specifics blank and the seller retyped facts we had already extracted.
  //
  // Fill-only: resolveItemAspects never returns a name that `itemSpecifics`
  // already holds, so a model- or refiner-set value always wins. The names
  // filled here are tracked so they land as `inventory_derived` provenance —
  // which is what lets a later manual edit outrank them (mergeSources).
  const inventoryDerivedNames = new Set<string>();
  if (aspectSpecs.length > 0) {
    const derived = deriveInventoryAspects(registryItem, aspectSpecs, itemSpecifics);
    for (const name of Object.keys(derived)) inventoryDerivedNames.add(name);
    if (inventoryDerivedNames.size > 0) {
      itemSpecifics = { ...itemSpecifics, ...derived };
    }
  }

  // 6c-ter. US-3043: what visually similar live listings agree on, for the
  // aspects still empty after the model, the registry and the label. Same
  // helper and same refusals as the one-item path (US-2770): a value the model
  // gave, a value already set, or a value the leaf does not allow is skipped
  // and the refusal logged. Confidence is capped at VISUAL_ASPECT_CONFIDENCE_CAP
  // inside the helper, and the names land as `visual_consensus` provenance so a
  // seller edit and a later AI pass both outrank them. No model runs here.
  const visualConsensusNames = new Set<string>();
  if (aspectSpecs.length > 0 && visual.evidence) {
    const prefill = visualAspectPrefill({
      evidence: visual.evidence,
      specs: aspectSpecs,
      existing: itemSpecifics,
      modelSuggestions: refineSuggestions,
    });
    const applied = applyVisualPrefill(itemSpecifics, prefill.suggestions);
    if (applied.names.length > 0) {
      itemSpecifics = applied.aspects;
      Object.assign(fieldConfidence, applied.confidence);
      for (const name of applied.names) visualConsensusNames.add(name);
    }
    if (prefill.skipped.length > 0) {
      console.log(
        `[AI Listing] visual aspect prefill skipped for item ${itemId}:`,
        JSON.stringify(prefill.skipped.map((k) => `${k.aspect}:${k.reason}`)),
      );
    }
  }

  // 6d. US-828: reconcile the assembled specifics against the category spec —
  // validate every aspect NAME and VALUE, normalize SELECTION_ONLY near-misses
  // through the US-823 normalizer, and capture anything still unmatched as
  // needs-review on the draft (kept visibly, never silently dropped). This
  // closes the value-validation hole the name-only fallback (above) left: a
  // SELECTION_ONLY aspect that kept its original AI value when the refiner
  // omitted it gets one more normalization pass here, and an invalid value is
  // surfaced for the seller instead of discovered as a publish-time omission.
  let aspectReview: AspectReviewEntry[] = [];
  if (aspectSpecs.length > 0) {
    const reconciled = reconcileGeneratedAspects(
      itemSpecifics,
      specsFromEbayAspectSpecs(aspectSpecs),
    );
    itemSpecifics = reconciled.aspects;
    aspectReview = reconciled.review;
    if (aspectReview.length > 0) {
      console.warn(
        `[AI Listing] ${aspectReview.length} aspect(s) need review for item ${itemId}: ` +
          JSON.stringify(aspectReview),
      );
    }
  }

  // 6e. US-2425: score the finished specifics against the category spec. This is
  // the number that makes every other change in this pipeline measurable — a
  // wider capture, a better category pick, a new projection either moves it or
  // it didn't help. Required and recommended stay separate: a required gap
  // blocks the publish, a recommended one only costs search placement.
  // Null when no category resolved (nothing to score against).
  const aspectCoverage: DraftAspectCoverage | null = rawAspectsResponse
    ? buildAspectCoverage(
      rankedAspectSpecs(rawAspectsResponse),
      itemSpecifics,
      categoryId,
      new Date().toISOString(),
    )
    : null;

  // 7. Price (US-542): prefer REALIZED/sold comps; price_is_estimated=false ONLY
  // when the price is backed by sold data. Active Browse comps are ASKING prices
  // (systematically high), so when we fall back to them we set the price but
  // keep price_is_estimated=true and surface the limitation via price_comp_source.
  let priceCents = listing.suggested_price_cents;
  let priceIsEstimated = true; // assume AI estimate until sold-backed
  let priceRangeLowCents: number | null = null;
  let priceRangeHighCents: number | null = null;
  let priceConfidence: number | null = null;
  let priceCompSource: PriceCompSource = "ai_estimate";
  if (useComps && categoryId) {
    const conditionId = conditionIdForComps(listing.ebay_condition);
    // US-544: comps key on the NORMALIZED brand (exact-match aspect filter) and,
    // for sneakers/streetwear, on the style code as the query — the single most
    // precise comp key (returns the same product, not a fuzzy category match).
    const compBrand = normalizedBrand ?? undefined;
    const compQuery = styleResolution?.compQuery ??
      compBrand ?? (listing.suggested_category_query || undefined);
    try {
      const sold = await getRealizedComps({
        ownerId,
        categoryId,
        brand: compBrand,
        q: compQuery,
        size: item.size ?? undefined,
        conditionId,
      });
      if (sold && sold.medianCents != null) {
        // Backed by realized sales — the honest, non-estimated price.
        priceCents = sold.medianCents;
        priceIsEstimated = false;
        priceRangeLowCents = sold.lowCents;
        priceRangeHighCents = sold.highCents;
        priceConfidence = sold.confidence;
        priceCompSource = sold.source;
      } else {
        // Graceful fallback: active asking-price comps. Set the price but flag
        // it as estimated (not sold-backed) so the editor surfaces the caveat.
        const active = await searchBrowseComps({
          categoryId,
          q: compQuery,
          brand: compBrand,
          size: item.size ?? undefined,
          conditionId,
        });
        if (active.stats.median != null) {
          priceCents = Math.round(active.stats.median * 100);
          priceRangeLowCents = active.stats.p25 != null
            ? Math.round(active.stats.p25 * 100)
            : null;
          priceRangeHighCents = active.stats.p75 != null
            ? Math.round(active.stats.p75 * 100)
            : null;
          priceConfidence = activeCompConfidence(active.stats.count);
          priceCompSource = "active_asking";
          // priceIsEstimated stays true — asking prices are not realized sales.
        }
      }
    } catch (err) {
      console.error("[AI Listing] comp pricing failed:", err);
    }
  }
  // US-956: the confidence we attribute to the chosen price, recorded under
  // ai_field_confidence.listing_price. Sold/active comps carry their own
  // confidence; a pure AI estimate inherits the model's overall confidence.
  const listingPriceConfidence = priceConfidence ?? listing.confidence;
  // US-956: clear the estimated flag when the price is trusted enough — either
  // sold-backed (priceIsEstimated already false above) OR its confidence meets
  // the threshold. Below threshold the flag (and "est." badge) is unchanged.
  if (priceIsEstimated && priceConfidenceClearsEstimated(listingPriceConfidence)) {
    priceIsEstimated = false;
  }
  const priceDollars = Math.round(priceCents) / 100;

  // US-317: surface the per-group cover photo as listings.primary_photo_id
  // so the composer's "primary photo" view (00027) and any thumbnail-aware
  // surface (kanban, listings table) see the cover that AutoLister chose.
  // Items are inserted by autolister.tsx with the cover at sort_order=0; we
  // resolve its id here so the listing draft can reference it.
  const { data: firstPhotoRow } = await supabaseAdmin
    .from("item_photos")
    .select("id")
    .eq("inventory_item_id", itemId)
    // US-1549: a seller-reference photo must never become the cover.
    .neq("photo_type", "internal")
    // US-1571: nor the MeasureCard calibration frame. SQL-side filter on the
    // new enum value is safe here: the boot guard holds this code behind
    // migration 00346 (EXPECTED_SCHEMA_VERSION bumps in the same commit).
    .neq("photo_type", "measurement")
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  const primaryPhotoId = firstPhotoRow
    ? ((firstPhotoRow as { id: string }).id)
    : null;

  // 7b. The description, as BLOCKS (US-2959).
  //
  // This used to be four string concatenations in a row: the measurements block
  // appended to the model's prose, then the disclosure, then the credential,
  // then the facts block. Every fact the model had ALSO written into its prose
  // stayed there forever, because a string has no seam a later edit can find.
  //
  // Now the model writes three prose fields and everything factual is a derived
  // block, rendered by the one renderer the composer and the routes also use.
  // The string is still written — full-text search (00016) and return
  // attribution (00655) read that column — but it is the OUTPUT of the blocks
  // now rather than the thing being assembled, and both land in one upsert.
  let conditionDescription = listing.condition_description;

  // US-2682: the facts a summariser and an agent buyer need, collected as the
  // description is assembled and emitted once at the end.
  let factsGrade: number | null = null;
  let factsFactors: FactsGradeFactor[] = [];
  // Kept as INPUT, not rendered here: the disclosure block renders itself from
  // this at render time, so the generation path holds no second copy of it.
  let disclosureInput: DisclosureInput | null = null;
  if (gradeReportId) {
    // US-1124: guarantee the passport exists BEFORE we read garment_id — closes
    // the race/failure window where the grading pipeline's seed didn't persist
    // (createSingleHopPassport returned null). Idempotent + best-effort, so a
    // healthy report is a cheap garment_id re-read and a failure just omits the
    // passport link (the listing still builds).
    await ensurePassportForGradeReport(gradeReportId);
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select(
        "overall_score, grade_tier, defects_found, detected_style_attributes, per_image_analysis, detailed_notes, certificate_id, garment_id, fabric_condition_score, structural_integrity_score, cosmetic_appearance_score, functional_elements_score, odor_cleanliness_score",
      )
      .eq("id", gradeReportId)
      .maybeSingle();
    if (report) {
      const r = report as Record<string, unknown>;
      // US-2682: keep the grade and its factor breakdown for the facts block.
      // Read here because this is where the report row is in scope; the block
      // itself is built once, at the end, so it can never be written twice.
      factsGrade = Number.isFinite(Number(r.overall_score)) ? Number(r.overall_score) : null;
      factsFactors = factorScoresToFacts(r);
      // US-1095: when the grade's garment has a passport, carry its public slug
      // into the listing description so the next buyer can claim + continue the
      // chain. Best-effort — a missing/failed lookup just omits the passport link.
      let passportSlug: string | null = null;
      if (r.garment_id) {
        const { data: garment } = await supabaseAdmin
          .from("garments")
          .select("public_passport_slug")
          .eq("id", r.garment_id as string)
          .maybeSingle();
        passportSlug =
          (garment as { public_passport_slug: string } | null)?.public_passport_slug ?? null;
      }
      disclosureInput = {
        overall_score: Number(r.overall_score ?? 0),
        grade_tier: String(r.grade_tier ?? ""),
        defects_found: Array.isArray(r.defects_found)
          ? (r.defects_found as DisclosureInput["defects_found"])
          : [],
        detected_style_attributes: Array.isArray(r.detected_style_attributes)
          ? (r.detected_style_attributes as DisclosureInput["detected_style_attributes"])
          : [],
        per_image_analysis: Array.isArray(r.per_image_analysis)
          ? (r.per_image_analysis as PerImageAnalysisLike[])
          : [],
        certificate_id: (r.certificate_id as string | null) ?? null,
        passport_slug: passportSlug,
        legacy_defects_summary:
          (r.detailed_notes as Record<string, string> | null)?.defects_summary ?? null,
      };
      if (!conditionDescription || !conditionDescription.trim()) {
        conditionDescription = buildDisclosure(disclosureInput).plain.slice(0, 990);
      }
    }
  }

  // US-1126: embed the seller's verified credentials (total graded, average
  // grade, profile link) — the trust signal that differentiates a verified
  // seller from a plain marketplace seller. Independent of THIS item's grade;
  // gated server-side on the seller being publicly verified + opted in
  // (returns null otherwise). HTML, since the eBay description renders it.
  const sellerCredential = await loadSellerCredential(ownerId);

  // US-2959: assemble the blocks and render once.
  //
  // The facts block is still last and still exactly once — renderDescription
  // pins it there regardless of array position, which is the same guarantee
  // upsertListingFactsBlock used to give by replacing itself, minus the string
  // surgery.
  const descriptionCtx: RenderContext = {
    item: {
      brand: typeof item.brand === "string" ? item.brand : null,
      size: typeof item.size === "string" ? item.size : null,
      color: typeof item.color === "string" ? item.color : null,
      material: typeof item.material === "string" ? item.material : null,
      style: typeof item.style === "string" ? item.style : null,
      measurements,
    },
    grade: factsGrade === null && factsFactors.length === 0 && !disclosureInput
      ? null
      : { overall_score: factsGrade, factors: factsFactors, disclosure: disclosureInput },
    credential: sellerCredential,
    // A freshly generated draft references no account snippet yet — the seller
    // adds those in the composer (US-2961), so there is nothing to resolve.
    snippets: {},
    unit: "in",
    calibrated: calibratedMeasurements,
    conditionDescription: listing.condition_description,
  };

  // The model's three prose fields, scrubbed. scrubRestatedFacts is the
  // backstop for the prompt: anything it strips is a labelled fact the model
  // was told not to write and a derived block already carries, so leaving it
  // would recreate the stale duplicate this epic removes. Logged, because if
  // this is doing the work then the prompt is not.
  const aiText: Record<string, string> = {
    intro: listing.description_intro,
    features: listing.description_features,
    condition: listing.description_condition,
  };
  const descriptionBlocks = defaultBlocks().map((block) => {
    const raw = aiText[block.key];
    if (raw === undefined) return block;
    const cleaned = scrubRestatedFacts(raw, descriptionCtx);
    if (cleaned !== raw.trim()) {
      console.warn(
        `[AI Listing] scrubbed restated facts from description_${block.key} (item ${itemId})`,
      );
    }
    return { ...block, text: cleaned };
  });

  // US-2967: the seller's saved template adds its boilerplate as a block, in
  // front of the credentials/facts rows. Before this it was appended to the
  // rendered string by a follow-up UPDATE, which the composer's first save
  // then overwrote from these very blocks.
  const withTemplate = opts.templateBoilerplate?.trim()
    ? withTemplateBlock(descriptionBlocks, {
      description_template: opts.templateBoilerplate,
    })
    : descriptionBlocks;

  const listingDescription = renderDescription(withTemplate, descriptionCtx);

  // US-541: route low-confidence drafts to review.
  // US-828: also flag the draft when reconciliation left aspects unmatched —
  // the seller must reconcile them before they silently drop at publish.
  // US-3031: and when the category accepts no honest condition for this item,
  // which is the one case step 5b cannot settle on the seller's behalf.
  // 2026-09-02: the RN cap is re-asserted here because the refine pass writes
  // fieldConfidence.brand from the model's own confidence, which would lift it.
  if (rnOutcome === "contradicts") {
    fieldConfidence.brand = Math.min(
      fieldConfidence.brand ?? 1,
      RN_CONTRADICTION_BRAND_CONFIDENCE,
    );
  }
  const needsReview =
    listingNeedsReview(listing.confidence, fieldConfidence) ||
    aspectReview.length > 0 ||
    conditionUnresolved;

  // US-956: record the price confidence under listing_price so the estimated-flag
  // gate (and any future surface) can read it. Added AFTER needsReview so it does
  // NOT alter the aspect-only review triage above.
  fieldConfidence.listing_price = listingPriceConfidence;

  // US-546 (AC3): record the A/B title variants. Variant "A" is the chosen,
  // published title; "B" is the model's optional alternate (omitted when it
  // didn't supply a distinct one). "A" is active by default — promotion of "B"
  // is driven by the sell-through summary (summarizeTitleVariantSellThrough).
  const titleVariants: TitleVariant[] = [
    { label: "A", title: listing.title, active: true },
  ];
  if (listing.title_variant) {
    titleVariants.push({ label: "B", title: listing.title_variant, active: false });
  }

  // 8. Upsert the eBay draft listing for this item (tenant-safe: item owned).
  const draftFields = {
    listing_title: listing.title,
    // US-2959: the blocks and the string they render to, in the SAME upsert.
    // Writing one without the other is the drift this epic exists to remove.
    listing_description: listingDescription,
    description_blocks: withTemplate,
    listing_status: "draft" as const,
    // A draft is never live on a marketplace. The listings column defaults
    // is_active=true, so without this every generated draft was born "active" —
    // which desynced status checks (the composer's live-listing test, the
    // delete guard) into treating plain drafts as live listings.
    is_active: false,
    // US-1568: a fresh generation overwrites whatever a human reviewed —
    // the draft goes back into the not-yet-reviewed queue.
    reviewed_at: null,
    listing_price: priceDollars,
    platform_category_id: categoryId,
    ebay_condition: listing.ebay_condition,
    ebay_condition_description: conditionDescription,
    item_specifics_override: itemSpecifics,
    price_is_estimated: priceIsEstimated,
    price_range_low_cents: priceRangeLowCents,
    price_range_high_cents: priceRangeHighCents,
    price_confidence: priceConfidence,
    price_comp_source: priceCompSource,
    batch_id: opts.batchId ?? null,
    primary_photo_id: primaryPhotoId,
    ai_confidence: listing.confidence,
    ai_field_confidence: Object.keys(fieldConfidence).length > 0 ? fieldConfidence : null,
    needs_review: needsReview,
    // US-828: the per-aspect needs-review list (name + unmatched values +
    // reason) so the drafts cockpit + composer can surface exactly which
    // specifics to fix, instead of an opaque "needs review" boolean.
    aspect_review: aspectReview.length > 0 ? aspectReview : null,
    // US-2424: the ranked leaf candidates and the score behind the pick, so the
    // composer can offer a one-click switch to the runner-up without a fresh
    // generation run.
    //
    // OMITTED, not nulled, when this run scored nothing. draftFields is also the
    // UPDATE payload for a re-generation, and a re-generation always skips the
    // scorer — step 9 of the previous run persisted ebay_category_id onto the
    // item, so step 5's `if (!categoryId)` is false. Writing null here would
    // therefore wipe the runner-ups on the second generate, which is exactly
    // when a seller is most likely to be looking for them.
    ...(categoryCandidates.length > 0
      ? { category_candidates: categoryCandidates }
      : {}),
    // US-2425: the draft's eBay-aspect coverage at generation time, both tiers.
    aspect_coverage: aspectCoverage,
    // US-546: A/B title variants (AC3) + the demand terms fed to the prompt (AC2)
    // for transparency/debug. active_title_variant tracks the live label.
    title_variants: titleVariants,
    active_title_variant: "A",
    demand_terms: demandTerms.length > 0 ? demandTerms : null,
    // US-2675 (00621): the same terms with their provenance. Parallel to the
    // flat array above rather than replacing it, so every existing reader keeps
    // working; NULL here means the source was never recorded, which is not the
    // same claim as "these were active-sourced".
    demand_terms_detail: demandTermDetail.length > 0 ? demandTermDetail : null,
    // US-547: attribute the draft to the prompt version that produced it and
    // snapshot the AI's generated fields, so captureListingAcceptance can diff
    // the seller's published edits against the model's output at publish time.
    ai_prompt_version: gen.promptVersion,
    ai_generated_snapshot: {
      title: listing.title,
      description: listingDescription,
      price_cents: priceCents,
      ebay_condition: listing.ebay_condition,
      condition_description: conditionDescription,
      category_id: categoryId,
      item_specifics: itemSpecifics,
    },
  };

  const { data: existing } = await supabaseAdmin
    .from("listings")
    .select("id")
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .eq("listing_status", "draft")
    .limit(1)
    .maybeSingle();

  let listingId: string;
  if (existing?.id) {
    const { error } = await supabaseAdmin
      .from("listings")
      .update(draftFields)
      .eq("id", existing.id);
    if (error) throw new Error(`Failed to update draft listing: ${error.message}`);
    listingId = existing.id;
  } else {
    const { data: inserted, error } = await supabaseAdmin
      .from("listings")
      .insert({
        inventory_item_id: itemId,
        platform: "ebay",
        // US-1077: AutoLister-created draft is GradeThread-originated.
        listing_origin: "gradethread",
        ...draftFields,
      })
      .select("id")
      .single();
    if (error || !inserted) {
      throw new Error(`Failed to create draft listing: ${error?.message}`);
    }
    listingId = inserted.id;
  }

  // 9. Persist category + specifics + AI-generation marker on the item.
  // ebay_aspects is the canonical aspect store the composer's category picker
  // and the publish path (assemblePublishContext) both read, so the generated
  // specifics must land here — not only on listings.item_specifics_override.
  // US-544: also write the canonical brand back to the item so future comp
  // searches and re-generations key on the normalized value, not the raw read.
  const itemUpdate: Record<string, unknown> = {
    ebay_category_id: categoryId,
    ebay_aspects: itemSpecifics,
    // US-825: everything the AI produced carries ai_extracted provenance; this
    // is a fresh AI pass, so the source map is rebuilt from the generated keys
    // (a later manual edit refines individual entries).
    // US-2423: the aspects the registry filled from the item's own attributes
    // are NOT model output — they are `inventory_derived`, the lowest rung of
    // the precedence ladder, so a seller edit (manual) or a later AI pass both
    // outrank them. Passing itemSpecifics as the value map drops any name the
    // reconcile pass removed, so the source map can't outlive its values.
    ebay_aspect_sources: buildAspectSources(
      itemSpecifics,
      inventoryDerivedNames,
      visualConsensusNames,
    ),
    ai_generated_aspects_at: new Date().toISOString(),
  };
  if (normalizedBrand && normalizedBrand !== item.brand) {
    itemUpdate.brand = normalizedBrand;
  }
  // US-2595: a size the estimate pass read off the photos belongs on the item,
  // not just in this draft — the composer, the specifics editor and the comp
  // search all read the column. Fill-only: it only runs when the size was blank.
  if (estimatedSize && String(item.size ?? "").trim() === "") {
    itemUpdate.size = estimatedSize;
  }
  // Fold the generated title into the item when it still carries the
  // AutoLister placeholder ("Item 12"/"Untitled"/blank), so Inventory → Drafts
  // and the item page show the real garment. Seller-typed titles are never
  // overwritten (shouldAdoptGeneratedTitle is placeholder-guarded).
  if (shouldAdoptGeneratedTitle(item.title, listing.title)) {
    itemUpdate.title = listing.title;
  }
  // US-1567: carry the extracted specifics onto the item's own columns +
  // attributes (fill-only), and the generated description onto the item's
  // public description when the seller hasn't written one — so the item
  // page and inventory grid show real data for AI-processed drafts instead
  // of blanks.
  Object.assign(itemUpdate, aspectCarryOver(item, itemSpecifics));
  // The label reads land on the item even when the leaf has no aspect for
  // them (a Product Line on a leaf without one), so the next generation and
  // the composer still have them. Verbatim label text outranks the same fact
  // carried back from an aspect.
  if (Object.keys(tagAttributes).length > 0) {
    itemUpdate.attributes = {
      ...((item.attributes as Record<string, unknown> | null) ?? {}),
      ...((itemUpdate.attributes as Record<string, unknown> | undefined) ?? {}),
      ...tagAttributes,
    };
  }
  if (
    (item.description ?? "").trim() === "" &&
    listingDescription.trim() !== ""
  ) {
    itemUpdate.description = listingDescription;
  }
  await supabaseAdmin
    .from("inventory_items")
    .update(itemUpdate)
    .eq("id", itemId)
    .eq("user_id", ownerId);

  // 10. Usage logging (the quota GATE is enforced by the caller). Includes
  //     the second-pass aspect-extraction tokens/cost so per-item billing
  //     reflects total Anthropic spend, not just the generation call.
  const genCost = estimateCost(gen.model, gen.tokensIn, gen.tokensOut);
  // US-2595: the measurement and size passes are bundled into this one AI
  // action (same contract as tag-OCR), so their spend belongs in this total —
  // otherwise per-item billing understates what Anthropic actually charged.
  const costUsd = genCost + extractCost + tagOcrCost + measureCost + sizeCost +
    roleCost;
  const totalTokensIn = gen.tokensIn + extractTokensIn + tagOcrTokensIn +
    measureTokensIn + sizeTokensIn + roleTokensIn;
  const totalTokensOut = gen.tokensOut + extractTokensOut + tagOcrTokensOut +
    measureTokensOut + sizeTokensOut + roleTokensOut;
  let enrichmentLogId: string | null = null;
  try {
    const { data: logRow } = await supabaseAdmin.from("ai_enrichment_log").insert({
      user_id: ownerId,
      inventory_item_id: itemId,
      model: gen.model,
      input_kind: "both",
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      cost_usd: costUsd,
      latency_ms: 0,
      suggested_fields: {
        listing_gen: {
          category_id: categoryId,
          title: listing.title,
          price_cents: priceCents,
          price_is_estimated: priceIsEstimated,
          prompt_version: gen.promptVersion,
          aspect_refine_tokens_in: extractTokensIn,
          aspect_refine_tokens_out: extractTokensOut,
          // US-543: which fields were read verbatim off the tag (ground truth),
          // so brand/size accuracy can be measured against a labeled sample.
          tag_ground_truth: tagGroundTruth ?? null,
          tag_ocr_model: tagOcrModel,
          tag_ocr_tokens_in: tagOcrTokensIn,
          tag_ocr_tokens_out: tagOcrTokensOut,
          // US-3047: the role pass that FOUND the label, when one ran. Null
          // model means it was skipped — either a tag photo was already typed
          // or every photo already carried a deliberate role.
          photo_role_model: roleModel,
          photo_role_tokens_in: roleTokensIn,
          photo_role_tokens_out: roleTokensOut,
          // US-2425: coverage travels WITH the generation telemetry, so a run's
          // cost and its completeness can be read off the same row — otherwise
          // "we spent more and got more" stays an assertion.
          aspect_coverage: aspectCoverage,
          // US-2424: what the category pick cost in required-aspect terms, and
          // how many leaves were weighed to get there.
          // US-3043: the METHOD travels with the choice, so a wrong category
          // can be traced to the vote or to the keyword search, not just to
          // the id. The keyword-scoring fields keep their names and are null
          // when that branch never ran.
          category_choice: categoryDecision
            ? {
              chosen: categoryId,
              method: categoryDecision.method,
              support: categoryDecision.support,
              rejected_reason: categoryDecision.rejectedReason,
              required_filled: categoryCandidates[0]?.requiredFilled ?? null,
              required_total: categoryCandidates[0]?.requiredTotal ?? null,
              ebay_rank: categoryCandidates[0]?.rank ?? null,
              candidates_considered: categoryCandidates.length,
              visual_prefilled: [...visualConsensusNames],
            }
            : null,
        },
      },
    }).select("id").maybeSingle();
    enrichmentLogId = (logRow as { id: string } | null)?.id ?? null;
    // US-527: the AutoLister worker (the sole caller) now atomically RESERVES
    // the AI action against the monthly cap BEFORE calling generateListing
    // (reserve_ai_action) and refunds on failure, so the counter is no longer
    // incremented here — doing both would double-count and re-introduce the
    // parallel-batch cap-bypass race this story fixes.
  } catch (err) {
    console.error("[AI Listing] usage logging failed (non-fatal):", err);
  }

  // 10b. US-2778: what was offered and what came back, on the batch path too.
  //
  // BOTH HALVES, ALWAYS. Nothing offered, offered-and-ignored, and
  // offered-and-refused are three different findings with three different
  // fixes, and a row that stored only the rulings would collapse them into one.
  // The write is unconditional for that reason — a run where the pass declined
  // is a reading, not an absence.
  //
  // Best-effort: the record of a decision is worth less than the decision.
  //
  // The one run NOT recorded is `disabled`. A flag that is off did not decide
  // anything, and a row per generation saying so would be the largest
  // population in the table while carrying no finding at all.
  if (visual.declined !== "disabled") {
    try {
      const provenanceId = await recordExtractionProvenance(supabaseAdmin, {
        ownerUserId: ownerId,
        itemId,
        enrichmentLogId,
        candidates: visual.candidates,
        rulings: gen.visualRulings,
        visualDeclined: visual.declined,
      });
      // US-3043: the category decision completes the same row, as it does on
      // the one-item path (US-2774). Same method values migration 00641 allows.
      if (categoryDecision) {
        await recordCategoryDecision(supabaseAdmin, {
          ownerUserId: ownerId,
          itemId,
          provenanceId,
          decision: categoryDecision,
        });
      }
    } catch (err) {
      console.error("[AI Listing] provenance write failed (non-fatal):", err);
    }
  }

  return {
    listingId,
    listing: { ...listing, item_specifics: itemSpecifics, suggested_price_cents: priceCents },
    categoryId,
    categoryPath,
    priceCents,
    priceIsEstimated,
    model: gen.model,
    promptVersion: gen.promptVersion,
    costUsd,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
  };
}

// ── US-721: per-marketplace listing-field generation ──────────────────────
//
// Turns ONE already-generated draft (the eBay-shaped base) into platform-
// tailored fields for every other marketplace, so the copy-paste Listing Kit
// (US-723) and the API adapters (US-710/714) have ready-to-use content.
//
// Cost discipline: the expensive vision pass already ran in generateListing.
// This re-uses that base and makes a SINGLE text-only Claude call to adapt
// tone/length/tags across all requested platforms at once — no images, small
// tokens. Condition + category are mapped deterministically (US-720/722), not
// re-asked from the model.

export const PLATFORM_VARIANT_PROMPT_VERSION = "platform_variant_v1";

// Pure variant assembly (types + trimToLimit + assemblePlatformVariant) lives
// in platform-variants.ts so it has no I/O dependency and is unit-testable.
// Re-exported here for callers that import from ai-listing.
export {
  assemblePlatformVariant,
  type PlatformText,
  type PlatformVariant,
  type PlatformVariantBase,
  trimToLimit,
} from "./platform-variants.ts";
import {
  assemblePlatformVariant,
  type PlatformText,
  type PlatformVariant,
  type PlatformVariantBase,
} from "./platform-variants.ts";

// Tool the text pass must call: a map of platform -> {title, description, tags}.
const PLATFORM_VARIANT_TOOL: Anthropic.Tool = {
  name: "write_platform_listings",
  description:
    "Return tone/length/tag-adapted copy for each requested marketplace. Keep all FACTS identical to the source; only adapt voice, length, and tags/hashtags to each platform.",
  input_schema: {
    type: "object",
    properties: {
      platforms: {
        type: "object",
        description: "Keyed by platform id (e.g. poshmark, mercari, grailed, depop, shopify).",
        additionalProperties: {
          type: "object",
          properties: {
            title: { type: "string", description: "Platform title (omit/empty if the platform has no title)." },
            description: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["description"],
        },
      },
    },
    required: ["platforms"],
  },
};

function platformGuidance(platform: MarketplacePlatform): string {
  const spec = getMarketplaceSpec(platform);
  if (!spec) return platform;
  const parts: string[] = [`${spec.label} (${platform})`];
  if (spec.titleMaxLength == null) parts.push("no title field — description is the listing");
  else parts.push(`title <= ${spec.titleMaxLength} chars`);
  if (spec.descriptionMaxLength != null) parts.push(`description <= ${spec.descriptionMaxLength} chars`);
  if (spec.tags) parts.push(`up to ${spec.tags.max} ${spec.tags.help ?? "tags"}`);
  const tone: Partial<Record<MarketplacePlatform, string>> = {
    poshmark: "friendly, social, relevant hashtags",
    mercari: "concise, keyword-first, a few hashtags",
    depop: "casual Gen-Z tone, hashtags, no title",
    grailed: "minimal designer/streetwear voice",
    // 2026-08-11: Vinted's buyers are EU-first and the title cap is 60 chars,
    // the tightest of any kit channel — so the guidance is plain and factual
    // rather than a voice. Without an entry the variant is generated from the
    // spec alone, which is correct but reads like eBay.
    vinted: "plain, factual, item-first; no hashtags",
    shopify: "clean retail product copy",
    ebay: "keyword-rich, search-optimized",
  };
  if (tone[platform]) parts.push(`tone: ${tone[platform]}`);
  return "- " + parts.join("; ");
}

/**
 * Single text-only Claude call: adapt the base listing's voice/length/tags for
 * each requested platform. Returns a map platform -> PlatformText. Robust to a
 * model that omits a platform (the assembler falls back to the base text).
 */
export async function generatePlatformVariantText(
  base: PlatformVariantBase,
  platforms: MarketplacePlatform[],
): Promise<{ byPlatform: Record<string, PlatformText>; model: string; tokensIn: number; tokensOut: number }> {
  enterAiFeature("autolister"); // US-894 spend attribution
  const client = getAnthropicClient();
  // 2026-09-02: the lightweight tier. Text in, text out, every fact pinned to
  // the source - see getPlatformVariantModel for why this is the right call to
  // move and why it has its own override.
  const model = getPlatformVariantModel();
  const temperature = getAiTemperature();

  const facts = {
    brand: base.brand,
    size: base.size,
    color: base.color,
    material: base.material,
    condition_tier: base.gradeLabel,
    category: base.categoryQuery,
    key_specifics: base.itemSpecifics,
    source_title: base.title,
    source_description: base.description,
  };

  const system =
    "You adapt ONE resale clothing listing to several marketplaces. For each " +
    "requested platform, rewrite the title (within its char limit; omit when the " +
    "platform has no title field), the description (in that platform's voice and " +
    "length), and tags/hashtags (within the platform's max). NEVER invent or change " +
    "facts — brand, size, color, material, measurements and condition must match the " +
    "source exactly. Call write_platform_listings.";

  const user = [
    "SOURCE LISTING FACTS:",
    JSON.stringify(facts, null, 2),
    "",
    "TARGET PLATFORMS:",
    platforms.map(platformGuidance).join("\n"),
  ].join("\n");

  const response = await withRetry(
    () =>
      client.messages.create({
        model,
        // Five channels now ride one call (Vinted joined the kit 2026-08-11)
        // and a truncated tool call loses ALL of them, so the ceiling is
        // sized for five full descriptions. Output is billed as used, not as
        // capped.
        max_tokens: 3072,
        ...(temperature !== undefined ? { temperature } : {}),
        system: [{ type: "text", text: system }],
        tools: [PLATFORM_VARIANT_TOOL],
        tool_choice: { type: "tool", name: "write_platform_listings" },
        messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      }),
    {
      onRetry: ({ attempt, delayMs }) =>
        console.warn(`[AI Listing] platform-variant retry #${attempt} after ${delayMs}ms`),
    },
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  const byPlatform: Record<string, PlatformText> = {};
  if (toolUse && toolUse.type === "tool_use") {
    const raw = (toolUse.input as { platforms?: Record<string, unknown> }).platforms ?? {};
    for (const [plat, val] of Object.entries(raw)) {
      const o = (val ?? {}) as Record<string, unknown>;
      byPlatform[plat] = {
        title: typeof o.title === "string" ? o.title.trim() : "",
        description: typeof o.description === "string" ? o.description.trim() : "",
        tags: Array.isArray(o.tags) ? o.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      };
    }
  }

  return {
    byPlatform,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

export interface GeneratePlatformVariantsResult {
  listingId: string;
  variants: PlatformVariant[];
  model: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Orchestrates per-platform field generation for an item that already has an
 * eBay draft: loads the base from the draft + item, runs the text pass, builds
 * + validates each variant, and persists them to listings.platform_fields.
 * Tenant-safe: the item is loaded scoped to ownerId and the draft is matched by
 * the owned inventory_item_id.
 */
export async function generatePlatformVariants(
  itemId: string,
  ownerId: string,
  platforms: MarketplacePlatform[],
  // 2026-09-02: who asked. "draft" is the AutoLister batch filling the kit as
  // part of the generation action; "manual" (the default, and what every
  // pre-existing caller gets) is the kit's own button and the cross-push lazy
  // fill, each of which meters its own action. Stored on every variant so the
  // kit can say which it was.
  opts: { source?: "draft" | "manual" } = {},
): Promise<GeneratePlatformVariantsResult> {
  if (platforms.length === 0) throw new Error("No platforms requested");
  const source = opts.source ?? "manual";

  // 1. Item facts (tenant-scoped).
  const { data: itemData, error: itemErr } = await supabaseAdmin
    .from("inventory_items")
    .select(
      // US-2736: target_price is the FALLBACK price. Every platform variant's
      // price came from the eBay draft alone, so an item priced on the item
      // itself generated a kit with a blank price for every channel — and the
      // extension then refused to fill a field it had no value for.
      "id, user_id, brand, size, color, material, grade_value, grade_label, ebay_aspects, garment_category, item_category, measurements, ai_field_sources, target_price",
    )
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .single();
  if (itemErr || !itemData) throw new Error(`Item ${itemId} not found for this workspace`);
  const item = itemData as {
    brand: string | null;
    size: string | null;
    color: string | null;
    material: string | null;
    grade_value: number | null;
    grade_label: string | null;
    target_price: number | null;
    ebay_aspects: Record<string, string[]> | null;
    garment_category: string | null;
    item_category: string | null;
    measurements: Record<string, unknown> | null;
    ai_field_sources: Record<string, unknown> | null;
  };

  // 2. The eBay draft is the base. It must exist (generateListing ran first).
  const { data: draft } = await supabaseAdmin
    .from("listings")
    .select("id, listing_title, listing_description, listing_price, platform_category_id, platform_fields, ai_confidence")
    .eq("inventory_item_id", itemId)
    .eq("platform", "ebay")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!draft) throw new Error(`Item ${itemId} has no eBay draft to adapt — generate the base listing first`);
  const d = draft as {
    id: string;
    listing_title: string | null;
    listing_description: string | null;
    listing_price: number | null;
    platform_category_id: string | null;
    platform_fields: Record<string, unknown> | null;
    ai_confidence: number | null;
  };

  const base: PlatformVariantBase = {
    title: d.listing_title ?? "",
    // The draft's description is rendered HTML (blocks, the facts block, the
    // credential and disclosure markers). The model needs the words; the tags
    // and comment markers were tokens it paid to ignore (2026-09-02).
    description: htmlToPlainText(d.listing_description ?? ""),
    brand: item.brand,
    size: item.size,
    color: item.color,
    material: item.material,
    itemSpecifics: item.ebay_aspects ?? {},
    gradeValue: item.grade_value,
    gradeLabel: item.grade_label,
    // US-2736: the composer's own rule, all THREE sources.
    //
    // This read the draft alone, so an item whose price lives on the ITEM
    // produced priceCents 0 -> every variant priced at 0 -> the kit showed a
    // blank Listing price -> buildListerPayload turned 0 into "" -> the
    // extension refused to fill it, and told the seller on every single
    // cross-post that we could not set their price. The selectors were fine the
    // whole time; there was simply no number to type.
    //
    // FIRST POSITIVE wins, not first non-null: a stale 0 on a draft row must
    // not shadow the item's target price.
    //
    // The composer reads a THIRD source, `item.list_price` — but that is a
    // column on the `items_full` VIEW, where it is an alias for a listing's
    // listing_price. `inventory_items` has no such column, and selecting it
    // here throws "Item not found for this workspace" and takes generation with
    // it. The equivalent third source is another of the item's listing rows;
    // it is not read here, and this comment is the record of why.
    priceCents: Math.round(
      ([d.listing_price, item.target_price].find(
        (p): p is number => p != null && p > 0,
      ) ?? 0) * 100,
    ),
    categoryQuery: d.platform_category_id ?? "",
    confidence: d.ai_confidence ?? 0.7,
  };

  // 3. One text-only AI pass for all requested platforms.
  const text = await generatePlatformVariantText(base, platforms);

  // 4. Photo count (for the photo-cap validation rule). US-1549: 'internal'
  // photos never publish, so they don't count toward a platform's photo cap.
  // (Safe to filter at the DB: the edge only deploys once 00340 is applied —
  // the schema boot guard enforces the ordering.)
  const { count: photoCount } = await supabaseAdmin
    .from("item_photos")
    .select("id", { count: "exact", head: true })
    .eq("inventory_item_id", itemId)
    .neq("photo_type", "internal")
    // US-1571: the MeasureCard frame isn't cross-listable imagery either
    // (enum value guaranteed by the 00346 boot guard, same as the cover pick).
    .neq("photo_type", "measurement");

  // 5. Resolve each platform's category (US-722): shared cache → seed → AI →
  // unmapped. Cache/seed hits cost ~0; only an unseeded garment type triggers
  // (and then caches) one cheap AI suggestion. Resolved in parallel.
  const resolutions = await Promise.all(
    platforms.map((p) =>
      resolveMarketplaceCategory(p, item.garment_category, item.item_category)
        .catch(() => null),
    ),
  );

  // 6. Assemble + validate each variant. An unmapped/AI-guess category sets
  // categoryNeedsPick so the kit surfaces a "pick a category" prompt rather than
  // silently guessing; mapped seed/admin rows are trusted.
  const variants = platforms.map((p, i) =>
    assemblePlatformVariant(
      p,
      base,
      text.byPlatform[p] ?? { title: "", description: "", tags: [] },
      {
        photoCount: photoCount ?? undefined,
        // Brand-allow-list (Grailed) can't be verified here yet — treated as
        // unknown (the kit confirms the designer). Don't hard-fail.
        brandAllowed: true,
      },
      resolutions[i] ?? null,
    )
  );

  // 6b. US-1126: embed the seller's verified credentials into EACH platform's
  // description so the trust signal reaches buyers on every marketplace, not just
  // eBay. These platforms render plain text (no HTML), so append the plain block —
  // only when it still fits the platform's description cap (never push a listing
  // over its limit). Gated server-side on verified + opted-in (null otherwise).
  const crossCredential = await loadSellerCredentialBlock(ownerId);
  if (crossCredential) {
    for (const v of variants) {
      const spec = getMarketplaceSpec(v.platform);
      const addition = `\n\n${crossCredential.plain}`;
      const max = spec?.descriptionMaxLength ?? null;
      if (max == null || v.description.length + addition.length <= max) {
        v.description = `${v.description}${addition}`;
      }
    }
  }

  // 6c. US-1578: measurements ride EVERY platform. The text pass rewrites the
  // eBay description per platform and may drop the measurements section — so
  // append the deterministic plain-text block (no HTML markers) to any variant
  // that lost it, within the platform's description cap. Buyers comparing
  // across marketplaces always see the same numbers.
  const plainMeasurements = buildPlainMeasurementsText(item.measurements, "in", {
    calibrated: hasCalibratedMeasurements(item.ai_field_sources),
  });
  if (plainMeasurements) {
    for (const v of variants) {
      if (v.description.includes("Measurements (garment laid flat)")) continue;
      const spec = getMarketplaceSpec(v.platform);
      const addition = `

${plainMeasurements}`;
      const max = spec?.descriptionMaxLength ?? null;
      if (max == null || v.description.length + addition.length <= max) {
        v.description = `${v.description}${addition}`;
      }
    }
  }

  // 7. Persist, merging into any existing platform_fields.
  const now = new Date().toISOString();
  const merged: Record<string, unknown> = { ...(d.platform_fields ?? {}) };
  for (const v of variants) {
    merged[v.platform] = {
      title: v.title,
      description: v.description,
      condition: v.condition,
      category: v.category,
      // US-722 category provenance so the kit can prompt a pick when needed.
      category_source: v.categorySource ?? null,
      category_department: v.categoryDepartment ?? null,
      category_needs_pick: v.categoryNeedsPick ?? false,
      brand: v.brand,
      color: v.color,
      size: v.size,
      // Depop's "style" field (Sporty, Streetwear, Y2K) had no source at all
      // and rendered blank on every kit; the eBay Style specific is the
      // closest fact we hold (2026-09-02).
      style: v.style ?? null,
      price: v.price,
      tags: v.tags,
      confidence: v.confidence,
      validation: v.validation,
      generated_at: now,
      generated_with_draft: source === "draft",
    };
  }
  const { error: upErr } = await supabaseAdmin
    .from("listings")
    .update({ platform_fields: merged, platform_fields_generated_at: now })
    .eq("id", d.id);
  if (upErr) throw new Error(`Failed to persist platform fields: ${upErr.message}`);

  const costUsd = estimateCost(text.model, text.tokensIn, text.tokensOut);

  // Spend attribution the operator can read off the same table as generation.
  // This pass logged nothing before, so a kit's cost was invisible everywhere
  // but the raw ai_usage_events ledger. Best-effort (2026-09-02).
  try {
    await supabaseAdmin.from("ai_enrichment_log").insert({
      user_id: ownerId,
      inventory_item_id: itemId,
      model: text.model,
      input_kind: "text",
      tokens_in: text.tokensIn,
      tokens_out: text.tokensOut,
      cost_usd: costUsd,
      latency_ms: 0,
      suggested_fields: {
        platform_variants: {
          listing_id: d.id,
          platforms,
          source,
          prompt_version: PLATFORM_VARIANT_PROMPT_VERSION,
        },
      },
    });
  } catch (err) {
    console.error("[AI Listing] platform-variant usage logging failed (non-fatal):", err);
  }

  return {
    listingId: d.id,
    variants,
    model: text.model,
    costUsd,
    tokensIn: text.tokensIn,
    tokensOut: text.tokensOut,
  };
}

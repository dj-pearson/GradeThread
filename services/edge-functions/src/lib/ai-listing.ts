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
  getDefaultModel,
  isCachingEnabled,
} from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { getActionCascadeConfig, runActionCascade } from "./ai-action-cascade.ts";
import {
  estimateCost,
  extractEbayAspects,
  getHaikuModel,
  type EbayAspectSpec,
  type ResearchIdentification,
} from "./ai-extract.ts";
import {
  isEasyAspectCategory,
  selectListingPhotos,
} from "./listing-photo-budget.ts";
import {
  getCategoryAspects,
  searchBrowseComps,
  suggestCategories,
} from "./ebay-client.ts";
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
import { resolveBrandKnowledgePack } from "./brand-knowledge.ts";
import { recordStyleCodeObservations } from "./style-code-observations.ts";
import { recordExtractionProvenance } from "./identification-provenance.ts";
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
  applyMeasurementsBlock,
  buildPlainMeasurementsText,
  hasCalibratedMeasurements,
  resolveMeasurementAspects,
} from "./measurements.ts";
// US-2595: the two passes that make a MeasureCard shot one-and-done — the
// calibrated measurement extraction, and the size estimate that used to require
// pressing "Estimate" on the composer.
import { autofillMeasurementsFromCard } from "./measure-autofill.ts";
import { estimateSize } from "./ai-size-estimate.ts";
import { SIZE_ESTIMATE_LOW_CONFIDENCE } from "./ai-size-estimate-core.ts";
import {
  buildDisclosure,
  type DisclosureInput,
  type PerImageAnalysisLike,
} from "./disclosure.ts";
import { loadSellerCredentialBlock } from "./seller-credentials-job.ts";
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
  TAG_PHOTO_TYPES,
} from "./ai-tag-ocr.ts";
import {
  applyCanonicalBrandAndStyle,
  canonicalizeBrand,
  resolveStyleCode,
  type StyleResolution,
} from "./brand-normalize.ts";
// US-2682: the machine-readable facts block. Emitted last and exactly once, so
// a revise replaces it rather than stacking a second copy.
import {
  disclosedFlawsToFacts,
  factorScoresToFacts,
  type FactsGradeFactor,
  measurementsToFacts,
  upsertListingFactsBlock,
} from "./listing-facts-block.ts";

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
- description: a clean opening line, then attribute bullets, then the condition
  statement, then measurements if provided. Buyer-friendly, follows eBay best
  practices. NEVER mention, describe, or disclaim a thrift/retail price tag,
  price sticker, or any original/sticker price visible in a photo — a price
  shown in a photo is NOT a listing fact; ignore it entirely and never add "for
  reference only" notes about it.
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
- description: write FACTUAL, SCANNABLE prose — a clean opening line, then
  attribute bullets, then the condition statement (consistent with the condition
  tier above), then the measurements block if provided. eBay now AI-SUMMARIZES
  descriptions for buyers, so plain accurate sentences and clear structured
  facts summarize well; a keyword list or repeated phrases do not — never dump a
  block of comma-separated keywords. NEVER mention, describe, or disclaim a
  thrift/retail price tag, price sticker, or any original/sticker price visible
  in a photo — a price shown in a photo is NOT a listing fact; ignore it
  entirely and never add "for reference only" notes about it.
- MEASUREMENTS: when measurements are supplied, PRESERVE them as a clearly
  labeled block in the description (flat measurements in inches) — buyers rely on
  them and they must survive verbatim.
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
      description: {
        type: "string",
        description: "Buyer-facing structured description",
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
      "description",
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
  if (input.allowedAspects && Object.keys(input.allowedAspects).length > 0) {
    lines.push(
      "ALLOWED ITEM-SPECIFIC ASPECTS (use only these aspect names; [] = free text):\n" +
        JSON.stringify(input.allowedAspects, null, 2),
    );
  }
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
 * Core Claude call: photos (+ optional context) -> a structured eBay listing
 * object. Uses the listing_gen prompt (DB override or code default) and forces
 * the create_ebay_listing tool. Orchestration (category resolution, pricing,
 * draft write, quota/logging) lives in US-312's generateListing.
 */
export async function generateListingFields(
  input: ListingGenInput,
): Promise<ListingGenResult> {
  enterAiFeature("autolister"); // US-894 spend attribution
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
    content.push({ type: "image", source: { type: "url", url: photo.url } });
  });

  content.push({ type: "text", text: buildListingUserLines(input).join("\n\n") });

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? { type: "text", text: prompt.text, cache_control: { type: "ephemeral" } }
    : { type: "text", text: prompt.text };

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
        systemBlock,
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
  systemBlock: Anthropic.TextBlockParam;
  temperature: number | undefined;
  promptVersion: string;
}

async function callListingModel(
  model: string,
  { client, content, systemBlock, temperature, promptVersion }: ListingCallInputs,
): Promise<ListingGenResult> {
  // Retry transient Anthropic rate-limit / overload (429/529/5xx) with
  // exponential backoff so one momentary limit doesn't fail the whole batch.
  const response = await withRetry(
    () =>
      client.messages.create({
        model,
        max_tokens: 1536,
        ...(temperature !== undefined ? { temperature } : {}),
        system: [systemBlock],
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
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  if (!title || !description) {
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
    description,
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
function buildAspectSpecsForCategory(
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
    });
  }

  // US-2420: required first, then by eBay's own 30-day buyer-search volume.
  // The old sort was required → RECOMMENDED → OPTIONAL, which cut Theme,
  // Accents and Occasion out of the schema before the model could fill them.
  return prioritizeByDemand(specs, raw);
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
): AspectSourceMap {
  const aiNames = Object.keys(aspects).filter((n) => !inventoryDerived.has(n));
  return mergeSources(
    sourcesFor(aiNames, "ai_extracted"),
    sourcesFor(inventoryDerived, "inventory_derived"),
    aspects,
  );
}

export interface GenerateListingOptions {
  // Associate the produced draft with a generation batch (US-313).
  batchId?: string | null;
  // When false, skip the comp lookup (e.g. very large batches). Defaults true.
  useComps?: boolean;
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

// Returns ALL listable photos in sort_order — deliberately uncapped. The
// vision-pass count discipline lives in selectListingPhotos (US-545), which
// picks a role-diverse capped subset; a positional pre-slice here would let
// gallery order (especially a manual reorder, US-1543) hide tag/defect shots
// from the role budget and the tag-OCR pass entirely.
async function loadItemPhotoUrls(itemId: string): Promise<ListingGenPhoto[]> {
  const { data } = await supabaseAdmin
    .from("item_photos")
    .select("photo_type, photo_role, storage_path, sort_order, photo_url")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });
  // US-1549: 'internal' photos (price tags, receipts) are seller-reference
  // only — the AI must never read them (they'd leak cost basis into copy).
  const listable = filterListablePhotos(
    (data ?? []) as ItemPhotoUrlRow[],
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
  let tagOcrTokensIn = 0;
  let tagOcrTokensOut = 0;
  let tagOcrCost = 0;
  let tagOcrModel: string | null = null;
  const tagPhotos = photos
    .filter((p) => p.type && TAG_PHOTO_TYPES.has(p.type))
    .slice(0, MAX_TAG_OCR_PHOTOS);
  if (tagPhotos.length > 0) {
    try {
      const ocr = await extractTagGroundTruth(
        tagPhotos.map((p) => ({ url: p.url, type: p.type })),
      );
      const { merged, groundTruth } = mergeTagGroundTruth(knownFields, ocr.fields);
      Object.assign(knownFields, merged);
      if (Object.keys(groundTruth).length > 0) tagGroundTruth = groundTruth;
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
        photos: photos.map((p) => ({ url: p.url, type: p.type })),
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

  // 3. If the item already has a category, constrain item_specifics up front.
  let categoryId = item.ebay_category_id;
  let categoryPath: string | null = null;
  let allowedAspects: Record<string, string[]> = {};
  let aspectsAlreadyConstrained = false;

  if (categoryId) {
    try {
      allowedAspects = extractAllowedAspects(await getCategoryAspects(categoryId));
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
    decodedStyleName: styleResolution?.aspects.Model?.[0] ?? null,
    styleCodeRaw: styleResolution?.styleCode ?? null,
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
    visualCandidates: [...visual.candidates, ...styleFromVisual],
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
    attributes:
      (item.attributes as Record<string, string | string[]> | null) ?? null,
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
  let categoryCandidates: CategoryCandidateScore[] = [];
  if (!categoryId && listing.suggested_category_query) {
    try {
      const suggestions = await suggestCategories(listing.suggested_category_query);
      if (suggestions.length > 0) {
        const shortlist = suggestions.slice(0, CATEGORY_CANDIDATE_LIMIT);
        const scored: CategoryCandidateScore[] = [];
        for (const [rank, s] of shortlist.entries()) {
          try {
            const specs = buildAspectSpecsForCategory(
              await getCategoryAspects(s.categoryId),
            );
            scored.push(
              scoreCategoryCandidate(
                {
                  categoryId: s.categoryId,
                  categoryPath: s.categoryTreePath,
                  rank,
                },
                registryItem,
                listing.item_specifics,
                specs,
              ),
            );
          } catch (err) {
            // A candidate whose spec we can't read is not disqualified — it
            // just scores zero and falls back to its eBay rank. Dropping it
            // could leave us with nothing at all.
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
        categoryCandidates = rankCategoryCandidates(scored);
        const best = categoryCandidates[0]!;
        categoryId = best.categoryId;
        categoryPath = best.categoryPath;
        if (categoryCandidates.length > 1) {
          console.log(
            `[AI Listing] category ${best.categoryId} chosen for item ${itemId}: ` +
              `${best.requiredFilled}/${best.requiredTotal} required aspects fillable ` +
              `(eBay rank ${best.rank})`,
          );
        }
      }
    } catch (err) {
      console.error("[AI Listing] suggestCategories failed:", err);
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
  const fieldConfidence: Record<string, number> = {};
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
            photos: visionPhotos.map((p) => ({ url: p.url, type: p.type })),
            knownAspects: listing.item_specifics,
            aspects: specs,
            categoryPath,
            modelOverride: easyCategory ? getHaikuModel() : undefined,
            // US-2419: name the identified product so Style/Model/Product Line/
            // Fabric Type can be filled instead of omitted under the never-guess
            // rule. No extra AI call — this is the SAME second pass, told what
            // the first pass already worked out. Null identification → the
            // prompt is byte-identical to before.
            research: researchFromIdentification(identification),
          });
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

  // 7b. Auto-Disclosure: if the item is graded, append a documented, AI-verified
  // "Condition & Flaws" block to the listing body (where HTML renders) and seed
  // the plain disclosure into the condition field. This is the dispute-defense
  // artifact — buyers see exactly what the grader found.
  // US-827: append a clean, buyer-expected flat-lay measurements block to the
  // description (idempotent — a regeneration strips the prior block first, never
  // duplicating). Edge renders inches (the stored unit); the composer re-applies
  // it in the seller's preferred unit (US-648) on edit.
  let listingDescription = applyMeasurementsBlock(
    listing.description,
    measurements,
    "in",
    { calibrated: calibratedMeasurements },
  );
  let conditionDescription = listing.condition_description;

  // US-2682: the facts a summariser and an agent buyer need, collected as the
  // description is assembled and emitted once at the end.
  let factsGrade: number | null = null;
  let factsFactors: FactsGradeFactor[] = [];
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
      const disclosure = buildDisclosure({
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
      });
      listingDescription = `${listingDescription}\n<!--gradethread-disclosure-->${disclosure.html}`;
      if (!conditionDescription || !conditionDescription.trim()) {
        conditionDescription = disclosure.plain.slice(0, 990);
      }
    }
  }

  // US-1126: embed the seller's verified credentials (total graded, average
  // grade, profile link) — the trust signal that differentiates a verified
  // seller from a plain marketplace seller. Independent of THIS item's grade;
  // gated server-side on the seller being publicly verified + opted in
  // (returns null otherwise). HTML, since the eBay description renders it.
  const sellerCredential = await loadSellerCredentialBlock(ownerId);
  if (sellerCredential) {
    listingDescription =
      `${listingDescription}\n<!--gradethread-seller-credentials-->${sellerCredential.html}`;
  }

  // US-2682: the machine-readable facts block, LAST and exactly once.
  //
  // Last because it is a reference a buyer consults rather than an opening they
  // read past, and exactly once because upsertListingFactsBlock replaces any
  // block already present — which is also what makes a revise pick it up on a
  // listing that already exists rather than accumulating a second copy.
  listingDescription = upsertListingFactsBlock(listingDescription, {
    grade: factsGrade,
    factors: factsFactors,
    measurements: measurementsToFacts(measurements),
    fibreContent: typeof item.material === "string" ? item.material : null,
    flaws: disclosedFlawsToFacts(listing.condition_description),
  });

  // US-541: route low-confidence drafts to review.
  // US-828: also flag the draft when reconciliation left aspects unmatched —
  // the seller must reconcile them before they silently drop at publish.
  const needsReview =
    listingNeedsReview(listing.confidence, fieldConfidence) ||
    aspectReview.length > 0;

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
    listing_description: listingDescription,
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
    ebay_aspect_sources: buildAspectSources(itemSpecifics, inventoryDerivedNames),
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
  const costUsd = genCost + extractCost + tagOcrCost + measureCost + sizeCost;
  const totalTokensIn = gen.tokensIn + extractTokensIn + tagOcrTokensIn +
    measureTokensIn + sizeTokensIn;
  const totalTokensOut = gen.tokensOut + extractTokensOut + tagOcrTokensOut +
    measureTokensOut + sizeTokensOut;
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
          // US-2425: coverage travels WITH the generation telemetry, so a run's
          // cost and its completeness can be read off the same row — otherwise
          // "we spent more and got more" stays an assertion.
          aspect_coverage: aspectCoverage,
          // US-2424: what the category pick cost in required-aspect terms, and
          // how many leaves were weighed to get there.
          category_choice: categoryCandidates.length > 0
            ? {
              chosen: categoryCandidates[0]!.categoryId,
              required_filled: categoryCandidates[0]!.requiredFilled,
              required_total: categoryCandidates[0]!.requiredTotal,
              ebay_rank: categoryCandidates[0]!.rank,
              candidates_considered: categoryCandidates.length,
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
      await recordExtractionProvenance(supabaseAdmin, {
        ownerUserId: ownerId,
        itemId,
        enrichmentLogId,
        candidates: visual.candidates,
        rulings: gen.visualRulings,
        visualDeclined: visual.declined,
      });
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
  const model = getDefaultModel();
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
        max_tokens: 2048,
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
): Promise<GeneratePlatformVariantsResult> {
  if (platforms.length === 0) throw new Error("No platforms requested");

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
    description: d.listing_description ?? "",
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
      price: v.price,
      tags: v.tags,
      confidence: v.confidence,
      validation: v.validation,
      generated_at: now,
    };
  }
  const { error: upErr } = await supabaseAdmin
    .from("listings")
    .update({ platform_fields: merged, platform_fields_generated_at: now })
    .eq("id", d.id);
  if (upErr) throw new Error(`Failed to persist platform fields: ${upErr.message}`);

  const costUsd = estimateCost(text.model, text.tokensIn, text.tokensOut);
  return {
    listingId: d.id,
    variants,
    model: text.model,
    costUsd,
    tokensIn: text.tokensIn,
    tokensOut: text.tokensOut,
  };
}

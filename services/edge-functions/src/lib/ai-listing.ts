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
  getAiTemperature,
  getAnthropicClient,
  getDefaultModel,
  isCachingEnabled,
} from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import {
  estimateCost,
  extractEbayAspects,
  getHaikuModel,
  type EbayAspectSpec,
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
import { withRetry } from "./retry.ts";
import { supabaseAdmin } from "./supabase.ts";
import { sourcesFor } from "./aspect-provenance.ts";
import {
  type AspectReviewEntry,
  reconcileGeneratedAspects,
  specsFromEbayAspectSpecs,
} from "./aspect-reconcile.ts";
import {
  applyMeasurementsBlock,
  resolveMeasurementAspects,
} from "./measurements.ts";
import {
  buildDisclosure,
  type DisclosureInput,
  type PerImageAnalysisLike,
} from "./disclosure.ts";
import {
  getMarketplaceSpec,
  type MarketplacePlatform,
} from "./marketplace-specs.ts";
import { resolveMarketplaceCategory } from "./marketplace-category-resolve.ts";
import { EBAY_TITLE_MAX, trimTitleToLimit } from "./title-trim.ts";
import {
  getEbaySearchDemandTerms,
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

// eBay Sell API condition enum values. Kept in sync with mapEbayCondition in
// flipdesk-ebay.ts so generated drafts publish without a translation step.
export const EBAY_CONDITION_VALUES = [
  "NEW",
  "LIKE_NEW",
  "USED_EXCELLENT",
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
}

export interface ListingGenResult {
  listing: GeneratedListing;
  model: string;
  promptVersion: string;
  tokensIn: number;
  tokensOut: number;
}

const LISTING_GEN_SYSTEM_PROMPT =
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
  practices.
- suggested_price_cents: a reasonable starting price in US cents based on the
  item, brand, and condition. The system may refine this from comparable sales.
- confidence: your overall confidence (0..1) that this listing is accurate.
- Do not fabricate attributes, brands, sizes, or model numbers not supported by
  the photos or supplied attributes.`;

const LISTING_GEN_TOOL: Anthropic.Tool = {
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

function pickPromptText(promptText: string | null, fallback: string): string {
  return promptText && promptText.trim().length > 0 ? promptText : fallback;
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
        text: pickPromptText(picked.prompt_text, codeDefault.text),
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
        text: pickPromptText(picked.prompt_text, codeDefault.text),
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

  const model = getDefaultModel(); // vision-capable
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
  lines.push("Call create_ebay_listing with the finished listing.");
  content.push({ type: "text", text: lines.join("\n\n") });

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? { type: "text", text: prompt.text, cache_control: { type: "ephemeral" } }
    : { type: "text", text: prompt.text };

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
    promptVersion: prompt.versionName,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

// ── US-312: end-to-end single-item generation orchestration ───────────
// photos → generateListingFields → resolve real eBay leaf category →
// constrain item specifics → comp-based price (AI fallback, flagged) →
// write a tenant-scoped draft listing + log usage.

// eBay Sell condition enum → Browse API conditionId for comp searches.
function conditionIdForComps(condition: EbayCondition): string {
  switch (condition) {
    case "NEW":
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
    const allowedValues = (a.aspectValues ?? [])
      .map((v) => (typeof v.localizedValue === "string" ? v.localizedValue : ""))
      .filter((v): v is string => v.length > 0)
      .slice(0, 80);
    specs.push({
      name,
      required,
      cardinality,
      mode,
      allowedValues: allowedValues.length > 0 ? allowedValues : undefined,
    });
  }

  // Prioritize: required → recommended → optional, capped so the AI focuses on
  // what actually matters for an eBay listing.
  const usageByName = new Map<string, string>();
  for (const a of raw as RawAspect[]) {
    if (a.localizedAspectName) {
      usageByName.set(a.localizedAspectName, a.aspectConstraint?.aspectUsage ?? "OPTIONAL");
    }
  }
  const required = specs.filter((s) => s.required);
  const recommended = specs.filter(
    (s) => !s.required && usageByName.get(s.name) === "RECOMMENDED",
  );
  const optional = specs.filter(
    (s) => !s.required && usageByName.get(s.name) !== "RECOMMENDED",
  );
  return [...required, ...recommended, ...optional].slice(0, 35);
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

/**
 * US-541: a generated draft needs a human look when the model's OVERALL
 * confidence is low, or ANY refined per-aspect confidence is low. Pure, so the
 * triage rule is unit-tested.
 */
export function listingNeedsReview(
  overallConfidence: number,
  fieldConfidence: Record<string, number>,
  threshold: number = LISTING_REVIEW_CONFIDENCE,
): boolean {
  if (overallConfidence < threshold) return true;
  return Object.values(fieldConfidence).some((c) => c < threshold);
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
  condition_notes: string | null;
  measurements: Record<string, unknown> | null;
  ebay_category_id: string | null;
}

async function loadItemPhotoUrls(itemId: string): Promise<ListingGenPhoto[]> {
  const { data } = await supabaseAdmin
    .from("item_photos")
    .select("photo_type, storage_path, sort_order")
    .eq("inventory_item_id", itemId)
    .order("sort_order", { ascending: true });
  return ((data ?? []) as Array<{ photo_type: string; storage_path: string | null }>)
    .filter((p) => !!p.storage_path)
    .map((p) => ({
      url: supabaseAdmin.storage.from("item-photos").getPublicUrl(p.storage_path!)
        .data.publicUrl,
      type: p.photo_type,
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
      "id, user_id, title, brand, style, size, color, material, condition_notes, measurements, ebay_category_id, grade_report_id",
    )
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .single();
  if (itemErr || !itemData) {
    throw new Error(`Item ${itemId} not found for this workspace`);
  }
  const item = itemData as ItemRow;
  const gradeReportId =
    (itemData as { grade_report_id?: string | null }).grade_report_id ?? null;

  // 2. Photos. US-545: the vision passes (generation + aspect refine) send a
  // cost-disciplined subset — exact-duplicate and near-identical same-role
  // shots dropped, count capped — since image tokens dominate per-item cost.
  // Tag-OCR still scans the full tag set below (tags are cheap and authoritative).
  const photos = await loadItemPhotoUrls(itemId);
  if (photos.length === 0) {
    throw new Error(`Item ${itemId} has no photos to generate a listing from`);
  }
  const visionPhotos = selectListingPhotos(photos);

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
  const measurements = item.measurements && typeof item.measurements === "object"
    ? item.measurements
    : undefined;

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
  const tagPhotos = photos.filter((p) => p.type && TAG_PHOTO_TYPES.has(p.type));
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
  const demandTerms = await getEbaySearchDemandTerms({
    brand: normalizedBrand,
    categoryId,
    query: demandQueryHint || null,
    size: item.size,
  });

  // 4. Generate (on the cost-disciplined photo subset).
  const gen = await generateListingFields({
    photos: visionPhotos,
    knownFields: Object.keys(knownFields).length > 0 ? knownFields : undefined,
    tagGroundTruth,
    measurements,
    allowedAspects: aspectsAlreadyConstrained ? allowedAspects : undefined,
    demandTerms: demandTerms.length > 0 ? demandTerms : undefined,
    // US-547: split this item between champion / A/B-challenger prompt.
    promptSelectKey: itemId,
  });
  const listing = gen.listing;

  // 5. Resolve a real eBay leaf category when the item didn't have one.
  if (!categoryId && listing.suggested_category_query) {
    try {
      const suggestions = await suggestCategories(listing.suggested_category_query);
      if (suggestions.length > 0) {
        categoryId = suggestions[0]!.categoryId;
        categoryPath = suggestions[0]!.categoryTreePath;
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
  if (categoryId) {
    let rawAspectsResponse: unknown = null;
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
  let listingDescription = applyMeasurementsBlock(listing.description, measurements);
  let conditionDescription = listing.condition_description;
  if (gradeReportId) {
    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select(
        "overall_score, grade_tier, defects_found, detected_style_attributes, per_image_analysis, detailed_notes, certificate_id",
      )
      .eq("id", gradeReportId)
      .maybeSingle();
    if (report) {
      const r = report as Record<string, unknown>;
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
        legacy_defects_summary:
          (r.detailed_notes as Record<string, string> | null)?.defects_summary ?? null,
      });
      listingDescription = `${listingDescription}\n<!--gradethread-disclosure-->${disclosure.html}`;
      if (!conditionDescription || !conditionDescription.trim()) {
        conditionDescription = disclosure.plain.slice(0, 990);
      }
    }
  }

  // US-541: route low-confidence drafts to review.
  // US-828: also flag the draft when reconciliation left aspects unmatched —
  // the seller must reconcile them before they silently drop at publish.
  const needsReview =
    listingNeedsReview(listing.confidence, fieldConfidence) ||
    aspectReview.length > 0;

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
    // US-546: A/B title variants (AC3) + the demand terms fed to the prompt (AC2)
    // for transparency/debug. active_title_variant tracks the live label.
    title_variants: titleVariants,
    active_title_variant: "A",
    demand_terms: demandTerms.length > 0 ? demandTerms : null,
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
    // US-825: everything AutoLister generated is AI-extracted provenance. This
    // is a fresh AI pass, so the source map is rebuilt from the generated keys
    // (a later deterministic refill / manual edit refines individual entries).
    ebay_aspect_sources: sourcesFor(Object.keys(itemSpecifics), "ai_extracted"),
    ai_generated_aspects_at: new Date().toISOString(),
  };
  if (normalizedBrand && normalizedBrand !== item.brand) {
    itemUpdate.brand = normalizedBrand;
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
  const costUsd = genCost + extractCost + tagOcrCost;
  const totalTokensIn = gen.tokensIn + extractTokensIn + tagOcrTokensIn;
  const totalTokensOut = gen.tokensOut + extractTokensOut + tagOcrTokensOut;
  try {
    await supabaseAdmin.from("ai_enrichment_log").insert({
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
        },
      },
    });
    // US-527: the AutoLister worker (the sole caller) now atomically RESERVES
    // the AI action against the monthly cap BEFORE calling generateListing
    // (reserve_ai_action) and refunds on failure, so the counter is no longer
    // incremented here — doing both would double-count and re-introduce the
    // parallel-batch cap-bypass race this story fixes.
  } catch (err) {
    console.error("[AI Listing] usage logging failed (non-fatal):", err);
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
      "id, user_id, brand, size, color, material, grade_value, grade_label, ebay_aspects, garment_category, item_category",
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
    ebay_aspects: Record<string, string[]> | null;
    garment_category: string | null;
    item_category: string | null;
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
    priceCents: Math.round((d.listing_price ?? 0) * 100),
    categoryQuery: d.platform_category_id ?? "",
    confidence: d.ai_confidence ?? 0.7,
  };

  // 3. One text-only AI pass for all requested platforms.
  const text = await generatePlatformVariantText(base, platforms);

  // 4. Photo count (for the photo-cap validation rule).
  const { count: photoCount } = await supabaseAdmin
    .from("item_photos")
    .select("id", { count: "exact", head: true })
    .eq("inventory_item_id", itemId);

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

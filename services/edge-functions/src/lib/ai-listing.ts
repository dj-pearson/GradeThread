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
import {
  estimateCost,
  extractEbayAspects,
  type EbayAspectSpec,
} from "./ai-extract.ts";
import {
  getCategoryAspects,
  searchBrowseComps,
  suggestCategories,
} from "./ebay-client.ts";
import { withRetry } from "./retry.ts";
import { supabaseAdmin } from "./supabase.ts";
import {
  buildDisclosure,
  type DisclosureInput,
  type PerImageAnalysisLike,
} from "./disclosure.ts";

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
  type?: string; // front | back | tag | detail | defect | flatlay | on_model
}

export interface ListingGenInput {
  photos: ListingGenPhoto[];
  // Optional known attributes (brand/size/etc.) already captured for the item.
  knownFields?: Record<string, unknown>;
  // Optional measurements (inches) to fold into the description.
  measurements?: Record<string, unknown>;
  // Optional: the resolved category's allowed aspects, used to steer
  // item_specifics on a constrained second pass (US-312). Aspect name ->
  // allowed values ([] = free text).
  allowedAspects?: Record<string, string[]>;
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
- title: <= 80 characters (eBay's hard limit). Lead with brand, then item type,
  then the most search-relevant attributes (size, color, model, style code).
  No ALL-CAPS spam, no emoji, no keyword stuffing of unrelated terms.
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
  Omit any aspect you cannot determine — never guess.
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

const PROMPT_CACHE_TTL_MS = 60_000;
let cached: { value: ResolvedListingPrompt; expiresAt: number } | null = null;

export async function resolveListingPrompt(): Promise<ResolvedListingPrompt> {
  const codeDefault: ResolvedListingPrompt = {
    text: LISTING_GEN_SYSTEM_PROMPT,
    versionName: LISTING_GEN_PROMPT_VERSION,
  };
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  let resolved = codeDefault;
  try {
    const { data, error } = await supabaseAdmin
      .from("ai_prompt_versions")
      .select("version_name, prompt_text")
      .eq("stage", "listing_gen")
      .eq("is_active", true)
      .limit(1);

    if (!error && Array.isArray(data) && data.length > 0) {
      const picked = data[0] as { version_name: string; prompt_text: string | null };
      const text =
        picked.prompt_text && picked.prompt_text.trim().length > 0
          ? picked.prompt_text
          : codeDefault.text;
      resolved = { text, versionName: picked.version_name };
    }
  } catch (err) {
    console.error(
      "[AI Listing] resolveListingPrompt fallback:",
      err instanceof Error ? err.message : String(err),
    );
  }

  cached = { value: resolved, expiresAt: now + PROMPT_CACHE_TTL_MS };
  return resolved;
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
  if (!input.photos || input.photos.length === 0) {
    throw new Error("generateListingFields requires at least one photo");
  }

  const model = getDefaultModel(); // vision-capable
  const client = getAnthropicClient();
  const temperature = getAiTemperature();
  const prompt = await resolveListingPrompt();

  const content: Anthropic.ContentBlockParam[] = [];
  input.photos.forEach((photo, i) => {
    content.push({
      type: "text",
      text: `Photo ${i + 1}${photo.type ? ` (${photo.type})` : ""}:`,
    });
    content.push({ type: "image", source: { type: "url", url: photo.url } });
  });

  const lines: string[] = [];
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

  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 80) : "";
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  if (!title || !description) {
    throw new Error("AI returned an incomplete listing (missing title/description)");
  }

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

  // 2. Photos.
  const photos = await loadItemPhotoUrls(itemId);
  if (photos.length === 0) {
    throw new Error(`Item ${itemId} has no photos to generate a listing from`);
  }

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

  // 4. Generate.
  const gen = await generateListingFields({
    photos,
    knownFields: Object.keys(knownFields).length > 0 ? knownFields : undefined,
    measurements,
    allowedAspects: aspectsAlreadyConstrained ? allowedAspects : undefined,
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
      if (specs.length > 0) {
        try {
          const refined = await extractEbayAspects({
            text: [item.title, item.brand, item.size, item.color, item.material]
              .filter((v): v is string => !!v && v.length > 0)
              .join(" • "),
            photos: photos.map((p) => ({ url: p.url, type: p.type })),
            knownAspects: listing.item_specifics,
            aspects: specs,
            categoryPath,
          });
          const refinedSpecifics = suggestionsToSpecifics(refined.suggestions);
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

  // 7. Price: prefer comp median, else AI estimate (flagged).
  let priceCents = listing.suggested_price_cents;
  let priceIsEstimated = true;
  if (useComps && categoryId) {
    try {
      const comps = await searchBrowseComps({
        categoryId,
        q: item.brand ?? (listing.suggested_category_query || undefined),
        brand: item.brand ?? undefined,
        size: item.size ?? undefined,
        conditionId: conditionIdForComps(listing.ebay_condition),
      });
      if (comps.stats.median != null) {
        priceCents = Math.round(comps.stats.median * 100);
        priceIsEstimated = false;
      }
    } catch (err) {
      console.error("[AI Listing] searchBrowseComps failed:", err);
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
  let listingDescription = listing.description;
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
    batch_id: opts.batchId ?? null,
    primary_photo_id: primaryPhotoId,
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
  await supabaseAdmin
    .from("inventory_items")
    .update({
      ebay_category_id: categoryId,
      ebay_aspects: itemSpecifics,
      ai_generated_aspects_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .eq("user_id", ownerId);

  // 10. Usage logging (the quota GATE is enforced by the caller). Includes
  //     the second-pass aspect-extraction tokens/cost so per-item billing
  //     reflects total Anthropic spend, not just the generation call.
  const genCost = estimateCost(gen.model, gen.tokensIn, gen.tokensOut);
  const costUsd = genCost + extractCost;
  const totalTokensIn = gen.tokensIn + extractTokensIn;
  const totalTokensOut = gen.tokensOut + extractTokensOut;
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
        },
      },
    });
    await supabaseAdmin.rpc("increment_ai_actions", { p_user_id: ownerId });
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

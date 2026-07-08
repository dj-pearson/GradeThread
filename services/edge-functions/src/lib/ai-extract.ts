import Anthropic from "@anthropic-ai/sdk";
import {
  getAiTemperature,
  getAnthropicClient,
  getDefaultModel,
  getLightweightModel,
  isCachingEnabled,
} from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { safeFetch, SsrfError } from "./ssrf.ts";
import {
  type BrandKnowledgePack,
  brandPackPromptBlock,
  decoderSpecsFromPack,
  resolveBrandKnowledgePack,
} from "./brand-knowledge.ts";
import { decodeTagCode, type DecodeResult } from "./brand-decoders.ts";

// Model routing: text-only requests use the cheap lightweight model; any
// request that includes a photo uses the vision-capable default model.
// Both names come from Coolify Team Shared Variables — see ai-config.ts.
export function getHaikuModel(): string {
  return getLightweightModel();
}

export function getSonnetModel(): string {
  return getDefaultModel();
}

// Approximate per-million-token pricing (USD). Used only for budget
// guardrails — exact billing is not the goal. Keyed by the model family
// prefix so that pinned date variants still resolve.
const PRICING: Array<{ match: RegExp; in: number; out: number }> = [
  { match: /haiku/i, in: 1.0, out: 5.0 },
  { match: /sonnet/i, in: 3.0, out: 15.0 },
  { match: /opus/i, in: 15.0, out: 75.0 },
];
const FALLBACK_PRICING = { in: 1.0, out: 5.0 };

// Keep in sync with the item_category enum (supabase migrations 00008 + 00230),
// src/lib/constants.ts ITEM_CATEGORIES, and the photo-profile table
// (lib/photo-profiles.ts). The classifier picks one of these from the photos so
// the client can load the matching photo profile.
export const ITEM_CATEGORIES = [
  "clothing",
  "shoes",
  "watches",
  "jewelry",
  "sports_cards",
  "collectibles",
  "electronics",
  "books",
  "bags",
  "accessories",
  "other",
] as const;

// Clothing-specific grading taxonomy — mirrors GARMENT_TYPES/GARMENT_CATEGORIES
// in src/lib/constants.ts (and the inline copies in routes/grade.ts). The edge
// is a separate Deno project and can't import frontend code. Only meaningful
// when item_category === "clothing"; the grading readiness gate requires both.
export const GARMENT_TYPES = [
  "tops",
  "bottoms",
  "outerwear",
  "dresses",
  "footwear",
  "accessories",
] as const;
export const GARMENT_CATEGORIES = [
  "t-shirt", "shirt", "blouse", "sweater", "hoodie",
  "jacket", "coat", "jeans", "pants", "shorts",
  "skirt", "dress", "sneakers", "boots", "sandals",
  "hat", "bag", "belt", "scarf", "other",
] as const;

const EXTRACT_FIELDS = [
  "title",
  "brand",
  "style",
  "size",
  "color",
  "material",
  "item_category",
  "garment_type",
  "garment_category",
  "condition_notes",
  "description",
] as const;

// ─── Canonical listing attributes (US-821) ──────────────────────────
//
// ONE extract pass should capture everything an eBay listing will ever need so
// a later category change never re-runs AI. These are CANONICAL (lowercase
// snake_case) keys — NOT eBay aspect names; US-822 maps canonical -> per-
// category eBay aspect downstream. Values are kept as free text (with common
// values hinted in the prompt) so US-823's normalization layer owns synonyms;
// constraining them to enums here would silently drop legitimate values.
//
// Token-budget note: this set adds ~13 small object slots to the SAME single
// extract tool call (no extra AI invocation). max_tokens was bumped to 2500 to
// keep the tool-call JSON from truncating mid-string with the wider schema.
interface CanonicalAttributeSpec {
  key: string;
  multi: boolean;
  description: string;
}

export const CANONICAL_ATTRIBUTES: CanonicalAttributeSpec[] = [
  { key: "department", multi: false, description: "Target department — e.g. Men, Women, Unisex Adult, Boys, Girls, Baby" },
  { key: "size_type", multi: false, description: "Size type — e.g. Regular, Plus, Petite, Big & Tall, Juniors, Maternity, Tall" },
  { key: "sleeve_length", multi: false, description: "Sleeve length — e.g. Short Sleeve, Long Sleeve, 3/4 Sleeve, Sleeveless" },
  { key: "neckline", multi: false, description: "Neckline — e.g. Crew Neck, V-Neck, Collared, Hooded, Turtleneck, Scoop Neck" },
  { key: "pattern", multi: false, description: "Pattern — e.g. Solid, Striped, Plaid, Floral, Graphic, Camouflage, Polka Dot" },
  { key: "fit", multi: false, description: "Fit — e.g. Regular, Slim, Relaxed, Oversized, Skinny, Loose" },
  { key: "closure", multi: false, description: "Closure — e.g. Button, Zip, Pullover, Snap, Drawstring, Hook & Loop" },
  { key: "features", multi: true, description: "Notable features as an array — e.g. Pockets, Hooded, Lined, Stretch, Water Resistant, Breathable" },
  { key: "garment_care", multi: false, description: "Care instructions read from the tag — e.g. Machine Wash, Hand Wash, Dry Clean Only" },
  { key: "country_of_manufacture", multi: false, description: "Country of manufacture read verbatim from the care label" },
  { key: "vintage", multi: false, description: "Whether the item is vintage (20+ years old / clearly retro) — 'Yes' or 'No'" },
  { key: "theme", multi: false, description: "Theme or franchise — e.g. a sports team, band, movie, brand collab" },
  { key: "mpn", multi: false, description: "Manufacturer Part Number / style code printed on the tag (distinct from the marketing style name)" },
  // US-1526: machine-readable identity codes read off the tag photos. These are
  // hard anchors for downstream product identification (US-1527/1528) — a
  // partial read is still a useful search key, so the prompt tells the model to
  // return them with LOW confidence rather than omit (codes ONLY; every other
  // field keeps the never-guess rule).
  { key: "style_code", multi: false, description: "Brand style/product code printed on the tag (e.g. LW7DVCS, 511-0011) — transcribe characters VERBATIM, never normalize. Often the same code as mpn; fill both when one code serves both." },
  { key: "rn_number", multi: false, description: "US FTC RN number from the care label — the digits after 'RN' (e.g. 'RN 106259' → 106259). Identifies the manufacturer of record." },
  { key: "upc", multi: false, description: "UPC/EAN barcode digits from a retail hang tag or sticker, transcribed verbatim (12–13 digits)" },
];

const MULTI_ATTRIBUTE_KEYS = new Set(
  CANONICAL_ATTRIBUTES.filter((a) => a.multi).map((a) => a.key),
);

export interface FieldSuggestion {
  value: string;
  confidence: number; // 0..1
  source: string; // "text" | "photo:tag" | "photo:front" | ...
}

// A captured canonical attribute. Always an array (multi fits the same shape;
// single uses length 1) with a calibrated confidence + provenance source.
export interface AttributeSuggestion {
  values: string[];
  confidence: number; // 0..1
  source: string;
}

// The persisted form of inventory_items.attributes: canonical key -> a scalar
// string (single) or string[] (multi, e.g. features).
export type CanonicalAttributeColumn = Record<string, string | string[]>;

export interface ExtractPhoto {
  url: string;
  type?: string; // front | back | tag | detail | defect | flatlay | on_model
}

export interface ExtractInput {
  text?: string;
  photos?: ExtractPhoto[];
  knownFields?: Record<string, unknown>;
}

export interface FieldConflict {
  field: string;
  text_value: string;
  photo_value: string;
}

// AI-suggested flat measurements (inches) derived from brand + size standards
// when the tag is readable. Values represent the brand's published spec for
// that size, NOT a measurement of this specific garment — the user verifies.
export type MeasurementSuggestions = Record<string, number>;

// US-1527: the research-tier product identification. Unlike OBSERVED fields
// (read off the photos/text under the never-guess rule), these are INFORMED
// IDENTIFICATION from the model's product knowledge, anchored on brand + codes
// (US-1526) + visible construction details — e.g. "Lululemon ABC Pant Classic"
// vs "Commission Pant". Carried with distinct provenance (source: "research")
// so the UI badges it as an identification to verify, never silent fact.
export interface ResearchIdentification {
  /** The named style/model — e.g. "ABC Pant Classic", "Better Sweater 1/4-Zip". */
  identifiedStyle: string | null;
  /** The product line/family — e.g. "ABC", "Dri-FIT", "Nano Puff". */
  productLine: string | null;
  /** Brand fabric technology — e.g. "Warpstreme", "Luon", "Tech Fleece". */
  fabricTechnology: string | null;
  /** Original-retail estimate in CENTS. Seller context only — never auto-applied to price. */
  msrpEstimateCents: number | null;
  /** Which photo evidence supports the ID — required, shown to the user. */
  rationale: string | null;
  /** Calibrated 0..1. Below RESEARCH_MIN_CONFIDENCE the whole block is dropped. */
  confidence: number;
}

/** US-1527: identifications below this confidence are dropped server-side. */
export const RESEARCH_MIN_CONFIDENCE = 0.5;

/** Provenance value for research-tier suggestions (UI badges these). */
export const RESEARCH_SOURCE = "research";

export interface ExtractionResult {
  suggestions: Record<string, FieldSuggestion>;
  /** US-821: canonical listing attributes captured in the same single pass. */
  attributes: Record<string, AttributeSuggestion>;
  /** US-1527: research-tier product identification; null when below the
   * confidence floor or not attempted. */
  research: ResearchIdentification | null;
  conditionSummary: string | null;
  conflicts: FieldConflict[];
  measurements: MeasurementSuggestions | null;
  /** Short eBay Taxonomy search query (e.g. "men's flannel shirt") so the
   * caller can resolve a leaf category without a second AI call. */
  ebayCategoryQuery: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  const price = PRICING.find((p) => p.match.test(model)) ?? FALLBACK_PRICING;
  const cost = (tokensIn / 1_000_000) * price.in +
    (tokensOut / 1_000_000) * price.out;
  return Math.round(cost * 100000) / 100000;
}

// Static — kept in a cache-controlled system block to cut repeat-call cost.
const SYSTEM_PROMPT =
  `You extract structured resale-item attributes for FlipDesk, a reseller tool.
You are given a free-text description and/or photos of a single second-hand item.

Hard rules:
- Never guess. If the input does not support a field, omit it entirely.
- item_category MUST be one of: ${ITEM_CATEGORIES.join(", ")}. Never invent a category. Classify from the FRONT photo first (what KIND of product is this?) — the client uses this to pick which photo slots to ask the seller for, so prefer the most specific fit: a handbag/purse is 'bags', a hat/belt/sunglasses sold on its own is 'accessories', a ring/necklace is 'jewelry', a graded or raw trading card is 'sports_cards'. Use 'other' only when nothing else fits.
- garment_type and garment_category: fill these ONLY when item_category is 'clothing' (apparel that is graded on the clothing rubric). Omit both entirely for any other item_category. garment_type MUST be one of: ${GARMENT_TYPES.join(", ")}. garment_category MUST be one of: ${GARMENT_CATEGORIES.join(", ")} and must be consistent with garment_type (e.g. tops→t-shirt/shirt/blouse/sweater/hoodie; bottoms→jeans/pants/shorts/skirt; outerwear→jacket/coat; dresses→dress; footwear→sneakers/boots/sandals; accessories→hat/bag/belt/scarf/other). Classify from the front/flatlay photo. These power grading readiness, so prefer a confident best-fit over omission when the item is clearly clothing.
- size: normalize to a common token (XS, S, M, L, XL, XXL, a numeric size, or a shoe size) only when unambiguous; otherwise omit it.
- brand: the MANUFACTURER / maker of the item (e.g. Patagonia, Nike, Levi's, Lululemon) — usually the logo or wordmark on the brand tag (neck, waistband, or inside collar). A COLLECTION name, product line, style name, or model name is NOT the brand: "Better Sweater", "Dri-FIT", "511", "Heattech", "Sport" are styles/lines, not brands — put those in 'style', never in 'brand'. Care labels frequently print a collection/line name large with the actual maker small or as a tiny wordmark; pick the MAKER. If you can read a style/collection name but cannot confidently identify the actual manufacturer, set 'style' and OMIT 'brand' — do NOT promote a style name into the brand field. Never copy generic tag text ("MADE IN", "100% COTTON", "MACHINE WASH") into brand.
- title: produce a clean, listing-ready title (brand + key descriptors), not a copy of the raw text.
- color: a single primary color word. material: the primary fabric/material.
- condition_notes: only condition hints explicitly present in the input.
- description: compose a clean, buyer-facing LISTING description — an opening line, then the key attributes (brand, item type, size, color, material), then an HONEST condition statement. Use ONLY what the photos/text/known fields support; never invent attributes or upgrade condition (over-promising condition causes returns). Keep it concise — a short paragraph or a few bullet-style lines. Always return a description when there is enough signal to write one.
- For every field you return, give a calibrated confidence from 0 to 1, and a source string.

Photo guidance (when photos are present):
- The 'tag' / 'tag_2' photos carry the brand and/or care labels — the highest-value inputs. Read the BRAND from the maker's logo/wordmark (often a separate neck/waistband brand tag), and the SIZE + fiber/material from the care label. Do not mistake a collection/style name printed on the label for the brand (see the brand rule above).
- 'front', 'flatlay', 'on_model' photos: use for color, item_category, and garment style.
- 'detail' and 'defect' photos: use for condition_notes and condition_summary.
- Set each field's source to where it came from: 'text', or 'photo:<type>' (e.g. 'photo:tag').
- Read label text robustly across blurry or angled shots — if a label is hard to read, return the field with LOW confidence rather than a confident guess. Skip images you genuinely cannot interpret.

Cross-photo synthesis (US-1530) — the photos are ONE item, not separate jobs:
- The per-photo guidance above says where each field is EASIEST to read, not which photo "owns" it. Reason about the item jointly: corroborate every field against EVERY photo that bears on it. The care label's fiber content should inform what the front photo's sheen/drape means; a gusset or waistband construction in a detail shot should refine the garment_type you read from the front; a printed size on a waistband should be checked against the size tag.
- Confidence must reflect corroboration: a field supported by multiple photos that agree deserves HIGHER confidence than one read from a single blurry source. One clean tag read is still strong; two agreeing signals are stronger; a lone ambiguous glimpse is LOW.
- When two PHOTOS genuinely disagree on a field (tag says M, waistband print says 8), that is a conflict exactly like a text-vs-photo disagreement: prefer tag/label TEXT over visual inference for the suggestion, and ALSO add a conflicts entry carrying both values (use text_value for the tag/label reading and photo_value for the visual one, and name which photos in the values when helpful). Never silently coin-flip a disagreement.
- Photos win for brand, size, and material; text wins for condition_notes.
- If text and photos genuinely disagree on a field, do NOT silently pick one — add an entry to conflicts with both values.

Fields supplied as already-known are ground truth — do not contradict them; only fill genuine gaps.
Always also return a short condition_summary describing the item's observed condition.
Always also return ebay_category_query: a short, generic eBay category search phrase for this item (e.g. "men's flannel button-up shirt", "women's ankle boots") — item type + department, NO brand, NO size, NO color.

Canonical attributes (the 'attributes' object):
- Capture EVERY listing attribute you can support in this ONE call, so a later category change never needs a fresh AI pass. These are CANONICAL keys, not eBay aspect names.
- Fill only the attributes the photos/text clearly support — omit the rest. Never guess.
- The example values in each field's description are HINTS, not a closed list — return the value you actually observe (a downstream layer normalizes synonyms).
- 'features' is an array (return all that apply); every other attribute is a single value.
- Read department, size_type, garment_care, country_of_manufacture, and mpn from the care/brand tag when present. mpn is the manufacturer part/style number printed on the tag — distinct from the marketing 'style' name; do not conflate them.
- Give each attribute a 0..1 confidence and a source string, same as the core fields.

Identity codes on the tag (style_code, rn_number, upc):
- Tag/care-label photos often carry machine-readable identity: a brand style/product code (usually an alphanumeric block printed near the size or fiber content — e.g. LW7DVCS, 511-0011, CV8839-010), an RN number ("RN 12345" — the US FTC manufacturer registry), and UPC/EAN barcode digits on retail hang tags.
- Transcribe these codes VERBATIM, character for character — never normalize, expand, reformat, or drop leading zeros. For rn_number return only the digits after "RN".
- EXCEPTION to the never-guess rule, for these three code fields ONLY: a partial or uncertain read is still a useful search key, so return your best transcription with LOW confidence (≤ 0.4) instead of omitting it. Mark the source (usually 'photo:tag'). Every other field keeps the never-guess rule.
- If one printed code serves as both the style code and the MPN, fill both style_code and mpn with it.

Product identification — the 'research_identification' object (RESEARCH tier):
- This object is the ONE place you are AUTHORIZED to use your own product knowledge to IDENTIFY the item, not just describe it. Every other field keeps the never-guess rule exactly as written above.
- Identify the NAMED style/model when the evidence supports it: anchor on the brand, any tag codes (style_code / RN / UPC — a style code often maps directly to a known product), the fabric from the care label, and the CONSTRUCTION DETAILS visible across ALL photos — gusset, waistband build, pocket layout, stitching, zips, hardware, hem style. Example: a Lululemon tag + Warpstreme content + a gusseted crotch and zippered back pocket says "ABC Pant Classic"; a dress-pant waistband with hidden zip pockets says "Commission Pant".
- identified_style: the specific named style/model. product_line: the family/line ("ABC", "Dri-FIT", "Nano Puff"). fabric_technology: the brand's fabric name when identifiable ("Warpstreme", "Luon", "Tech Fleece").
- msrp_estimate_cents: your best estimate of the ORIGINAL retail price in cents (context for the seller; never a listing price).
- identification_rationale: REQUIRED — cite the specific photo evidence supporting the ID ("gusseted crotch + zippered back pocket in the back photo; Warpstreme on the care label"). An identification without a rationale is worthless to the seller.
- identification_confidence: calibrated 0..1 for the identification as a whole. If it is below 0.5, OMIT the entire research_identification object — a wrong confident-sounding ID is worse than none.
- Do not attempt identification for unbranded/generic items; omit the object.
- APPLY the identification to the listing fields you return in this same call (US-1529): LEAD the title with brand + the identified style name ("Lululemon ABC Pant Classic …") — the style name is a top buyer search token. In the description, name the product line and fabric technology, and give MSRP context ("retails around $128") — phrased as an identification ("identified as the ABC Pant Classic"), never as fabricated certainty, and never overriding the honest-condition rules. ebay_category_query may use the identified product type. When you return NO research_identification, compose title/description exactly as the base rules above describe.

Measurement suggestions:
- ONLY suggest measurements when brand AND size AND item type are clearly identifiable. If any of those are unknown, OMIT measurements entirely.
- Measurements are the BRAND'S PUBLISHED FLAT-MEASUREMENT SPEC for that size, NOT measured from this specific garment. The user will verify.
- All values are flat measurements in INCHES, garment laid flat (so a 40" chest top has chest=20).
- Use only field keys from this list, and only the ones relevant to the item type:
  - Tops/outerwear: chest, length, shoulder, sleeve
  - Bottoms: waist, inseam, rise, hip, leg_opening
  - Dresses: bust, waist, hip, length
  - Shoes: size_us (the numeric US size; insole length in inches if known)
- If you DON'T know the brand's published spec for that exact size, OMIT that aspect rather than guessing.`;

function fieldSchema(description: string) {
  return {
    type: "object" as const,
    description,
    properties: {
      value: { type: "string" as const },
      confidence: {
        type: "number" as const,
        description: "0..1 calibrated confidence",
      },
      source: {
        type: "string" as const,
        description: "'text' or 'photo:<type>'",
      },
    },
    required: ["value", "confidence"],
  };
}

// One canonical-attribute slot in the extract tool. Multi attrs (features)
// take a string array; single attrs take a scalar string. Confidence + source
// mirror fieldSchema so the same decode path reads both.
function attributeSchema(spec: CanonicalAttributeSpec) {
  const valueProp = spec.multi
    ? {
        values: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "All applicable values",
        },
      }
    : { value: { type: "string" as const } };
  return {
    type: "object" as const,
    description: spec.description,
    properties: {
      ...valueProp,
      confidence: {
        type: "number" as const,
        description: "0..1 calibrated confidence",
      },
      source: {
        type: "string" as const,
        description: "'text' or 'photo:<type>'",
      },
    },
    required: ["confidence"],
  };
}

// The nested `attributes` object schema, one property per canonical attribute.
const ATTRIBUTES_SCHEMA = {
  type: "object" as const,
  description:
    "Canonical listing attributes (lowercase snake_case keys, NOT eBay aspect names). Fill every attribute the photos/text support; omit the rest.",
  properties: Object.fromEntries(
    CANONICAL_ATTRIBUTES.map((spec) => [spec.key, attributeSchema(spec)]),
  ),
};

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "extract_item_fields",
  description:
    "Return the structured resale-item fields you can determine from the provided text and/or images. Omit any field you cannot support.",
  input_schema: {
    type: "object",
    properties: {
      title: fieldSchema("Clean, listing-ready item title"),
      brand: fieldSchema("Brand or maker name"),
      style: fieldSchema("Style name, model, silhouette, or model number"),
      size: fieldSchema("Normalized size token"),
      color: fieldSchema("Primary color"),
      material: fieldSchema("Primary material or fabric"),
      item_category: {
        type: "object",
        description: "Item category",
        properties: {
          value: { type: "string", enum: [...ITEM_CATEGORIES] },
          confidence: { type: "number" },
          source: { type: "string" },
        },
        required: ["value", "confidence"],
      },
      garment_type: {
        type: "object",
        description:
          "Clothing garment type — ONLY when item_category is 'clothing'. Omit for every non-clothing item.",
        properties: {
          value: { type: "string", enum: [...GARMENT_TYPES] },
          confidence: { type: "number" },
          source: { type: "string" },
        },
        required: ["value", "confidence"],
      },
      garment_category: {
        type: "object",
        description:
          "Specific clothing garment category — ONLY when item_category is 'clothing'. Must be consistent with garment_type. Omit for every non-clothing item.",
        properties: {
          value: { type: "string", enum: [...GARMENT_CATEGORIES] },
          confidence: { type: "number" },
          source: { type: "string" },
        },
        required: ["value", "confidence"],
      },
      condition_notes: fieldSchema(
        "Brief condition hints explicitly mentioned or visible"
      ),
      description: fieldSchema(
        "Buyer-facing listing description: opening line, key attributes, then an honest condition statement. Compose only from supported facts."
      ),
      condition_summary: {
        type: "string",
        description: "A short overall condition summary of the item",
      },
      ebay_category_query: {
        type: "string",
        description:
          "Short eBay category search phrase: item type + department, no brand/size/color (e.g. \"men's flannel button-up shirt\")",
      },
      attributes: ATTRIBUTES_SCHEMA,
      research_identification: {
        type: "object",
        description:
          "RESEARCH-tier product identification (informed by your product knowledge, anchored on brand + tag codes + visible construction). Omit entirely when identification_confidence would be below 0.5 or the item is unbranded/generic.",
        properties: {
          identified_style: {
            type: "string",
            description: "The named style/model — e.g. 'ABC Pant Classic', 'Better Sweater 1/4-Zip'",
          },
          product_line: {
            type: "string",
            description: "Product line/family — e.g. 'ABC', 'Dri-FIT', 'Nano Puff'",
          },
          fabric_technology: {
            type: "string",
            description: "Brand fabric technology — e.g. 'Warpstreme', 'Luon', 'Tech Fleece'",
          },
          msrp_estimate_cents: {
            type: "number",
            description: "Estimated ORIGINAL retail price in cents (seller context only)",
          },
          identification_rationale: {
            type: "string",
            description: "REQUIRED: the specific photo evidence supporting this identification",
          },
          identification_confidence: {
            type: "number",
            description: "Calibrated 0..1 for the identification as a whole",
          },
        },
        required: ["identified_style", "identification_rationale", "identification_confidence"],
      },
      conflicts: {
        type: "array",
        description:
          "Fields where the text and the photos genuinely disagree",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            text_value: { type: "string" },
            photo_value: { type: "string" },
          },
          required: ["field", "text_value", "photo_value"],
        },
      },
      measurements: {
        type: "object",
        description:
          "Brand-spec flat measurements (inches) for the identified brand + size + item type. ONLY fill when all three are clearly identifiable AND you know the brand's published spec. Omit aspects you're unsure of.",
        properties: {
          chest: { type: "number", description: "Pit to pit" },
          length: { type: "number", description: "HPS to hem (tops) or top to hem (bottoms)" },
          shoulder: { type: "number" },
          sleeve: { type: "number" },
          waist: { type: "number" },
          inseam: { type: "number" },
          rise: { type: "number", description: "Front rise" },
          hip: { type: "number" },
          leg_opening: { type: "number" },
          bust: { type: "number" },
          size_us: { type: "number", description: "Numeric US shoe size" },
          insole: { type: "number" },
        },
      },
    },
  },
};

function buildUserPrompt(input: ExtractInput): string {
  const parts: string[] = [];
  if (input.text && input.text.trim()) {
    parts.push(`ITEM DESCRIPTION:\n${input.text.trim()}`);
  }
  const known = input.knownFields ?? {};
  const knownEntries = Object.entries(known).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );
  if (knownEntries.length > 0) {
    parts.push(
      `ALREADY KNOWN (ground truth — do not contradict, only fill gaps):\n` +
        JSON.stringify(Object.fromEntries(knownEntries), null, 2)
    );
  }
  parts.push(
    "Call extract_item_fields with only the fields you can confidently determine."
  );
  return parts.join("\n\n");
}

// Anthropic's per-image limit is ~5 MB of source bytes; stay under it (base64
// inflates ~33%, but the API measures the decoded bytes). Oversized photos are
// skipped rather than risking a hard API rejection.
const MAX_IMAGE_FETCH_BYTES = 4_500_000;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

type AnthropicImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

// Sniff the media type from magic bytes — DON'T trust the Content-Type header
// (Supabase storage can serve application/octet-stream). Mirrors the upload
// validator's sniffing. Returns null for anything Anthropic can't accept.
function sniffImageMediaType(b: Uint8Array): AnthropicImageMediaType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return "image/gif";
  }
  return null;
}

// Base64-encode bytes via the global btoa (no extra dependency, so the frozen
// edge lockfile stays untouched). Chunked so String.fromCharCode never gets an
// argument list big enough to overflow for multi-MB photos.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Fetches each photo in the edge and returns labelled Anthropic content blocks
 * with the image bytes inlined as base64.
 *
 * We deliberately do NOT hand Anthropic the raw URLs: a single signed/expired/
 * unreachable URL makes the whole `messages.create` fail with a 400 "Unable to
 * download the file", which previously sank the ENTIRE extraction (one bad photo
 * → user gets nothing). Fetching here lets us SKIP an individual bad/oversized/
 * non-image photo and proceed with the rest, and the edge shares infra with
 * storage so it fetches reliably. Order is preserved; skipped photos are logged.
 */
export async function buildPhotoContent(
  photos: ExtractPhoto[],
  // Injectable so tests can stub the network without reaching the SSRF guard /
  // real DNS. Defaults to the SSRF-safe fetcher in production.
  fetcher: typeof safeFetch = safeFetch,
): Promise<Anthropic.ContentBlockParam[]> {
  const fetched = await Promise.all(
    photos.map(async (photo, i) => {
      try {
        // SSRF-safe fetch: photo.url can be caller-supplied (POST
        // /api/flipdesk/ai/extract accepts photo_urls in the request body), so
        // the target hostname MUST be resolved and refused if it maps to a
        // private / loopback / link-local / cloud-metadata range, and every
        // redirect hop re-validated, BEFORE the socket opens. safeFetch also
        // enforces the byte cap (throws SsrfError past maxBytes → skipped below).
        const res = await fetcher(photo.url, {
          timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
          maxBytes: MAX_IMAGE_FETCH_BYTES,
        });
        if (res.status < 200 || res.status >= 300) {
          console.warn(`[flipdesk-ai] image ${i} fetch HTTP ${res.status} — skipping`);
          return null;
        }
        const bytes = res.bytes;
        if (bytes.byteLength === 0) {
          console.warn(`[flipdesk-ai] image ${i} empty body — skipping`);
          return null;
        }
        const mediaType = sniffImageMediaType(bytes);
        if (!mediaType) {
          console.warn(`[flipdesk-ai] image ${i} not a supported image — skipping`);
          return null;
        }
        return { photo, mediaType, data: bytesToBase64(bytes) };
      } catch (err) {
        if (err instanceof SsrfError) {
          console.warn(`[flipdesk-ai] image ${i} rejected by SSRF guard: ${err.message} — skipping`);
          return null;
        }
        console.warn(
          `[flipdesk-ai] image ${i} fetch failed: ${err instanceof Error ? err.message : String(err)} — skipping`,
        );
        return null;
      }
    }),
  );

  const content: Anthropic.ContentBlockParam[] = [];
  fetched.forEach((entry, i) => {
    if (!entry) return;
    content.push({
      type: "text",
      text: `Photo ${i + 1}${entry.photo.type ? ` (${entry.photo.type})` : ""}:`,
    });
    content.push({
      type: "image",
      source: { type: "base64", media_type: entry.mediaType, data: entry.data },
    });
  });
  return content;
}

/** Pick a garment category/type hint from already-known fields to scope the
 *  brand pack (styles + size charts). Returns null when none is known. */
function categoryHintFromKnown(
  known: Record<string, unknown> | undefined,
): string | null {
  if (!known) return null;
  for (const k of ["garment_category", "garment_type", "item_category"]) {
    const v = known[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * Extracts structured item attributes from text and/or photos, routing to
 * Haiku (text-only) or Sonnet (any photo). Throws on transport/parse errors
 * so the caller can return a 502 without charging a log row.
 */
export async function extractItemFields(
  input: ExtractInput
): Promise<ExtractionResult> {
  enterAiFeature("catalog_extract"); // US-894 spend attribution
  const photos = input.photos ?? [];
  const hasPhotos = photos.length > 0;
  const model = hasPhotos ? getSonnetModel() : getHaikuModel();
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  // US-1713 Phase 1/2: when the brand is known upfront (seller-set / enrich
  // pass), load its knowledge pack and GROUND the prompt with it. Best-effort —
  // any failure just skips the injection so extraction never regresses.
  const knownBrand = typeof input.knownFields?.brand === "string"
    ? input.knownFields.brand
    : undefined;
  const categoryHint = categoryHintFromKnown(input.knownFields);
  let injectedPack: BrandKnowledgePack | null = null;
  if (knownBrand) {
    try {
      injectedPack = await resolveBrandKnowledgePack(knownBrand, {
        category: categoryHint,
      });
    } catch {
      injectedPack = null;
    }
  }
  const packBlock = brandPackPromptBlock(injectedPack);

  // Fetch + inline the images (skips any unreachable one rather than failing the
  // whole call); each block is captioned with its slot (tag/front/…).
  const content: Anthropic.ContentBlockParam[] = await buildPhotoContent(photos);
  if (packBlock) content.push({ type: "text", text: packBlock });
  content.push({ type: "text", text: buildUserPrompt(input) });

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
    : { type: "text", text: SYSTEM_PROMPT };

  const response = await client.messages.create({
    model,
    // 2500 (was 2000): the buyer-facing `description` plus the US-821 canonical
    // `attributes` object widen the tool-call JSON; extra headroom keeps it from
    // truncating mid-string.
    max_tokens: 2500,
    ...(temperature !== undefined ? { temperature } : {}),
    system: [systemBlock],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "extract_item_fields" },
    messages: [{ role: "user", content }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return structured fields");
  }

  let decoded = decodeExtraction(
    toolUse.input as Record<string, unknown>,
    hasPhotos,
  );

  // US-1713 Phase 2: enrich with the brand pack + run tag-code decoders. Uses
  // the AI-detected brand (or the upfront hint), and reuses the injected pack
  // via the resolver cache. Fully guarded — enrichment NEVER breaks extraction.
  try {
    const enrichBrand = decoded.suggestions.brand?.value ?? knownBrand ?? null;
    const catHint = categoryHint ??
      decoded.suggestions.garment_category?.value ??
      decoded.suggestions.item_category?.value ?? null;
    if (enrichBrand) {
      const pack = await resolveBrandKnowledgePack(enrichBrand, {
        category: catHint,
      });
      if (pack) {
        const enriched = enrichExtractionWithBrandKnowledge(decoded, pack);
        decoded = enriched.decoded;
        // US-1714 metric — one structured line per enriched extraction so the
        // KB's effect is measurable in log aggregation: which brand, whether a
        // decoder fired (match-rate), and how many fields it grounded.
        const d = enriched.diagnostics;
        console.log(
          `[brand-knowledge-metric] brand=${JSON.stringify(d.brand)} ` +
            `pack=${d.packSource} ` +
            `decoders=${
              d.decoderHits.map((h) => h.decoderKind).join("|") || "none"
            } ` +
            `overrides=${d.overrides.length} styles=${pack.styles.length}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[brand-knowledge] enrichment skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return {
    ...decoded,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

/**
 * Pure decoder for the extract_item_fields tool output. Split out from the
 * transport so the schema-decode + the original-9-field regression can be unit
 * tested without an AI call (US-821). Returns everything in ExtractionResult
 * except the transport-only model/token fields.
 */
export function decodeExtraction(
  raw: Record<string, unknown>,
  hasPhotos: boolean,
): Omit<ExtractionResult, "model" | "tokensIn" | "tokensOut"> {
  const defaultSource = hasPhotos ? "photo" : "text";
  const suggestions: Record<string, FieldSuggestion> = {};

  for (const key of EXTRACT_FIELDS) {
    const field = raw[key];
    if (!field || typeof field !== "object") continue;
    const f = field as { value?: unknown; confidence?: unknown; source?: unknown };
    if (
      f.value === undefined ||
      f.value === null ||
      String(f.value).trim() === ""
    ) {
      continue;
    }
    let confidence = Number(f.confidence);
    if (Number.isNaN(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));
    const source =
      typeof f.source === "string" && f.source.trim() !== ""
        ? f.source
        : defaultSource;
    suggestions[key] = {
      value: String(f.value).trim(),
      confidence,
      source,
    };
  }

  // Canonical attributes (US-821). Each slot is { value | values, confidence,
  // source }; normalize to an always-array AttributeSuggestion. Drop empties.
  const attributes: Record<string, AttributeSuggestion> = {};
  const rawAttrs =
    raw.attributes && typeof raw.attributes === "object"
      ? (raw.attributes as Record<string, unknown>)
      : {};
  for (const spec of CANONICAL_ATTRIBUTES) {
    const slot = rawAttrs[spec.key];
    if (!slot || typeof slot !== "object") continue;
    const s = slot as {
      value?: unknown;
      values?: unknown;
      confidence?: unknown;
      source?: unknown;
    };
    const rawValues = Array.isArray(s.values)
      ? s.values
      : s.value !== undefined && s.value !== null
        ? [s.value]
        : [];
    let values = rawValues
      .map((v) => (typeof v === "string" ? v.trim() : String(v).trim()))
      .filter((v) => v.length > 0 && v.toLowerCase() !== "unknown");
    if (!MULTI_ATTRIBUTE_KEYS.has(spec.key)) values = values.slice(0, 1);
    if (values.length === 0) continue;
    let confidence = Number(s.confidence);
    if (Number.isNaN(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));
    const source =
      typeof s.source === "string" && s.source.trim() !== ""
        ? s.source
        : defaultSource;
    attributes[spec.key] = { values, confidence, source };
  }

  // US-1527: research-tier product identification. Validated hard: a usable
  // block needs a style name, a rationale (an ID the user can't verify is
  // worthless), and confidence at/above the floor — otherwise the WHOLE block
  // drops (partial research output would masquerade as observed fact).
  let research: ResearchIdentification | null = null;
  if (raw.research_identification && typeof raw.research_identification === "object") {
    const r = raw.research_identification as Record<string, unknown>;
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim() !== "" ? v.trim() : null;
    const identifiedStyle = str(r.identified_style);
    const rationale = str(r.identification_rationale);
    let confidence = Number(r.identification_confidence);
    if (Number.isNaN(confidence)) confidence = 0;
    confidence = Math.max(0, Math.min(1, confidence));
    const msrpRaw = Number(r.msrp_estimate_cents);
    // Sanity band: $1 – $10,000 in cents; anything else is a unit mistake.
    const msrpEstimateCents =
      Number.isFinite(msrpRaw) && msrpRaw >= 100 && msrpRaw <= 1_000_000
        ? Math.round(msrpRaw)
        : null;
    if (identifiedStyle && rationale && confidence >= RESEARCH_MIN_CONFIDENCE) {
      research = {
        identifiedStyle,
        productLine: str(r.product_line),
        fabricTechnology: str(r.fabric_technology),
        msrpEstimateCents,
        rationale,
        confidence,
      };
    }
  }

  // US-1527: an accepted identification fills the style suggestion when the
  // photos/text produced none (no style name printed on the tag) — with the
  // distinct 'research' provenance so the UI badges it. An OBSERVED style
  // always wins; research never overwrites it.
  if (research && !suggestions.style) {
    suggestions.style = {
      value: research.identifiedStyle as string,
      confidence: research.confidence,
      source: RESEARCH_SOURCE,
    };
  }

  const conditionSummary =
    typeof raw.condition_summary === "string" &&
      raw.condition_summary.trim() !== ""
      ? raw.condition_summary.trim()
      : null;

  const ebayCategoryQuery =
    typeof raw.ebay_category_query === "string" &&
      raw.ebay_category_query.trim() !== ""
      ? raw.ebay_category_query.trim()
      : null;

  const conflicts: FieldConflict[] = Array.isArray(raw.conflicts)
    ? (raw.conflicts as unknown[])
        .filter(
          (c): c is FieldConflict =>
            !!c &&
            typeof c === "object" &&
            typeof (c as FieldConflict).field === "string"
        )
        .map((c) => ({
          field: c.field,
          text_value: String(c.text_value ?? ""),
          photo_value: String(c.photo_value ?? ""),
        }))
    : [];

  // Measurements — only keep finite numbers; drop strings and zeros (Claude
  // sometimes returns "0" for "unknown" rather than omitting). Storing 0s
  // would mislead the user into thinking we measured a zero-width sleeve.
  const measurements: MeasurementSuggestions = {};
  if (raw.measurements && typeof raw.measurements === "object") {
    for (const [key, value] of Object.entries(
      raw.measurements as Record<string, unknown>,
    )) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) {
        measurements[key] = Math.round(n * 100) / 100;
      }
    }
  }

  return {
    suggestions,
    attributes,
    research,
    conditionSummary,
    conflicts,
    measurements: Object.keys(measurements).length > 0 ? measurements : null,
    ebayCategoryQuery,
  };
}

/** The decode-time subset of ExtractionResult (no transport/token fields). */
export type DecodedExtraction = Omit<
  ExtractionResult,
  "model" | "tokensIn" | "tokensOut"
>;

/** US-1713: what the brand-knowledge enrichment changed, for logging/telemetry. */
export interface BrandKnowledgeDiagnostics {
  brand: string;
  packSource: string;
  decoderHits: DecodeResult[];
  overrides: Array<{ field: string; to: string; source: string }>;
}

/**
 * US-1713 Phase 2 — deterministic enrichment of a decoded extraction with a
 * brand knowledge pack. PURE (the pack + decoder specs are passed in). Applies:
 *
 *  1. Brand CONFIRMATION from a matched tag-code decoder — the killer case: a
 *     legible Lululemon style number recovers the brand even when the brand tag
 *     is cut off. Decoder WINS over the AI on conflict (US-1712 contract).
 *  2. Size from a size-dot decoder — decoder wins on size when it fires.
 *  3. Conservative style fingerprint fill — only when the pack has exactly one
 *     style (unambiguous) and the AI produced none; never overwrites an
 *     observed/research style, and never guesses among multiple styles.
 *
 * Provenance is preserved: overridden fields carry source "decoder" or
 * "pack-fingerprint" so the UI/telemetry can distinguish grounded values from
 * model guesses. Returns the decoded input UNCHANGED when nothing applies.
 */
export function enrichExtractionWithBrandKnowledge(
  decoded: DecodedExtraction,
  pack: BrandKnowledgePack,
): { decoded: DecodedExtraction; diagnostics: BrandKnowledgeDiagnostics } {
  const suggestions = { ...decoded.suggestions };
  const attributes = { ...decoded.attributes };
  const conflicts: FieldConflict[] = [...decoded.conflicts];
  const overrides: BrandKnowledgeDiagnostics["overrides"] = [];

  // Decode any legible tag code the AI transcribed (style_code / mpn). DB specs
  // first; decodeTagCode falls back to the in-code defaults when empty.
  const specs = decoderSpecsFromPack(pack);
  const codes = ["style_code", "mpn"]
    .map((k) => attributes[k]?.values?.[0])
    .filter((v): v is string => !!v && v.trim() !== "");
  const decoderHits: DecodeResult[] = [];
  for (const code of codes) {
    const hit = decodeTagCode(pack.key, code, specs);
    if (hit) decoderHits.push(hit);
  }

  // Apply a decoder-derived value to a core suggestion (US-1714):
  //  - decoder WINS on conflict (US-1712), but when it overrides a DIFFERENT
  //    non-empty AI value we ALSO record a conflict so a human sees both — a
  //    silent override on a hot path is exactly what review exists to catch.
  //  - confidence composes as max(AI, decoder) then clamps to [0,1]; decoder
  //    confidences are intentionally < 1 (never fabricate certainty), so the
  //    clamp is the hard cap and grounding can only RAISE, never invent, 1.0.
  const applyDecoded = (field: "brand" | "size", value: string, conf: number) => {
    const cur = suggestions[field];
    const same = cur && cur.value.toLowerCase() === value.toLowerCase();
    if (same) return;
    if (cur && cur.value.trim() !== "") {
      // genuine disagreement — surface it (text_value = the tag-code decode).
      conflicts.push({ field, text_value: value, photo_value: cur.value });
    }
    suggestions[field] = {
      value,
      confidence: Math.min(1, Math.max(cur?.confidence ?? 0, conf)),
      source: "decoder",
    };
    overrides.push({ field, to: value, source: "decoder" });
  };

  // 1. Brand confirmation (decoder wins). A STYLE-CODE match confirms the brand
  //    (a bare size-dot number does not); the canonical spelling comes from the
  //    pack, not the decoder — so every brand is eBay-canonical without a
  //    per-brand display map in brand-decoders.
  const brandHit = decoderHits.find((h) => h.styleCode);
  if (brandHit) applyDecoded("brand", pack.brand, brandHit.confidence);

  // 2. Size from a size-dot decoder (decoder wins).
  const sizeHit = decoderHits.find((h) => h.size);
  if (sizeHit?.size) applyDecoded("size", sizeHit.size, sizeHit.confidence);

  // 3. Conservative style fingerprint fill (only when unambiguous).
  if (!suggestions.style && pack.styles.length === 1) {
    const only = pack.styles[0];
    suggestions.style = {
      value: only.styleName,
      confidence: 0.55,
      source: "pack-fingerprint",
    };
    overrides.push({
      field: "style",
      to: only.styleName,
      source: "pack-fingerprint",
    });
  }

  return {
    decoded: { ...decoded, suggestions, attributes, conflicts },
    diagnostics: {
      brand: pack.brand,
      packSource: pack.source,
      decoderHits,
      overrides,
    },
  };
}

/**
 * US-1529: research fields as attribute suggestions, so the identification
 * persists onto inventory_items.attributes (gap-fill, research provenance) and
 * downstream passes (AutoLister listing generation, aspects) can consume it
 * without re-running AI. Empty for null research — items without an
 * identification persist exactly what they do today.
 */
export function researchAttributeSuggestions(
  research: ResearchIdentification | null,
): Record<string, AttributeSuggestion> {
  if (!research) return {};
  const out: Record<string, AttributeSuggestion> = {};
  const put = (key: string, value: string | null) => {
    if (value === null || value.trim() === "") return;
    out[key] = {
      values: [value.trim()],
      confidence: research.confidence,
      source: RESEARCH_SOURCE,
    };
  };
  put("identified_style", research.identifiedStyle);
  put("product_line", research.productLine);
  put("fabric_technology", research.fabricTechnology);
  if (research.msrpEstimateCents !== null) {
    put("identification_msrp_cents", String(research.msrpEstimateCents));
  }
  return out;
}

/**
 * Maps decoded AttributeSuggestions to the persisted inventory_items.attributes
 * column form (canonical key -> scalar string | string[] for multi). US-821.
 */
export function attributesToColumn(
  attributes: Record<string, AttributeSuggestion>,
): CanonicalAttributeColumn {
  const out: CanonicalAttributeColumn = {};
  for (const [key, sug] of Object.entries(attributes)) {
    if (sug.values.length === 0) continue;
    out[key] = MULTI_ATTRIBUTE_KEYS.has(key) ? sug.values : sug.values[0]!;
  }
  return out;
}

// ─── eBay aspect-aware extraction (Week 2) ────────────────────────
//
// eBay's item-specifics differ per leaf category. Rather than asking Claude
// to free-form fill an open set of fields, we feed it the exact aspect
// spec for the chosen category — names, allowed values, cardinality — and
// build a tool schema where the model can only choose from real eBay
// values. That makes the output directly pasteable into a listing.

export type AspectCardinality = "SINGLE" | "MULTI";
export type AspectMode =
  | "FREE_TEXT"
  | "SELECTION_ONLY"
  | "SUGGESTED";

export interface EbayAspectSpec {
  name: string;
  required: boolean;
  cardinality: AspectCardinality;
  mode: AspectMode;
  // Only present when eBay's getItemAspectsForCategory returned aspectValues.
  allowedValues?: string[];
}

export interface AspectValueSuggestion {
  // Always an array so MULTI fits the same shape; SINGLE uses length 1.
  values: string[];
  confidence: number;
  source: string;
}

export interface AspectExtractionInput {
  text?: string;
  photos?: ExtractPhoto[];
  knownAspects?: Record<string, string[]>; // already-filled values
  aspects: EbayAspectSpec[];
  categoryPath?: string | null;
  // US-1529: the research-tier identification from the extract pass, so
  // Style/Model/Product Line/Fabric Type aspects fill from the identification
  // instead of being omitted. Absent → the prompt is byte-identical to today.
  research?: ResearchIdentification | null;
  // US-545: override the model for this refine pass. The listing flow routes
  // EASY apparel categories to the cheaper lightweight model (Haiku) here, since
  // their item-specifics are unambiguous enough to refine reliably without
  // Sonnet. Unset → the default routing (Sonnet with photos, Haiku without).
  modelOverride?: string;
}

export interface AspectExtractionResult {
  suggestions: Record<string, AspectValueSuggestion>;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const ASPECT_SYSTEM_PROMPT =
  `You extract eBay item-specifics for a single second-hand item.
You will be given a list of aspect specs (name, required-ness, cardinality, mode, and allowed values when eBay provides them) and photos and/or text of the item.

Hard rules:
- For SELECTION_ONLY aspects with allowed values: pick ONLY from the allowed list. If none of the listed values match what you see, OMIT the aspect entirely.
- For SUGGESTED aspects with allowed values: prefer a listed value; only return a free-text value if the item clearly matches something outside the list.
- For FREE_TEXT aspects: return a clean, listing-ready value (Title Case, no marketing language).
- For MULTI-cardinality aspects: return ALL applicable values as a JSON array. For SINGLE: return one value as a single-element array.
- Never guess. If the input does not clearly support an aspect, omit it.
- For every aspect you return, give a 0..1 confidence and a source string ('photo:tag', 'photo:front', 'text', etc.).
- The 'tag' / care-label photo is the highest-value input for Brand, Size, Material/Fabric, and Country of Manufacture — read it verbatim when present.
- Already-known aspect values are ground truth. Do not contradict them; only fill gaps.

You will call extract_ebay_aspects with a single object whose properties are the aspect names. Each property's value is { values: string[], confidence: number, source: string }.`;

// Anthropic's tool input_schema property keys must match
// `^[a-zA-Z0-9_.-]{1,64}$`. eBay aspect names regularly contain spaces and
// slashes ("Country/Region of Manufacture", "Size Type", "Material/Fabric"),
// which would be rejected with a 400. Sanitize to a safe key and keep a
// reverse map so the response can be read back under the original name.
function sanitizeKey(name: string): string {
  let safe = name
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (!safe) safe = "_";
  return safe;
}

interface BuiltAspectTool {
  tool: Anthropic.Tool;
  /** Sanitized property key → original aspect name (for reading the response). */
  keyToName: Map<string, string>;
}

function buildAspectTool(aspects: EbayAspectSpec[]): BuiltAspectTool {
  // Build one property per aspect. The shared item shape is values+confidence+source.
  const properties: Record<string, unknown> = {};
  const keyToName = new Map<string, string>();
  const usedKeys = new Set<string>();
  for (const a of aspects) {
    // Disambiguate collisions (rare but possible — "Color" and "Color " both
    // sanitize to "Color"). Suffix _2, _3, … as needed.
    let key = sanitizeKey(a.name);
    if (usedKeys.has(key)) {
      let n = 2;
      while (usedKeys.has(`${key}_${n}`)) n++;
      key = `${key}_${n}`;
    }
    usedKeys.add(key);
    keyToName.set(key, a.name);

    const valuesSchema: Record<string, unknown> = {
      type: "array",
      items: { type: "string" },
      description: a.required ? "(REQUIRED)" : undefined,
    };
    // Constrain to eBay's allowed set when one exists and the aspect isn't
    // pure free-text. SUGGESTED aspects can technically accept new values,
    // but we lean toward enums for cleanliness; the system prompt covers
    // the rare "neither matches" escape hatch.
    if (a.allowedValues && a.allowedValues.length > 0 && a.mode !== "FREE_TEXT") {
      (valuesSchema.items as Record<string, unknown>) = {
        type: "string",
        enum: a.allowedValues,
      };
    }
    if (a.cardinality === "SINGLE") {
      valuesSchema.maxItems = 1;
    }
    properties[key] = {
      type: "object",
      // Always reference the ORIGINAL aspect name in the description so the
      // model knows what this slot represents, even though the key was
      // sanitized for Anthropic's pattern.
      description: `eBay aspect "${a.name}" — ${a.cardinality}, ${a.mode}${
        a.required ? ", required" : ""
      }`,
      properties: {
        values: valuesSchema,
        confidence: { type: "number" },
        source: { type: "string" },
      },
      required: ["values", "confidence"],
    };
  }
  return {
    tool: {
      name: "extract_ebay_aspects",
      description:
        "Return values for each eBay item-specific you can determine from the inputs. Omit aspects you cannot support.",
      input_schema: {
        type: "object",
        properties,
      },
    },
    keyToName,
  };
}

/**
 * US-1529: human-readable identification block for the aspects prompt.
 * Returns "" for null/style-less research so the prompt stays byte-identical
 * when no identification exists (regression guarantee).
 */
export function researchAspectContext(
  research: ResearchIdentification | null | undefined,
): string {
  if (!research?.identifiedStyle) return "";
  const parts = [`style: ${research.identifiedStyle}`];
  if (research.productLine) parts.push(`product line: ${research.productLine}`);
  if (research.fabricTechnology) {
    parts.push(`fabric technology: ${research.fabricTechnology}`);
  }
  return (
    `IDENTIFIED PRODUCT (research-tier identification from the extract pass — ` +
    `use for Style/Model/Product Line/Fabric Type aspects when the category ` +
    `offers them; do not fabricate beyond it):\n${parts.join("\n")}`
  );
}

export function buildAspectUserPrompt(input: AspectExtractionInput): string {
  const lines: string[] = [];
  if (input.categoryPath) {
    lines.push(`EBAY CATEGORY: ${input.categoryPath}`);
  }
  const researchBlock = researchAspectContext(input.research);
  if (researchBlock) lines.push(researchBlock);
  if (input.text && input.text.trim()) {
    lines.push(`ITEM DESCRIPTION / NOTES:\n${input.text.trim()}`);
  }
  const known = input.knownAspects ?? {};
  const knownEntries = Object.entries(known).filter(([, v]) => v.length > 0);
  if (knownEntries.length > 0) {
    lines.push(
      `ALREADY-KNOWN ASPECT VALUES (ground truth — do not contradict):\n` +
        JSON.stringify(Object.fromEntries(knownEntries), null, 2)
    );
  }
  // Compact aspect-spec brief — the tool schema already encodes the
  // constraints, but a human-readable summary helps the model reason
  // about which aspects are highest-priority.
  const required = input.aspects.filter((a) => a.required).map((a) => a.name);
  if (required.length > 0) {
    lines.push(`REQUIRED ASPECTS: ${required.join(", ")}`);
  }
  lines.push(
    "Call extract_ebay_aspects with only the aspects you can confidently determine from the photos and text."
  );
  return lines.join("\n\n");
}

export async function extractEbayAspects(
  input: AspectExtractionInput
): Promise<AspectExtractionResult> {
  enterAiFeature("catalog_extract"); // US-894 spend attribution
  if (input.aspects.length === 0) {
    return {
      suggestions: {},
      model: getHaikuModel(),
      tokensIn: 0,
      tokensOut: 0,
    };
  }
  const photos = input.photos ?? [];
  const hasPhotos = photos.length > 0;
  // Aspect extraction without photos is rarely useful — most aspects can
  // only be filled from visual evidence — but we still run the model on
  // text alone if that's all we have.
  // US-545: an explicit override (easy-category routing) wins over the default.
  const model = input.modelOverride?.trim() ||
    (hasPhotos ? getSonnetModel() : getHaikuModel());
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  const content: Anthropic.ContentBlockParam[] = await buildPhotoContent(photos);
  content.push({ type: "text", text: buildAspectUserPrompt(input) });

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? {
        type: "text",
        text: ASPECT_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      }
    : { type: "text", text: ASPECT_SYSTEM_PROMPT };

  const { tool, keyToName } = buildAspectTool(input.aspects);
  // Reverse map: original name → sanitized key, so each aspect can be looked
  // up from its original name in the response object.
  const nameToKey = new Map<string, string>();
  for (const [k, n] of keyToName) nameToKey.set(n, k);

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    ...(temperature !== undefined ? { temperature } : {}),
    system: [systemBlock],
    tools: [tool],
    tool_choice: { type: "tool", name: "extract_ebay_aspects" },
    messages: [{ role: "user", content }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return structured aspect values");
  }

  const raw = toolUse.input as Record<string, unknown>;
  const defaultSource = hasPhotos ? "photo" : "text";
  const allowedSets = new Map<string, Set<string>>();
  for (const a of input.aspects) {
    if (a.allowedValues && a.allowedValues.length > 0 && a.mode !== "FREE_TEXT") {
      allowedSets.set(a.name, new Set(a.allowedValues));
    }
  }

  const suggestions: Record<string, AspectValueSuggestion> = {};
  for (const a of input.aspects) {
    // Look up the sanitized property key for this aspect; fall back to the
    // raw name for backwards compatibility with any caller that hand-built a
    // raw map without going through buildAspectTool (none currently).
    const key = nameToKey.get(a.name) ?? a.name;
    const field = raw[key];
    if (!field || typeof field !== "object") continue;
    const f = field as {
      values?: unknown;
      confidence?: unknown;
      source?: unknown;
    };
    if (!Array.isArray(f.values) || f.values.length === 0) continue;

    let values = f.values
      .map((v) => (typeof v === "string" ? v.trim() : String(v).trim()))
      .filter((v) => v.length > 0);
    // Final-pass safety net: drop any model-emitted value that isn't in the
    // allowed set when one was provided. The enum constraint should already
    // handle this, but better to silently drop than to surface garbage.
    const allowed = allowedSets.get(a.name);
    if (allowed) {
      values = values.filter((v) => allowed.has(v));
    }
    if (a.cardinality === "SINGLE") values = values.slice(0, 1);
    if (values.length === 0) continue;

    let confidence = Number(f.confidence);
    if (Number.isNaN(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));
    const source =
      typeof f.source === "string" && f.source.trim() !== ""
        ? f.source
        : defaultSource;

    suggestions[a.name] = { values, confidence, source };
  }

  return {
    suggestions,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

// ─── Listing copy generation (US-165) ──────────────────────────────

export interface ListingCopyInput {
  attributes: Record<string, unknown>;
  conditionNotes?: string;
  measurements?: Record<string, unknown>;
  photos?: ExtractPhoto[];
}

export interface ListingCopyResult {
  title: string;
  description: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const LISTING_SYSTEM_PROMPT =
  `You are a resale listing copywriter for FlipDesk. Given an item's known
attributes (and optionally photos), write a polished, search-friendly listing.

Rules:
- title: lead with brand, then item type, then key attributes (size, color,
  material). Keep it under 80 characters — marketplace title limits.
- description: a short opening line, then attribute bullet points, then a clear
  condition statement, then measurements if provided.
- CONDITION HONESTY IS CRITICAL: only state condition facts that are present in
  the supplied condition notes or that you can plainly see in the photos. Never
  invent or upgrade condition claims — over-promising condition causes returns.
- Do not fabricate attributes that were not supplied.`;

const LISTING_TOOL: Anthropic.Tool = {
  name: "write_listing_copy",
  description: "Return a marketplace-ready listing title and description.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Search-friendly title, <80 chars" },
      description: {
        type: "string",
        description: "Structured buyer-facing description",
      },
    },
    required: ["title", "description"],
  },
};

/**
 * Generates a listing title + description. Routes to Sonnet when photos are
 * present (so copy can reference visible condition), Haiku otherwise.
 */
export async function generateListingCopy(
  input: ListingCopyInput
): Promise<ListingCopyResult> {
  enterAiFeature("catalog_extract"); // US-894 spend attribution
  const photos = input.photos ?? [];
  const hasPhotos = photos.length > 0;
  const model = hasPhotos ? getSonnetModel() : getHaikuModel();
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  const content: Anthropic.ContentBlockParam[] = await buildPhotoContent(photos);

  const lines: string[] = [
    "ITEM ATTRIBUTES:",
    JSON.stringify(input.attributes, null, 2),
  ];
  if (input.conditionNotes && input.conditionNotes.trim()) {
    lines.push(`CONDITION NOTES:\n${input.conditionNotes.trim()}`);
  }
  if (input.measurements && Object.keys(input.measurements).length > 0) {
    lines.push(`MEASUREMENTS:\n${JSON.stringify(input.measurements, null, 2)}`);
  }
  lines.push("Call write_listing_copy with the finished listing.");
  content.push({ type: "text", text: lines.join("\n\n") });

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? { type: "text", text: LISTING_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
    : { type: "text", text: LISTING_SYSTEM_PROMPT };

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    ...(temperature !== undefined ? { temperature } : {}),
    system: [systemBlock],
    tools: [LISTING_TOOL],
    tool_choice: { type: "tool", name: "write_listing_copy" },
    messages: [{ role: "user", content }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return listing copy");
  }
  const raw = toolUse.input as { title?: unknown; description?: unknown };
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const description =
    typeof raw.description === "string" ? raw.description.trim() : "";
  if (!title && !description) {
    throw new Error("AI returned empty listing copy");
  }

  return {
    title,
    description,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

// ─── Inline AI rewrite (US-552) ─────────────────────────────────────
//
// One-shot rewrites of an already-drafted title or description, driven by a
// fixed menu of reseller actions. Unlike generateListingCopy these operate on
// the seller's current text (punch it up, shorten, add keywords, tighten),
// except the photo regenerate which re-derives the description from scratch.

export const REWRITE_ACTIONS = [
  "title_seo",
  "title_shorten",
  "title_keywords",
  "description_tighten",
  "description_regen",
] as const;

export type RewriteAction = (typeof REWRITE_ACTIONS)[number];

export function isRewriteAction(v: unknown): v is RewriteAction {
  return (
    typeof v === "string" &&
    (REWRITE_ACTIONS as readonly string[]).includes(v)
  );
}

// Which form field each action rewrites.
export function rewriteField(action: RewriteAction): "title" | "description" {
  return action.startsWith("title_") ? "title" : "description";
}

// Only the photo-regenerate action needs to look at the images; the rest
// transform existing text, so they route to the cheap lightweight model.
function rewriteUsesPhotos(action: RewriteAction): boolean {
  return action === "description_regen";
}

const TITLE_CHAR_LIMIT = 80;

const REWRITE_INSTRUCTIONS: Record<RewriteAction, string> = {
  title_seo:
    `Rewrite this eBay listing TITLE to maximize search visibility. Front-load the highest-value search keywords (brand, item type, then key attributes like size/color/material), drop filler words, and keep it readable. Use ONLY facts supported by the title and known attributes — never invent attributes. The result MUST be ${TITLE_CHAR_LIMIT} characters or fewer.`,
  title_shorten:
    `Shorten this eBay listing TITLE to ${TITLE_CHAR_LIMIT} characters or fewer while preserving the most important search keywords (brand, item type, size). Drop the least valuable words first. The result MUST be ${TITLE_CHAR_LIMIT} characters or fewer.`,
  title_keywords:
    `Rewrite this eBay listing TITLE to add high-value buyer search keywords drawn from the known attributes (e.g. style, fit, era, colorway, material) that buyers actually search. Do NOT invent attributes the item does not have. The result MUST be ${TITLE_CHAR_LIMIT} characters or fewer.`,
  description_tighten:
    `Tighten and polish this listing DESCRIPTION: cut redundancy, improve flow and readability, and keep every factual claim and the honest condition statement intact. Do NOT add attributes the item does not have and do NOT upgrade any condition claim.`,
  description_regen:
    `Write a fresh buyer-facing listing DESCRIPTION from the photos and known attributes: a short opening line, the key attributes (brand, item type, size, color, material), then an HONEST condition statement. Use ONLY what the photos and attributes support — never invent attributes or upgrade condition (over-promising condition causes returns).`,
};

export interface RewriteInput {
  action: RewriteAction;
  title?: string;
  description?: string;
  attributes?: Record<string, unknown>;
  conditionNotes?: string;
  photos?: ExtractPhoto[];
}

export interface RewriteResult {
  field: "title" | "description";
  value: string;
  confidence: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const REWRITE_SYSTEM_PROMPT =
  `You are a resale listing copywriter for FlipDesk. You revise a single field of
an existing eBay listing on request, returning ONLY the rewritten field.

Rules:
- Follow the requested action exactly.
- CONDITION HONESTY IS CRITICAL: never invent attributes and never upgrade or
  soften a condition claim — over-promising condition causes returns.
- Only use facts present in the supplied text, attributes, or photos.
- For TITLE rewrites the result must be 80 characters or fewer.
- Return a calibrated 0..1 confidence for your rewrite.`;

const REWRITE_TOOL: Anthropic.Tool = {
  name: "rewrite_listing_field",
  description: "Return the single rewritten listing field.",
  input_schema: {
    type: "object",
    properties: {
      value: { type: "string", description: "The rewritten field text" },
      confidence: {
        type: "number",
        description: "0..1 calibrated confidence in the rewrite",
      },
    },
    required: ["value"],
  },
};

/**
 * Rewrites a listing title or description per a fixed reseller action. Routes
 * to Sonnet only for the photo-driven regenerate; all text transforms use the
 * cheap lightweight model. Throws on transport/parse errors so the caller can
 * return a 502 without charging a log row.
 */
export async function rewriteListingCopy(
  input: RewriteInput
): Promise<RewriteResult> {
  enterAiFeature("catalog_extract"); // US-894 spend attribution
  const field = rewriteField(input.action);
  const photos = rewriteUsesPhotos(input.action) ? input.photos ?? [] : [];
  const hasPhotos = photos.length > 0;
  const model = hasPhotos ? getSonnetModel() : getHaikuModel();
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  const content: Anthropic.ContentBlockParam[] = await buildPhotoContent(photos);

  const lines: string[] = [`ACTION:\n${REWRITE_INSTRUCTIONS[input.action]}`];
  if (input.title && input.title.trim()) {
    lines.push(`CURRENT TITLE:\n${input.title.trim()}`);
  }
  if (input.description && input.description.trim()) {
    lines.push(`CURRENT DESCRIPTION:\n${input.description.trim()}`);
  }
  if (input.attributes && Object.keys(input.attributes).length > 0) {
    lines.push(
      `KNOWN ATTRIBUTES (do not contradict):\n` +
        JSON.stringify(input.attributes, null, 2)
    );
  }
  if (input.conditionNotes && input.conditionNotes.trim()) {
    lines.push(`CONDITION NOTES:\n${input.conditionNotes.trim()}`);
  }
  lines.push(
    `Call rewrite_listing_field with the rewritten ${field.toUpperCase()} only.`
  );
  content.push({ type: "text", text: lines.join("\n\n") });

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? {
        type: "text",
        text: REWRITE_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      }
    : { type: "text", text: REWRITE_SYSTEM_PROMPT };

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    ...(temperature !== undefined ? { temperature } : {}),
    system: [systemBlock],
    tools: [REWRITE_TOOL],
    tool_choice: { type: "tool", name: "rewrite_listing_field" },
    messages: [{ role: "user", content }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return a rewritten field");
  }
  const raw = toolUse.input as { value?: unknown; confidence?: unknown };
  let value = typeof raw.value === "string" ? raw.value.trim() : "";
  if (!value) {
    throw new Error("AI returned an empty rewrite");
  }
  // Defensive title cap — the prompt asks for <=80 but the user-facing
  // composer hard-limits at 80, so never hand back something longer.
  if (field === "title" && value.length > TITLE_CHAR_LIMIT) {
    value = value.slice(0, TITLE_CHAR_LIMIT).trimEnd();
  }
  let confidence = Number(raw.confidence);
  if (Number.isNaN(confidence)) confidence = 0.8;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    field,
    value,
    confidence,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

// ── US-952: Snap-to-Value → certified-grade garment classifier ──────────────
//
// A tiny single-photo classifier that names the garment_type + garment_category
// so the certified-grade form (new-submission) can prefill the garment-info
// step when a seller upgrades a free Snap-to-Value. Deliberately separate from
// extractItemFields (heavy, full catalog extraction): this is one small,
// enum-constrained tool call. Best-effort — callers should treat any
// thrown/null result as "no detection" and never block the snap on it.

const CLASSIFY_GARMENT_TOOL: Anthropic.Tool = {
  name: "classify_garment",
  description:
    "Report the garment type and clothing category visible in the photo.",
  input_schema: {
    type: "object",
    properties: {
      garment_type: {
        type: "string",
        enum: [...GARMENT_TYPES],
        description:
          "Broad garment type. Omit if it is not a wearable garment or you are unsure.",
      },
      garment_category: {
        type: "string",
        enum: [...GARMENT_CATEGORIES],
        description:
          "Specific clothing category, consistent with garment_type. Omit if unsure.",
      },
    },
    required: [],
  },
};

export interface GarmentClassification {
  garmentType: string | null;
  garmentCategory: string | null;
}

// Build an image content block from a data: URI (the Snap photo). Returns null
// for anything that isn't a base64 image data URI we can hand to the model.
function dataUriToImageBlock(dataUri: string): Anthropic.ContentBlockParam | null {
  const m = dataUri.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (!m) return null;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: m[1] as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
      data: m[2],
    },
  };
}

/**
 * Classify a single garment photo into the GradeThread garment_type +
 * garment_category enums. Returns null when nothing usable is detected (or the
 * data URI can't be parsed). Validates the model's output against the enums so a
 * stray value can never reach the form.
 */
export async function classifyGarment(
  dataUri: string,
): Promise<GarmentClassification | null> {
  const imageBlock = dataUriToImageBlock(dataUri);
  if (!imageBlock) return null;

  const client = getAnthropicClient();
  const temperature = getAiTemperature();
  const response = await client.messages.create({
    model: getSonnetModel(), // vision-capable default model
    max_tokens: 200,
    ...(temperature !== undefined ? { temperature } : {}),
    tools: [CLASSIFY_GARMENT_TOOL],
    tool_choice: { type: "tool", name: "classify_garment" },
    messages: [
      {
        role: "user",
        content: [
          imageBlock,
          {
            type: "text",
            text:
              "Classify this garment's type and category using only the allowed enum values. Omit a field if you cannot tell.",
          },
        ],
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;
  const raw = toolUse.input as {
    garment_type?: unknown;
    garment_category?: unknown;
  };
  const garmentType =
    typeof raw.garment_type === "string" &&
    (GARMENT_TYPES as readonly string[]).includes(raw.garment_type)
      ? raw.garment_type
      : null;
  const garmentCategory =
    typeof raw.garment_category === "string" &&
    (GARMENT_CATEGORIES as readonly string[]).includes(raw.garment_category)
      ? raw.garment_category
      : null;
  if (!garmentType && !garmentCategory) return null;
  return { garmentType, garmentCategory };
}

// ── US-1168: AI negotiation assist + counter-offer validation ───────────────
//
// Two parts: a PURE validator (no LLM) that the endpoint and tests share, and
// an LLM drafter that writes a buyer-facing counter/reply. The validator is the
// guardrail — it never lets the suggested counter fall to/below the buyer's
// offer or below the seller's cost — so the AI draft is anchored to a sane
// number rather than free-styling a price.

export type NegotiationMode = "counter" | "reply";

export interface CounterOfferInputs {
  /** The buyer's current best offer, in dollars. */
  offerPrice: number;
  /** The listing's current asking price, in dollars (null when unknown). */
  askingPrice: number | null;
  /** What the seller paid for the item, in dollars (null when unknown). */
  costBasis: number | null;
}

export interface CounterOfferValidation {
  /** A safe suggested counter price in dollars, or null when we can't compute one. */
  suggestedCounter: number | null;
  belowCost: boolean; // the buyer's offer is at/under the seller's cost
  atOrBelowOffer: boolean; // a proposed counter would be <= the offer (pointless)
  aboveAsking: boolean; // a proposed counter would exceed the asking price
  /** Human-readable cautions for the composer to surface inline. */
  warnings: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure counter-offer guardrail. Given the buyer's offer, the asking price and
 * the seller's cost, returns a suggested counter (the midpoint between offer
 * and ask, floored so it never lands at/below the offer or below cost) plus the
 * out-of-range flags + warnings the UI surfaces. No I/O, no LLM — unit-tested.
 *
 * `proposedCounter` (optional) lets the caller validate a price the seller
 * actually typed; when omitted only the suggested counter is computed.
 */
export function validateCounterOffer(
  inputs: CounterOfferInputs,
  proposedCounter?: number | null,
): CounterOfferValidation {
  const { offerPrice, askingPrice, costBasis } = inputs;
  const warnings: string[] = [];

  const belowCost =
    costBasis != null && costBasis > 0 && offerPrice <= costBasis;
  if (belowCost) {
    warnings.push(
      "The buyer's offer is at or below your cost — countering near it loses money.",
    );
  }

  // Suggested counter: meet in the middle between offer and ask. With no ask,
  // nudge 10% above the offer. Always keep it strictly above the offer and at
  // or above cost so we never suggest a money-losing counter.
  let suggestedCounter: number | null = null;
  if (Number.isFinite(offerPrice) && offerPrice > 0) {
    const base =
      askingPrice != null && askingPrice > offerPrice
        ? (offerPrice + askingPrice) / 2
        : offerPrice * 1.1;
    let candidate = Math.max(base, offerPrice + 0.01);
    if (costBasis != null && costBasis > candidate) candidate = costBasis;
    if (askingPrice != null && candidate > askingPrice) candidate = askingPrice;
    suggestedCounter = round2(candidate);
  }

  let atOrBelowOffer = false;
  let aboveAsking = false;
  if (proposedCounter != null && Number.isFinite(proposedCounter)) {
    atOrBelowOffer = proposedCounter <= offerPrice;
    if (atOrBelowOffer) {
      warnings.push(
        "Your counter is at or below the buyer's offer — just accept the offer instead.",
      );
    }
    aboveAsking = askingPrice != null && proposedCounter > askingPrice;
    if (aboveAsking) {
      warnings.push(
        "Your counter is above your asking price, which usually pushes buyers away.",
      );
    }
    if (costBasis != null && costBasis > 0 && proposedCounter < costBasis) {
      warnings.push("Your counter is below your cost — you'd lose money on the sale.");
    }
  }

  return { suggestedCounter, belowCost, atOrBelowOffer, aboveAsking, warnings };
}

export interface NegotiationDraftInput {
  mode: NegotiationMode;
  itemTitle: string | null;
  offerPrice: number | null;
  currency: string;
  /** The buyer's message to reply to (reply mode) or any note on the offer. */
  buyerMessage: string | null;
  /** The validator's suggested counter, threaded in so the draft cites it. */
  suggestedCounter: number | null;
}

export interface NegotiationDraftResult {
  message: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const NEGOTIATION_SYSTEM_PROMPT =
  `You are a resale-marketplace negotiation assistant for FlipDesk sellers
responding to eBay best offers and buyer messages. Draft a SHORT, warm,
professional reply the seller can send as-is.

Rules:
- Keep it to 2-4 sentences, friendly but businesslike. No greeting boilerplate
  beyond a brief "Hi" / "Thanks".
- COUNTER mode: politely propose the supplied suggested counter price. State the
  number plainly. Never propose a price at or below the buyer's offer.
- REPLY mode: answer the buyer's message helpfully without committing to a price
  unless the message asks for one.
- Never invent facts about the item, shipping, or condition you weren't given.
- No markdown, no signature line, no placeholders like [your name].`;

const NEGOTIATION_TOOL: Anthropic.Tool = {
  name: "write_negotiation_reply",
  description: "Return a ready-to-send buyer reply for a best offer or message.",
  input_schema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "The buyer-facing reply, 2-4 sentences, no signature.",
      },
    },
    required: ["message"],
  },
};

/**
 * Drafts a buyer-facing counter or reply with the cheap lightweight model
 * (text-only). Throws on transport/parse errors so the route returns a 502
 * without logging a billable row.
 */
export async function generateNegotiationReply(
  input: NegotiationDraftInput,
): Promise<NegotiationDraftResult> {
  enterAiFeature("catalog_extract"); // US-894 spend attribution (AI-action bucket)
  const model = getHaikuModel();
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  const lines: string[] = [`MODE: ${input.mode.toUpperCase()}`];
  if (input.itemTitle) lines.push(`ITEM: ${input.itemTitle}`);
  if (input.offerPrice != null) {
    lines.push(`BUYER OFFER: ${input.currency} ${round2(input.offerPrice)}`);
  }
  if (input.mode === "counter" && input.suggestedCounter != null) {
    lines.push(
      `SUGGESTED COUNTER (propose this price): ${input.currency} ${round2(
        input.suggestedCounter,
      )}`,
    );
  }
  if (input.buyerMessage && input.buyerMessage.trim()) {
    lines.push(`BUYER MESSAGE:\n${input.buyerMessage.trim()}`);
  }
  lines.push("Call write_negotiation_reply with the finished reply.");

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? {
        type: "text",
        text: NEGOTIATION_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      }
    : { type: "text", text: NEGOTIATION_SYSTEM_PROMPT };

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    ...(temperature !== undefined ? { temperature } : {}),
    system: [systemBlock],
    tools: [NEGOTIATION_TOOL],
    tool_choice: { type: "tool", name: "write_negotiation_reply" },
    messages: [{ role: "user", content: [{ type: "text", text: lines.join("\n\n") }] }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return a negotiation reply");
  }
  const raw = toolUse.input as { message?: unknown };
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) throw new Error("AI returned an empty negotiation reply");

  return {
    message,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

// ── US-1169: AI analytics narrative ─────────────────────────────────────────
//
// The iOS/web client computes its period rollups locally (PeriodPnL, sell-
// through, grading ROI) and posts the NUMBERS here; this endpoint turns them
// into a plain-language "what this means / what to do next" without re-querying
// the DB. deriveAnalyticsMetrics is the pure normalizer the route + tests share.

export interface AnalyticsRollupInput {
  periodLabel: string;
  grossRevenue: number;
  fees: number;
  cogs: number;
  unitsSold: number;
  /** Optional 0..1 sell-through rate over the period. */
  sellThroughRate?: number | null;
  /** Optional average net-profit lift from grading, in dollars. */
  gradingRoiLift?: number | null;
  /** Optional best-performing brand by net profit. */
  topBrand?: string | null;
  currency?: string | null;
}

export interface AnalyticsDerived {
  periodLabel: string;
  currency: string;
  grossRevenue: number;
  fees: number;
  cogs: number;
  netProfit: number; // grossRevenue - fees - cogs
  unitsSold: number;
  /** Net margin as a 0..1 fraction of gross revenue (0 when no revenue). */
  margin: number;
  /** ROI on cost (netProfit / cogs) as a fraction, null when cogs is 0. */
  roi: number | null;
  sellThroughRate: number | null;
  gradingRoiLift: number | null;
  topBrand: string | null;
}

/**
 * Pure normalizer: coerces a posted rollup into finite numbers and derives net
 * profit, margin and ROI. No I/O — unit-tested. Negative/NaN inputs are floored
 * to 0 except the derived net profit, which may legitimately be negative.
 */
export function deriveAnalyticsMetrics(
  input: AnalyticsRollupInput,
): AnalyticsDerived {
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const grossRevenue = Math.max(0, num(input.grossRevenue));
  const fees = Math.max(0, num(input.fees));
  const cogs = Math.max(0, num(input.cogs));
  const unitsSold = Math.max(0, Math.round(num(input.unitsSold)));
  const netProfit = round2(grossRevenue - fees - cogs);
  const margin = grossRevenue > 0 ? round2(netProfit / grossRevenue) : 0;
  const roi = cogs > 0 ? round2(netProfit / cogs) : null;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  return {
    periodLabel: input.periodLabel,
    currency: input.currency && input.currency.trim() ? input.currency : "USD",
    grossRevenue: round2(grossRevenue),
    fees: round2(fees),
    cogs: round2(cogs),
    netProfit,
    unitsSold,
    margin,
    roi,
    sellThroughRate:
      input.sellThroughRate != null && Number.isFinite(Number(input.sellThroughRate))
        ? clamp01(Number(input.sellThroughRate))
        : null,
    gradingRoiLift:
      input.gradingRoiLift != null && Number.isFinite(Number(input.gradingRoiLift))
        ? round2(Number(input.gradingRoiLift))
        : null,
    topBrand: input.topBrand && input.topBrand.trim() ? input.topBrand : null,
  };
}

export interface AnalyticsNarrativeResult {
  summary: string;
  highlights: string[];
  actions: string[];
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const ANALYTICS_SYSTEM_PROMPT =
  `You are a reseller business analyst for FlipDesk. Given a seller's period
financials, write a brief, encouraging-but-honest narrative of how the period
went and concrete next steps.

Rules:
- summary: 2-3 sentences naming the standout trend (profit, margin, ROI, or
  sell-through). Use the supplied numbers; never invent metrics you weren't given.
- highlights: 2-4 short bullet phrases of what stood out (good or bad).
- actions: 2-3 short, concrete next steps a reseller can act on this week.
- Plain language, no jargon, no markdown, no currency symbols you weren't given.
- Be honest about a loss or thin margin — do not spin a negative net profit as good.`;

const ANALYTICS_TOOL: Anthropic.Tool = {
  name: "write_analytics_narrative",
  description: "Return a plain-language summary, highlights and next actions.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "2-3 sentence period summary" },
      highlights: {
        type: "array",
        items: { type: "string" },
        description: "2-4 short bullet phrases of what stood out",
      },
      actions: {
        type: "array",
        items: { type: "string" },
        description: "2-3 short concrete next steps",
      },
    },
    required: ["summary", "highlights", "actions"],
  },
};

/**
 * Narrates a derived analytics rollup. Text-only, cheap lightweight model.
 * Throws on transport/parse errors so the route returns a 502 without logging.
 */
export async function generateAnalyticsNarrative(
  m: AnalyticsDerived,
): Promise<AnalyticsNarrativeResult> {
  enterAiFeature("catalog_extract"); // US-894 spend attribution (AI-action bucket)
  const model = getHaikuModel();
  const client = getAnthropicClient();
  const temperature = getAiTemperature();

  const facts: Record<string, unknown> = {
    period: m.periodLabel,
    currency: m.currency,
    gross_revenue: m.grossRevenue,
    fees: m.fees,
    cost_of_goods_sold: m.cogs,
    net_profit: m.netProfit,
    units_sold: m.unitsSold,
    net_margin_pct: Math.round(m.margin * 100),
  };
  if (m.roi != null) facts.roi_pct = Math.round(m.roi * 100);
  if (m.sellThroughRate != null) {
    facts.sell_through_pct = Math.round(m.sellThroughRate * 100);
  }
  if (m.gradingRoiLift != null) facts.grading_net_profit_lift = m.gradingRoiLift;
  if (m.topBrand) facts.top_brand_by_profit = m.topBrand;

  const text =
    `PERIOD FINANCIALS:\n${JSON.stringify(facts, null, 2)}\n\n` +
    "Call write_analytics_narrative with the summary, highlights and actions.";

  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? {
        type: "text",
        text: ANALYTICS_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      }
    : { type: "text", text: ANALYTICS_SYSTEM_PROMPT };

  const response = await client.messages.create({
    model,
    max_tokens: 700,
    ...(temperature !== undefined ? { temperature } : {}),
    system: [systemBlock],
    tools: [ANALYTICS_TOOL],
    tool_choice: { type: "tool", name: "write_analytics_narrative" },
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("AI did not return an analytics narrative");
  }
  const raw = toolUse.input as {
    summary?: unknown;
    highlights?: unknown;
    actions?: unknown;
  };
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  const toStrings = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
         .map((x) => x.trim())
      : [];
  const highlights = toStrings(raw.highlights);
  const actions = toStrings(raw.actions);
  if (!summary) throw new Error("AI returned an empty analytics narrative");

  return {
    summary,
    highlights,
    actions,
    model,
    tokensIn:
      response.usage.input_tokens +
      (response.usage.cache_read_input_tokens ?? 0) +
      (response.usage.cache_creation_input_tokens ?? 0),
    tokensOut: response.usage.output_tokens,
  };
}

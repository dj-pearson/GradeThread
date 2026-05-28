import Anthropic from "@anthropic-ai/sdk";
import {
  getAiTemperature,
  getAnthropicClient,
  getDefaultModel,
  getGradingCompositeModel,
  isCachingEnabled,
} from "./ai-config.ts";
import { supabaseAdmin } from "./supabase.ts";

// Version names for the in-code default prompts. These MUST match the seeded
// rows in ai_prompt_versions (migration 00050) so the accuracy loop can
// attribute grades to a version and write the score back. Bump the suffix
// whenever the prompt text below changes in a way that could move grades.
export const PER_IMAGE_PROMPT_VERSION = "per_image_v2";
export const COMPOSITE_PROMPT_VERSION = "composite_v2";

// --- Types ---

export interface PerImageAnalysis {
  image_type: string;
  detected_issues: DetectedIssue[];
  condition_signals: ConditionSignal[];
  // Intentional design features observed in this image (factory distressing,
  // raw hems, acid wash, etc.). These are recorded as STYLE, not damage, and
  // must not reduce estimated_scores.
  style_attributes: StyleAttribute[];
  estimated_scores: FactorScores;
}

export interface DetectedIssue {
  issue: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  // True when the "issue" is an intentional manufactured design feature
  // (distressing, deliberate fraying, etc.) rather than genuine wear/damage.
  // Intentional issues are reported for transparency but do NOT lower scores.
  is_intentional: boolean;
}

export interface StyleAttribute {
  attribute: string;
  location: string;
}

export interface ConditionSignal {
  signal: string;
  sentiment: "positive" | "neutral" | "negative";
}

export interface FactorScores {
  fabric_condition: number;
  structural_integrity: number;
  cosmetic_appearance: number;
  functional_elements: number;
  odor_cleanliness: number;
}

export interface GarmentInfo {
  garment_type: string;
  garment_category: string;
  brand: string | null;
  title: string;
  description: string | null;
  // Seller-declared intentional design features (hint only — the grader
  // verifies visually and may override). Empty when none declared.
  style_attributes?: string[];
}

export interface DetectedStyleAttribute {
  attribute: string;
  location: string;
  // 0.0–1.0 — how sure the AI is this is intentional design vs. genuine damage.
  confidence: number;
}

export interface DefectFound {
  defect: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  impact_on_grade: string;
}

export interface ImageValidity {
  is_clothing: boolean;
  reason: string;
}

export interface CompositeGradeResult {
  overall_score: number;
  grade_tier: string;
  factor_scores: FactorScores;
  ai_summary: string;
  defects_found: DefectFound[];
  // Intentional design features the AI judged present. Surfaced on the
  // certificate so buyers see distressing was assessed, not missed. Never
  // lowers the grade.
  style_attributes: DetectedStyleAttribute[];
  confidence_score: number;
  needs_human_review: boolean;
  image_validity: ImageValidity;
  prompt_version: string;
  // Actual model that produced the composite grade. Recorded so the
  // accuracy tracker can attribute error rates per model, not just per
  // prompt version.
  model: string;
}

// --- Constants ---

const IMAGE_TYPE_CONTEXT: Record<string, string> = {
  front:
    "This is the FRONT VIEW of the garment. Focus on overall appearance, fabric condition visible from the front, stains, pilling, fading, print condition, and general wear patterns.",
  back:
    "This is the BACK VIEW of the garment. Focus on overall appearance from behind, seat wear (for bottoms), back panel condition, any stains or damage not visible from front.",
  label:
    "This is the LABEL/TAG of the garment. Focus on brand identification, care instructions legibility, label condition (fading, fraying, removal), size tag presence, and material composition.",
  detail:
    "This is a DETAIL/CLOSE-UP shot of the garment. Focus on stitching quality, seam integrity, button/zipper condition, hardware condition, and any specific areas of wear or damage shown.",
  defect:
    "This is a DEFECT/DAMAGE close-up. Focus on identifying and assessing the specific defect shown: its type (tear, stain, hole, missing button, broken zipper, etc.), severity, repairability, and impact on overall garment condition.",
};

const GARMENT_TYPE_CRITERIA: Record<string, string> = {
  tops:
    "For tops: Pay special attention to collar condition, armpit discoloration/staining, cuff wear, button integrity, print/graphic condition, and fabric pilling especially around high-friction areas.",
  bottoms:
    "For bottoms: Pay special attention to waistband elasticity, zipper/button fly function, pocket integrity, and crotch/inseam reinforcement (a blown-out crotch seam is genuine failure). IMPORTANT: knee abrasion, seat fading, hem fraying, whiskering and rips are frequently INTENTIONAL on jeans and other distressed bottoms — judge whether each is a manufactured design feature or genuine wear before counting it against condition.",
  outerwear:
    "For outerwear: Pay special attention to zipper functionality, snap/button closures, lining condition, insulation integrity, waterproofing condition, cuff elasticity, and hood attachment.",
  dresses:
    "For dresses: Pay special attention to zipper functionality, hemline condition, lining integrity, belt/sash condition, embellishment security, and overall drape/shape retention.",
  footwear:
    "For footwear: Pay special attention to sole wear patterns, heel condition, upper material condition, stitching integrity, insole condition, lace/strap condition, and any odor indicators visible (staining, discoloration).",
  accessories:
    "For accessories: Pay special attention to hardware condition (buckles, clasps, zippers), material wear, stitching integrity, structural shape retention, and any tarnishing or corrosion on metal parts.",
};

// Category-level criteria layered ON TOP of the garment_type criteria. Keyed
// on garment_category (the 20-value list). This is where design-vs-defect
// nuance lives for the categories most prone to intentional distressing.
const GARMENT_CATEGORY_CRITERIA: Record<string, string> = {
  jeans:
    "JEANS-SPECIFIC: Distressing is a mainstream design choice. Factory features that LOOK like damage but are NOT condition defects include: deliberate rips/slashes/holes (often at knees/thighs), whiskering and honeycomb fading, sandblasted/abraded patches, raw or frayed hems (chewed/cut-off hems are a style), destroyed/'destroyed-wash' panels, paint splatter, acid/bleach wash, and grinding at pockets/hems. Distinguish these from GENUINE wear: a designed knee slash that has RUN further than intended into the leg, a hem fraying because the garment is worn out (vs. a deliberate raw hem), thinning/transparency from real abrasion, blown crotch/inseam seams, popped rivets, a non-functional zipper/button, stains, or odor. Grade condition relative to how the jean looked NEW from the factory.",
  pants:
    "PANTS-SPECIFIC: Some styles ship with intentional distressing or raw hems; assess whether knee/seat/hem wear is by design or genuine. Watch crease retention on dress pants and shininess from over-wear.",
  shorts:
    "SHORTS-SPECIFIC: Cut-off/raw frayed hems are commonly intentional on denim shorts. Distinguish a deliberate frayed hem from a hem disintegrating due to wear.",
  jacket:
    "JACKET-SPECIFIC: Distressed/washed denim and leather jackets may have intentional abrasion, cracking-look finishes, or patchwork. Verify zipper/snap function and lining integrity, which are genuine condition signals.",
  sweater:
    "SWEATER-SPECIFIC: Some designs are intentionally slubby, loose-knit, or pre-distressed. Distinguish design texture from genuine pilling, snags, moth holes, and stretched-out cuffs/hems.",
  hoodie:
    "HOODIE-SPECIFIC: 'Vintage'/acid-wash and intentionally cropped raw hems exist. Distinguish from genuine pilling, drawstring loss, and cuff stretch-out.",
  "t-shirt":
    "T-SHIRT-SPECIFIC: Distressed/'thrashed' tees and intentionally cropped raw hems are common, as is intentional vintage fading on graphics. Distinguish from genuine thinning, holes, cracked-from-wear prints, and stains.",
  dress:
    "DRESS-SPECIFIC: Some designs use intentional raw edges or distressing; most do not. Treat tears, broken zippers, and embellishment loss as genuine defects.",
};

// The single most important framing change: condition is measured against the
// garment's AS-MANUFACTURED state, not against an idealized defect-free
// garment. This block is shared by both grading stages.
const DESIGN_VS_DEFECT_PRINCIPLE = `CORE PRINCIPLE — GRADE AGAINST AS-MANUFACTURED STATE:
Condition measures how far a garment has deviated from how it looked when it left the factory — NOT the absence of holes, fraying, or fading in the abstract. Many garments are MANUFACTURED with features that resemble damage:
- Distressed/ripped/destroyed denim (rips, slashes, holes, sandblasting, grinding)
- Whiskering, honeycombs, and intentional fading
- Raw, frayed, or cut-off hems (denim, tees, sweatshirts)
- Acid/bleach/tie-dye/garment-dye finishes
- Deliberate paint splatter, patchwork, deconstructed seams
- Pre-pilled, slubby, or "vintage" finishes

A pristine, never-worn factory-distressed jean is a 10 — the rips are design, not wear.

For EVERY observed "issue", first decide: is this an INTENTIONAL manufactured design feature, or GENUINE wear/damage?
- Intentional design feature → record it as a style attribute / mark the issue is_intentional=true. It must NOT lower any factor score.
- Genuine wear/damage → assess severity and let it affect the relevant factor scores.
- The hard case: an intentional feature that has DEGRADED beyond its design intent (e.g. a designed knee slash that has torn further up the leg, a deliberate raw hem now unraveling from wear). Count ONLY the genuine excess degradation, not the original design.

Use the seller's declared design features (when provided) as a HINT, but verify visually — sellers sometimes mislabel. When genuinely ambiguous, lean toward "intentional" only if the feature is symmetric/uniform/finished in a way consistent with manufacturing, and lower confidence_score.`;

const SYSTEM_PROMPT = `You are an expert clothing condition assessor for GradeThread, a professional garment grading service. You have extensive experience evaluating pre-owned clothing condition across all garment types, including distressed, washed, and intentionally-designed garments.

Your role is to analyze individual garment images and provide detailed, objective condition assessments. You grade on a 1.0-10.0 scale:
- 10: New with Tags (NWT) - unworn, tags attached
- 9: New without Tags (NWOT) - unworn, no tags
- 8: Excellent - minimal signs of wear
- 7: Very Good - light wear, no notable flaws
- 6: Good - moderate wear, minor flaws
- 5: Fair - noticeable wear and flaws
- 3-4: Poor/Below Average - significant wear, damage, or flaws

You evaluate 5 condition factors:
1. Fabric Condition (30% weight): Material integrity, pilling, thinning, holes, stains, fading
2. Structural Integrity (25% weight): Seams, hems, construction, shape retention
3. Cosmetic Appearance (20% weight): Visual appeal, color consistency, print condition
4. Functional Elements (15% weight): Zippers, buttons, closures, pockets, elastic
5. Odor & Cleanliness (10% weight): Visible cleanliness indicators, staining patterns

${DESIGN_VS_DEFECT_PRINCIPLE}

IMPORTANT: You must respond ONLY with valid JSON matching the exact schema requested. No markdown, no explanation, no preamble — just the JSON object.`;

// ── DB-driven prompt overrides ────────────────────────────────────────
// Prompts ship as versioned code defaults. An active row in
// ai_prompt_versions (stage + optional garment_scope) OVERRIDES the code
// prompt at runtime, enabling no-deploy iteration + A/B testing. We always
// report the version_name so the accuracy loop can attribute the grade.

export interface ResolvedPrompt {
  text: string;
  versionName: string;
}

const PROMPT_CACHE_TTL_MS = 60_000;
const promptCache = new Map<string, { value: ResolvedPrompt; expiresAt: number }>();

/**
 * Resolve the active prompt for a grading stage. Prefers a garment_scope-
 * specific active row, then a global (null-scope) active row, then the code
 * default. A row with empty prompt_text means "use the code default text but
 * attribute to this version_name" (that's how the seeded default rows work).
 * Never throws — a DB hiccup falls back to the code default.
 */
async function resolveActivePrompt(
  stage: "per_image" | "composite",
  garmentScope: string | null,
  codeDefault: ResolvedPrompt,
): Promise<ResolvedPrompt> {
  const cacheKey = `${stage}:${garmentScope ?? ""}`;
  const now = Date.now();
  const cached = promptCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  let resolved = codeDefault;
  try {
    const { data, error } = await supabaseAdmin
      .from("ai_prompt_versions")
      .select("version_name, prompt_text, garment_scope")
      .eq("stage", stage)
      .eq("is_active", true);

    if (!error && Array.isArray(data) && data.length > 0) {
      const rows = data as Array<{
        version_name: string;
        prompt_text: string | null;
        garment_scope: string | null;
      }>;
      const scoped = garmentScope
        ? rows.find((r) => r.garment_scope === garmentScope)
        : undefined;
      const global = rows.find((r) => !r.garment_scope);
      const picked = scoped ?? global;
      if (picked) {
        const text =
          picked.prompt_text && picked.prompt_text.trim().length > 0
            ? picked.prompt_text
            : codeDefault.text;
        resolved = { text, versionName: picked.version_name };
      }
    }
  } catch (err) {
    console.error(
      `[AI Grading] resolveActivePrompt fallback (${stage}/${garmentScope ?? "global"}):`,
      err instanceof Error ? err.message : String(err),
    );
  }

  promptCache.set(cacheKey, { value: resolved, expiresAt: now + PROMPT_CACHE_TTL_MS });
  return resolved;
}

function buildUserPrompt(
  imageType: string,
  garmentType: string,
  garmentCategory: string,
  styleHint: string[],
): string {
  const imageContext =
    IMAGE_TYPE_CONTEXT[imageType] || `This is a ${imageType} image of the garment.`;
  const garmentCriteria =
    GARMENT_TYPE_CRITERIA[garmentType] || "Evaluate using general garment condition criteria.";
  const categoryCriteria = GARMENT_CATEGORY_CRITERIA[garmentCategory];

  const styleHintLine =
    styleHint.length > 0
      ? `\nSELLER-DECLARED DESIGN FEATURES (hint — verify visually, may be wrong): ${styleHint.join(", ")}`
      : "";

  return `Analyze this garment image and provide a detailed condition assessment.

IMAGE CONTEXT: ${imageContext}

GARMENT-TYPE CRITERIA: ${garmentCriteria}${categoryCriteria ? `\n\nCATEGORY CRITERIA: ${categoryCriteria}` : ""}${styleHintLine}

Respond with a JSON object matching this exact schema:
{
  "detected_issues": [
    {
      "issue": "description of the issue",
      "severity": "minor" | "moderate" | "major",
      "location": "where on the garment",
      "is_intentional": true | false
    }
  ],
  "style_attributes": [
    {
      "attribute": "intentional design feature (e.g. factory distressing, raw hem, acid wash)",
      "location": "where on the garment"
    }
  ],
  "condition_signals": [
    {
      "signal": "description of condition indicator",
      "sentiment": "positive" | "neutral" | "negative"
    }
  ],
  "estimated_scores": {
    "fabric_condition": <1.0-10.0>,
    "structural_integrity": <1.0-10.0>,
    "cosmetic_appearance": <1.0-10.0>,
    "functional_elements": <1.0-10.0>,
    "odor_cleanliness": <1.0-10.0>
  }
}

Rules:
- detected_issues: List every visible issue. Set is_intentional=true when the "issue" is a manufactured design feature (distressing, raw hem, etc.), false for genuine wear/damage. Empty array if none found.
- style_attributes: List intentional design features you observe (the design language of the garment). Empty array if none.
- estimated_scores: Score each factor 1.0-10.0 based on what is visible in THIS image only, GRADING AGAINST THE AS-MANUFACTURED STATE. Intentional design features (is_intentional=true) must NOT lower any score — only genuine wear/damage and any degradation BEYOND the original design intent counts.
- condition_signals: List all positive AND negative indicators you observe.
- For factors not assessable from this image type, score 7.0 (neutral) and note it in condition_signals.
- Be precise and objective. Do not guess about things not visible in the image.`;
}

// --- Helpers ---

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function parseImageInput(imageUrl: string): {
  type: "base64";
  media_type: ImageMediaType;
  data: string;
} {
  // Handle data URI format: data:image/jpeg;base64,/9j/4AAQ...
  if (imageUrl.startsWith("data:")) {
    const match = imageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      return {
        type: "base64",
        media_type: match[1] as ImageMediaType,
        data: match[2],
      };
    }
  }
  // Assume raw base64 JPEG if no prefix
  return {
    type: "base64",
    media_type: "image/jpeg",
    data: imageUrl,
  };
}

// --- Main function ---

export async function analyzeImage(
  imageUrl: string,
  imageType: string,
  garmentType: string,
  garmentCategory = "",
  styleHint: string[] = [],
  // Eval harness passes a candidate prompt to score a not-yet-active version.
  promptOverride?: ResolvedPrompt
): Promise<PerImageAnalysis> {
  const client = getAnthropicClient();
  const startTime = Date.now();
  const imageSource = parseImageInput(imageUrl);
  const temperature = getAiTemperature();

  // Resolve the active per-image prompt (DB override → code default), unless
  // the caller supplied an explicit candidate prompt.
  const prompt =
    promptOverride ??
    (await resolveActivePrompt("per_image", garmentCategory || null, {
      text: SYSTEM_PROMPT,
      versionName: PER_IMAGE_PROMPT_VERSION,
    }));

  // Cache the (static) system prompt so repeated per-image calls within a
  // submission — and across submissions inside the 5-min cache window —
  // don't re-bill the prompt tokens. Mirrors the FlipDesk extractor.
  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? { type: "text", text: prompt.text, cache_control: { type: "ephemeral" } }
    : { type: "text", text: prompt.text };

  try {
    const response = await client.messages.create({
      model: getDefaultModel(),
      max_tokens: 1024,
      ...(temperature !== undefined ? { temperature } : {}),
      system: [systemBlock],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: imageSource,
            },
            {
              type: "text",
              text: buildUserPrompt(imageType, garmentType, garmentCategory, styleHint),
            },
          ],
        },
      ],
    });

    const latencyMs = Date.now() - startTime;

    // Log API usage
    console.log(
      `[AI Grading] analyzeImage | image_type=${imageType} | garment_type=${garmentType} | ` +
        `input_tokens=${response.usage.input_tokens} | output_tokens=${response.usage.output_tokens} | ` +
        `latency_ms=${latencyMs}`
    );

    // Extract text content from response
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text content in API response");
    }

    // Parse JSON response
    const rawText = textBlock.text.trim();
    // Strip markdown code fences if present
    const jsonText = rawText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

    let parsed: {
      detected_issues: DetectedIssue[];
      style_attributes?: StyleAttribute[];
      condition_signals: ConditionSignal[];
      estimated_scores: FactorScores;
    };

    try {
      parsed = JSON.parse(jsonText);
    } catch {
      console.error(`[AI Grading] Failed to parse JSON response: ${rawText}`);
      throw new Error("AI returned invalid JSON response");
    }

    // Validate response structure
    if (!parsed.detected_issues || !Array.isArray(parsed.detected_issues)) {
      parsed.detected_issues = [];
    }
    // Normalize is_intentional (older/looser responses may omit it → treat as
    // genuine damage, the safe default).
    parsed.detected_issues = parsed.detected_issues.map((i) => ({
      ...i,
      is_intentional: i.is_intentional === true,
    }));
    if (!parsed.style_attributes || !Array.isArray(parsed.style_attributes)) {
      parsed.style_attributes = [];
    }
    if (!parsed.condition_signals || !Array.isArray(parsed.condition_signals)) {
      parsed.condition_signals = [];
    }
    if (!parsed.estimated_scores || typeof parsed.estimated_scores !== "object") {
      throw new Error("AI response missing estimated_scores");
    }

    // Clamp scores to valid range
    const factorKeys: (keyof FactorScores)[] = [
      "fabric_condition",
      "structural_integrity",
      "cosmetic_appearance",
      "functional_elements",
      "odor_cleanliness",
    ];
    for (const key of factorKeys) {
      const value = parsed.estimated_scores[key];
      if (typeof value !== "number" || isNaN(value)) {
        parsed.estimated_scores[key] = 7.0; // Default neutral
      } else {
        parsed.estimated_scores[key] = Math.max(1.0, Math.min(10.0, value));
      }
    }

    return {
      image_type: imageType,
      detected_issues: parsed.detected_issues,
      style_attributes: parsed.style_attributes,
      condition_signals: parsed.condition_signals,
      estimated_scores: parsed.estimated_scores,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error(
      `[AI Grading] analyzeImage FAILED | image_type=${imageType} | garment_type=${garmentType} | ` +
        `latency_ms=${latencyMs} | error=${errorMessage}`
    );

    // Rethrow with context
    if (errorMessage.includes("timeout") || errorMessage.includes("TIMEOUT")) {
      throw new Error(`AI analysis timed out for ${imageType} image`);
    }
    if (errorMessage.includes("rate_limit") || errorMessage.includes("429")) {
      throw new Error("AI service rate limit reached. Please try again shortly.");
    }
    throw new Error(`AI analysis failed for ${imageType} image: ${errorMessage}`);
  }
}

// --- Composite Grading ---

const FACTOR_WEIGHTS: Record<keyof FactorScores, number> = {
  fabric_condition: 0.30,
  structural_integrity: 0.25,
  cosmetic_appearance: 0.20,
  functional_elements: 0.15,
  odor_cleanliness: 0.10,
};

const GRADE_TIER_DEFINITIONS = `Grade Tiers (score ranges):
- 10.0: NWT (New with Tags) — Unworn item with original retail tags still attached. No signs of wear, washing, or handling beyond store display. Perfect condition.
- 9.0-9.5: NWOT (New without Tags) — Unworn item, tags removed. No signs of wear, washing, or use. Indistinguishable from new except missing tags.
- 8.0-8.5: Excellent — Barely worn, minimal signs of use. No visible defects, stains, or wear patterns. May have been worn 1-3 times.
- 7.0-7.5: Very Good — Light wear evident but no notable flaws. Minor signs of washing/wearing. All functional elements work perfectly.
- 6.0-6.5: Good — Moderate wear visible. May have minor flaws (light pilling, slight fading, small mark). Still presentable and fully functional.
- 5.0-5.5: Fair — Noticeable wear and minor flaws. Some pilling, fading, or small stains. Functional but shows clear use history.
- 3.0-4.5: Poor — Significant wear, damage, or flaws. May have holes, major stains, broken elements, or heavy fading. Still wearable but with obvious issues.
- 1.0-2.5: Very Poor/Salvage — Severe damage. Primarily useful for parts, fabric, or craft projects. Major structural issues.`;

const COMPOSITE_SYSTEM_PROMPT = `You are an expert clothing condition grading specialist for GradeThread, a professional garment grading service. You produce final composite grades by synthesizing per-image analysis results into a single, authoritative condition assessment.

${GRADE_TIER_DEFINITIONS}

Factor Weights:
- Fabric Condition: 30% — Material integrity, pilling, thinning, holes, stains, fading
- Structural Integrity: 25% — Seams, hems, construction, shape retention
- Cosmetic Appearance: 20% — Visual appeal, color consistency, print condition
- Functional Elements: 15% — Zippers, buttons, closures, pockets, elastic
- Odor & Cleanliness: 10% — Visible cleanliness indicators, staining patterns

You must synthesize all individual image analyses into one cohesive grade. When images disagree, weight the more revealing image type (e.g., defect images carry more weight for their specific area than front overview shots).

${DESIGN_VS_DEFECT_PRINCIPLE}

When synthesizing: consolidate intentional design features into style_attributes (NOT defects_found). An issue flagged is_intentional=true in a per-image analysis must not pull down factor scores — re-examine it if a per-image score seems to have penalized intentional distressing. defects_found contains GENUINE wear/damage only.

IMPORTANT: You must respond ONLY with valid JSON matching the exact schema requested. No markdown, no explanation, no preamble — just the JSON object.`;

function buildCompositeUserPrompt(
  perImageResults: PerImageAnalysis[],
  garmentInfo: GarmentInfo
): string {
  const analysesJson = JSON.stringify(perImageResults, null, 2);
  const styleHint = garmentInfo.style_attributes ?? [];
  const styleHintLine =
    styleHint.length > 0
      ? `\n- Seller-declared design features (hint, verify): ${styleHint.join(", ")}`
      : "";

  return `Synthesize the following per-image analyses into a single composite grade for this garment.

GARMENT INFO:
- Type: ${garmentInfo.garment_type}
- Category: ${garmentInfo.garment_category}
- Brand: ${garmentInfo.brand || "Unknown"}
- Title: ${garmentInfo.title}
${garmentInfo.description ? `- Description: ${garmentInfo.description}` : ""}${styleHintLine}

PER-IMAGE ANALYSES:
${analysesJson}

Apply the factor weights (Fabric 30%, Structural 25%, Cosmetic 20%, Functional 15%, Odor 10%) to produce the final scores. Grade against the AS-MANUFACTURED state — intentional design features never lower the grade.

Respond with a JSON object matching this exact schema:
{
  "overall_score": <1.0-10.0, weighted average rounded to nearest 0.5>,
  "grade_tier": "<NWT|NWOT|Excellent|Very Good|Good|Fair|Poor>",
  "factor_scores": {
    "fabric_condition": <1.0-10.0>,
    "structural_integrity": <1.0-10.0>,
    "cosmetic_appearance": <1.0-10.0>,
    "functional_elements": <1.0-10.0>,
    "odor_cleanliness": <1.0-10.0>
  },
  "ai_summary": "<2-4 sentence professional condition summary; mention intentional design features as styling, not defects>",
  "defects_found": [
    {
      "defect": "<description of GENUINE wear/damage only>",
      "severity": "minor|moderate|major",
      "location": "<where on garment>",
      "impact_on_grade": "<how this affects the score>"
    }
  ],
  "style_attributes": [
    {
      "attribute": "<intentional design feature, e.g. factory distressing, raw hem, acid wash>",
      "location": "<where on garment>",
      "confidence": <0.0-1.0 that this is intentional design vs. genuine damage>
    }
  ],
  "confidence_score": <0.0-1.0, your confidence in the accuracy of this grade>,
  "image_validity": {
    "is_clothing": <true if the images clearly show a wearable garment, false otherwise>,
    "reason": "<brief explanation, especially when is_clothing is false>"
  }
}

Rules:
- overall_score must be the weighted average of factor scores, rounded to nearest 0.5
- grade_tier must match the overall_score according to the tier definitions
- factor_scores: synthesize across all images, weighting image types appropriately, grading against as-manufactured state
- ai_summary: professional, objective summary suitable for a grade certificate
- defects_found: consolidate all unique GENUINE defects (empty array if none). Do NOT list intentional design features here.
- style_attributes: consolidate all intentional design features observed (empty array if none). These do not lower the grade.
- confidence_score: lower if images are blurry, incomplete coverage, conflicting signals, ambiguous design-vs-damage calls, or unusual garment
- image_validity: set is_clothing to false if the images do not depict an actual item of clothing (e.g. blank, unrelated objects, inappropriate content)`;
}

function scoreToGradeTier(score: number): string {
  if (score >= 10.0) return "NWT";
  if (score >= 9.0) return "NWOT";
  if (score >= 8.0) return "Excellent";
  if (score >= 7.0) return "Very Good";
  if (score >= 6.0) return "Good";
  if (score >= 5.0) return "Fair";
  return "Poor";
}

function roundToHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

export async function compositeGrade(
  perImageResults: PerImageAnalysis[],
  garmentInfo: GarmentInfo,
  // Eval harness passes a candidate prompt to score a not-yet-active version.
  promptOverride?: ResolvedPrompt
): Promise<CompositeGradeResult> {
  const client = getAnthropicClient();
  const startTime = Date.now();
  const temperature = getAiTemperature();
  const compositeModel = getGradingCompositeModel();

  // Resolve the active composite prompt (DB override → code default), unless
  // the caller supplied an explicit candidate. The resolved version_name is
  // recorded on the grade so accuracy tracking can attribute it.
  const prompt =
    promptOverride ??
    (await resolveActivePrompt("composite", garmentInfo.garment_category || null, {
      text: COMPOSITE_SYSTEM_PROMPT,
      versionName: COMPOSITE_PROMPT_VERSION,
    }));
  const promptVersion = prompt.versionName;

  // Cache the static composite system prompt (tier definitions + weights).
  const systemBlock: Anthropic.TextBlockParam = isCachingEnabled()
    ? {
        type: "text",
        text: prompt.text,
        cache_control: { type: "ephemeral" },
      }
    : { type: "text", text: prompt.text };

  try {
    const response = await client.messages.create({
      model: compositeModel,
      max_tokens: 2048,
      ...(temperature !== undefined ? { temperature } : {}),
      system: [systemBlock],
      messages: [
        {
          role: "user",
          content: buildCompositeUserPrompt(perImageResults, garmentInfo),
        },
      ],
    });

    const latencyMs = Date.now() - startTime;

    console.log(
      `[AI Grading] compositeGrade | model=${compositeModel} | ` +
        `garment_type=${garmentInfo.garment_type} | ` +
        `images=${perImageResults.length} | ` +
        `input_tokens=${response.usage.input_tokens} | output_tokens=${response.usage.output_tokens} | ` +
        `latency_ms=${latencyMs}`
    );

    // Extract text content
    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text content in composite grade API response");
    }

    // Parse JSON response
    const rawText = textBlock.text.trim();
    const jsonText = rawText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");

    let parsed: {
      overall_score: number;
      grade_tier: string;
      factor_scores: FactorScores;
      ai_summary: string;
      defects_found: DefectFound[];
      style_attributes?: DetectedStyleAttribute[];
      confidence_score: number;
      image_validity?: { is_clothing?: boolean; reason?: string };
    };

    try {
      parsed = JSON.parse(jsonText);
    } catch {
      console.error(`[AI Grading] Failed to parse composite grade JSON: ${rawText}`);
      throw new Error("AI returned invalid JSON for composite grade");
    }

    // Validate and clamp factor scores
    const factorKeys: (keyof FactorScores)[] = [
      "fabric_condition",
      "structural_integrity",
      "cosmetic_appearance",
      "functional_elements",
      "odor_cleanliness",
    ];

    if (!parsed.factor_scores || typeof parsed.factor_scores !== "object") {
      throw new Error("AI response missing factor_scores");
    }

    for (const key of factorKeys) {
      const value = parsed.factor_scores[key];
      if (typeof value !== "number" || isNaN(value)) {
        parsed.factor_scores[key] = 7.0;
      } else {
        parsed.factor_scores[key] = Math.max(1.0, Math.min(10.0, value));
      }
    }

    // Recalculate overall_score from factor scores with weights to ensure correctness
    let weightedSum = 0;
    for (const key of factorKeys) {
      weightedSum += parsed.factor_scores[key] * FACTOR_WEIGHTS[key];
    }
    const calculatedScore = roundToHalf(Math.max(1.0, Math.min(10.0, weightedSum)));

    // Use calculated score (authoritative) and derive tier from it
    const overallScore = calculatedScore;
    const gradeTier = scoreToGradeTier(overallScore);

    // Validate confidence score
    const confidenceScore =
      typeof parsed.confidence_score === "number" && !isNaN(parsed.confidence_score)
        ? Math.max(0.0, Math.min(1.0, parsed.confidence_score))
        : 0.5;

    // Validate ai_summary
    const aiSummary =
      typeof parsed.ai_summary === "string" && parsed.ai_summary.length > 0
        ? parsed.ai_summary
        : "Grade report generated by AI analysis.";

    // Validate defects_found
    const defectsFound: DefectFound[] = Array.isArray(parsed.defects_found)
      ? parsed.defects_found.filter(
          (d) =>
            typeof d === "object" &&
            d !== null &&
            typeof d.defect === "string" &&
            typeof d.severity === "string" &&
            ["minor", "moderate", "major"].includes(d.severity)
        )
      : [];

    // Validate style_attributes — intentional design features. Clamp
    // confidence and drop malformed entries.
    const styleAttributes: DetectedStyleAttribute[] = Array.isArray(parsed.style_attributes)
      ? parsed.style_attributes
          .filter(
            (s) => typeof s === "object" && s !== null && typeof s.attribute === "string"
          )
          .map((s) => ({
            attribute: s.attribute,
            location: typeof s.location === "string" ? s.location : "",
            confidence:
              typeof s.confidence === "number" && !isNaN(s.confidence)
                ? Math.max(0.0, Math.min(1.0, s.confidence))
                : 0.5,
          }))
      : [];

    // Validate image_validity — default to valid if the AI omitted it.
    const imageValidity: ImageValidity = {
      is_clothing: parsed.image_validity?.is_clothing !== false,
      reason:
        typeof parsed.image_validity?.reason === "string"
          ? parsed.image_validity.reason
          : "",
    };

    // Flag for human review if confidence is below threshold
    const needsHumanReview = confidenceScore < 0.75;

    if (needsHumanReview) {
      console.log(
        `[AI Grading] compositeGrade FLAGGED for human review | ` +
          `confidence=${confidenceScore} | overall_score=${overallScore}`
      );
    }

    return {
      overall_score: overallScore,
      grade_tier: gradeTier,
      factor_scores: parsed.factor_scores,
      ai_summary: aiSummary,
      defects_found: defectsFound,
      style_attributes: styleAttributes,
      confidence_score: confidenceScore,
      needs_human_review: needsHumanReview,
      image_validity: imageValidity,
      prompt_version: promptVersion,
      model: compositeModel,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error(
      `[AI Grading] compositeGrade FAILED | garment_type=${garmentInfo.garment_type} | ` +
        `images=${perImageResults.length} | latency_ms=${latencyMs} | error=${errorMessage}`
    );

    if (errorMessage.includes("timeout") || errorMessage.includes("TIMEOUT")) {
      throw new Error("AI composite grading timed out");
    }
    if (errorMessage.includes("rate_limit") || errorMessage.includes("429")) {
      throw new Error("AI service rate limit reached. Please try again shortly.");
    }
    throw new Error(`AI composite grading failed: ${errorMessage}`);
  }
}

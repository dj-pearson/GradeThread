import Anthropic from "@anthropic-ai/sdk";

// --- Types ---

export interface PerImageAnalysis {
  image_type: string;
  detected_issues: DetectedIssue[];
  condition_signals: ConditionSignal[];
  estimated_scores: FactorScores;
}

export interface DetectedIssue {
  issue: string;
  severity: "minor" | "moderate" | "major";
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
}

export interface DefectFound {
  defect: string;
  severity: "minor" | "moderate" | "major";
  location: string;
  impact_on_grade: string;
}

export interface CompositeGradeResult {
  overall_score: number;
  grade_tier: string;
  factor_scores: FactorScores;
  ai_summary: string;
  defects_found: DefectFound[];
  confidence_score: number;
  needs_human_review: boolean;
  prompt_version: string;
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
    "For bottoms: Pay special attention to waistband elasticity, zipper/button fly function, knee wear, seat wear, hem fraying, pocket integrity, and crotch area reinforcement.",
  outerwear:
    "For outerwear: Pay special attention to zipper functionality, snap/button closures, lining condition, insulation integrity, waterproofing condition, cuff elasticity, and hood attachment.",
  dresses:
    "For dresses: Pay special attention to zipper functionality, hemline condition, lining integrity, belt/sash condition, embellishment security, and overall drape/shape retention.",
  footwear:
    "For footwear: Pay special attention to sole wear patterns, heel condition, upper material condition, stitching integrity, insole condition, lace/strap condition, and any odor indicators visible (staining, discoloration).",
  accessories:
    "For accessories: Pay special attention to hardware condition (buckles, clasps, zippers), material wear, stitching integrity, structural shape retention, and any tarnishing or corrosion on metal parts.",
};

const SYSTEM_PROMPT = `You are an expert clothing condition assessor for GradeThread, a professional garment grading service. You have extensive experience evaluating pre-owned clothing condition across all garment types.

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

IMPORTANT: You must respond ONLY with valid JSON matching the exact schema requested. No markdown, no explanation, no preamble — just the JSON object.`;

function buildUserPrompt(imageType: string, garmentType: string): string {
  const imageContext =
    IMAGE_TYPE_CONTEXT[imageType] || `This is a ${imageType} image of the garment.`;
  const garmentCriteria =
    GARMENT_TYPE_CRITERIA[garmentType] || "Evaluate using general garment condition criteria.";

  return `Analyze this garment image and provide a detailed condition assessment.

IMAGE CONTEXT: ${imageContext}

GARMENT-SPECIFIC CRITERIA: ${garmentCriteria}

Respond with a JSON object matching this exact schema:
{
  "detected_issues": [
    {
      "issue": "description of the issue",
      "severity": "minor" | "moderate" | "major",
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
- detected_issues: List every visible issue. Empty array if none found.
- condition_signals: List all positive AND negative indicators you observe.
- estimated_scores: Score each factor 1.0-10.0 based on what is visible in THIS image only.
- For factors not assessable from this image type, score 7.0 (neutral) and note it in condition_signals.
- Be precise and objective. Do not guess about things not visible in the image.`;
}

// --- Client ---

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set");
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
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
  garmentType: string
): Promise<PerImageAnalysis> {
  const client = getClient();
  const startTime = Date.now();
  const imageSource = parseImageInput(imageUrl);

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
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
              text: buildUserPrompt(imageType, garmentType),
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

IMPORTANT: You must respond ONLY with valid JSON matching the exact schema requested. No markdown, no explanation, no preamble — just the JSON object.`;

function buildCompositeUserPrompt(
  perImageResults: PerImageAnalysis[],
  garmentInfo: GarmentInfo
): string {
  const analysesJson = JSON.stringify(perImageResults, null, 2);

  return `Synthesize the following per-image analyses into a single composite grade for this garment.

GARMENT INFO:
- Type: ${garmentInfo.garment_type}
- Category: ${garmentInfo.garment_category}
- Brand: ${garmentInfo.brand || "Unknown"}
- Title: ${garmentInfo.title}
${garmentInfo.description ? `- Description: ${garmentInfo.description}` : ""}

PER-IMAGE ANALYSES:
${analysesJson}

Apply the factor weights (Fabric 30%, Structural 25%, Cosmetic 20%, Functional 15%, Odor 10%) to produce the final scores.

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
  "ai_summary": "<2-4 sentence professional condition summary>",
  "defects_found": [
    {
      "defect": "<description>",
      "severity": "minor|moderate|major",
      "location": "<where on garment>",
      "impact_on_grade": "<how this affects the score>"
    }
  ],
  "confidence_score": <0.0-1.0, your confidence in the accuracy of this grade>
}

Rules:
- overall_score must be the weighted average of factor scores, rounded to nearest 0.5
- grade_tier must match the overall_score according to the tier definitions
- factor_scores: synthesize across all images, weighting image types appropriately
- ai_summary: professional, objective summary suitable for a grade certificate
- defects_found: consolidate all unique defects from all images (empty array if none)
- confidence_score: lower if images are blurry, incomplete coverage, conflicting signals, or unusual garment`;
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
  garmentInfo: GarmentInfo
): Promise<CompositeGradeResult> {
  const client = getClient();
  const startTime = Date.now();

  // Determine prompt version — references ai_prompt_versions concept
  const promptVersion = "composite_v1";

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2048,
      system: COMPOSITE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildCompositeUserPrompt(perImageResults, garmentInfo),
        },
      ],
    });

    const latencyMs = Date.now() - startTime;

    console.log(
      `[AI Grading] compositeGrade | garment_type=${garmentInfo.garment_type} | ` +
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
      confidence_score: number;
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
    let confidenceScore =
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
      confidence_score: confidenceScore,
      needs_human_review: needsHumanReview,
      prompt_version: promptVersion,
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

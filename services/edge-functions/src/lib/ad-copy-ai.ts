// US-1073: AI ad-copy generation grounded in the keyword library + brand voice.
//
// Loads the marketer-selected keyword themes plus the brand voice / SEO pillars
// from content_knowledge, prompts the configured model for Google Ads RSA
// headlines+descriptions OR Apple Search Ads keyword sets + creative lines, then
// applies the char-limit/policy guardrails in ad-copy.ts before returning. Cost
// is attributed to ai_usage_events with feature='ads' (the limiter captures it
// automatically inside enterAiFeature("ads", …)).

import {
  getAiTemperature,
  getAnthropicClient,
  getDefaultModel,
} from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { supabaseAdmin } from "./supabase.ts";
import {
  AD_LIMITS,
  type AdPayload,
  type AdPlatform,
  enforceKeywords,
  enforceLines,
} from "./ad-copy.ts";

export const AD_COPY_PROMPT_VERSION = "ads.v1";

export interface KeywordTheme {
  id: string;
  theme: string;
  keywords: string[];
  pillar: string | null;
  notes: string | null;
}

export interface GenerateAdCopyInput {
  platform: AdPlatform;
  themes: KeywordTheme[];
  userId?: string | null;
  // Optional free-text refinement instruction ("punchier", "lead with price",
  // "emphasize the free certificate") for the refine/iterate loop.
  instruction?: string;
  model?: string;
}

export interface GenerateAdCopyResult {
  platform: AdPlatform;
  payload: AdPayload;
  sourceKeywords: string[];
  meta: {
    model_used: string;
    prompt_version: string;
    prompt_tokens: number;
    completion_tokens: number;
    latency_ms: number;
    dropped: number; // candidates rejected by the guardrails
  };
}

async function loadBrandKnowledge(): Promise<{
  brandVoice: string;
  pillarMap: string;
}> {
  const { data, error } = await supabaseAdmin
    .from("content_knowledge")
    .select("key, body_md")
    .in("key", ["brand.voice", "seo.pillars"]);
  if (error) {
    throw new Error(`Failed to load brand knowledge: ${error.message}`);
  }
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(row.key as string, (row.body_md as string) ?? "");
  }
  return {
    brandVoice: map.get("brand.voice") ?? "",
    pillarMap: map.get("seo.pillars") ?? "",
  };
}

function stripCodeFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

function buildSystemPrompt(platform: AdPlatform, brandVoice: string, pillarMap: string): string {
  const lim = AD_LIMITS;
  const platformRules = platform === "google_ads"
    ? [
      `Produce Google Ads RESPONSIVE SEARCH AD assets.`,
      `- ${lim.google_ads.headlineMax} headlines, EACH ≤ ${lim.google_ads.headlineMaxChars} characters (hard limit — count characters).`,
      `- ${lim.google_ads.descriptionMax} descriptions, EACH ≤ ${lim.google_ads.descriptionMaxChars} characters.`,
      `- Vary angles across headlines (benefit, feature, trust, CTA). No duplicates.`,
      `Return JSON: {"headlines": string[], "descriptions": string[]}.`,
    ].join("\n")
    : [
      `Produce Apple Search Ads assets.`,
      `- An "exact" keyword list and a "broad" keyword list of buyer-intent search terms (single words or short phrases, lowercase, ≤ ${lim.apple_search_ads.keywordMaxChars} chars each).`,
      `- ${lim.apple_search_ads.creativeMax} short custom-product-page creative lines, EACH ≤ ${lim.apple_search_ads.creativeMaxChars} characters.`,
      `Return JSON: {"keywords": {"exact": string[], "broad": string[]}, "creative": string[]}.`,
    ].join("\n");

  return [
    "You are GradeThread's performance-marketing copywriter.",
    "GradeThread is an AI-powered condition-grading SaaS for pre-owned clothing; FlipDesk is its eBay reseller-management surface.",
    "",
    "## Brand voice",
    brandVoice || "(brand voice unavailable — use a clear, trustworthy, benefit-led tone.)",
    "",
    "## SEO pillars (topic guidance)",
    pillarMap || "(pillar map unavailable.)",
    "",
    "## Output rules",
    platformRules,
    "",
    "## Policy guardrails (MANDATORY)",
    "- NEVER exceed the per-asset character limits above.",
    "- No unverifiable superlatives (no \"#1\", \"best ever\", \"guaranteed\").",
    "- No ALL-CAPS words and no repeated punctuation (!!, ??).",
    "- Ground every asset in the supplied keyword themes; do not invent features.",
    "Respond with ONLY the JSON object, no markdown, no commentary.",
  ].join("\n");
}

function buildUserPrompt(themes: KeywordTheme[], instruction?: string): string {
  const themeBlock = themes
    .map((t) => {
      const parts = [`Theme: ${t.theme}`];
      if (t.pillar) parts.push(`Pillar: ${t.pillar}`);
      if (t.notes) parts.push(`Angle: ${t.notes}`);
      parts.push(`Keywords: ${t.keywords.join(", ")}`);
      return parts.join("\n");
    })
    .join("\n\n");
  const lines = [
    "Draft ad copy grounded in these keyword themes:",
    "",
    themeBlock,
  ];
  if (instruction && instruction.trim()) {
    lines.push("", `Refinement instruction: ${instruction.trim()}`);
  }
  return lines.join("\n");
}

export async function generateAdCopy(
  input: GenerateAdCopyInput,
): Promise<GenerateAdCopyResult> {
  enterAiFeature("ads", input.userId ?? null); // US-1073 spend attribution

  if (input.themes.length === 0) {
    throw new Error("At least one keyword theme is required");
  }

  const { brandVoice, pillarMap } = await loadBrandKnowledge();
  const systemPrompt = buildSystemPrompt(input.platform, brandVoice, pillarMap);
  const userPrompt = buildUserPrompt(input.themes, input.instruction);

  const client = getAnthropicClient();
  const model = input.model ?? getDefaultModel();
  const temperature = getAiTemperature();
  const startTime = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    ...(temperature !== undefined ? { temperature } : {}),
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const latencyMs = Date.now() - startTime;

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI response contained no text block");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(textBlock.text));
  } catch {
    console.error("[ad-copy-ai] JSON parse failed:", textBlock.text.slice(0, 300));
    throw new Error("AI returned invalid JSON for ad copy");
  }

  const sourceKeywords = [
    ...new Set(input.themes.flatMap((t) => t.keywords).map((k) => k.trim()).filter(Boolean)),
  ];

  let payload: AdPayload;
  let rawCount = 0;
  if (input.platform === "google_ads") {
    const rawHeadlines = Array.isArray(parsed.headlines) ? parsed.headlines : [];
    const rawDescriptions = Array.isArray(parsed.descriptions) ? parsed.descriptions : [];
    rawCount = rawHeadlines.length + rawDescriptions.length;
    payload = {
      headlines: enforceLines(
        rawHeadlines,
        AD_LIMITS.google_ads.headlineMaxChars,
        AD_LIMITS.google_ads.headlineMax,
      ),
      descriptions: enforceLines(
        rawDescriptions,
        AD_LIMITS.google_ads.descriptionMaxChars,
        AD_LIMITS.google_ads.descriptionMax,
      ),
    };
  } else {
    const kw = (parsed.keywords ?? {}) as Record<string, unknown>;
    const rawExact = Array.isArray(kw.exact) ? kw.exact : [];
    const rawBroad = Array.isArray(kw.broad) ? kw.broad : [];
    const rawCreative = Array.isArray(parsed.creative) ? parsed.creative : [];
    rawCount = rawExact.length + rawBroad.length + rawCreative.length;
    payload = {
      keywords: {
        exact: enforceKeywords(
          rawExact,
          AD_LIMITS.apple_search_ads.keywordMaxChars,
          AD_LIMITS.apple_search_ads.keywordMax,
        ),
        broad: enforceKeywords(
          rawBroad,
          AD_LIMITS.apple_search_ads.keywordMaxChars,
          AD_LIMITS.apple_search_ads.keywordMax,
        ),
      },
      creative: enforceLines(
        rawCreative,
        AD_LIMITS.apple_search_ads.creativeMaxChars,
        AD_LIMITS.apple_search_ads.creativeMax,
      ),
    };
  }

  const keptCount = input.platform === "google_ads"
    ? (payload as { headlines: unknown[]; descriptions: unknown[] }).headlines.length +
      (payload as { headlines: unknown[]; descriptions: unknown[] }).descriptions.length
    : (() => {
      const p = payload as { keywords: { exact: unknown[]; broad: unknown[] }; creative: unknown[] };
      return p.keywords.exact.length + p.keywords.broad.length + p.creative.length;
    })();

  console.log(
    `[ad-copy-ai] generated | platform=${input.platform} | themes=${input.themes.length} | ` +
      `raw=${rawCount} | kept=${keptCount} | latency_ms=${latencyMs}`,
  );

  return {
    platform: input.platform,
    payload,
    sourceKeywords,
    meta: {
      model_used: model,
      prompt_version: AD_COPY_PROMPT_VERSION,
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      latency_ms: latencyMs,
      dropped: Math.max(0, rawCount - keptCount),
    },
  };
}

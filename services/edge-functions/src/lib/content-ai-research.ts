import {
  getAiTemperature,
  getAnthropicClient,
  getLightweightModel,
} from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { supabaseAdmin } from "./supabase.ts";
import {
  buildHistoryContext,
  findDuplicateKeywords,
  type ContentProduct,
  type ContentSurface,
} from "./content-history.ts";
import {
  buildResearchUserPrompt,
  buildSystemPrompt,
  TOPIC_RESEARCH_PROMPT_VERSION,
} from "./content-ai-prompts.ts";

// Topic research: produces candidate titles for the bank.
// Uses the lightweight model (Haiku) since this is a low-stakes
// brainstorm, not the final article. Always dedup-filters the result
// against the history index + existing bank before returning.

export interface ResearchTopicsInput {
  surface: ContentSurface;
  productFocus: ContentProduct;
  count?: number;     // default 10
  model?: string;     // override the configured lightweight model
}

export interface ResearchedCandidate {
  title: string;
  angle: string;
  primary_keyword: string;
  secondary_keywords: string[];
  search_intent: string;
}

export interface ResearchTopicsResult {
  candidates: ResearchedCandidate[];
  rejected_duplicates: number;
  meta: {
    model_used: string;
    prompt_version: string;
    prompt_tokens: number;
    completion_tokens: number;
    latency_ms: number;
  };
}

async function loadResearchKnowledge(
  surface: ContentSurface,
  productFocus: ContentProduct,
) {
  const styleKey =
    surface === "blog"
      ? productFocus === "flipdesk"
        ? "blog.flipdesk.style"
        : "blog.gradethread.style"
      : "social.long.style"; // research uses the long-form style as guide

  const { data, error } = await supabaseAdmin
    .from("content_knowledge")
    .select("key, body_md")
    .in("key", ["brand.voice", styleKey, "seo.pillars"]);
  if (error) {
    throw new Error(`Failed to load knowledge docs: ${error.message}`);
  }
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(row.key as string, (row.body_md as string) ?? "");
  }
  return {
    brandVoice: map.get("brand.voice") ?? "",
    surfaceStyle: map.get(styleKey) ?? "",
    pillarMap: map.get("seo.pillars") ?? "",
  };
}

function stripCodeFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

function normalizeCandidate(raw: unknown): ResearchedCandidate | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const title = String(p.title ?? "").trim();
  const pk = String(p.primary_keyword ?? "").trim().toLowerCase();
  if (!title || !pk) return null;
  return {
    title,
    angle: String(p.angle ?? "").trim(),
    primary_keyword: pk,
    secondary_keywords: Array.isArray(p.secondary_keywords)
      ? (p.secondary_keywords as unknown[])
          .map((k) => String(k).trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 6)
      : [],
    search_intent: String(p.search_intent ?? "informational").trim().toLowerCase(),
  };
}

export async function researchTopics(
  input: ResearchTopicsInput,
): Promise<ResearchTopicsResult> {
  enterAiFeature("content"); // US-894 spend attribution
  const count = Math.min(Math.max(input.count ?? 10, 1), 25);
  const knowledge = await loadResearchKnowledge(input.surface, input.productFocus);
  const historyContext = await buildHistoryContext({
    surface: input.surface,
    productFocus: input.productFocus,
    maxTokens: 3500,
  });

  const systemPrompt = buildSystemPrompt({
    ...knowledge,
    historyContext,
    task: "research-topics",
  });
  const userPrompt = buildResearchUserPrompt({
    surface: input.surface,
    productFocus: input.productFocus,
    count,
  });

  const client = getAnthropicClient();
  const model = input.model ?? getLightweightModel();
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

  let parsed: { candidates?: unknown[] };
  try {
    parsed = JSON.parse(stripCodeFence(textBlock.text));
  } catch {
    console.error(
      "[content-ai-research] JSON parse failed:",
      textBlock.text.slice(0, 300),
    );
    throw new Error("AI returned invalid JSON for topic research");
  }

  const candidates = (parsed.candidates ?? [])
    .map(normalizeCandidate)
    .filter((c): c is ResearchedCandidate => c !== null);

  // Belt-and-suspenders dedup: even if the model didn't catch a
  // collision against the history context, we drop it here.
  const keywords = candidates.map((c) => c.primary_keyword);
  const dupes = await findDuplicateKeywords(
    input.surface,
    input.productFocus,
    keywords,
  );
  const accepted = candidates.filter((c) => !dupes.has(c.primary_keyword));
  const rejected = candidates.length - accepted.length;

  console.log(
    `[content-ai-research] generated | surface=${input.surface} | product=${input.productFocus} | ` +
      `requested=${count} | returned=${candidates.length} | accepted=${accepted.length} | ` +
      `dupes_rejected=${rejected} | latency_ms=${latencyMs}`,
  );

  return {
    candidates: accepted,
    rejected_duplicates: rejected,
    meta: {
      model_used: model,
      prompt_version: TOPIC_RESEARCH_PROMPT_VERSION,
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      latency_ms: latencyMs,
    },
  };
}

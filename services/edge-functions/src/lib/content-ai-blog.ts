import {
  getAiTemperature,
  getAnthropicClient,
  getContentModel,
} from "./ai-config.ts";
import { extractTextBlock, jsonParseError } from "./ai-response-text.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { supabaseAdmin } from "./supabase.ts";
import { buildHistoryContext, type ContentProduct } from "./content-history.ts";
import {
  BLOG_ARTICLE_PROMPT_VERSION,
  buildBlogArticleUserPrompt,
  buildSystemPrompt,
  normalizeTitleSuggestions,
  type BlogArticleOutput,
  type BlogTopicInput,
} from "./content-ai-prompts.ts";

// Blog article generator.
// Reads the curated knowledge docs from content_knowledge, the recent
// history index from content_history_index, then calls Anthropic and
// returns a typed, validated draft ready to write straight into
// blog_posts. Sanitization happens at publish time, not here.

export interface GenerateBlogArticleInput {
  topic: BlogTopicInput;
  // Override the configured default model (e.g. for A/B prompts later).
  model?: string;
  // Override the surface-style knowledge key. Default picks by product_focus.
  styleKey?: string;
}

export interface GenerateBlogArticleResult {
  article: BlogArticleOutput;
  meta: {
    model_used: string;
    prompt_version: string;
    prompt_tokens: number;
    completion_tokens: number;
    latency_ms: number;
  };
}

export interface KnowledgeBundle {
  brandVoice: string;
  surfaceStyle: string;
  pillarMap: string;
}

export async function loadKnowledge(
  productFocus: ContentProduct,
  styleKeyOverride?: string,
): Promise<KnowledgeBundle> {
  const styleKey =
    styleKeyOverride ??
    (productFocus === "flipdesk"
      ? "blog.flipdesk.style"
      : "blog.gradethread.style");

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

// Strips ```json fences if the model wrapped its output despite instructions.
function stripCodeFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Best-effort tag normalization: lowercase, kebab, dedup, cap at 6.
function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of input) {
    if (typeof t !== "string") continue;
    const norm = t.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 6) break;
  }
  return out;
}

// Reading time at ~225 wpm based on visible text length. Coarse but
// good enough for the "X min read" indicator.
function estimateReadingTime(html: string): number {
  const words = html
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 225));
}

function validateAndNormalize(parsed: unknown): BlogArticleOutput {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI response was not a JSON object");
  }
  const p = parsed as Record<string, unknown>;
  const title = String(p.title ?? "").trim();
  if (!title) throw new Error("AI response missing title");
  const bodyHtml = String(p.body_html ?? "").trim();
  if (!bodyHtml) throw new Error("AI response missing body_html");

  return {
    title,
    titleSuggestions: normalizeTitleSuggestions(p.title_suggestions, title),
    slug: slugify(String(p.slug ?? title)),
    excerpt: String(p.excerpt ?? "").trim().slice(0, 240),
    body_html: bodyHtml,
    seo_title: String(p.seo_title ?? title).trim().slice(0, 70),
    seo_description: String(p.seo_description ?? p.excerpt ?? "")
      .trim()
      .slice(0, 170),
    primary_keyword: String(p.primary_keyword ?? "").trim().toLowerCase(),
    secondary_keywords: Array.isArray(p.secondary_keywords)
      ? (p.secondary_keywords as unknown[])
          .map((k) => String(k).trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 8)
      : [],
    tags: normalizeTags(p.tags),
    reading_time_min:
      typeof p.reading_time_min === "number" && p.reading_time_min > 0
        ? Math.round(p.reading_time_min)
        : estimateReadingTime(bodyHtml),
    hero_prompt: String(p.hero_prompt ?? "").trim(),
    // US-876: store concise hero alt/caption produced in the same call (cheap;
    // no extra round-trip). Capped so a verbose model can't blow past sane SEO
    // lengths; empty caption is fine (the SSR omits the <figcaption>).
    hero_image_alt: String(p.hero_image_alt ?? "").trim().slice(0, 160),
    hero_image_caption: String(p.hero_image_caption ?? "").trim().slice(0, 200),
    summary_one_line: String(p.summary_one_line ?? p.excerpt ?? "")
      .trim()
      .slice(0, 160),
  };
}

export async function generateBlogArticle(
  input: GenerateBlogArticleInput,
): Promise<GenerateBlogArticleResult> {
  enterAiFeature("content"); // US-894 spend attribution
  const knowledge = await loadKnowledge(
    input.topic.product_focus,
    input.styleKey,
  );
  const historyContext = await buildHistoryContext({
    surface: "blog",
    productFocus: input.topic.product_focus,
    maxTokens: 3500,
  });

  const systemPrompt = buildSystemPrompt({
    ...knowledge,
    historyContext,
    task: "write-blog-article",
  });
  const userPrompt = buildBlogArticleUserPrompt(input.topic);

  const client = getAnthropicClient();
  const model = input.model ?? getContentModel("blog");
  const temperature = getAiTemperature();
  const startTime = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    ...(temperature !== undefined ? { temperature } : {}),
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const latencyMs = Date.now() - startTime;

  const rawText = extractTextBlock(response, "content-ai-blog");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch {
    console.error("[content-ai-blog] JSON parse failed:", rawText.slice(0, 300));
    throw jsonParseError(response, "content-ai-blog", rawText);
  }
  const article = validateAndNormalize(parsed);

  console.log(
    `[content-ai-blog] generated | model=${model} | product=${input.topic.product_focus} | ` +
      `input_tokens=${response.usage.input_tokens} | output_tokens=${response.usage.output_tokens} | ` +
      `latency_ms=${latencyMs} | title="${article.title}"`,
  );

  return {
    article,
    meta: {
      model_used: model,
      prompt_version: BLOG_ARTICLE_PROMPT_VERSION,
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      latency_ms: latencyMs,
    },
  };
}

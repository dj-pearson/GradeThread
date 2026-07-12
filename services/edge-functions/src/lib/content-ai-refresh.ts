import {
  getAiTemperature,
  getAnthropicClient,
  getContentModel,
} from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { loadKnowledge } from "./content-ai-blog.ts";
import {
  BLOG_REFRESH_PROMPT_VERSION,
  type BlogRefreshInput,
  type BlogRefreshOutput,
  buildBlogRefreshUserPrompt,
  buildSystemPrompt,
} from "./content-ai-prompts.ts";
import type { ContentProduct } from "./content-history.ts";

// US-875: blog article refresh generator.
//
// Mirrors content-ai-blog.ts generateBlogArticle, but for an EXISTING post: it
// feeds the current body + answer blocks back to the model and asks for an
// improved-but-recognizable version. Returns a typed, validated draft. The
// caller (jobs-content-refresh.ts) decides whether the change is material
// before writing — this just produces a candidate. Sanitization happens at the
// caller before persistence, same as generation.

export interface RefreshBlogArticleInput {
  product_focus: ContentProduct;
  refresh: BlogRefreshInput;
  model?: string;
  styleKey?: string;
}

export interface RefreshBlogArticleResult {
  refreshed: BlogRefreshOutput;
  meta: {
    model_used: string;
    prompt_version: string;
    prompt_tokens: number;
    completion_tokens: number;
    latency_ms: number;
  };
}

function stripCodeFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

function normalizeTakeaways(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const t of input) {
    const s = String(t ?? "").trim();
    if (s) out.push(s.slice(0, 280));
    if (out.length >= 6) break;
  }
  return out;
}

function normalizeFaqs(input: unknown): Array<{ q: string; a: string }> {
  if (!Array.isArray(input)) return [];
  const out: Array<{ q: string; a: string }> = [];
  for (const f of input) {
    if (!f || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    const q = String(rec.q ?? "").trim();
    const a = String(rec.a ?? "").trim();
    if (q && a) out.push({ q: q.slice(0, 300), a: a.slice(0, 1200) });
    if (out.length >= 8) break;
  }
  return out;
}

function validateAndNormalize(
  parsed: unknown,
  fallback: BlogRefreshInput,
): BlogRefreshOutput {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI refresh response was not a JSON object");
  }
  const p = parsed as Record<string, unknown>;
  const bodyHtml = String(p.body_html ?? "").trim();
  if (!bodyHtml) throw new Error("AI refresh response missing body_html");

  return {
    body_html: bodyHtml,
    excerpt:
      String(p.excerpt ?? fallback.current_excerpt ?? "").trim().slice(0, 240),
    seo_description: String(p.seo_description ?? p.excerpt ?? "")
      .trim()
      .slice(0, 170),
    key_takeaways: normalizeTakeaways(p.key_takeaways).length > 0
      ? normalizeTakeaways(p.key_takeaways)
      : fallback.current_key_takeaways,
    faqs: normalizeFaqs(p.faqs).length > 0
      ? normalizeFaqs(p.faqs)
      : fallback.current_faqs,
    summary_one_line: String(p.summary_one_line ?? p.excerpt ?? "")
      .trim()
      .slice(0, 160),
    change_summary: String(p.change_summary ?? "").trim().slice(0, 500),
  };
}

export async function refreshBlogArticle(
  input: RefreshBlogArticleInput,
): Promise<RefreshBlogArticleResult> {
  enterAiFeature("content"); // US-894 spend attribution
  const knowledge = await loadKnowledge(input.product_focus, input.styleKey);

  const systemPrompt = buildSystemPrompt({
    ...knowledge,
    historyContext: "",
    task: "refresh-article",
  });
  const userPrompt = buildBlogRefreshUserPrompt(input.refresh);

  const client = getAnthropicClient();
  const model = input.model ?? getContentModel("refresh");
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

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI refresh response contained no text block");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(textBlock.text));
  } catch {
    console.error(
      "[content-ai-refresh] JSON parse failed:",
      textBlock.text.slice(0, 300),
    );
    throw new Error("AI returned invalid JSON for blog refresh");
  }
  const refreshed = validateAndNormalize(parsed, input.refresh);

  console.log(
    `[content-ai-refresh] refreshed | model=${model} | product=${input.product_focus} | ` +
      `input_tokens=${response.usage.input_tokens} | output_tokens=${response.usage.output_tokens} | ` +
      `latency_ms=${latencyMs}`,
  );

  return {
    refreshed,
    meta: {
      model_used: model,
      prompt_version: BLOG_REFRESH_PROMPT_VERSION,
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      latency_ms: latencyMs,
    },
  };
}

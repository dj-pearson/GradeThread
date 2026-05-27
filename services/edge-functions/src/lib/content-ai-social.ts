import {
  getAiTemperature,
  getAnthropicClient,
  getDefaultModel,
} from "./ai-config.ts";
import { supabaseAdmin } from "./supabase.ts";
import { buildHistoryContext, type ContentProduct } from "./content-history.ts";
import {
  buildSocialPostUserPrompt,
  buildSystemPrompt,
  SOCIAL_POST_PROMPT_VERSION,
  type SocialPostOutput,
  type SocialTopicInput,
} from "./content-ai-prompts.ts";

// Paired long-format + short-format generator. One call returns both
// variants so they stay editorially coherent. CTA URL is composed
// upfront with UTM tags and passed into the prompt as a hard
// constraint — the model is told to include it verbatim.

export interface GenerateSocialPostInput {
  topic: Omit<SocialTopicInput, "cta_url">;
  // Override the configured default model.
  model?: string;
  // Optional UTM campaign override. Defaults to a slugified topic title.
  utmCampaign?: string;
}

export interface GenerateSocialPostResult {
  post: SocialPostOutput;
  ctaUrl: string;
  meta: {
    model_used: string;
    prompt_version: string;
    prompt_tokens: number;
    completion_tokens: number;
    latency_ms: number;
  };
}

async function loadSocialKnowledge() {
  const { data, error } = await supabaseAdmin
    .from("content_knowledge")
    .select("key, body_md")
    .in("key", [
      "brand.voice",
      "social.long.style",
      "social.short.style",
      "seo.pillars",
    ]);
  if (error) {
    throw new Error(`Failed to load knowledge docs: ${error.message}`);
  }
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(row.key as string, (row.body_md as string) ?? "");
  }
  // We concatenate the long + short style docs as a single "surface style"
  // section so the generator sees the constraints for both formats at once.
  const longStyle = map.get("social.long.style") ?? "";
  const shortStyle = map.get("social.short.style") ?? "";
  return {
    brandVoice: map.get("brand.voice") ?? "",
    surfaceStyle: `## Long-format rules\n${longStyle}\n\n## Short-format rules\n${shortStyle}`,
    pillarMap: map.get("seo.pillars") ?? "",
  };
}

async function loadPublicSiteUrl(): Promise<string> {
  const { data } = await supabaseAdmin
    .from("content_settings")
    .select("public_site_url")
    .eq("id", 1)
    .maybeSingle();
  const fromDb = (data?.public_site_url as string | undefined)?.trim();
  if (fromDb) return fromDb.replace(/\/$/, "");
  const envUrl = Deno.env.get("PUBLIC_SITE_URL")?.trim();
  return (envUrl ?? "https://gradethread.com").replace(/\/$/, "");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Builds the CTA URL that the generator must use verbatim in both bodies.
// Pattern matches US-250 — utm_source is filled per-platform downstream by
// the publish webhook (Make.com replaces it during fan-out if it wants
// platform-attributed analytics). Here we use a neutral "social" source.
export async function buildSocialCtaUrl(input: {
  productFocus: ContentProduct;
  campaign: string;
}): Promise<string> {
  const base = await loadPublicSiteUrl();
  const path = input.productFocus === "flipdesk" ? "/?focus=flipdesk" : "/";
  const sep = path.includes("?") ? "&" : "?";
  const qs = new URLSearchParams({
    utm_source: "social",
    utm_medium: "social",
    utm_campaign: input.campaign,
  });
  return `${base}${path}${sep}${qs.toString()}`;
}

function stripCodeFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
}

function normalizeHashtags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const h of input) {
    if (typeof h !== "string") continue;
    const norm = h
      .trim()
      .toLowerCase()
      .replace(/^#/, "")
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9_]/g, "");
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 5) break;
  }
  return out;
}

function validate(parsed: unknown): SocialPostOutput {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI response was not a JSON object");
  }
  const p = parsed as Record<string, unknown>;
  const long = String(p.long_body ?? "").trim();
  const short = String(p.short_body ?? "").trim();
  if (!long || !short) {
    throw new Error("AI response missing long_body or short_body");
  }
  // Hard truncate short to 280 — the prompt requests this but defenders
  // shouldn't trust models. Truncate at the last whitespace before 280.
  let shortBody = short;
  if (shortBody.length > 280) {
    const cut = shortBody.lastIndexOf(" ", 277);
    shortBody = `${shortBody.slice(0, cut > 0 ? cut : 277)}…`;
  }
  return {
    long_body: long,
    short_body: shortBody,
    hashtags: normalizeHashtags(p.hashtags),
  };
}

export async function generateSocialPost(
  input: GenerateSocialPostInput,
): Promise<GenerateSocialPostResult> {
  const knowledge = await loadSocialKnowledge();
  const historyContext = await buildHistoryContext({
    surface: "social",
    productFocus: input.topic.product_focus,
    maxTokens: 2500,
  });

  const campaign =
    input.utmCampaign?.trim() || slugify(input.topic.title) || "general";
  const ctaUrl = await buildSocialCtaUrl({
    productFocus: input.topic.product_focus,
    campaign,
  });

  const systemPrompt = buildSystemPrompt({
    ...knowledge,
    historyContext,
    task: "write-social-post",
  });
  const userPrompt = buildSocialPostUserPrompt({
    ...input.topic,
    cta_url: ctaUrl,
  });

  const client = getAnthropicClient();
  const model = input.model ?? getDefaultModel();
  const temperature = getAiTemperature();
  const startTime = Date.now();

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    ...(temperature !== undefined ? { temperature } : {}),
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const latencyMs = Date.now() - startTime;

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("AI response contained no text block");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(textBlock.text));
  } catch {
    console.error(
      "[content-ai-social] JSON parse failed:",
      textBlock.text.slice(0, 300),
    );
    throw new Error("AI returned invalid JSON for social post");
  }
  const post = validate(parsed);

  console.log(
    `[content-ai-social] generated | model=${model} | product=${input.topic.product_focus} | ` +
      `long_len=${post.long_body.length} | short_len=${post.short_body.length} | ` +
      `latency_ms=${latencyMs}`,
  );

  return {
    post,
    ctaUrl,
    meta: {
      model_used: model,
      prompt_version: SOCIAL_POST_PROMPT_VERSION,
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      latency_ms: latencyMs,
    },
  };
}

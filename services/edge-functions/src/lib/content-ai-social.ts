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
  buildSocialPostUserPrompt,
  buildSystemPrompt,
  SOCIAL_POST_PROMPT_VERSION,
  type SocialPostOutput,
  type SocialTopicInput,
  type SocialVariantOutput,
} from "./content-ai-prompts.ts";
import {
  normalizeEnabledPlatforms,
  PLATFORM_CHAR_LIMIT,
  PLATFORM_GENERATION_RULES,
  PLATFORM_IMAGE_FIELD,
  type SocialPlatform,
} from "./social-platforms.ts";

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
  // US-870: which platforms to generate tailored variants for. When omitted,
  // resolved from content_settings.social_platforms (default: all six).
  platforms?: SocialPlatform[];
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

// US-870: which platforms are enabled for fan-out. Read from the singleton
// content_settings row; normalized + defaulted to all six.
export async function loadEnabledPlatforms(): Promise<SocialPlatform[]> {
  const { data } = await supabaseAdmin
    .from("content_settings")
    .select("social_platforms")
    .eq("id", 1)
    .maybeSingle();
  return normalizeEnabledPlatforms(data?.social_platforms);
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

// Truncate body to a hard character ceiling at the last whitespace before the
// limit, appending an ellipsis. Models shouldn't be trusted to honor limits.
function truncateToLimit(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const cut = body.lastIndexOf(" ", limit - 3);
  return `${body.slice(0, cut > 0 ? cut : limit - 1)}…`;
}

// Pull the platform-tailored variants out of the model's `variants` object,
// keeping only the platforms we asked for, truncating each to its limit, and
// stamping the char_limit + image_field from the spec.
function normalizeVariants(
  input: unknown,
  platforms: SocialPlatform[],
): SocialVariantOutput[] {
  const obj = input && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
  const out: SocialVariantOutput[] = [];
  for (const platform of platforms) {
    const raw = obj[platform];
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const body = String(r.body ?? "").trim();
    if (!body) continue;
    const limit = PLATFORM_CHAR_LIMIT[platform];
    out.push({
      platform,
      body: truncateToLimit(body, limit),
      hashtags: normalizeHashtags(r.hashtags),
      char_limit: limit,
      image_field: PLATFORM_IMAGE_FIELD[platform],
    });
  }
  return out;
}

function validate(parsed: unknown, platforms: SocialPlatform[]): SocialPostOutput {
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
  const shortBody = truncateToLimit(short, 280);
  return {
    long_body: long,
    short_body: shortBody,
    hashtags: normalizeHashtags(p.hashtags),
    variants: normalizeVariants(p.variants, platforms),
  };
}

export async function generateSocialPost(
  input: GenerateSocialPostInput,
): Promise<GenerateSocialPostResult> {
  enterAiFeature("content"); // US-894 spend attribution
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

  // US-870: resolve the enabled platforms (explicit override → settings).
  const platforms = input.platforms ?? (await loadEnabledPlatforms());
  const platformSpecs = platforms.map((p) => ({
    platform: p,
    rules: PLATFORM_GENERATION_RULES[p],
  }));

  const systemPrompt = buildSystemPrompt({
    ...knowledge,
    historyContext,
    task: "write-social-post",
  });
  const userPrompt = buildSocialPostUserPrompt(
    {
      ...input.topic,
      cta_url: ctaUrl,
    },
    platformSpecs,
  );

  const client = getAnthropicClient();
  const model = input.model ?? getContentModel("social");
  const temperature = getAiTemperature();
  const startTime = Date.now();

  const response = await client.messages.create({
    model,
    // SEVEN platform variants plus a long and a short body. tiktok joined
    // SOCIAL_PLATFORMS in 4bc9ab30 and this number did not move; the comment
    // here still said six.
    // ⚠️ max_tokens caps THINKING + TEXT on sonnet-5, not text alone. This
    // number was sized on sonnet-4-6, where omitting `thinking` meant no
    // thinking at all — see lib/ai-response-text.ts for the outage that
    // caused. 8192 (b605211fb) was still not enough: 2026-09-02 runs died at
    // output_tokens=8192 with ~4.5k chars of JSON, i.e. ~6.9k tokens of
    // thinking. The non-streaming ceiling plus lower effort (below) is what
    // makes the budget hold — see content-ai-social-budget_test.ts.
    max_tokens: 16384,
    // Copy for a social post is not intelligence-sensitive work. The default
    // effort (high) had the model reasoning through seven character limits
    // for 73-100s and past the budget; medium keeps it inside both the token
    // cap and AI_TIMEOUT_MS (120s).
    output_config: { effort: "medium" },
    ...(temperature !== undefined ? { temperature } : {}),
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const latencyMs = Date.now() - startTime;

  const rawText = extractTextBlock(response, "content-ai-social");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch {
    console.error(
      "[content-ai-social] JSON parse failed:",
      rawText.slice(0, 300),
    );
    throw jsonParseError(response, "content-ai-social", rawText);
  }
  const post = validate(parsed, platforms);

  console.log(
    `[content-ai-social] generated | model=${model} | product=${input.topic.product_focus} | ` +
      `long_len=${post.long_body.length} | short_len=${post.short_body.length} | ` +
      `variants=${post.variants.map((v) => v.platform).join(",") || "none"} | ` +
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

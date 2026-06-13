import { supabaseAdmin } from "./supabase.ts";
import { getDefaultImageModel } from "./ai-config.ts";
import { validateImageUpload } from "./upload-validation.ts";
import { stripImageMetadata } from "./image-metadata.ts";

// OpenAI gpt-image-1 wrapper for hero image generation.
// Returns the raw image bytes; the route handler uploads to the
// content-images bucket and stores the public URL on the post row.
//
// We use OpenAI's REST API directly (not the SDK) to avoid pulling
// another large npm: dependency into Deno when we only need one call.

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

function getOpenAIKey(): string {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }
  return key;
}

export interface GenerateHeroInput {
  prompt: string;
  // Pixel size; gpt-image-1 supports 1024x1024, 1024x1536, 1536x1024.
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  // Quality; 'high' is more expensive but worth it for hero images.
  quality?: "low" | "medium" | "high";
  // Model override. Defaults to gpt-image-1.
  model?: string;
}

export interface GenerateHeroResult {
  bytes: Uint8Array;
  meta: {
    model: string;
    size: string;
    quality: string;
    latency_ms: number;
  };
}

export async function generateHeroImage(
  input: GenerateHeroInput,
): Promise<GenerateHeroResult> {
  // US-853: model comes from the shared ai-config, never hardcoded here.
  const model = input.model ?? getDefaultImageModel();
  const size = input.size ?? "1536x1024";
  const quality = input.quality ?? "high";
  const startTime = Date.now();

  const res = await fetch(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpenAIKey()}`,
    },
    body: JSON.stringify({
      model,
      prompt: input.prompt,
      size,
      quality,
      n: 1,
    }),
  });
  const latency_ms = Date.now() - startTime;

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI images API failed (${res.status}): ${errText}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = json.data?.[0];
  if (!first?.b64_json) {
    throw new Error("OpenAI response missing b64_json image data");
  }
  const bytes = Uint8Array.from(atob(first.b64_json), (c) => c.charCodeAt(0));
  console.log(
    `[openai-images] generated | model=${model} | size=${size} | quality=${quality} | ` +
      `bytes=${bytes.byteLength} | latency_ms=${latency_ms}`,
  );
  return { bytes, meta: { model, size, quality, latency_ms } };
}

export interface UploadHeroInput {
  postId: string;
  bytes: Uint8Array;
  contentType?: string; // default image/png
  ext?: string; // file extension without dot; derived from contentType if omitted
  surface?: "blog" | "social";
}

export interface UploadHeroResult {
  url: string;
  path: string;
}

// Uploads bytes to content-images/<surface>/<postId>/hero_<ts>.<ext> and
// returns the public URL. Service-role client bypasses RLS.
export async function uploadHeroImage(
  input: UploadHeroInput,
): Promise<UploadHeroResult> {
  const surface = input.surface ?? "blog";
  const contentType = input.contentType ?? "image/png";
  const ext = input.ext ?? (contentType.includes("jpeg") ? "jpg" : "png");
  const path = `${surface}/${input.postId}/hero_${Date.now()}.${ext}`;

  const { error: upErr } = await supabaseAdmin.storage
    .from("content-images")
    .upload(path, input.bytes, {
      contentType,
      upsert: false,
      cacheControl: "31536000",
    });
  if (upErr) {
    throw new Error(`Failed to upload hero: ${upErr.message}`);
  }
  const { data } = supabaseAdmin.storage.from("content-images").getPublicUrl(path);
  return { url: data.publicUrl, path };
}

// US-853: resolve the generation prompt deterministically.
// Priority: explicit override → stored hero_prompt → title-based fallback →
// generic fallback. Pure (no I/O) so it's unit-testable.
export function resolveHeroPrompt(
  post: { hero_prompt?: string | null; title?: string | null },
  override?: string | null,
): string {
  const ovr = override?.trim();
  if (ovr) return ovr;
  const stored = post.hero_prompt?.trim();
  if (stored) return stored;
  const title = post.title?.trim();
  if (title) {
    return (
      `Editorial photograph for an article titled "${title}". ` +
      `Photographic realism, clean composition, no text in the image.`
    );
  }
  return "Editorial photograph for a reseller-focused blog. Photographic realism, no text in the image.";
}

export interface EnsureHeroInput {
  postId: string;
  surface?: "blog" | "social";
  prompt?: string; // explicit override; otherwise resolved from the post row
  size?: GenerateHeroInput["size"];
  quality?: GenerateHeroInput["quality"];
  // Regenerate even if a hero already exists. The autonomous generate/publish
  // pipeline leaves this false (idempotent); the manual dashboard button sets it.
  force?: boolean;
}

export interface EnsureHeroResult {
  status: "generated" | "skipped" | "failed";
  url?: string;
  path?: string;
  prompt?: string;
  reason?: string;
  meta?: GenerateHeroResult["meta"];
}

// US-853: idempotent, best-effort hero-image pipeline shared by the manual
// /hero route, the blog generate/publish handlers, and the autonomous
// scheduler. Generates from the stored hero_prompt via the shared image model,
// validates + strips metadata, uploads to the PUBLIC content-images bucket on a
// stable path, and stamps hero_image_url on the post row.
//
// NEVER THROWS — a generation failure returns { status: "failed" } so callers
// can fire-and-forget without ever blocking a publish.
export async function ensureHeroImage(
  input: EnsureHeroInput,
): Promise<EnsureHeroResult> {
  const surface = input.surface ?? "blog";
  const table = surface === "blog" ? "blog_posts" : "social_posts";
  const urlCol = surface === "blog" ? "hero_image_url" : "asset_image_url";
  const pathCol = surface === "blog" ? "hero_image_path" : "asset_image_path";

  try {
    const { data: post, error: loadErr } = await supabaseAdmin
      .from(table)
      .select(
        surface === "blog"
          ? "hero_image_url, hero_prompt, title"
          : "asset_image_url",
      )
      .eq("id", input.postId)
      .maybeSingle();
    if (loadErr) return { status: "failed", reason: loadErr.message };
    if (!post) return { status: "failed", reason: "post not found" };

    const row = post as {
      hero_image_url?: string | null;
      asset_image_url?: string | null;
      hero_prompt?: string | null;
      title?: string | null;
    };

    // Idempotent: don't regenerate if a hero already exists (unless forced).
    const existing = surface === "blog" ? row.hero_image_url : row.asset_image_url;
    if (!input.force && existing) {
      return { status: "skipped", reason: "hero already exists", url: existing };
    }

    const prompt = resolveHeroPrompt(row, input.prompt);

    const gen = await generateHeroImage({
      prompt,
      size: input.size,
      quality: input.quality,
    });

    // Validate + strip metadata before it lands in a public bucket. gpt-image-1
    // returns PNG; if a sniff quirk fails validation we still upload (best-
    // effort) as PNG rather than dropping the hero.
    const verdict = validateImageUpload(gen.bytes, {
      allow: ["jpeg", "png", "webp"],
    });
    let bytes = gen.bytes;
    let contentType = "image/png";
    let ext = "png";
    if (verdict.ok) {
      const stripped = stripImageMetadata(gen.bytes, verdict.format);
      bytes = stripped.bytes;
      contentType = verdict.contentType;
      ext = verdict.ext;
    } else {
      console.warn(
        `[openai-images] hero failed image validation (${verdict.reason}); ` +
          `uploading raw bytes as PNG`,
      );
    }

    const uploaded = await uploadHeroImage({
      postId: input.postId,
      bytes,
      contentType,
      ext,
      surface,
    });

    const updateCols: Record<string, string> = {
      [urlCol]: uploaded.url,
      [pathCol]: uploaded.path,
    };
    if (surface === "blog") updateCols.hero_prompt = prompt;
    await supabaseAdmin.from(table).update(updateCols).eq("id", input.postId);

    return {
      status: "generated",
      url: uploaded.url,
      path: uploaded.path,
      prompt,
      meta: gen.meta,
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[openai-images] ensureHeroImage failed: ${reason}`);
    return { status: "failed", reason };
  }
}

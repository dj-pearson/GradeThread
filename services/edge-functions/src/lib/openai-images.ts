import { supabaseAdmin } from "./supabase.ts";

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
  const model = input.model ?? "gpt-image-1";
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
  surface?: "blog" | "social";
}

export interface UploadHeroResult {
  url: string;
  path: string;
}

// Uploads bytes to content-images/<surface>/<postId>/hero_<ts>.png and
// returns the public URL. Service-role client bypasses RLS.
export async function uploadHeroImage(
  input: UploadHeroInput,
): Promise<UploadHeroResult> {
  const surface = input.surface ?? "blog";
  const contentType = input.contentType ?? "image/png";
  const ext = contentType.includes("jpeg") ? "jpg" : "png";
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

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { ensureHeroImage } from "../lib/openai-images.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import {
  buildSocialCardUrl,
  deriveCardText,
  type SocialCardRatio,
} from "../lib/social-platforms.ts";

// Image endpoints for the content module.
//   POST /hero    — synchronous AI generation + storage upload, updates the post row.
//   POST /inline  — returns a signed upload URL the editor can PUT to for manual uploads.
//
// Both endpoints are admin-gated by the /api/content/* middleware in main.ts.

type Env = { Variables: { userId: string } };
export const contentImagesRoutes = new Hono<Env>();

interface HeroInput {
  post_id: string;
  prompt?: string; // optional override; otherwise we use blog_posts.hero_prompt
  surface?: "blog" | "social";
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  quality?: "low" | "medium" | "high";
}

contentImagesRoutes.post("/hero", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as HeroInput;
  if (!body.post_id) {
    return c.json({ error: "post_id is required" }, 400);
  }
  const surface = body.surface ?? "blog";

  // Manual dashboard button → force regenerate even if a hero already exists.
  // Prompt/metadata resolution, validation, stripping, upload, and persistence
  // all live in the shared ensureHeroImage pipeline (US-853).
  const result = await ensureHeroImage({
    postId: body.post_id,
    surface,
    prompt: body.prompt,
    size: body.size,
    quality: body.quality,
    force: true,
  });
  if (result.status === "failed") {
    console.error("[content-images] hero generation failed:", result.reason);
    return c.json({ error: result.reason ?? "hero generation failed" }, 500);
  }
  return c.json({
    url: result.url,
    path: result.path,
    prompt: result.prompt,
    meta: result.meta,
  });
});

// US-871: set or override a social post's branded card.
//   - With `image_base64` → an admin OVERRIDE: validate (magic-byte sniff) +
//     strip EXIF/GPS, upload to the public content-images bucket, and point the
//     post at it. Mirrors the /hero upload-hardening pipeline.
//   - Without it → REGENERATE: point the post at the auto branded
//     /og/social/card URL derived from its body (no stored bytes).
interface SocialCardInput {
  post_id: string;
  ratio?: SocialCardRatio;
  kind?: "title" | "quote" | "stat";
  text?: string; // override the derived pull-quote
  image_base64?: string; // override: raw base64 (no data: prefix needed)
}

const CARD_RATIOS = new Set<SocialCardRatio>([
  "landscape",
  "square",
  "portrait",
  "pin",
]);

async function resolvePublicSiteUrl(): Promise<string> {
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

contentImagesRoutes.post("/social-card", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SocialCardInput;
  if (!body.post_id) return c.json({ error: "post_id is required" }, 400);

  const { data: post, error: loadErr } = await supabaseAdmin
    .from("social_posts")
    .select("id, short_body, long_body, product_focus")
    .eq("id", body.post_id)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!post) return c.json({ error: "Not found" }, 404);

  // ── OVERRIDE: a custom upload ──────────────────────────────
  if (body.image_base64) {
    let bytes: Uint8Array;
    try {
      const b64 = body.image_base64.replace(/^data:[^;]+;base64,/, "");
      bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    } catch {
      return c.json({ error: "image_base64 is not valid base64" }, 400);
    }

    const verdict = validateImageUpload(bytes, { allow: ["jpeg", "png", "webp"] });
    if (!verdict.ok) return c.json({ error: verdict.reason }, 400);

    const stripped = stripImageMetadata(bytes, verdict.format);
    const path = `social/${post.id}/card_${Date.now()}.${verdict.ext}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from("content-images")
      .upload(path, stripped.bytes, {
        contentType: verdict.contentType,
        upsert: false,
        cacheControl: "31536000",
      });
    if (upErr) return c.json({ error: upErr.message }, 500);

    const { data: pub } = supabaseAdmin.storage
      .from("content-images")
      .getPublicUrl(path);

    const { error: updErr } = await supabaseAdmin
      .from("social_posts")
      .update({ asset_image_url: pub.publicUrl, asset_image_path: path })
      .eq("id", post.id);
    if (updErr) return c.json({ error: updErr.message }, 500);

    return c.json({ url: pub.publicUrl, path, source: "upload" });
  }

  // ── REGENERATE: point at the auto branded card URL ─────────
  const ratio = body.ratio && CARD_RATIOS.has(body.ratio) ? body.ratio : "landscape";
  const text = body.text?.trim() ||
    deriveCardText(post.short_body || post.long_body || "");
  const url = buildSocialCardUrl({
    siteUrl: await resolvePublicSiteUrl(),
    ratio,
    kind: body.kind ?? "quote",
    text,
    product: post.product_focus,
  });

  // A regenerated branded card has no stored bytes, so clear asset_image_path.
  const { error: updErr } = await supabaseAdmin
    .from("social_posts")
    .update({ asset_image_url: url, asset_image_path: null })
    .eq("id", post.id);
  if (updErr) return c.json({ error: updErr.message }, 500);

  return c.json({ url, path: null, source: "card" });
});

interface InlineUploadInput {
  post_id: string;
  filename: string; // e.g. "diagram.png"
  surface?: "blog" | "social";
}

contentImagesRoutes.post("/inline", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as InlineUploadInput;
  if (!body.post_id || !body.filename) {
    return c.json({ error: "post_id and filename are required" }, 400);
  }
  const surface = body.surface ?? "blog";
  const safeName = body.filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  const path = `${surface}/${body.post_id}/inline_${Date.now()}_${safeName}`;

  const { data, error } = await supabaseAdmin.storage
    .from("content-images")
    .createSignedUploadUrl(path);
  if (error) return c.json({ error: error.message }, 500);

  const { data: pub } = supabaseAdmin.storage
    .from("content-images")
    .getPublicUrl(path);

  return c.json({
    upload_url: data.signedUrl,
    token: data.token,
    path,
    public_url: pub.publicUrl,
  });
});

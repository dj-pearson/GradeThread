import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
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
  if (loadErr) return failSafe(c, 500, "Couldn't load the post.", loadErr, "content.images.social-card.load");
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
    if (upErr) return failSafe(c, 500, "Couldn't upload the image.", upErr, "content.images.social-card.upload");

    const { data: pub } = supabaseAdmin.storage
      .from("content-images")
      .getPublicUrl(path);

    const { error: updErr } = await supabaseAdmin
      .from("social_posts")
      .update({ asset_image_url: pub.publicUrl, asset_image_path: path })
      .eq("id", post.id);
    if (updErr) return failSafe(c, 500, "Couldn't save the image.", updErr, "content.images.social-card.update");

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
  if (updErr) return failSafe(c, 500, "Couldn't save the image.", updErr, "content.images.social-card.finalize");

  return c.json({ url, path: null, source: "card" });
});

interface InlineUploadInput {
  post_id: string;
  filename: string; // e.g. "diagram.png"
  surface?: "blog" | "social";
  // US-876: optional image-SEO metadata persisted onto blog_posts.inline_images
  // so the blog SSR can emit a real alt + <figcaption> for this in-body image.
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
}

interface InlineImageMetaRow {
  src: string;
  alt: string;
  caption: string;
  width: number | null;
  height: number | null;
}

contentImagesRoutes.post("/inline", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as InlineUploadInput;
  if (!body.post_id || !body.filename) {
    return c.json({ error: "post_id and filename are required" }, 400);
  }
  const surface = body.surface ?? "blog";
  // US-876: descriptive, slug-ish inline filename (sanitized) for image SEO.
  const safeName = body.filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  const path = `${surface}/${body.post_id}/inline_${Date.now()}_${safeName}`;

  const { data, error } = await supabaseAdmin.storage
    .from("content-images")
    .createSignedUploadUrl(path);
  if (error) return failSafe(c, 500, "Couldn't add the inline image.", error, "content.images.inline");

  const { data: pub } = supabaseAdmin.storage
    .from("content-images")
    .getPublicUrl(path);

  // US-876: persist any supplied alt/caption/dimensions keyed by the public URL.
  // Only blog posts carry inline_images; social cards don't have a body to embed.
  if (surface === "blog" && (body.alt || body.caption || body.width || body.height)) {
    await upsertInlineImageMeta(body.post_id, {
      src: pub.publicUrl,
      alt: (body.alt ?? "").trim(),
      caption: (body.caption ?? "").trim(),
      width: typeof body.width === "number" && body.width > 0 ? body.width : null,
      height: typeof body.height === "number" && body.height > 0 ? body.height : null,
    });
  }

  return c.json({
    upload_url: data.signedUrl,
    token: data.token,
    path,
    public_url: pub.publicUrl,
  });
});

// US-876: read-modify-write blog_posts.inline_images, upserting one entry by src
// (the public URL). Best-effort — a metadata failure must never fail the upload.
async function upsertInlineImageMeta(
  postId: string,
  meta: InlineImageMetaRow,
): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin
      .from("blog_posts")
      .select("inline_images")
      .eq("id", postId)
      .maybeSingle();
    if (error || !data) return;
    const existing = Array.isArray((data as { inline_images?: unknown }).inline_images)
      ? ((data as { inline_images: InlineImageMetaRow[] }).inline_images)
      : [];
    const next = existing.filter((m) => m && m.src !== meta.src);
    next.push(meta);
    await supabaseAdmin
      .from("blog_posts")
      .update({ inline_images: next })
      .eq("id", postId);
  } catch (e) {
    console.warn(
      `[content-images] inline_images upsert failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

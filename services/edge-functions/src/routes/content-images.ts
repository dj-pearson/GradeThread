import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { generateHeroImage, uploadHeroImage } from "../lib/openai-images.ts";

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
  const table = surface === "blog" ? "blog_posts" : "social_posts";

  // Resolve the prompt: explicit override > stored hero_prompt > title-based fallback.
  let prompt = body.prompt?.trim();
  if (!prompt) {
    const { data: post, error } = await supabaseAdmin
      .from(table)
      .select(surface === "blog" ? "hero_prompt, title, product_focus" : "product_focus")
      .eq("id", body.post_id)
      .maybeSingle();
    if (error) return c.json({ error: error.message }, 500);
    if (!post) return c.json({ error: "Post not found" }, 404);
    const p = post as { hero_prompt?: string; title?: string; product_focus?: string };
    prompt =
      p.hero_prompt?.trim() ||
      (p.title
        ? `Editorial photograph for an article titled "${p.title}". Photographic realism, clean composition, no text in the image.`
        : "Editorial photograph for a reseller-focused blog. Photographic realism, no text in the image.");
  }

  try {
    const gen = await generateHeroImage({
      prompt,
      size: body.size,
      quality: body.quality,
    });
    const uploaded = await uploadHeroImage({
      postId: body.post_id,
      bytes: gen.bytes,
      contentType: "image/png",
      surface,
    });

    // Persist on the post row.
    const updateCols =
      surface === "blog"
        ? {
            hero_image_url: uploaded.url,
            hero_image_path: uploaded.path,
            hero_prompt: prompt,
          }
        : { asset_image_url: uploaded.url, asset_image_path: uploaded.path };
    await supabaseAdmin
      .from(table)
      .update(updateCols)
      .eq("id", body.post_id);

    return c.json({
      url: uploaded.url,
      path: uploaded.path,
      prompt,
      meta: gen.meta,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[content-images] hero generation failed:", msg);
    return c.json({ error: msg }, 500);
  }
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

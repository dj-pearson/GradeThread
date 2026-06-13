import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { ensureHeroImage } from "../lib/openai-images.ts";

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

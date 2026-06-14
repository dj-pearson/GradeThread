import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { appendToHistoryIndex } from "../lib/content-history.ts";
import { generateSocialPost } from "../lib/content-ai-social.ts";
import {
  fireSocialWebhooks,
  loadSocialVariants,
  persistSocialVariants,
} from "../lib/content-social-publish.ts";
import { isSocialPlatform } from "../lib/social-platforms.ts";
import {
  getAiTemperature,
  getAnthropicClient,
  getLightweightModel,
} from "../lib/ai-config.ts";

// Social posts CRUD + lifecycle. One row carries BOTH long and short
// variants so the editorial pairing stays atomic. Publish fires one
// webhook per format (Phase E).

type Env = { Variables: { userId: string } };
export const contentSocialRoutes = new Hono<Env>();

type ContentProduct = "gradethread" | "flipdesk" | "both";

interface CreateInput {
  product_focus?: ContentProduct;
  topic_id?: string | null;
  long_body?: string;
  short_body?: string;
  hashtags?: string[];
  cta_url?: string;
  asset_image_url?: string;
  generated_by?: "ai" | "human";
}

interface UpdateInput extends Partial<CreateInput> {
  status?: "draft" | "scheduled" | "published" | "archived" | "failed";
  scheduled_for?: string | null;
  asset_image_path?: string | null;
}

// ── LIST ─────────────────────────────────────────────────
contentSocialRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const productFocus = c.req.query("product_focus");
  const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200);

  let q = supabaseAdmin
    .from("social_posts")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  if (productFocus) q = q.eq("product_focus", productFocus);

  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ posts: data ?? [] });
});

// ── READ ─────────────────────────────────────────────────
contentSocialRoutes.get("/:id", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("social_posts")
    .select("*")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ post: data });
});

// ── CREATE ───────────────────────────────────────────────
contentSocialRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as CreateInput;
  const { data, error } = await supabaseAdmin
    .from("social_posts")
    .insert({
      product_focus: body.product_focus ?? "gradethread",
      topic_id: body.topic_id ?? null,
      long_body: body.long_body ?? "",
      short_body: body.short_body ?? "",
      hashtags: body.hashtags ?? [],
      cta_url: body.cta_url ?? null,
      asset_image_url: body.asset_image_url ?? null,
      generated_by: body.generated_by ?? "human",
      status: "draft",
    })
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ post: data });
});

// ── UPDATE (autosave) ────────────────────────────────────
contentSocialRoutes.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as UpdateInput;
  const { data, error } = await supabaseAdmin
    .from("social_posts")
    .update(body)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ post: data });
});

// ── DELETE ───────────────────────────────────────────────
contentSocialRoutes.delete("/:id", async (c) => {
  const { error } = await supabaseAdmin
    .from("social_posts")
    .delete()
    .eq("id", c.req.param("id"));
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// ── PUBLISH ──────────────────────────────────────────────
contentSocialRoutes.post("/:id/publish", async (c) => {
  const id = c.req.param("id");
  const { data: post, error: loadErr } = await supabaseAdmin
    .from("social_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!post) return c.json({ error: "Not found" }, 404);
  if (!post.long_body?.trim() && !post.short_body?.trim()) {
    return c.json({ error: "long_body or short_body must be set" }, 400);
  }

  const now = new Date().toISOString();
  const { data: updated, error: upErr } = await supabaseAdmin
    .from("social_posts")
    .update({ status: "published", published_at: now })
    .eq("id", id)
    .select("*")
    .single();
  if (upErr) return c.json({ error: upErr.message }, 500);

  if (updated.topic_id) {
    await supabaseAdmin
      .from("content_topics")
      .update({ status: "used", used_by_post_id: updated.id, used_at: now })
      .eq("id", updated.topic_id);
  }

  // For history, condense whichever body is set into the one-line summary.
  const summary =
    (updated.short_body || updated.long_body || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || null;

  await appendToHistoryIndex({
    surface: "social",
    product_focus: updated.product_focus,
    post_id: updated.id,
    title: summary ?? "social post",
    primary_keyword: null,
    secondary_keywords: updated.hashtags ?? [],
    summary_one_line: summary,
    published_at: now,
  }).catch((e) => console.error("[content-social] history append failed:", e));

  // US-870: fan one social.published webhook out per ENABLED platform that has
  // a tailored variant (falls back to long/short for variant-less posts).
  // Best-effort: errors are logged in content_webhook_log; publish succeeds
  // even if delivery fails.
  fireSocialWebhooks(updated, now).catch((e) =>
    console.error("[content-social] webhook dispatch failed:", e),
  );

  return c.json({ post: updated });
});

// ── SCHEDULE ─────────────────────────────────────────────
contentSocialRoutes.post("/:id/schedule", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    scheduled_for?: string;
  };
  if (!body.scheduled_for) {
    return c.json({ error: "scheduled_for is required" }, 400);
  }
  const { data, error } = await supabaseAdmin
    .from("social_posts")
    .update({ status: "scheduled", scheduled_for: body.scheduled_for })
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json({ post: data });
});

// ── SUGGEST HASHTAGS ─────────────────────────────────────
// Cheap Haiku call. Returns 5-8 deduped, lowercased hashtags suitable
// for the body's product/topic. The editor appends them to the chip
// input, leaving the user in control.
contentSocialRoutes.post("/:id/suggest-hashtags", async (c) => {
  const id = c.req.param("id");
  const { data: post } = await supabaseAdmin
    .from("social_posts")
    .select("long_body, short_body, product_focus")
    .eq("id", id)
    .maybeSingle();
  if (!post) return c.json({ error: "Not found" }, 404);

  const body = (post.long_body || post.short_body || "").trim();
  if (!body) return c.json({ error: "Post body is empty" }, 400);

  const userPrompt = [
    "Suggest 5-8 hashtags for the following social post.",
    "",
    `Product focus: ${post.product_focus}`,
    "Body:",
    body.slice(0, 1500),
    "",
    "Rules:",
    "- Lowercase, no spaces, no '#' prefix in the array values.",
    "- Mix general (reselling, thrifting) with specific (vintageclothing, ebayreseller).",
    "- Skip generic spam tags (follow4follow etc.).",
    "",
    'Return JSON: { "hashtags": ["reselling", "thrifting", "..."] }',
  ].join("\n");

  try {
    const client = getAnthropicClient();
    const model = getLightweightModel();
    const temperature = getAiTemperature();
    const response = await client.messages.create({
      model,
      max_tokens: 256,
      ...(temperature !== undefined ? { temperature } : {}),
      messages: [{ role: "user", content: userPrompt }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return c.json({ error: "AI response missing text" }, 502);
    }
    const cleaned = textBlock.text
      .trim()
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "");
    const parsed = JSON.parse(cleaned) as { hashtags?: unknown };
    const out: string[] = [];
    const seen = new Set<string>();
    if (Array.isArray(parsed.hashtags)) {
      for (const h of parsed.hashtags) {
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
        if (out.length >= 8) break;
      }
    }
    return c.json({ hashtags: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[content-social] suggest-hashtags failed:", msg);
    return c.json({ error: msg }, 500);
  }
});

// ── AI GENERATE ───────────────────────────────────────────
// Body (all optional — uses the linked topic + post fields as fallback):
//   { topic?: { title, angle?, primary_keyword, product_focus? }, model?, utm_campaign? }
contentSocialRoutes.post("/:id/generate", async (c) => {
  const id = c.req.param("id");
  const overrideBody = (await c.req.json().catch(() => ({}))) as {
    topic?: {
      title?: string;
      angle?: string;
      primary_keyword?: string;
      product_focus?: "gradethread" | "flipdesk" | "both";
    };
    model?: string;
    utm_campaign?: string;
  };

  const { data: post, error: loadErr } = await supabaseAdmin
    .from("social_posts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!post) return c.json({ error: "Not found" }, 404);

  // Resolve the topic. Priority: explicit override → linked content_topic
  // → derive from existing post.long_body title-line (last resort).
  let topicTitle = overrideBody.topic?.title;
  let topicAngle: string | null = overrideBody.topic?.angle ?? null;
  let primaryKw = overrideBody.topic?.primary_keyword;
  const productFocus = overrideBody.topic?.product_focus ?? post.product_focus;

  if ((!topicTitle || !primaryKw || !topicAngle) && post.topic_id) {
    const { data: topic } = await supabaseAdmin
      .from("content_topics")
      .select("title, angle, primary_keyword")
      .eq("id", post.topic_id)
      .maybeSingle();
    if (topic) {
      topicTitle = topicTitle ?? topic.title;
      topicAngle = topicAngle ?? topic.angle ?? null;
      primaryKw = primaryKw ?? topic.primary_keyword;
    }
  }

  if (!topicTitle || !primaryKw) {
    return c.json(
      {
        error:
          "topic title + primary_keyword required (link a topic_id or pass topic in the body)",
      },
      400,
    );
  }

  try {
    const result = await generateSocialPost({
      topic: {
        title: topicTitle,
        angle: topicAngle,
        primary_keyword: primaryKw,
        product_focus: productFocus,
      },
      model: overrideBody.model,
      utmCampaign: overrideBody.utm_campaign,
    });

    const { data: updated, error: upErr } = await supabaseAdmin
      .from("social_posts")
      .update({
        long_body: result.post.long_body,
        short_body: result.post.short_body,
        hashtags: result.post.hashtags,
        cta_url: result.ctaUrl,
        generated_by: "ai" as const,
        model_used: result.meta.model_used,
        prompt_tokens: result.meta.prompt_tokens,
        completion_tokens: result.meta.completion_tokens,
      })
      .eq("id", id)
      .select("*")
      .single();
    if (upErr) return c.json({ error: upErr.message }, 500);

    // US-870: (re)write the per-platform variant rows from this generation.
    await persistSocialVariants(id, result.post.variants);
    const variants = await loadSocialVariants(id);

    return c.json({ post: updated, variants, meta: result.meta });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[content-social] generate failed:", msg);
    return c.json({ error: msg }, 500);
  }
});

// ── PLATFORM VARIANTS (US-870) ────────────────────────────
// List the per-platform variants for a post.
contentSocialRoutes.get("/:id/variants", async (c) => {
  const id = c.req.param("id");
  const { data: post } = await supabaseAdmin
    .from("social_posts")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!post) return c.json({ error: "Not found" }, 404);
  const variants = await loadSocialVariants(id);
  return c.json({ variants });
});

// Edit a single platform variant before publish (body + hashtags). The editor
// tweaks each tailored variant independently.
contentSocialRoutes.patch("/:id/variants/:platform", async (c) => {
  const id = c.req.param("id");
  const platform = c.req.param("platform");
  if (!isSocialPlatform(platform)) {
    return c.json({ error: "Unknown platform" }, 400);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    body?: string;
    hashtags?: string[];
  };

  // Confirm the parent post (and thus the variant) belongs to this content
  // surface before mutating — variants are admin-only but we still scope writes
  // to a real post row.
  const { data: post } = await supabaseAdmin
    .from("social_posts")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (!post) return c.json({ error: "Not found" }, 404);

  const patch: Record<string, unknown> = {};
  if (typeof body.body === "string") patch.body = body.body;
  if (Array.isArray(body.hashtags)) {
    patch.hashtags = body.hashtags
      .filter((h): h is string => typeof h === "string")
      .map((h) => h.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, ""))
      .filter(Boolean);
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "Nothing to update" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("social_platform_variants")
    .update(patch)
    .eq("social_post_id", id)
    .eq("platform", platform)
    .select("platform, body, hashtags, image_field, char_limit")
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: "Variant not found" }, 404);
  return c.json({ variant: data });
});

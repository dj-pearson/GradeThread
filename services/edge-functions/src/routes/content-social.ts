import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { appendToHistoryIndex } from "../lib/content-history.ts";
import { generateSocialPost } from "../lib/content-ai-social.ts";
import { dispatchContentWebhook } from "../lib/content-webhook.ts";

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

  // Fire one webhook per non-empty format. We do this concurrently
  // because LI/FB and X/Threads have separate Make.com scenarios.
  // Best-effort: errors are logged in content_webhook_log; publish
  // succeeds even if both webhooks fail.
  const fires: Promise<unknown>[] = [];
  if (updated.long_body?.trim()) {
    fires.push(
      dispatchContentWebhook({
        event: "social.published",
        format: "long",
        timestamp: now,
        data: {
          id: updated.id,
          body: updated.long_body,
          hashtags: updated.hashtags ?? [],
          cta_url: updated.cta_url ?? null,
          product_focus: updated.product_focus,
        },
      }),
    );
  }
  if (updated.short_body?.trim()) {
    fires.push(
      dispatchContentWebhook({
        event: "social.published",
        format: "short",
        timestamp: now,
        data: {
          id: updated.id,
          body: updated.short_body,
          hashtags: updated.hashtags ?? [],
          cta_url: updated.cta_url ?? null,
          product_focus: updated.product_focus,
        },
      }),
    );
  }
  Promise.all(fires).catch((e) =>
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

    return c.json({ post: updated, meta: result.meta });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[content-social] generate failed:", msg);
    return c.json({ error: msg }, 500);
  }
});

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { dispatchContentWebhook } from "../lib/content-webhook.ts";

// Singleton settings table (id=1). The dashboard's Content Settings page
// reads/writes here for webhook URLs, auto-publish toggles, cadence,
// and default model IDs. The scheduler tick (Phase E) reads cadence
// and auto_publish flags to decide what to do.

type Env = { Variables: { userId: string } };
export const contentSettingsRoutes = new Hono<Env>();

const SETTINGS_ID = 1;

contentSettingsRoutes.get("/", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("content_settings")
    .select("*")
    .eq("id", SETTINGS_ID)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) {
    // Self-heal: if the migration's seed row was deleted, recreate it.
    const { data: created, error: insErr } = await supabaseAdmin
      .from("content_settings")
      .insert({ id: SETTINGS_ID })
      .select("*")
      .single();
    if (insErr) return c.json({ error: insErr.message }, 500);
    return c.json({ settings: created });
  }
  return c.json({ settings: data });
});

interface SettingsPatch {
  make_webhook_blog?: string | null;
  make_webhook_social_long?: string | null;
  make_webhook_social_short?: string | null;
  auto_publish_blog?: boolean;
  auto_publish_social?: boolean;
  default_blog_model?: string;
  default_social_model?: string;
  default_research_model?: string;
  default_image_model?: string;
  min_topics_in_bank?: number;
  topics_refill_batch?: number;
  post_cadence_per_day_blog?: number;
  post_cadence_per_day_social?: number;
  public_site_url?: string;
  // US-486: kill-switch + weekly auto-publish ceiling.
  publishing_paused?: boolean;
  max_auto_publishes_per_week?: number;
}

contentSettingsRoutes.patch("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SettingsPatch;

  // Drop unknown keys defensively.
  const allowed: (keyof SettingsPatch)[] = [
    "make_webhook_blog",
    "make_webhook_social_long",
    "make_webhook_social_short",
    "auto_publish_blog",
    "auto_publish_social",
    "default_blog_model",
    "default_social_model",
    "default_research_model",
    "default_image_model",
    "min_topics_in_bank",
    "topics_refill_batch",
    "post_cadence_per_day_blog",
    "post_cadence_per_day_social",
    "public_site_url",
    "publishing_paused",
    "max_auto_publishes_per_week",
  ];
  const patch: Partial<SettingsPatch> = {};
  for (const k of allowed) {
    if (k in body) (patch as Record<string, unknown>)[k] = body[k];
  }

  const { data, error } = await supabaseAdmin
    .from("content_settings")
    .upsert({ id: SETTINGS_ID, ...patch }, { onConflict: "id" })
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ settings: data });
});

// ── Dashboard stats ──────────────────────────────────────
// Aggregates everything the analytics page needs in one round-trip so
// the page renders in a single fetch. Fast (just COUNT queries) and
// safe to call frequently.
contentSettingsRoutes.get("/stats", async (c) => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const since7 = new Date(now - 7 * day).toISOString();
  const since30 = new Date(now - 30 * day).toISOString();

  // Topic bank levels per (surface, product_focus, status). One SELECT,
  // bucketed in JS — cheap because the topics table stays small.
  const { data: topicRows } = await supabaseAdmin
    .from("content_topics")
    .select("surface, product_focus, status");
  const bank: Record<string, number> = {};
  for (const r of topicRows ?? []) {
    const k = `${r.surface}:${r.product_focus}:${r.status}`;
    bank[k] = (bank[k] ?? 0) + 1;
  }

  // Posts published, last 7d + last 30d, per (surface, product_focus).
  async function countPublished(table: "blog_posts" | "social_posts", since: string) {
    const { data } = await supabaseAdmin
      .from(table)
      .select("product_focus")
      .eq("status", "published")
      .gte("published_at", since);
    const out: Record<string, number> = {};
    for (const r of data ?? []) {
      out[r.product_focus as string] = (out[r.product_focus as string] ?? 0) + 1;
    }
    return out;
  }
  const [blog7, blog30, social7, social30] = await Promise.all([
    countPublished("blog_posts", since7),
    countPublished("blog_posts", since30),
    countPublished("social_posts", since7),
    countPublished("social_posts", since30),
  ]);

  // Webhook health: success rate over the last 100 attempts, plus the
  // raw failed-count over the last 7 days (drives a "needs attention" badge).
  const { data: recentDeliveries } = await supabaseAdmin
    .from("content_webhook_log")
    .select("succeeded, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  const succeeded = (recentDeliveries ?? []).filter((r) => r.succeeded).length;
  const totalRecent = recentDeliveries?.length ?? 0;
  const successRate = totalRecent > 0 ? succeeded / totalRecent : null;
  const { count: failed7Count } = await supabaseAdmin
    .from("content_webhook_log")
    .select("id", { count: "exact", head: true })
    .eq("succeeded", false)
    .gte("created_at", since7);

  // AI token usage. Sum prompt_tokens + completion_tokens across blog +
  // social posts created in the last 30 days. Coarse but useful for
  // ballparking API spend.
  const [{ data: blogTokens }, { data: socialTokens }] = await Promise.all([
    supabaseAdmin
      .from("blog_posts")
      .select("prompt_tokens, completion_tokens")
      .gte("created_at", since30),
    supabaseAdmin
      .from("social_posts")
      .select("prompt_tokens, completion_tokens")
      .gte("created_at", since30),
  ]);
  let inputTokens = 0,
    outputTokens = 0;
  for (const r of blogTokens ?? []) {
    inputTokens += (r.prompt_tokens as number | null) ?? 0;
    outputTokens += (r.completion_tokens as number | null) ?? 0;
  }
  for (const r of socialTokens ?? []) {
    inputTokens += (r.prompt_tokens as number | null) ?? 0;
    outputTokens += (r.completion_tokens as number | null) ?? 0;
  }

  // Recent activity feed — 10 most recent published items across both
  // surfaces, oldest to newest. The dashboard sorts client-side so the
  // shape stays simple.
  const [{ data: recentBlog }, { data: recentSocial }] = await Promise.all([
    supabaseAdmin
      .from("blog_posts")
      .select("id, slug, title, product_focus, published_at")
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(10),
    supabaseAdmin
      .from("social_posts")
      .select("id, short_body, long_body, product_focus, published_at")
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(10),
  ]);

  return c.json({
    bank,
    published_7d: { blog: blog7, social: social7 },
    published_30d: { blog: blog30, social: social30 },
    webhooks: {
      success_rate_last_100: successRate,
      total_last_100: totalRecent,
      failed_last_7d: failed7Count ?? 0,
    },
    ai_usage_30d: { input_tokens: inputTokens, output_tokens: outputTokens },
    recent: {
      blog: recentBlog ?? [],
      social: recentSocial ?? [],
    },
  });
});

// ── Recent webhook deliveries ────────────────────────────
// Used by the dashboard settings panel to surface failures and offer
// a one-click retry. Returns the most recent 50 attempts.
contentSettingsRoutes.get("/webhooks/log", async (c) => {
  const onlyFailed = c.req.query("failed_only") === "1";
  let q = supabaseAdmin
    .from("content_webhook_log")
    .select(
      "id, event, format, target_url, attempt_no, http_status, succeeded, error, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (onlyFailed) q = q.eq("succeeded", false);
  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ deliveries: data ?? [] });
});

// ── Retry a failed delivery ──────────────────────────────
// Pulls the original payload out of the log row and re-dispatches.
// New attempts will be logged as fresh content_webhook_log rows.
contentSettingsRoutes.post("/webhooks/:logId/retry", async (c) => {
  const logId = c.req.param("logId");
  const { data: row, error } = await supabaseAdmin
    .from("content_webhook_log")
    .select("event, format, payload")
    .eq("id", logId)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!row) return c.json({ error: "Log row not found" }, 404);

  try {
    // Payload is stored as jsonb — pass through to the dispatcher.
    // The dispatcher resolves the URL fresh from content_settings, so a
    // changed webhook URL takes effect on retry without code changes.
    const result = await dispatchContentWebhook(
      row.payload as Parameters<typeof dispatchContentWebhook>[0],
    );
    return c.json({
      retried: true,
      delivered: result.delivered,
      attempts: result.attempts,
      last_status: result.last_status,
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

// Test-fire a webhook URL without publishing anything real. The dashboard
// settings page's "Test webhook" button hits this.
contentSettingsRoutes.post("/webhooks/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    target: "blog" | "social_long" | "social_short";
  };
  if (!body.target) return c.json({ error: "target is required" }, 400);

  const { data: settings, error: loadErr } = await supabaseAdmin
    .from("content_settings")
    .select("*")
    .eq("id", SETTINGS_ID)
    .maybeSingle();
  if (loadErr) return c.json({ error: loadErr.message }, 500);
  if (!settings) return c.json({ error: "Settings row missing" }, 500);

  const url =
    body.target === "blog"
      ? settings.make_webhook_blog
      : body.target === "social_long"
        ? settings.make_webhook_social_long
        : settings.make_webhook_social_short;
  if (!url) {
    return c.json({ error: `No URL configured for ${body.target}` }, 400);
  }

  const payload = {
    event: body.target === "blog" ? "blog.published" : "social.published",
    format: body.target === "social_short" ? "short" : body.target === "social_long" ? "long" : undefined,
    timestamp: new Date().toISOString(),
    test: true,
    data: { id: "test-00000000-0000-0000-0000-000000000000", title: "Test webhook from GradeThread" },
  };

  const startTime = Date.now();
  let httpStatus = 0;
  let responseBody = "";
  let succeeded = false;
  let err: string | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    httpStatus = res.status;
    responseBody = (await res.text()).slice(0, 1000);
    succeeded = res.ok;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const latency_ms = Date.now() - startTime;

  await supabaseAdmin.from("content_webhook_log").insert({
    event: payload.event,
    format: payload.format ?? null,
    target_url: url,
    payload,
    attempt_no: 1,
    http_status: httpStatus || null,
    response_body: responseBody || null,
    succeeded,
    error: err,
  });

  return c.json({ succeeded, http_status: httpStatus, response_body: responseBody, latency_ms, error: err });
});

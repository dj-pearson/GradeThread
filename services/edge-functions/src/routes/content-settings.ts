import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

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

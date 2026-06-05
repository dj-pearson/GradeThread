// US-570 / US-572 / US-573 / US-576: Growth ("Promote") admin routes.
//
//   /api/admin/growth/segments*       audience segment CRUD + live preview
//   /api/admin/growth/campaigns*      broadcast composer + multi-channel send
//   /api/admin/growth/announcements*  in-app banner CRUD
//   /api/admin/growth/summary         growth analytics aggregate
//
// PLATFORM-level (not tenant-scoped) — gated by the /api/admin/* auth+admin
// middleware in main.ts. Broadcasting and other destructive writes require
// super_admin + a fresh MFA step-up. The scheduled-dispatch cron entry point
// (handleGrowthDispatchCron) is exported separately and mounted OUTSIDE
// /api/admin so a job (no user JWT) can reach it; it enforces the job secret.

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import {
  iterateSegmentUsers,
  previewSegment,
  SegmentRuleError,
  validateRules,
} from "../lib/segments.ts";
import type { SegmentRules } from "../lib/segments.ts";
import { sendBroadcastEmail } from "../lib/email.ts";
import { sendPushToUser } from "../lib/apns.ts";

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminGrowthRoutes = new Hono<AdminEnv>();

const SITE_URL = "https://gradethread.com";
const EMPTY_RULES: SegmentRules = { match: "all", conditions: [] };

// Super-admin gate for the most sensitive growth actions (broadcasting).
function requireSuperAdmin(c: Context): Response | null {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super admin required for this action." }, 403);
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════
// SEGMENTS (US-570)
// ════════════════════════════════════════════════════════════════════

adminGrowthRoutes.post("/segments/preview", async (c) => {
  let body: { rules?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const rules = validateRules(body.rules);
    const result = await previewSegment(rules);
    return c.json(result);
  } catch (err) {
    if (err instanceof SegmentRuleError) return c.json({ error: err.message }, 400);
    console.error("[admin-growth] segment preview failed:", err);
    return c.json({ error: "Preview failed" }, 500);
  }
});

adminGrowthRoutes.get("/segments", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("audience_segments")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ segments: data ?? [] });
});

adminGrowthRoutes.post("/segments", async (c) => {
  let body: { name?: unknown; description?: unknown; rules?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "name is required" }, 400);

  let rules: SegmentRules;
  try {
    rules = validateRules(body.rules ?? EMPTY_RULES);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Invalid rules" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("audience_segments")
    .insert({
      name,
      description: typeof body.description === "string" ? body.description : null,
      rules,
      created_by: c.get("userId"),
    })
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);

  await writeAuditLog(c, {
    action: "growth.segment.create",
    targetType: "audience_segment",
    targetId: data.id,
    details: { name, rules },
  });
  return c.json({ segment: data });
});

adminGrowthRoutes.patch("/segments/:id", async (c) => {
  const id = c.req.param("id");
  let body: { name?: unknown; description?: unknown; rules?: unknown; is_active?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.description === "string" || body.description === null) {
    patch.description = body.description;
  }
  if (typeof body.is_active === "boolean") patch.is_active = body.is_active;
  if (body.rules !== undefined) {
    try {
      patch.rules = validateRules(body.rules);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Invalid rules" }, 400);
    }
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update" }, 400);

  const { data, error } = await supabaseAdmin
    .from("audience_segments")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);

  await writeAuditLog(c, {
    action: "growth.segment.update",
    targetType: "audience_segment",
    targetId: id,
    details: { patch },
  });
  return c.json({ segment: data });
});

adminGrowthRoutes.delete("/segments/:id", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabaseAdmin.from("audience_segments").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  await writeAuditLog(c, {
    action: "growth.segment.delete",
    targetType: "audience_segment",
    targetId: id,
  });
  return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// CAMPAIGNS (US-572)
// ════════════════════════════════════════════════════════════════════

const VALID_CHANNELS = new Set(["email", "in_app", "push"]);

function parseChannels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string" && VALID_CHANNELS.has(x));
}

adminGrowthRoutes.get("/campaigns", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("growth_campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ campaigns: data ?? [] });
});

adminGrowthRoutes.get("/campaigns/:id", async (c) => {
  const id = c.req.param("id");
  const { data: campaign, error } = await supabaseAdmin
    .from("growth_campaigns")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !campaign) return c.json({ error: "Campaign not found" }, 404);

  // Lightweight engagement roll-up via head counts.
  const base = () =>
    supabaseAdmin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", id);
  const [total, sent, failed, opened, clicked] = await Promise.all([
    base(),
    base().eq("status", "sent"),
    base().eq("status", "failed"),
    base().not("opened_at", "is", null),
    base().not("clicked_at", "is", null),
  ]);

  return c.json({
    campaign,
    engagement: {
      recipients: total.count ?? 0,
      sent: sent.count ?? 0,
      failed: failed.count ?? 0,
      opened: opened.count ?? 0,
      clicked: clicked.count ?? 0,
    },
  });
});

adminGrowthRoutes.post("/campaigns", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const messageBody = typeof body.body === "string" ? body.body.trim() : "";
  if (!name || !subject || !messageBody) {
    return c.json({ error: "name, subject, and body are required" }, 400);
  }
  const channels = parseChannels(body.channels);
  if (channels.length === 0) {
    return c.json({ error: "Select at least one channel" }, 400);
  }

  let scheduledFor: string | null = null;
  if (typeof body.scheduled_for === "string" && body.scheduled_for) {
    const d = new Date(body.scheduled_for);
    if (Number.isNaN(d.getTime())) return c.json({ error: "Invalid scheduled_for" }, 400);
    scheduledFor = d.toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from("growth_campaigns")
    .insert({
      name,
      subject,
      body: messageBody,
      cta_label: typeof body.cta_label === "string" ? body.cta_label : null,
      cta_url: typeof body.cta_url === "string" ? body.cta_url : null,
      channels: channels as ("email" | "in_app" | "push")[],
      segment_id: typeof body.segment_id === "string" ? body.segment_id : null,
      status: scheduledFor ? "scheduled" : "draft",
      scheduled_for: scheduledFor,
      created_by: c.get("userId"),
    })
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);

  await writeAuditLog(c, {
    action: "growth.campaign.create",
    targetType: "growth_campaign",
    targetId: data.id,
    details: { name, channels, segment_id: data.segment_id, scheduled_for: scheduledFor },
  });
  return c.json({ campaign: data });
});

adminGrowthRoutes.patch("/campaigns/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Only editable while not yet sent.
  const { data: existing } = await supabaseAdmin
    .from("growth_campaigns")
    .select("status")
    .eq("id", id)
    .single();
  if (!existing) return c.json({ error: "Campaign not found" }, 404);
  if (existing.status === "sent" || existing.status === "sending") {
    return c.json({ error: "Cannot edit a campaign that is sending or sent" }, 409);
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (typeof body.subject === "string") patch.subject = body.subject.trim();
  if (typeof body.body === "string") patch.body = body.body.trim();
  if (typeof body.cta_label === "string" || body.cta_label === null) patch.cta_label = body.cta_label;
  if (typeof body.cta_url === "string" || body.cta_url === null) patch.cta_url = body.cta_url;
  if (body.channels !== undefined) {
    const channels = parseChannels(body.channels);
    if (channels.length === 0) return c.json({ error: "Select at least one channel" }, 400);
    patch.channels = channels;
  }
  if (typeof body.segment_id === "string" || body.segment_id === null) patch.segment_id = body.segment_id;
  if (body.scheduled_for !== undefined) {
    if (body.scheduled_for === null || body.scheduled_for === "") {
      patch.scheduled_for = null;
      patch.status = "draft";
    } else if (typeof body.scheduled_for === "string") {
      const d = new Date(body.scheduled_for);
      if (Number.isNaN(d.getTime())) return c.json({ error: "Invalid scheduled_for" }, 400);
      patch.scheduled_for = d.toISOString();
      patch.status = "scheduled";
    }
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update" }, 400);

  const { data, error } = await supabaseAdmin
    .from("growth_campaigns")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);

  await writeAuditLog(c, {
    action: "growth.campaign.update",
    targetType: "growth_campaign",
    targetId: id,
    details: { patch },
  });
  return c.json({ campaign: data });
});

adminGrowthRoutes.delete("/campaigns/:id", async (c) => {
  const id = c.req.param("id");
  const { data: existing } = await supabaseAdmin
    .from("growth_campaigns")
    .select("status")
    .eq("id", id)
    .single();
  if (!existing) return c.json({ error: "Campaign not found" }, 404);
  if (existing.status === "sending") {
    return c.json({ error: "Cannot delete a campaign while it is sending" }, 409);
  }
  const { error } = await supabaseAdmin.from("growth_campaigns").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  await writeAuditLog(c, {
    action: "growth.campaign.delete",
    targetType: "growth_campaign",
    targetId: id,
  });
  return c.json({ ok: true });
});

// Manual send. Super-admin + fresh step-up (destructive: fans out to real
// users across email/push). Idempotent — safe to retry.
adminGrowthRoutes.post("/campaigns/:id/send", async (c) => {
  const gate = requireSuperAdmin(c);
  if (gate) return gate;
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const result = await dispatchCampaign(id);
  if (!result.ok) return c.json({ error: result.error }, result.status ?? 500);

  await writeAuditLog(c, {
    action: "growth.campaign.send",
    targetType: "growth_campaign",
    targetId: id,
    details: result.stats,
  });
  return c.json({ ok: true, stats: result.stats });
});

// ─── Send engine ────────────────────────────────────────────────────

function marketingOptedOut(
  prefs: Record<string, unknown> | null,
  channel: "email" | "push",
): boolean {
  if (!prefs) return false;
  const m = prefs["marketing"];
  if (!m || typeof m !== "object") return false;
  return (m as Record<string, unknown>)[channel] === false;
}

interface DispatchResult {
  ok: boolean;
  error?: string;
  status?: number;
  stats?: Record<string, number>;
}

// Resolve a campaign's segment to a rule tree (null segment = everyone).
async function rulesForCampaign(segmentId: string | null): Promise<SegmentRules> {
  if (!segmentId) return EMPTY_RULES;
  const { data } = await supabaseAdmin
    .from("audience_segments")
    .select("rules")
    .eq("id", segmentId)
    .single();
  return (data?.rules as SegmentRules) ?? EMPTY_RULES;
}

/**
 * Resolve a campaign's audience and dispatch across its channels. Writes a
 * campaign_recipients ledger row per (user, channel) and skips any already
 * marked 'sent', so a retry never double-delivers. Shared by the manual-send
 * route and the scheduled-dispatch cron.
 */
export async function dispatchCampaign(id: string): Promise<DispatchResult> {
  const { data: campaign, error } = await supabaseAdmin
    .from("growth_campaigns")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !campaign) return { ok: false, error: "Campaign not found", status: 404 };
  if (campaign.status === "sent") return { ok: false, error: "Already sent", status: 409 };
  if (campaign.status === "sending") return { ok: false, error: "Already in progress", status: 409 };

  const channels = (campaign.channels as ("email" | "in_app" | "push")[]) ?? [];
  if (channels.length === 0) return { ok: false, error: "No channels selected", status: 400 };

  await supabaseAdmin.from("growth_campaigns").update({ status: "sending" }).eq("id", id);

  // Pre-load recipients already delivered so a retry is idempotent.
  const alreadySent = new Set<string>();
  {
    const { data: prior } = await supabaseAdmin
      .from("campaign_recipients")
      .select("user_id, channel, status")
      .eq("campaign_id", id);
    for (const r of (prior ?? []) as Array<{ user_id: string; channel: string; status: string }>) {
      if (r.status === "sent") alreadySent.add(`${r.user_id}:${r.channel}`);
    }
  }

  const rules = await rulesForCampaign(campaign.segment_id);
  const link = campaign.cta_url || `${SITE_URL}/dashboard`;
  const stats: Record<string, number> = {
    recipients: 0,
    sent_email: 0,
    sent_in_app: 0,
    sent_push: 0,
    skipped: 0,
    failed: 0,
  };

  try {
    for await (const page of iterateSegmentUsers(rules)) {
      for (const user of page) {
        stats.recipients++;
        for (const channel of channels) {
          const key = `${user.id}:${channel}`;
          if (alreadySent.has(key)) {
            stats.skipped++;
            continue;
          }

          // Opt-out: email + push honor the marketing preference; in-app always.
          if (
            (channel === "email" || channel === "push") &&
            marketingOptedOut(user.notification_preferences, channel)
          ) {
            await recordRecipient(id, user.id, channel, "skipped", "opted_out");
            stats.skipped++;
            continue;
          }

          let ok = false;
          let errMsg: string | null = null;
          try {
            if (channel === "in_app") {
              const { error: insErr } = await supabaseAdmin.from("notifications").insert({
                user_id: user.id,
                type: "system",
                title: campaign.subject,
                message: campaign.body,
                link,
              });
              ok = !insErr;
              errMsg = insErr?.message ?? null;
            } else if (channel === "email") {
              ok = await sendBroadcastEmail(user.email, {
                subject: campaign.subject,
                body: campaign.body,
                ctaLabel: campaign.cta_label,
                ctaUrl: campaign.cta_url,
              });
              if (!ok) errMsg = "email_not_sent";
            } else if (channel === "push") {
              const r = await sendPushToUser(user.id, {
                title: campaign.subject,
                body: campaign.body,
                category: "marketing",
                data: { url: link, campaign_id: id },
              });
              ok = r.sent > 0;
              if (!ok) errMsg = r.configured ? "no_active_devices" : "apns_not_configured";
            }
          } catch (err) {
            errMsg = err instanceof Error ? err.message : String(err);
          }

          await recordRecipient(id, user.id, channel, ok ? "sent" : "failed", errMsg);
          if (ok) {
            stats.failed += 0;
            if (channel === "email") stats.sent_email++;
            else if (channel === "in_app") stats.sent_in_app++;
            else stats.sent_push++;
          } else {
            stats.failed++;
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof SegmentRuleError) {
      await supabaseAdmin.from("growth_campaigns").update({ status: "failed" }).eq("id", id);
      return { ok: false, error: err.message, status: 400 };
    }
    console.error("[admin-growth] dispatch failed:", err);
    await supabaseAdmin.from("growth_campaigns").update({ status: "failed", stats }).eq("id", id);
    return { ok: false, error: "Dispatch failed", status: 500 };
  }

  await supabaseAdmin
    .from("growth_campaigns")
    .update({ status: "sent", sent_at: new Date().toISOString(), stats })
    .eq("id", id);

  return { ok: true, stats };
}

async function recordRecipient(
  campaignId: string,
  userId: string,
  channel: "email" | "in_app" | "push",
  status: "sent" | "failed" | "skipped",
  error: string | null,
): Promise<void> {
  await supabaseAdmin
    .from("campaign_recipients")
    .upsert(
      {
        campaign_id: campaignId,
        user_id: userId,
        channel,
        status,
        error,
        sent_at: status === "sent" ? new Date().toISOString() : null,
      },
      { onConflict: "campaign_id,user_id,channel" },
    );
}

// ════════════════════════════════════════════════════════════════════
// ANNOUNCEMENTS (US-573, admin side)
// ════════════════════════════════════════════════════════════════════

const VALID_VARIANTS = new Set(["info", "success", "warning", "promo"]);

adminGrowthRoutes.get("/announcements", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("announcements")
    .select("*")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ announcements: data ?? [] });
});

adminGrowthRoutes.post("/announcements", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const announcementBody = typeof body.body === "string" ? body.body.trim() : "";
  if (!title || !announcementBody) return c.json({ error: "title and body are required" }, 400);
  const variant = VALID_VARIANTS.has(String(body.variant)) ? String(body.variant) : "info";

  const insert: Record<string, unknown> = {
    title,
    body: announcementBody,
    variant,
    cta_label: typeof body.cta_label === "string" ? body.cta_label : null,
    cta_url: typeof body.cta_url === "string" ? body.cta_url : null,
    segment_id: typeof body.segment_id === "string" ? body.segment_id : null,
    dismissible: body.dismissible !== false,
    priority: Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0,
    is_active: body.is_active !== false,
    created_by: c.get("userId"),
  };
  if (typeof body.starts_at === "string" && body.starts_at) {
    insert.starts_at = new Date(body.starts_at).toISOString();
  }
  if (typeof body.ends_at === "string" && body.ends_at) {
    insert.ends_at = new Date(body.ends_at).toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from("announcements")
    .insert(insert)
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);

  await writeAuditLog(c, {
    action: "growth.announcement.create",
    targetType: "announcement",
    targetId: data.id,
    details: { title, variant },
  });
  return c.json({ announcement: data });
});

adminGrowthRoutes.patch("/announcements/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string") patch.title = body.title.trim();
  if (typeof body.body === "string") patch.body = body.body.trim();
  if (typeof body.variant === "string" && VALID_VARIANTS.has(body.variant)) patch.variant = body.variant;
  if (typeof body.cta_label === "string" || body.cta_label === null) patch.cta_label = body.cta_label;
  if (typeof body.cta_url === "string" || body.cta_url === null) patch.cta_url = body.cta_url;
  if (typeof body.segment_id === "string" || body.segment_id === null) patch.segment_id = body.segment_id;
  if (typeof body.dismissible === "boolean") patch.dismissible = body.dismissible;
  if (typeof body.is_active === "boolean") patch.is_active = body.is_active;
  if (Number.isFinite(Number(body.priority))) patch.priority = Number(body.priority);
  if (body.starts_at !== undefined) {
    patch.starts_at = body.starts_at ? new Date(String(body.starts_at)).toISOString() : new Date().toISOString();
  }
  if (body.ends_at !== undefined) {
    patch.ends_at = body.ends_at ? new Date(String(body.ends_at)).toISOString() : null;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update" }, 400);

  const { data, error } = await supabaseAdmin
    .from("announcements")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return c.json({ error: error.message }, 500);

  await writeAuditLog(c, {
    action: "growth.announcement.update",
    targetType: "announcement",
    targetId: id,
    details: { patch },
  });
  return c.json({ announcement: data });
});

adminGrowthRoutes.delete("/announcements/:id", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabaseAdmin.from("announcements").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  await writeAuditLog(c, {
    action: "growth.announcement.delete",
    targetType: "announcement",
    targetId: id,
  });
  return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// SUMMARY / ANALYTICS (US-576)
// ════════════════════════════════════════════════════════════════════

adminGrowthRoutes.get("/summary", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const headCount = (table: string) =>
    supabaseAdmin.from(table).select("id", { count: "exact", head: true });

  const [
    campaignsTotal,
    campaignsSent,
    recipientsSent,
    recipientsOpened,
    recipientsClicked,
    announcementsActive,
    dismissals,
    referralCodes,
    referralPending,
    referralGranted,
  ] = await Promise.all([
    headCount("growth_campaigns").gte("created_at", since),
    headCount("growth_campaigns").eq("status", "sent").gte("created_at", since),
    headCount("campaign_recipients").eq("status", "sent").gte("created_at", since),
    headCount("campaign_recipients").not("opened_at", "is", null).gte("created_at", since),
    headCount("campaign_recipients").not("clicked_at", "is", null).gte("created_at", since),
    headCount("announcements").eq("is_active", true),
    headCount("announcement_dismissals").gte("dismissed_at", since),
    headCount("referral_codes"),
    headCount("referral_events").eq("reward_status", "pending"),
    headCount("referral_events").eq("reward_status", "granted"),
  ]);

  return c.json({
    window_days: days,
    campaigns: {
      total: campaignsTotal.count ?? 0,
      sent: campaignsSent.count ?? 0,
      recipients_sent: recipientsSent.count ?? 0,
      opened: recipientsOpened.count ?? 0,
      clicked: recipientsClicked.count ?? 0,
    },
    announcements: {
      active: announcementsActive.count ?? 0,
      dismissals: dismissals.count ?? 0,
    },
    referrals: {
      codes: referralCodes.count ?? 0,
      pending: referralPending.count ?? 0,
      granted: referralGranted.count ?? 0,
    },
  });
});

// ════════════════════════════════════════════════════════════════════
// CRON: scheduled-campaign dispatch (US-572)
// ════════════════════════════════════════════════════════════════════

// Mounted OUTSIDE /api/admin (no user JWT) — enforces the job secret itself.
export async function handleGrowthDispatchCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const nowIso = new Date().toISOString();
  const { data: due } = await supabaseAdmin
    .from("growth_campaigns")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso)
    .limit(20);

  const ids = ((due ?? []) as Array<{ id: string }>).map((r) => r.id);
  const dispatched: Array<{ id: string; ok: boolean }> = [];
  for (const id of ids) {
    const result = await dispatchCampaign(id);
    dispatched.push({ id, ok: result.ok });
  }
  return c.json({ checked: ids.length, dispatched });
}

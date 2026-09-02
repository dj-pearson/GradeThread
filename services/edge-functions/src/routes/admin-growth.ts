// US-625 / US-627 / US-628 / US-631: Growth ("Promote") admin routes.
//
//   /api/admin/growth/segments*       audience segment CRUD + live preview
//   /api/admin/growth/campaigns*      broadcast composer + multi-channel send
//   /api/admin/growth/announcements*  in-app banner CRUD
//   /api/admin/growth/summary         growth analytics aggregate
//
// Quest / challenge definitions are NOT here. They live on
// /api/admin/rewards/quests (routes/admin-rewards.ts) over `reward_quests`,
// which is the table the rewards engine actually reads.
//
// PLATFORM-level (not tenant-scoped) — gated by the /api/admin/* auth+admin
// middleware in main.ts. Broadcasting and other destructive writes require
// super_admin + a fresh MFA step-up. The scheduled-dispatch cron entry point
// (handleGrowthDispatchCron) is exported separately and mounted OUTSIDE
// /api/admin so a job (no user JWT) can reach it; it enforces the job secret.

import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { failSafe } from "../lib/http-errors.ts";
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
import { buildBroadcastEmailHtml } from "../lib/email.ts";
import { sendPushToUser } from "../lib/apns.ts";
import { getReferralRewardConfig, grantReferralReward } from "../lib/referrals.ts";
import { platformBadgeFunnel } from "../lib/badge-analytics.ts";
import { type FlywheelPoint, summarizeFlywheel } from "../lib/buyer-analytics.ts";
import { coordinateMarketingSend } from "../lib/marketing-coordinator.ts";
import { isMarketingOptedOut } from "../lib/email-consent.ts";
import { marketingUnsubscribeUrl } from "../lib/unsubscribe.ts";
import {
  applyMarketingEmailTracking,
  engagementSigningSecret,
} from "../lib/email-engagement-token.ts";
import { getSetting } from "../lib/system-settings.ts";
import {
  isUniqueViolation,
  verdictForExistingRow,
} from "../lib/campaign-claim.ts";
import { captureException } from "../lib/observability.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { fetchAllPages } from "../lib/paged-read.ts";
import { normalizeEmail } from "../lib/email-suppression.ts";
import {
  DEFAULT_MAX_SEND_RATE_PER_SEC,
  DEFAULT_WARMUP_SCHEDULE,
  effectiveBatchLimit,
  MAX_SEND_RATE_SETTING,
  parseWarmupSchedule,
  remainingWarmupBudget,
  WARMUP_ENABLED_SETTING,
  WARMUP_SCHEDULE_SETTING,
  WARMUP_START_DATE_SETTING,
  warmupDailyCap,
  warmupDayIndex,
} from "../lib/email-warmup.ts";
import { type ConfirmedSubscriber, partitionExtraSubscribers } from "../lib/broadcast-audience.ts";
import { requireScope } from "../lib/scope-guard.ts";

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminGrowthRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminGrowthRoutes.use("*", requireScope("growth:write"));

// US-1760: platform-wide badge funnel (clicks by source + conversions + active
// sellers) for the growth dashboard.
adminGrowthRoutes.get("/badge-funnel", async (c) => {
  try {
    return c.json(await platformBadgeFunnel());
  } catch (err) {
    return failSafe(c, 500, "Couldn't load the badge funnel.", err, "admin-growth.badge-funnel");
  }
});

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
// SEGMENTS (US-625)
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
    if (err instanceof SegmentRuleError) return c.json({ error: err.message }, 400); // safe-raw-error: typed validation message, not raw DB text (US-1445)
    console.error("[admin-growth] segment preview failed:", err);
    return c.json({ error: "Preview failed" }, 500);
  }
});

adminGrowthRoutes.get("/segments", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("audience_segments")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return failSafe(c, 500, "Couldn't load segments.", error, "admin.growth.segments.list");
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
  if (error) return failSafe(c, 500, "Couldn't create the segment.", error, "admin.growth.segments.create");

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
  if (error) return failSafe(c, 500, "Couldn't update the segment.", error, "admin.growth.segments.update");

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
  if (error) return failSafe(c, 500, "Couldn't delete the segment.", error, "admin.growth.segments.delete");
  await writeAuditLog(c, {
    action: "growth.segment.delete",
    targetType: "audience_segment",
    targetId: id,
  });
  return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// CAMPAIGNS (US-627)
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
  if (error) return failSafe(c, 500, "Couldn't load campaigns.", error, "admin.growth.campaigns.list");
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
  if (error) return failSafe(c, 500, "Couldn't create the campaign.", error, "admin.growth.campaigns.create");

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
  if (error) return failSafe(c, 500, "Couldn't update the campaign.", error, "admin.growth.campaigns.update");

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
  if (error) return failSafe(c, 500, "Couldn't delete the campaign.", error, "admin.growth.campaigns.delete");
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
  // US-911: delegate to the canonical consent model so the push/email opt-out
  // reads the same `marketing` umbrella key the unsubscribe link writes.
  return isMarketingOptedOut(prefs, channel);
}

interface DispatchResult {
  ok: boolean;
  error?: string;
  status?: 400 | 404 | 409 | 500;
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

// US-925: per-tick SES-warmup send budget (the durable batch bound). A broadcast
// with more email recipients than this cap sends a batch, stays `sending`, and
// resumes on the next dispatch cron tick — overflow rides the email_deliveries
// outbox cadence rather than hammering SES at full rate. Tunable via the registry.
const SEND_BATCH_SETTING = "marketing_send_batch_limit";
const DEFAULT_SEND_BATCH = 1000;
// US-913: global no-track toggle (seeded 00294). When false, open/click tracking
// is not applied to broadcast email at render time.
const MARKETING_TRACKING_SETTING = "marketing_email_tracking_enabled";
// Cap the confirmed-subscriber UNION scan (mirrors the newsletter send cap).
const SUBSCRIBER_SCAN = 5000;

// US-915: resolve the remaining daily SES-warmup budget. During the ramp the
// per-day ceiling (settings: marketing_warmup_*) bounds total marketing volume
// across ALL ticks for the day; the per-tick batch limit still bounds burst. When
// warmup is off / completed the cap is null (unlimited) and behaviour is
// unchanged. Returns `null` for "no daily cap".
async function remainingDailyWarmupBudget(nowMs: number): Promise<number | null> {
  const enabled = Boolean(await getSetting(WARMUP_ENABLED_SETTING, false));
  if (!enabled) return null;
  const schedule = parseWarmupSchedule(
    await getSetting<unknown>(WARMUP_SCHEDULE_SETTING, DEFAULT_WARMUP_SCHEDULE),
  );
  const startDate = String(await getSetting(WARMUP_START_DATE_SETTING, ""));
  const maxRate = Number(await getSetting(MAX_SEND_RATE_SETTING, DEFAULT_MAX_SEND_RATE_PER_SEC)) ||
    DEFAULT_MAX_SEND_RATE_PER_SEC;
  const dailyCap = warmupDailyCap({
    enabled,
    schedule,
    dayIndex: warmupDayIndex(startDate, nowMs),
    maxRatePerSec: maxRate,
  });
  if (dailyCap === null) return null;
  // Count marketing sends already logged today (UTC day, matching warmupDayIndex)
  // across every program so the cap is a true global daily ceiling.
  const since = new Date(Math.floor(nowMs / 86_400_000) * 86_400_000).toISOString();
  const { count, error } = await supabaseAdmin
    .from("marketing_send_log")
    .select("id", { count: "exact", head: true })
    .gte("sent_at", since);
  if (error) {
    // Fail OPEN on the read — the per-tick batch limit still bounds the burst.
    captureException(error, { route: "admin-growth.warmup-count" });
    return null;
  }
  return remainingWarmupBudget(dailyCap, count ?? 0);
}

function trackingBaseUrl(): string {
  return Deno.env.get("FUNCTIONS_URL")?.trim() || "https://functions.gradethread.com";
}

interface CampaignEmailData {
  id: string;
  subject: string;
  body: string;
  cta_label: string | null;
  cta_url: string | null;
}

/**
 * Durable, tracked per-recipient broadcast email (US-925). Reserves the
 * campaign_recipients ledger row (its uuid id = the open/click tracking token),
 * renders the marketing HTML with click-tracking applied AT RENDER TIME, then
 * routes the send through coordinateMarketingSend — consent (US-911) +
 * suppression (US-914) + the per-recipient frequency cap + the email_deliveries
 * outbox (US-498), so a transient failure is retried/dead-lettered instead of
 * lost. A dropped (opted-out/suppressed) recipient is recorded 'skipped', never
 * sent. Returns the recorded ledger status.
 */
async function sendCampaignEmailDurable(
  campaign: CampaignEmailData,
  member: { userId: string; email: string; prefs?: Record<string, unknown> | null },
): Promise<"sent" | "skipped" | "failed" | "in_flight"> {
  // US-2316 AC2: CLAIM the ledger row, do not merely reserve it.
  //
  // This was an UPSERT to `pending`, which always succeeds — so two workers on
  // one recipient both "reserved" and both sent, and the done-set (rows already
  // sent/skipped) could not see a claim in progress. The INSERT makes the unique
  // index on (campaign_id, user_id, channel) decide the winner atomically, in
  // the database. A loser takes 23505 and asks what the existing row means.
  let token: string | null = null;
  const { data: row, error: resErr } = await supabaseAdmin
    .from("campaign_recipients")
    .insert({
      campaign_id: campaign.id,
      user_id: member.userId,
      channel: "email",
      status: "pending",
      error: null,
      sent_at: null,
    })
    .select("id")
    .maybeSingle();

  if (resErr && isUniqueViolation(resErr as { code?: string })) {
    const { data: existing } = await supabaseAdmin
      .from("campaign_recipients")
      .select("id, status")
      .eq("campaign_id", campaign.id)
      .eq("user_id", member.userId)
      .eq("channel", "email")
      .maybeSingle();
    const ex = existing as { id: string; status: string } | null;
    const verdict = verdictForExistingRow(ex);
    if (verdict.action === "already") return verdict.status;
    if (verdict.action === "in_flight") return "in_flight";
    // A previous attempt FAILED. Take the claim back, and only send if this
    // update actually moved the row — a second worker doing the same thing at
    // the same moment finds it already out of `failed` and stands down.
    const { data: reclaimed } = await supabaseAdmin
      .from("campaign_recipients")
      .update({ status: "pending", error: null, sent_at: null })
      .eq("id", ex!.id)
      .eq("status", verdict.from)
      .select("id")
      .maybeSingle();
    if (!reclaimed) return "in_flight";
    token = (reclaimed as { id: string }).id;
  } else if (resErr || !row) {
    captureException(resErr ?? new Error("reserve failed"), {
      route: "admin-growth.broadcast.reserve",
    });
    return "failed";
  } else {
    token = (row as { id: string }).id;
  }

  try {
    const unsubscribeUrl = await marketingUnsubscribeUrl(member.userId);
    let html = buildBroadcastEmailHtml(
      {
        subject: campaign.subject,
        body: campaign.body,
        ctaLabel: campaign.cta_label,
        ctaUrl: campaign.cta_url,
      },
      unsubscribeUrl,
    );
    // US-913 AC4: click-tracking rewrite + open pixel injected at render time,
    // keyed by SIGNED (campaign_id + user_id) tokens → /api/email/{o,c}. Applied
    // ONLY to this marketing broadcast (never transactional), and gated by the
    // global no-track setting so an operator can disable tracking without a deploy.
    if (await getSetting(MARKETING_TRACKING_SETTING, true)) {
      html = await applyMarketingEmailTracking(
        html,
        trackingBaseUrl(),
        { campaignId: campaign.id, userId: member.userId },
        engagementSigningSecret(),
      );
    }

    const result = await coordinateMarketingSend({
      to: member.email,
      userId: member.userId,
      prefs: member.prefs ?? null,
      source: "weekly_newsletter",
      category: `broadcast:${campaign.id}`,
      subject: campaign.subject,
      html,
    });

    if (result.action === "drop") {
      await supabaseAdmin
        .from("campaign_recipients")
        .update({ status: "skipped", error: result.reason, sent_at: null })
        .eq("id", token);
      return "skipped";
    }
    // send | defer — both durably accepted (defer = re-queued in the outbox).
    await supabaseAdmin
      .from("campaign_recipients")
      .update({ status: "sent", error: null, sent_at: new Date().toISOString() })
      .eq("id", token);
    return "sent";
  } catch (err) {
    captureException(err, { route: "admin-growth.broadcast.send" });
    await supabaseAdmin
      .from("campaign_recipients")
      .update({ status: "failed", error: err instanceof Error ? err.message : String(err) })
      .eq("id", token);
    return "failed";
  }
}

/** Confirmed newsletter subscribers — UNIONed with the segment for email sends. */
async function loadConfirmedSubscribers(): Promise<ConfirmedSubscriber[]> {
  const { data, error } = await supabaseAdmin
    .from("email_subscribers")
    .select("email, user_id")
    .eq("status", "confirmed")
    .limit(SUBSCRIBER_SCAN);
  if (error) {
    captureException(error, { route: "admin-growth.broadcast.subscribers" });
    return [];
  }
  return (data ?? []) as ConfirmedSubscriber[];
}

/**
 * Resolve a campaign's audience and dispatch across its channels. The EMAIL
 * channel (US-925) targets the segment UNION confirmed newsletter subscribers
 * (de-duped by email), routes every send through the durable email_deliveries
 * outbox (consent + suppression + frequency cap), applies click-tracking, and is
 * bounded per tick by the SES-warmup budget — overflow stays `sending` and the
 * dispatch cron resumes it (`opts.resume`). in-app/push are direct. Writes a
 * campaign_recipients ledger row per (user, channel); rows already 'sent' or
 * permanently 'skipped' are not reprocessed, so a re-run never double-delivers.
 */
export async function dispatchCampaign(
  id: string,
  opts: { resume?: boolean } = {},
): Promise<DispatchResult> {
  const { data: campaign, error } = await supabaseAdmin
    .from("growth_campaigns")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !campaign) return { ok: false, error: "Campaign not found", status: 404 };
  if (campaign.status === "sent") return { ok: false, error: "Already sent", status: 409 };
  if (campaign.status === "sending" && !opts.resume) {
    return { ok: false, error: "Already in progress", status: 409 };
  }

  const channels = (campaign.channels as ("email" | "in_app" | "push")[]) ?? [];
  if (channels.length === 0) return { ok: false, error: "No channels selected", status: 400 };
  const hasEmail = channels.includes("email");

  if (campaign.status !== "sending") {
    await supabaseAdmin.from("growth_campaigns").update({ status: "sending" }).eq("id", id);
  }

  // Pre-load terminal rows (sent OR permanently skipped) so a re-run/resume is
  // idempotent — only 'failed'/'pending' rows are reprocessed.
  const done = new Set<string>();
  {
    // US-2316 AC3: PAGED, because a truncated done-set sends duplicate email.
    //
    // This was a single unbounded select. PostgREST caps any response at
    // db-max-rows and reports the clip only in a Content-Range header
    // supabase-js does not surface — so on a large campaign the read came back
    // short with error:null, the done-set silently lost its tail, and every
    // recipient in that tail was emailed AGAIN on the next tick. The failure
    // scales with campaign size, i.e. it appears exactly when it costs most.
    //
    // fetchAllPages advances by rows RETURNED and stops only on an empty
    // response, so it cannot be fooled by a server ceiling it does not know.
    const prior = await fetchAllPages<
      { user_id: string; channel: string; status: string }
    >(async (from, to) => {
      const { data, error } = await supabaseAdmin
        .from("campaign_recipients")
        .select("user_id, channel, status")
        .eq("campaign_id", id)
        // An ORDER BY is required for paging to be stable: without it the
        // server may return rows in a different order per request and a page
        // boundary can skip a row entirely.
        .order("user_id", { ascending: true })
        .order("channel", { ascending: true })
        .range(from, to);
      if (error) throw new Error(`done-set read failed: ${error.message}`);
      return (data ?? []) as Array<
        { user_id: string; channel: string; status: string }
      >;
    });
    for (const r of prior) {
      if (r.status === "sent" || r.status === "skipped") done.add(`${r.user_id}:${r.channel}`);
    }
  }

  const rules = await rulesForCampaign(campaign.segment_id);
  const link = campaign.cta_url || `${SITE_URL}/dashboard`;
  const emailData: CampaignEmailData = {
    id,
    subject: campaign.subject,
    body: campaign.body,
    cta_label: campaign.cta_label,
    cta_url: campaign.cta_url,
  };
  const stats: Record<string, number> = {
    recipients: 0,
    sent_email: 0,
    sent_in_app: 0,
    sent_push: 0,
    skipped: 0,
    failed: 0,
    // Claimed by another worker (or left held by one that died). Counted so a
    // campaign that stalls on held rows is visible instead of looking complete.
    in_flight: 0,
  };

  // AC3: bound email sends per tick (SES warmup); overflow resumes next tick.
  const perTickLimit = Math.max(
    1,
    Number(await getSetting(SEND_BATCH_SETTING, DEFAULT_SEND_BATCH)) || DEFAULT_SEND_BATCH,
  );
  // US-915: fold in the remaining daily warmup-ramp budget so a large list paces
  // up over days, not a burst. `null` = no ramp cap → per-tick limit unchanged.
  const remainingDaily = await remainingDailyWarmupBudget(Date.now());
  const batchLimit = effectiveBatchLimit(perTickLimit, remainingDaily);
  let emailSends = 0;
  let truncated = false;
  // Normalized emails the segment already mailed — for the subscriber UNION dedup.
  const seenEmails = new Set<string>();

  try {
    for await (const page of iterateSegmentUsers(rules)) {
      for (const user of page) {
        stats.recipients++;
        for (const channel of channels) {
          const key = `${user.id}:${channel}`;
          if (done.has(key)) {
            stats.skipped++;
            continue;
          }

          if (channel === "email") {
            if (user.email) seenEmails.add(normalizeEmail(user.email));
            if (emailSends >= batchLimit) {
              truncated = true;
              continue;
            }
            emailSends++;
            const outcome = await sendCampaignEmailDurable(emailData, {
              userId: user.id,
              email: user.email,
              prefs: user.notification_preferences,
            });
            if (outcome === "sent") stats.sent_email++;
            else if (outcome === "skipped") stats.skipped++;
            // US-2316 AC2: a recipient another worker holds is NOT a failure and
            // must not be reported as one — it is a claim we did not win.
            else if (outcome === "in_flight") stats.in_flight++;
            else stats.failed++;
            continue;
          }

          // Push honors the marketing opt-out; in-app is always allowed.
          if (channel === "push" && marketingOptedOut(user.notification_preferences, "push")) {
            await recordRecipient(id, user.id, "push", "skipped", "opted_out");
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
            if (channel === "in_app") stats.sent_in_app++;
            else stats.sent_push++;
          } else {
            stats.failed++;
          }
        }
      }
    }

    // AC2: UNION confirmed newsletter subscribers (de-duped by email) into the
    // email channel — but only once the segment pass fit inside this tick's budget.
    if (hasEmail && !truncated && emailSends < batchLimit) {
      const subs = await loadConfirmedSubscribers();
      const { extras, skippedNoAccount } = partitionExtraSubscribers(subs, seenEmails);
      stats.skipped += skippedNoAccount;
      for (const ex of extras) {
        const key = `${ex.userId}:email`;
        if (done.has(key)) {
          stats.skipped++;
          continue;
        }
        stats.recipients++;
        if (emailSends >= batchLimit) {
          truncated = true;
          break;
        }
        emailSends++;
        const outcome = await sendCampaignEmailDurable(emailData, {
          userId: ex.userId,
          email: ex.email,
        });
        if (outcome === "sent") stats.sent_email++;
        else if (outcome === "skipped") stats.skipped++;
        else if (outcome === "in_flight") stats.in_flight++;
        else stats.failed++;
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

  if (truncated) {
    // More email recipients than this tick's SES budget — stay `sending` so the
    // dispatch cron resumes the rest next tick (idempotent via the `done` set).
    await supabaseAdmin.from("growth_campaigns").update({ status: "sending", stats }).eq("id", id);
    return { ok: true, stats: { ...stats, truncated: 1 } };
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
// ANNOUNCEMENTS (US-628, admin side)
// ════════════════════════════════════════════════════════════════════

const VALID_VARIANTS = new Set(["info", "success", "warning", "promo"]);

adminGrowthRoutes.get("/announcements", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("announcements")
    .select("*")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) return failSafe(c, 500, "Couldn't load announcements.", error, "admin.growth.announcements.list");
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
  if (error) return failSafe(c, 500, "Couldn't create the announcement.", error, "admin.growth.announcements.create");

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
  if (error) return failSafe(c, 500, "Couldn't update the announcement.", error, "admin.growth.announcements.update");

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
  if (error) return failSafe(c, 500, "Couldn't delete the announcement.", error, "admin.growth.announcements.delete");
  await writeAuditLog(c, {
    action: "growth.announcement.delete",
    targetType: "announcement",
    targetId: id,
  });
  return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// SUMMARY / ANALYTICS (US-631)
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

// Daily time-series for the growth dashboard charts (US-631): messages
// delivered + announcement dismissals per day over a window.
adminGrowthRoutes.get("/timeseries", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 90);
  const since = new Date(Date.now() - (days - 1) * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  const [recips, dismissals] = await Promise.all([
    supabaseAdmin
      .from("campaign_recipients")
      .select("sent_at")
      .eq("status", "sent")
      .gte("sent_at", sinceIso)
      .limit(20000),
    supabaseAdmin
      .from("announcement_dismissals")
      .select("dismissed_at")
      .gte("dismissed_at", sinceIso)
      .limit(20000),
  ]);

  // Pre-seed every day in the window so the chart is continuous.
  const buckets = new Map<string, { delivered: number; dismissals: number }>();
  for (let i = 0; i < days; i++) {
    const key = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    buckets.set(key, { delivered: 0, dismissals: 0 });
  }
  for (const r of (recips.data ?? []) as Array<{ sent_at: string | null }>) {
    if (!r.sent_at) continue;
    const b = buckets.get(r.sent_at.slice(0, 10));
    if (b) b.delivered++;
  }
  for (const r of (dismissals.data ?? []) as Array<{ dismissed_at: string }>) {
    const b = buckets.get(r.dismissed_at.slice(0, 10));
    if (b) b.dismissals++;
  }

  const series = [...buckets.entries()].map(([date, v]) => ({ date, ...v }));
  return c.json({ window_days: days, series });
});

// ════════════════════════════════════════════════════════════════════
// BUYER GROWTH (US-1845)
// ════════════════════════════════════════════════════════════════════
//
// The whole buyer rollup in ONE round trip, because every panel on the surface
// shares the same window and splitting it would let the funnel and the
// attribution table disagree about which days they cover.
//
// The heavy lifting is buyer_growth_metrics() (migration 00537) — counts only,
// never a user identifier. Two things are deliberately NOT in the SQL: the
// flywheel correlation, which is arithmetic over the series it already returns
// and belongs somewhere unit-testable; and MRR, which needs the plan prices and
// those live in the frontend tier matrix (src/lib/constants.ts BUYER_PLANS), not
// in a third copy here.
adminGrowthRoutes.get("/buyer", async (c) => {
  try {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
    const { data, error } = await supabaseAdmin.rpc("buyer_growth_metrics", {
      p_days: days,
    });
    if (error) throw new Error(error.message);

    const metrics = (data ?? {}) as Record<string, unknown>;
    const flywheel = Array.isArray(metrics.flywheel)
      ? (metrics.flywheel as FlywheelPoint[])
      : [];
    return c.json({ ...metrics, flywheel, flywheel_summary: summarizeFlywheel(flywheel) });
  } catch (err) {
    return failSafe(
      c,
      500,
      "Couldn't load the buyer growth metrics.",
      err,
      "admin-growth.buyer",
    );
  }
});

// ════════════════════════════════════════════════════════════════════
// REFERRALS (US-629, admin side)
// ════════════════════════════════════════════════════════════════════

// Reward sizes (grade credits) granted when a referral is approved live in the
// shared leaf module (referral-rewards.ts) so the auto-grant path, this admin
// overview, and the public surfaces all read the same numbers.

// Overview: funnel counts, top referrers, and the pending/qualified reward queue.
adminGrowthRoutes.get("/referrals", async (c) => {
  const headCount = (status?: string) => {
    let q = supabaseAdmin
      .from("referral_events")
      .select("id", { count: "exact", head: true });
    if (status) q = q.eq("reward_status", status);
    return q;
  };
  const [codes, total, pending, qualified, granted] = await Promise.all([
    supabaseAdmin.from("referral_codes").select("id", { count: "exact", head: true }),
    headCount(),
    headCount("pending"),
    headCount("qualified"),
    headCount("granted"),
  ]);

  // Top referrers — aggregate in JS over a bounded recent window of events.
  const { data: events } = await supabaseAdmin
    .from("referral_events")
    .select("referrer_user_id, reward_status")
    .limit(5000);
  const tally = new Map<string, { total: number; granted: number }>();
  for (const e of (events ?? []) as Array<{ referrer_user_id: string; reward_status: string }>) {
    const cur = tally.get(e.referrer_user_id) ?? { total: 0, granted: 0 };
    cur.total++;
    if (e.reward_status === "granted") cur.granted++;
    tally.set(e.referrer_user_id, cur);
  }
  const topIds = [...tally.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 10);
  const emailById = new Map<string, string>();
  if (topIds.length > 0) {
    const { data: users } = await supabaseAdmin
      .from("users")
      .select("id, email")
      .in("id", topIds.map(([id]) => id));
    for (const u of (users ?? []) as Array<{ id: string; email: string }>) emailById.set(u.id, u.email);
  }
  const topReferrers = topIds.map(([id, v]) => ({
    user_id: id,
    email: emailById.get(id) ?? id,
    total: v.total,
    granted: v.granted,
  }));

  // Reward queue — events awaiting a grant decision, with both parties' emails.
  const { data: queueRows } = await supabaseAdmin
    .from("referral_events")
    .select("id, referrer_user_id, referred_user_id, code, reward_status, created_at")
    .in("reward_status", ["pending", "qualified"])
    .order("created_at", { ascending: true })
    .limit(50);
  const queue = (queueRows ?? []) as Array<{
    id: string;
    referrer_user_id: string;
    referred_user_id: string;
    code: string;
    reward_status: string;
    created_at: string;
  }>;
  const partyIds = [...new Set(queue.flatMap((q) => [q.referrer_user_id, q.referred_user_id]))];
  const partyEmail = new Map<string, string>();
  if (partyIds.length > 0) {
    const { data: users } = await supabaseAdmin.from("users").select("id, email").in("id", partyIds);
    for (const u of (users ?? []) as Array<{ id: string; email: string }>) partyEmail.set(u.id, u.email);
  }

  // US-1069: surface the LIVE admin-configured economics (not the hardcoded
  // defaults) so the dashboard reflects what grants actually pay out.
  const rewardConfig = await getReferralRewardConfig();

  return c.json({
    funnel: {
      codes: codes.count ?? 0,
      total: total.count ?? 0,
      pending: pending.count ?? 0,
      qualified: qualified.count ?? 0,
      granted: granted.count ?? 0,
    },
    rewards: {
      referrer_credits: rewardConfig.referrer_credits,
      referred_credits: rewardConfig.referred_credits,
      qualification_window_days: rewardConfig.qualification_window_days,
      per_referrer_cap: rewardConfig.per_referrer_cap,
    },
    top_referrers: topReferrers,
    queue: queue.map((q) => ({
      id: q.id,
      code: q.code,
      reward_status: q.reward_status,
      created_at: q.created_at,
      referrer_email: partyEmail.get(q.referrer_user_id) ?? q.referrer_user_id,
      referred_email: partyEmail.get(q.referred_user_id) ?? q.referred_user_id,
    })),
  });
});

// Approve a referral: grant grade credits to BOTH parties and mark it granted.
// super_admin + fresh step-up (it moves real credit balances); audited. This is
// the ADMIN OVERRIDE for the auto-grant path (US-864) — it resolves rows that
// auto-grant intentionally left at `qualified` (a suspended party, a transient
// failure) or legacy `qualified` rows. The actual grant + notifications run
// through the single shared grantReferralReward() so there's one grant per event.
adminGrowthRoutes.post("/referrals/:id/grant", async (c) => {
  const gate = requireSuperAdmin(c);
  if (gate) return gate;
  const stepUp = requireStepUp(c);
  if (stepUp) return stepUp;

  const id = c.req.param("id");
  const { data: event } = await supabaseAdmin
    .from("referral_events")
    .select("id, referrer_user_id, referred_user_id, reward_status")
    .eq("id", id)
    .single();
  if (!event) return c.json({ error: "Referral not found" }, 404);

  const result = await grantReferralReward(id);
  switch (result.status) {
    case "not_found":
      return c.json({ error: "Referral not found" }, 404);
    case "already_granted":
      return c.json({ error: "Already granted" }, 409);
    case "blocked":
      return c.json({ error: result.reason }, 409);
    case "capped":
      return c.json({ error: result.reason }, 409);
    case "expired":
      return c.json({ error: result.reason }, 409);
    case "error":
      return c.json({ error: result.reason }, 500);
    case "granted":
      break;
  }

  await writeAuditLog(c, {
    action: "growth.referral.grant",
    targetType: "referral_event",
    targetId: id,
    details: {
      referrer_user_id: event.referrer_user_id,
      referred_user_id: event.referred_user_id,
      referrer_credits: result.referrer_credits,
      referred_credits: result.referred_credits,
    },
  });

  return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// REFERRAL VIRALITY ANALYTICS (US-1071)
// ════════════════════════════════════════════════════════════════════

// Virality rollup: funnel time series + conversion %, K-factor, and referred-
// vs direct-cohort activation/paying/LTV. All aggregation is server-side in the
// referral_analytics() RPC (cross-tenant, admin/service-role gated).
adminGrowthRoutes.get("/referrals/analytics", async (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 365);
  const { data, error } = await supabaseAdmin.rpc("referral_analytics", { p_days: days });
  if (error) {
    console.error("[admin-growth] referral_analytics failed:", error.message);
    return c.json({ error: "Failed to load referral analytics" }, 500);
  }
  return c.json(data);
});

// ════════════════════════════════════════════════════════════════════
// CAMPAIGN CODES (US-1071)
// ════════════════════════════════════════════════════════════════════

// Named promo / campaign codes (not tied to a referrer) that grant bonus credits
// to a new user on redemption. Admin CRUD + a redemption roll-up. Codes are
// normalized to UPPERCASE so they match the user-facing redeem (which upcases).

function normalizeCampaignCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

adminGrowthRoutes.get("/campaign-codes", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("referral_campaign_codes")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return failSafe(c, 500, "Couldn't load campaign codes.", error, "admin.growth.codes.list");
  return c.json({ codes: data ?? [] });
});

adminGrowthRoutes.post("/campaign-codes", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const code = normalizeCampaignCode(body.code);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!code) return c.json({ error: "code is required" }, 400);
  if (!/^[A-Z0-9]{3,32}$/.test(code)) {
    return c.json({ error: "code must be 3–32 letters/numbers" }, 400);
  }
  if (!name) return c.json({ error: "name is required" }, 400);

  const bonus = Number(body.bonus_referred_credits);
  if (!Number.isInteger(bonus) || bonus < 0) {
    return c.json({ error: "bonus_referred_credits must be a non-negative integer" }, 400);
  }
  const maxRedemptions = body.max_redemptions == null || body.max_redemptions === ""
    ? null
    : Number(body.max_redemptions);
  if (maxRedemptions !== null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
    return c.json({ error: "max_redemptions must be a positive integer" }, 400);
  }

  const insert: Record<string, unknown> = {
    code,
    name,
    description: typeof body.description === "string" ? body.description : null,
    bonus_referred_credits: bonus,
    is_active: body.is_active !== false,
    max_redemptions: maxRedemptions,
    created_by: c.get("userId"),
  };
  if (typeof body.starts_at === "string" && body.starts_at) {
    insert.starts_at = new Date(body.starts_at).toISOString();
  }
  if (typeof body.ends_at === "string" && body.ends_at) {
    insert.ends_at = new Date(body.ends_at).toISOString();
  }

  const { data, error } = await supabaseAdmin
    .from("referral_campaign_codes")
    .insert(insert)
    .select("*")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "That code already exists" }, 409);
    }
    return failSafe(c, 500, "Couldn't create the campaign code.", error, "admin.growth.codes.create");
  }

  await writeAuditLog(c, {
    action: "growth.campaign_code.create",
    targetType: "referral_campaign_code",
    targetId: data.id,
    details: { code, name, bonus },
  });
  return c.json({ code: data });
});

adminGrowthRoutes.patch("/campaign-codes/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
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
  if (body.bonus_referred_credits !== undefined) {
    const bonus = Number(body.bonus_referred_credits);
    if (!Number.isInteger(bonus) || bonus < 0) {
      return c.json({ error: "bonus_referred_credits must be a non-negative integer" }, 400);
    }
    patch.bonus_referred_credits = bonus;
  }
  if (body.max_redemptions !== undefined) {
    if (body.max_redemptions === null || body.max_redemptions === "") {
      patch.max_redemptions = null;
    } else {
      const m = Number(body.max_redemptions);
      if (!Number.isInteger(m) || m < 1) {
        return c.json({ error: "max_redemptions must be a positive integer" }, 400);
      }
      patch.max_redemptions = m;
    }
  }
  if (body.ends_at !== undefined) {
    patch.ends_at = body.ends_at ? new Date(String(body.ends_at)).toISOString() : null;
  }
  if (Object.keys(patch).length === 0) return c.json({ error: "Nothing to update" }, 400);

  const { data, error } = await supabaseAdmin
    .from("referral_campaign_codes")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return failSafe(c, 500, "Couldn't update the campaign code.", error, "admin.growth.codes.update");

  await writeAuditLog(c, {
    action: "growth.campaign_code.update",
    targetType: "referral_campaign_code",
    targetId: id,
    details: { patch },
  });
  return c.json({ code: data });
});

adminGrowthRoutes.delete("/campaign-codes/:id", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabaseAdmin.from("referral_campaign_codes").delete().eq("id", id);
  if (error) return failSafe(c, 500, "Couldn't delete the campaign code.", error, "admin.growth.codes.delete");
  await writeAuditLog(c, {
    action: "growth.campaign_code.delete",
    targetType: "referral_campaign_code",
    targetId: id,
  });
  return c.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
// CRON: scheduled-campaign dispatch (US-627)
// ════════════════════════════════════════════════════════════════════

// Mounted OUTSIDE /api/admin (no user JWT) — enforces the job secret itself.
export async function handleGrowthDispatchCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // US-2316 AC1: the ONLY bulk-email job in the fleet without a lock, on a
  // */15 schedule. dispatchCampaign's "already in progress" 409 is deliberately
  // BYPASSED on the resume path (resume:true) — which is exactly the path two
  // overlapping ticks take — so nothing serialised them. Each tick loads its
  // own done-set snapshot at start, so any recipient tick 1 finalises AFTER
  // tick 2 took its snapshot can be sent to twice.
  //
  // The lease is longer than the 15-minute schedule on purpose: a tick that
  // overruns its own interval is the case this exists for, and a lease shorter
  // than the work would hand the campaign to the next tick mid-send.
  //
  // Safe to add only as of US-2311, which made release verify the holder —
  // before that, a displaced run deleted its successor's lease, and adding a
  // lock here would have inherited that bug rather than fixed anything.
  const lock = await acquireJobLock("growth-dispatch", 1800);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason ?? "already running" });
  }

  try {
  const nowIso = new Date().toISOString();
  const { data: due } = await supabaseAdmin
    .from("growth_campaigns")
    .select("id")
    .eq("status", "scheduled")
    .lte("scheduled_for", nowIso)
    .limit(20);

  // US-925: also RESUME campaigns left `sending` by an earlier tick that hit the
  // SES-warmup batch budget — they drain across ticks until fully sent.
  const { data: resuming } = await supabaseAdmin
    .from("growth_campaigns")
    .select("id")
    .eq("status", "sending")
    .limit(20);

  const ids = ((due ?? []) as Array<{ id: string }>).map((r) => r.id);
  const resumeIds = ((resuming ?? []) as Array<{ id: string }>).map((r) => r.id);
  const dispatched: Array<{ id: string; ok: boolean }> = [];

  // US-2316: each campaign is isolated. Neither loop had a try/catch, so ONE
  // throwing campaign aborted the handler and every campaign queued behind it
  // in the same tick — a single bad recipient list could stall the whole
  // marketing fleet, and the failure looked like a cron error rather than a
  // campaign error.
  const runOne = async (id: string, opts?: { resume: true }) => {
    try {
      const result = await dispatchCampaign(id, opts);
      dispatched.push({ id, ok: result.ok });
    } catch (err) {
      console.error(
        `[growth-dispatch] campaign ${id} threw:`,
        err instanceof Error ? err.message : String(err),
      );
      captureException(err, { route: "growth-dispatch", tags: { campaign: id } });
      dispatched.push({ id, ok: false });
    }
  };

  for (const id of ids) await runOne(id);
  for (const id of resumeIds) await runOne(id, { resume: true });

  // US-2316: a FAILED COUNT, not just per-campaign ok flags.
  //
  // US-2312 made the cron ledger read failure counts out of the response body,
  // but it looks for NAMED counters (failed/failures/errors/…). An array of
  // {ok:false} objects matches none of them, and "checked" is not a
  // rows-processed key either — so a tick in which EVERY campaign failed still
  // recorded as a success with rows_processed 0. The alerting was blind to
  // exactly the job this story is about.
  const failed = dispatched.filter((d) => !d.ok).length;
  return c.json({
    checked: ids.length + resumeIds.length,
    processed: dispatched.length,
    failed,
    dispatched,
  });
  } finally {
    await lock.release();
  }
}

// ════════════════════════════════════════════════════════════════════
// CREATOR AFFILIATE ADMISSION (US-9212)
// ════════════════════════════════════════════════════════════════════
//
// Accepting the creator terms is an application. This is where it becomes a
// cash-earning account, one creator at a time, because that is what the ADR
// decided and because every approval creates a person we may have to 1099.
// Approval requires an acceptance already on record — migration 00719's CHECK
// refuses program='creator' without one, so approving a stranger fails loudly
// rather than half-writing the row.

adminGrowthRoutes.get("/affiliate/creators", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("affiliate_accounts")
    .select(
      "user_id, program, creator_terms_version, creator_terms_accepted_at, creator_approved_at, payouts_enabled",
    )
    .not("creator_terms_accepted_at", "is", null)
    .order("creator_terms_accepted_at", { ascending: false })
    .limit(200);
  if (error) {
    return failSafe(c, 500, "Couldn't load creators.", error, "admin.growth.creators.list");
  }
  return c.json({ creators: data ?? [] });
});

adminGrowthRoutes.post("/affiliate/creators/:userId/approve", async (c) => {
  const userId = c.req.param("userId");

  const { data: acctRaw } = await supabaseAdmin
    .from("affiliate_accounts")
    .select("creator_terms_accepted_at, creator_terms_version")
    .eq("user_id", userId)
    .maybeSingle();
  const acct = acctRaw as
    | { creator_terms_accepted_at: string | null; creator_terms_version: string | null }
    | null;
  if (!acct?.creator_terms_accepted_at) {
    return c.json({ error: "That account has not accepted the creator terms." }, 400);
  }

  const approvedAt = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("affiliate_accounts")
    .update({ program: "creator", creator_approved_at: approvedAt })
    .eq("user_id", userId);
  if (error) {
    return failSafe(c, 500, "Couldn't admit that creator.", error, "admin.growth.creators.approve");
  }

  await writeAuditLog(c, {
    action: "growth.creator.approve",
    targetType: "affiliate_account",
    targetId: userId,
    details: { terms_version: acct.creator_terms_version, approved_at: approvedAt },
  });
  return c.json({ ok: true, program: "creator", approved_at: approvedAt });
});

// Removal, not deletion: the account drops back to the user programme and stops
// accruing cash. Commissions already earned stay on the ledger — clause 7 of the
// terms pays those, and voiding them here would be a money decision hidden
// inside an access change.
adminGrowthRoutes.post("/affiliate/creators/:userId/remove", async (c) => {
  const userId = c.req.param("userId");
  const { error } = await supabaseAdmin
    .from("affiliate_accounts")
    .update({ program: "user", creator_approved_at: null })
    .eq("user_id", userId);
  if (error) {
    return failSafe(c, 500, "Couldn't remove that creator.", error, "admin.growth.creators.remove");
  }
  await writeAuditLog(c, {
    action: "growth.creator.remove",
    targetType: "affiliate_account",
    targetId: userId,
  });
  return c.json({ ok: true, program: "user" });
});

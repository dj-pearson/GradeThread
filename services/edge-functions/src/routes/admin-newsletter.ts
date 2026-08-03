import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { bustSettingCache, getSetting } from "../lib/system-settings.ts";
import { captureException } from "../lib/observability.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";
import { requireStepUp } from "../lib/step-up.ts";
import { writeAuditLog } from "../lib/audit-log.ts";
import { deliverEmail } from "../lib/email.ts";
import { coordinateMarketingSend } from "../lib/marketing-coordinator.ts";
import { accountPreferenceCenterUrl, marketingUnsubscribeUrl } from "../lib/unsubscribe.ts";
import { runIssueGuardrailGate } from "../lib/newsletter-qa-job.ts";
import { clearFeatureFlagCache, isFeatureEnabled } from "../lib/feature-flags.ts";
import {
  canTransition,
  isEditable,
  isNewsletterStatus,
  type NewsletterSection,
  type NewsletterStatus,
  nextScheduledRun,
  type RenderableIssue,
  renderNewsletterHtml,
  runIssueQa,
} from "../lib/newsletter-issue.ts";
import {
  DEFAULT_DELIVERABILITY_THRESHOLDS,
  type DeliverabilityMetrics,
  type DeliverabilityThresholds,
  evaluateDeliverability,
} from "../lib/newsletter-thresholds.ts";
import { NEWSLETTER_TOPICS, SUBJECT_STYLES } from "../lib/newsletter-tuning.ts";
import { recomputeNewsletterTuning } from "../lib/newsletter-tuning-job.ts";
import {
  finalizeAbTest,
  issueWantsAbTest,
  type AbIssueRow,
  resolveAbConfig,
  startAbTest,
} from "../lib/newsletter-ab-job.ts";
import { loadScheduleConfig } from "../lib/newsletter-dispatch-job.ts";
import { assembleNextIssue } from "../lib/newsletter-assembler.ts";
import {
  personalizeIssueSections,
  substituteTokens,
} from "../lib/newsletter-personalization.ts";
import { resolvePersonalizationForBatch } from "../lib/newsletter-personalization-job.ts";
import { isQuietPeriod, nextSendWindow } from "../lib/newsletter-schedule.ts";
import {
  type AbMetric,
  normalizeVariants,
  type SubjectVariant,
  variantById,
} from "../lib/newsletter-ab.ts";
import { requireScope } from "../lib/scope-guard.ts";

// US-931: Email program analytics & deliverability dashboard (read-only) + a
// deliverability-guard enforcement action.
//
// Mounted at /api/admin/newsletter, inheriting authMiddleware + adminAuthMiddleware
// (admin JWT + AAL2) from the /api/admin/* group in main.ts. Aggregation is done
// server-side by the `newsletter_analytics(period)` RPC (migration 00278) over
// campaign_recipients + email_suppressions + email_subscribers. Complements
// PostHog (server-side, deliverability-focused) rather than duplicating it.

type AdminEnv = {
  Variables: {
    userId: string;
    adminRole: "admin" | "super_admin";
  };
};

export const adminNewsletterRoutes = new Hono<AdminEnv>();

// US-1560: whole-router scope guard (see lib/admin-scope-map.ts).
adminNewsletterRoutes.use("*", requireScope("content:publish"));

const VALID_PERIODS = new Set(["7d", "30d", "90d", "180d", "365d"]);

// Resolve the operator-tunable bounce/complaint cutoffs from the registry; the
// unsub/open warnings stay on their built-in defaults.
async function loadThresholds(): Promise<DeliverabilityThresholds> {
  const [complaintRate, bounceRate] = await Promise.all([
    getSetting<number>(
      "newsletter_complaint_rate_threshold",
      DEFAULT_DELIVERABILITY_THRESHOLDS.complaintRate,
    ),
    getSetting<number>(
      "newsletter_bounce_rate_threshold",
      DEFAULT_DELIVERABILITY_THRESHOLDS.bounceRate,
    ),
  ]);
  return {
    ...DEFAULT_DELIVERABILITY_THRESHOLDS,
    complaintRate: Number.isFinite(complaintRate)
      ? complaintRate
      : DEFAULT_DELIVERABILITY_THRESHOLDS.complaintRate,
    bounceRate: Number.isFinite(bounceRate)
      ? bounceRate
      : DEFAULT_DELIVERABILITY_THRESHOLDS.bounceRate,
  };
}

interface NewsletterProgram {
  sent: number;
  openRate: number;
  bounceRate: number;
  complaintRate: number;
  unsubRate: number;
  [k: string]: unknown;
}

interface NewsletterRollup {
  period: string;
  window: { start: string; end: string };
  program: NewsletterProgram;
  issues: unknown[];
}

function metricsOf(program: NewsletterProgram): DeliverabilityMetrics {
  return {
    sent: Number(program.sent) || 0,
    openRate: Number(program.openRate) || 0,
    bounceRate: Number(program.bounceRate) || 0,
    complaintRate: Number(program.complaintRate) || 0,
    unsubRate: Number(program.unsubRate) || 0,
  };
}

async function loadRollup(period: string): Promise<NewsletterRollup | null> {
  const { data, error } = await supabaseAdmin.rpc("newsletter_analytics", {
    p_period: period,
  });
  if (error) {
    captureException(error, { tags: { area: "admin-newsletter" } });
    return null;
  }
  return (data ?? null) as NewsletterRollup | null;
}

// GET /api/admin/newsletter/analytics?period=7d|30d|90d|180d|365d
adminNewsletterRoutes.get("/analytics", async (c) => {
  const period = c.req.query("period") ?? "30d";
  if (!VALID_PERIODS.has(period)) {
    return c.json(
      { error: `Invalid period. Use one of: ${[...VALID_PERIODS].join(", ")}` },
      400,
    );
  }

  const rollup = await loadRollup(period);
  if (!rollup) {
    return c.json({ error: "Failed to load newsletter analytics" }, 500);
  }

  const thresholds = await loadThresholds();
  const deliverability = evaluateDeliverability(metricsOf(rollup.program), thresholds);
  const sendPaused = await getSetting<boolean>("newsletter_send_paused", false);

  return c.json({
    period,
    window: rollup.window,
    analytics: rollup,
    deliverability,
    sendPaused: Boolean(sendPaused),
  });
});

// POST /api/admin/newsletter/deliverability/enforce
// The automatable deliverability guard (a future scheduled job can call it):
// recompute, and on a CRITICAL bounce/complaint breach raise an ops alert and —
// when newsletter_auto_pause_enabled is set — auto-pause sends via the
// newsletter_send_paused kill-switch. super_admin + fresh MFA step-up (it mutates
// the send kill-switch).
adminNewsletterRoutes.post("/deliverability/enforce", async (c) => {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  const blocked = requireStepUp(c);
  if (blocked) return blocked;

  const period = c.req.query("period") ?? "30d";
  const usePeriod = VALID_PERIODS.has(period) ? period : "30d";

  const rollup = await loadRollup(usePeriod);
  if (!rollup) {
    return c.json({ error: "Failed to load newsletter analytics" }, 500);
  }

  const thresholds = await loadThresholds();
  const deliverability = evaluateDeliverability(metricsOf(rollup.program), thresholds);

  let alerted = false;
  let paused = false;

  if (deliverability.status === "critical") {
    const autoPauseEnabled = await getSetting<boolean>(
      "newsletter_auto_pause_enabled",
      false,
    );

    // Raise the ops alert (best-effort; never blocks the response).
    await emitOpsEvent("newsletter.deliverability", "critical", {
      title: "Newsletter deliverability breach — bounce/complaint over threshold",
      source: "newsletter-guard",
      actorUserId: c.get("userId"),
      data: {
        period: usePeriod,
        bounceRate: rollup.program.bounceRate,
        complaintRate: rollup.program.complaintRate,
        flags: deliverability.flags,
        autoPauseEnabled: Boolean(autoPauseEnabled),
      },
    });
    alerted = true;

    if (autoPauseEnabled) {
      const { error } = await supabaseAdmin
        .from("system_settings")
        .update({ value: true, updated_by: c.get("userId") })
        .eq("key", "newsletter_send_paused");
      if (error) {
        captureException(error, { tags: { area: "admin-newsletter.pause" } });
      } else {
        bustSettingCache("newsletter_send_paused");
        paused = true;
      }
    }
  }

  return c.json({
    period: usePeriod,
    status: deliverability.status,
    flags: deliverability.flags,
    alerted,
    paused,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// US-930: Newsletter admin console — program oversight + per-issue lifecycle.
//
// One place to see the autonomous program, preview/test-send issues, toggle
// approval mode, and pause/kill the whole thing. Destructive actions
// (approve/reject/send + program toggles) require super_admin + fresh MFA
// step-up and are audited. The master kill-switch flips the `newsletter` feature
// flag so the program halts instantly platform-wide.
// ════════════════════════════════════════════════════════════════════════════

const ISSUE_COLS =
  "id, title, subject, preheader, sections, status, audience, segment_id, " +
  "scheduled_for, qa_results, recipients_total, sent_count, skipped_count, " +
  "failed_count, block_reason, created_by, approved_by, approved_at, " +
  "send_started_at, sent_at, created_at, updated_at, " +
  "pillar, angle, subject_style, send_hour, " +
  "subject_variants, ab_metric, ab_test_fraction, ab_measurement_hours, " +
  "ab_phase, ab_test_started_at, ab_winner_variant, ab_winner_source, personalize";

// Cap a single synchronous send so the request stays bounded. The autonomous
// engine (sibling story) sends larger lists in durable batches; the console's
// manual "send now" is for the operator and intentionally capped.
const MAX_SEND_RECIPIENTS = 1000;

interface NewsletterIssueRow {
  id: string;
  title: string;
  subject: string;
  preheader: string | null;
  sections: NewsletterSection[];
  status: NewsletterStatus;
  audience: string;
  segment_id: string | null;
  scheduled_for: string | null;
  qa_results: Record<string, unknown>;
  recipients_total: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  block_reason: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  send_started_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  pillar: string | null;
  angle: string | null;
  subject_style: string | null;
  send_hour: number | null;
  subject_variants: unknown;
  ab_metric: "open" | "click";
  ab_test_fraction: number | null;
  ab_measurement_hours: number | null;
  ab_phase: "none" | "testing" | "completed";
  ab_test_started_at: string | null;
  ab_winner_variant: string | null;
  ab_winner_source: "auto" | "operator" | "fallback" | null;
  personalize: boolean | null;
}

function toRenderable(row: NewsletterIssueRow): RenderableIssue {
  return {
    subject: row.subject,
    preheader: row.preheader,
    sections: Array.isArray(row.sections) ? row.sections : [],
  };
}

async function loadIssue(id: string): Promise<NewsletterIssueRow | null> {
  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .select(ISSUE_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    captureException(error, { tags: { area: "admin-newsletter.console" } });
    return null;
  }
  return (data as unknown as NewsletterIssueRow | null) ?? null;
}

// Gate the most damaging actions: super_admin + fresh MFA step-up. Returns a
// Response to short-circuit, or null to proceed.
function requireSensitive(c: Context<AdminEnv>): Response | null {
  if (c.get("adminRole") !== "super_admin") {
    return c.json({ error: "Super-admin access required" }, 403);
  }
  return requireStepUp(c);
}

// ── Program state + controls ─────────────────────────────────────────────────

// GET /api/admin/newsletter/program — pause / require-approval / kill-switch
// state + the next scheduled run.
adminNewsletterRoutes.get("/program", async (c) => {
  const [paused, requireApproval, killSwitchEnabled, schedule] = await Promise.all([
    getSetting<boolean>("newsletter_send_paused", false),
    getSetting<boolean>("newsletter_require_approval", true),
    isFeatureEnabled("newsletter"),
    loadScheduleConfig(),
  ]);

  const { data: queued } = await supabaseAdmin
    .from("newsletter_issues")
    .select("status, scheduled_for")
    .not("scheduled_for", "is", null)
    .in("status", ["draft", "ready_for_qa", "awaiting_review", "approved"]);

  const nowMs = Date.now();
  const next = nextScheduledRun(
    ((queued ?? []) as { status: NewsletterStatus; scheduled_for: string | null }[]).map((r) => ({
      status: r.status,
      scheduledFor: r.scheduled_for,
    })),
    nowMs,
  );

  return c.json({
    paused: Boolean(paused),
    requireApproval: Boolean(requireApproval),
    killSwitchEnabled: killSwitchEnabled,
    // The earliest already-scheduled issue, plus the config-driven NEXT weekly
    // window (US-926) so the console shows the cadence even with nothing queued.
    nextScheduledRun: next,
    schedule: {
      weekday: schedule.weekday,
      hour: schedule.hour,
      timezone: schedule.timezone,
      cadencePeriodDays: schedule.cadencePeriodDays,
      sendTimeOptimization: schedule.stoEnabled,
      stoWindowHours: schedule.stoWindowHours,
      quietPeriodUntil: schedule.quietPeriodUntil,
      inQuietPeriod: isQuietPeriod(schedule.quietPeriodUntil, nowMs),
      nextWindow: nextSendWindow(schedule, nowMs),
    },
  });
});

// PATCH /api/admin/newsletter/program — flip the master controls. super_admin +
// step-up; audited. Body may include any of { paused, requireApproval, killSwitch }.
adminNewsletterRoutes.patch("/program", async (c) => {
  const blocked = requireSensitive(c);
  if (blocked) return blocked;

  const body = (await c.req.json().catch(() => ({}))) as {
    paused?: boolean;
    requireApproval?: boolean;
    killSwitch?: boolean;
    quietPeriodUntil?: string | null;
  };
  const adminId = c.get("userId");

  const changed: Record<string, unknown> = {};

  if (typeof body.paused === "boolean") {
    const { error } = await supabaseAdmin
      .from("system_settings")
      .update({ value: body.paused, updated_by: adminId })
      .eq("key", "newsletter_send_paused");
    if (error) {
      captureException(error, { tags: { area: "admin-newsletter.program" } });
      return c.json({ error: "Failed to update pause state" }, 500);
    }
    bustSettingCache("newsletter_send_paused");
    changed.paused = body.paused;
  }

  if (typeof body.requireApproval === "boolean") {
    const { error } = await supabaseAdmin
      .from("system_settings")
      .update({ value: body.requireApproval, updated_by: adminId })
      .eq("key", "newsletter_require_approval");
    if (error) {
      captureException(error, { tags: { area: "admin-newsletter.program" } });
      return c.json({ error: "Failed to update approval mode" }, 500);
    }
    bustSettingCache("newsletter_require_approval");
    changed.requireApproval = body.requireApproval;
  }

  if (typeof body.killSwitch === "boolean") {
    // killSwitch=true means the program is ENABLED (flag on); false halts it.
    const { error } = await supabaseAdmin
      .from("feature_flags")
      .update({ enabled: body.killSwitch, updated_by: adminId })
      .eq("key", "newsletter");
    if (error) {
      captureException(error, { tags: { area: "admin-newsletter.program" } });
      return c.json({ error: "Failed to update kill-switch" }, 500);
    }
    clearFeatureFlagCache();
    changed.killSwitchEnabled = body.killSwitch;
  }

  // US-926: holiday/quiet-period pause — skip dispatch until an ISO instant without
  // touching the cadence clock. Pass "" / null to clear it.
  if ("quietPeriodUntil" in body) {
    const raw = (body.quietPeriodUntil ?? "").trim();
    if (raw && !Number.isFinite(Date.parse(raw))) {
      return c.json({ error: "quietPeriodUntil must be an ISO datetime or empty to clear" }, 400);
    }
    const { error } = await supabaseAdmin
      .from("system_settings")
      .update({ value: raw, updated_by: adminId })
      .eq("key", "newsletter_quiet_period_until");
    if (error) {
      captureException(error, { tags: { area: "admin-newsletter.program" } });
      return c.json({ error: "Failed to update quiet period" }, 500);
    }
    bustSettingCache("newsletter_quiet_period_until");
    changed.quietPeriodUntil = raw || null;
  }

  if (Object.keys(changed).length === 0) {
    return c.json({ error: "No recognized program controls in body" }, 400);
  }

  await writeAuditLog(c, {
    action: "newsletter.program.update",
    targetType: "newsletter_program",
    targetId: "program",
    after: changed,
  });

  return c.json({ ok: true, changed });
});

// ── Issue listing + drill-in ─────────────────────────────────────────────────

// GET /api/admin/newsletter/issues?status=draft — list issues (optionally
// filtered by status), newest first.
adminNewsletterRoutes.get("/issues", async (c) => {
  const status = c.req.query("status");
  let q = supabaseAdmin
    .from("newsletter_issues")
    .select(ISSUE_COLS)
    .order("created_at", { ascending: false })
    .limit(200);
  if (status && isNewsletterStatus(status)) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    captureException(error, { tags: { area: "admin-newsletter.console" } });
    return c.json({ error: "Failed to load issues" }, 500);
  }
  return c.json({ issues: (data ?? []) as unknown as NewsletterIssueRow[] });
});

// GET /api/admin/newsletter/issues/:id — drill-in: the issue + resolved
// recipients (status + skip reasons) + live send-progress summary.
adminNewsletterRoutes.get("/issues/:id", async (c) => {
  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);

  const { data: recipients } = await supabaseAdmin
    .from("newsletter_issue_recipients")
    .select("id, email, status, skip_reason, sent_at, created_at")
    .eq("issue_id", issue.id)
    .order("created_at", { ascending: true })
    .limit(MAX_SEND_RECIPIENTS);

  const rows = (recipients ?? []) as {
    status: string;
    skip_reason: string | null;
  }[];
  const skipReasons: Record<string, number> = {};
  for (const r of rows) {
    if (r.status === "skipped" && r.skip_reason) {
      skipReasons[r.skip_reason] = (skipReasons[r.skip_reason] ?? 0) + 1;
    }
  }

  return c.json({
    issue,
    recipients: recipients ?? [],
    progress: {
      total: issue.recipients_total,
      sent: issue.sent_count,
      skipped: issue.skipped_count,
      failed: issue.failed_count,
      pending: rows.filter((r) => r.status === "pending").length,
      sending: issue.status === "sending",
      skipReasons,
    },
  });
});

// ── Issue creation + editing ─────────────────────────────────────────────────

// POST /api/admin/newsletter/issues/build-next — build the next issue now. With
// no autonomous content engine wired yet this scaffolds an editable draft; the
// engine (sibling story) will populate richer AI content into the same shape.
//
// US-928: topic, subject style, and send hour are chosen by the self-tuning weights
// (engagement-biased, with the exploration floor keeping under-tested topics in
// rotation and paused topics excluded). US-923: the actual assembly lives in the
// shared lib/newsletter-assembler.ts so this console button and the autonomous
// kickoff tick (routes/newsletter-scheduler.ts) never drift on how an issue is born.
adminNewsletterRoutes.post("/issues/build-next", async (c) => {
  const result = await assembleNextIssue(c.get("userId"), Date.now());
  if (!result.issue) {
    captureException(new Error(result.error ?? "insert returned no row"), {
      tags: { area: "admin-newsletter.console" },
    });
    return c.json({ error: "Failed to build issue" }, 500);
  }

  await writeAuditLog(c, {
    action: "newsletter.issue.build",
    targetType: "newsletter_issue",
    targetId: result.issue.id,
    details: {
      topic: result.chosen.topicId,
      subjectStyle: result.chosen.styleId,
      sendHour: result.chosen.sendHour,
    },
  });

  return c.json({ issue: result.issue.row as NewsletterIssueRow }, 201);
});

// ── Self-tuning transparency + override (US-928) ─────────────────────────────

// GET /api/admin/newsletter/tuning — the current learned weights, the config, the
// latest recommendations snapshot, and the catalog labels. Read-only surface so
// the console can show WHAT the program learned and WHY (AC4). Override is via the
// settings registry editor (/admin/ops/settings) — the keys are registered there.
adminNewsletterRoutes.get("/tuning", async (c) => {
  const [enabled, topicWeights, styleWeights, hourStats, recommendations, minSample, floor, ceiling] =
    await Promise.all([
      getSetting<boolean>("newsletter_tuning_enabled", true),
      getSetting<Record<string, number>>("newsletter_topic_weights", {}),
      getSetting<Record<string, number>>("newsletter_subject_style_weights", {}),
      getSetting<unknown>("newsletter_send_hour_stats", {}),
      getSetting<unknown>("newsletter_tuning_recommendations", {}),
      getSetting<number>("newsletter_tuning_min_sample", 50),
      getSetting<number>("newsletter_tuning_exploration_floor", 0.15),
      getSetting<number>("newsletter_tuning_unsub_ceiling", 0.005),
    ]);

  return c.json({
    enabled: Boolean(enabled),
    config: { minSample, explorationFloor: floor, unsubCeiling: ceiling },
    topicWeights: topicWeights ?? {},
    subjectStyleWeights: styleWeights ?? {},
    sendHourStats: hourStats ?? {},
    recommendations: recommendations ?? {},
    catalog: {
      topics: NEWSLETTER_TOPICS,
      subjectStyles: SUBJECT_STYLES.map((s) => ({ id: s.id, label: s.label })),
    },
  });
});

// POST /api/admin/newsletter/tuning/recompute — run the analysis pass now (the
// same logic the scheduled cron runs). Lets an operator force a refresh from the
// console instead of waiting for the daily cron. Audited.
adminNewsletterRoutes.post("/tuning/recompute", async (c) => {
  try {
    const nowMs = Date.now();
    const result = await recomputeNewsletterTuning(
      nowMs,
      new Date(nowMs).toISOString(),
      c.get("userId"),
    );
    await writeAuditLog(c, {
      action: "newsletter.tuning.recompute",
      targetType: "newsletter_program",
      targetId: "tuning",
      details: {
        topicWinner: result.recommendations.topicWinner,
        pausedTopics: result.recommendations.pausedTopics,
        topicSent: result.recommendations.topicSent,
      },
    });
    return c.json({ ok: true, recommendations: result.recommendations });
  } catch (err) {
    captureException(err, { tags: { area: "admin-newsletter.tuning" } });
    return c.json({ error: "Failed to recompute tuning" }, 500);
  }
});

// PATCH /api/admin/newsletter/issues/:id — edit subject/sections/schedule before
// send. Only allowed in pre-send states; re-runs QA when content changes.
adminNewsletterRoutes.patch("/issues/:id", async (c) => {
  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);
  if (!isEditable(issue.status)) {
    return c.json(
      { error: `An issue in '${issue.status}' can no longer be edited` },
      409,
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    subject?: string;
    preheader?: string | null;
    sections?: NewsletterSection[];
    audience?: string;
    scheduledFor?: string | null;
    subjectVariants?: SubjectVariant[];
    abMetric?: AbMetric;
    abTestFraction?: number | null;
    abMeasurementHours?: number | null;
    personalize?: boolean;
  };

  const patch: Record<string, unknown> = {};
  // US-921: per-issue personalization toggle (some broadcasts are non-personalized).
  if (typeof body.personalize === "boolean") patch.personalize = body.personalize;
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.subject === "string") patch.subject = body.subject;
  if ("preheader" in body) patch.preheader = body.preheader ?? null;
  if (Array.isArray(body.sections)) patch.sections = body.sections;
  if (typeof body.audience === "string") patch.audience = body.audience;
  if ("scheduledFor" in body) patch.scheduled_for = body.scheduledFor || null;
  // US-927: editable A/B controls — the copywriter (or operator) sets the subject
  // variants; the metric/fraction/window are optional per-issue overrides.
  if (Array.isArray(body.subjectVariants)) {
    patch.subject_variants = normalizeVariants(body.subjectVariants, issue.subject);
  }
  if (body.abMetric === "open" || body.abMetric === "click") patch.ab_metric = body.abMetric;
  if ("abTestFraction" in body) {
    patch.ab_test_fraction = typeof body.abTestFraction === "number" ? body.abTestFraction : null;
  }
  if ("abMeasurementHours" in body) {
    patch.ab_measurement_hours = typeof body.abMeasurementHours === "number"
      ? Math.floor(body.abMeasurementHours)
      : null;
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No editable fields in body" }, 400);
  }

  // Re-run QA against the merged content so the stored report stays accurate.
  const nextSubject = (patch.subject as string | undefined) ?? issue.subject;
  const nextSections = (patch.sections as NewsletterSection[] | undefined) ??
    issue.sections;
  patch.qa_results = runIssueQa({ subject: nextSubject, sections: nextSections });

  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .update(patch)
    .eq("id", issue.id)
    .select(ISSUE_COLS)
    .maybeSingle();
  if (error || !data) {
    captureException(error ?? new Error("update returned no row"), {
      tags: { area: "admin-newsletter.console" },
    });
    return c.json({ error: "Failed to update issue" }, 500);
  }

  await writeAuditLog(c, {
    action: "newsletter.issue.edit",
    targetType: "newsletter_issue",
    targetId: issue.id,
    details: { fields: Object.keys(patch) },
  });

  return c.json({ issue: data as unknown as NewsletterIssueRow });
});

// ── Preview + test send ──────────────────────────────────────────────────────

// POST /api/admin/newsletter/issues/:id/preview — render the issue HTML (with a
// sample unsubscribe link) so the operator can eyeball it.
adminNewsletterRoutes.post("/issues/:id/preview", async (c) => {
  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);

  const html = renderNewsletterHtml(toRenderable(issue), {
    unsubscribeUrl: "https://gradethread.com/unsubscribe?preview=1",
    preferenceCenterUrl: accountPreferenceCenterUrl(),
    postalAddress: Deno.env.get("COMPANY_POSTAL_ADDRESS")?.trim() ||
      "Pearson Media LLC, Iowa, USA",
  });
  return c.json({ html, subject: issue.subject });
});

// POST /api/admin/newsletter/issues/:id/test-send — send ONE test email to an
// admin address. Bypasses marketing gating (it's a transactional preview), and
// is prefixed [TEST]. Audited.
adminNewsletterRoutes.post("/issues/:id/test-send", async (c) => {
  // US-2356 AC2: same shape as the drip test-send — an arbitrary recipient
  // means unreleased issue content can leave the building one address at a time.
  {
    const stepUp = requireStepUp(c);
    if (stepUp) return stepUp;
  }
  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "A valid test recipient email is required" }, 400);
  }

  const html = renderNewsletterHtml(toRenderable(issue), {
    unsubscribeUrl: "https://gradethread.com/unsubscribe?preview=1",
    preferenceCenterUrl: accountPreferenceCenterUrl(),
    postalAddress: Deno.env.get("COMPANY_POSTAL_ADDRESS")?.trim() ||
      "Pearson Media LLC, Iowa, USA",
  });
  const sent = await deliverEmail({
    to: email,
    subject: `[TEST] ${issue.subject || issue.title}`,
    html,
  });

  await writeAuditLog(c, {
    action: "newsletter.issue.test_send",
    targetType: "newsletter_issue",
    targetId: issue.id,
    details: { to: email, sent },
  });

  if (!sent) {
    return c.json({ error: "Test email could not be delivered" }, 502);
  }
  return c.json({ ok: true, to: email });
});

// ── Lifecycle transitions (approve / reject / qa / reopen) ────────────────────

// POST /api/admin/newsletter/issues/:id/transition — drive the status machine.
// Body: { to, reason? }. Advancing TO 'approved' or 'blocked' is a sensitive
// action (super_admin + step-up + audit); QA must pass to reach 'ready_for_qa'.
adminNewsletterRoutes.post("/issues/:id/transition", async (c) => {
  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as {
    to?: string;
    reason?: string;
  };
  const to = body.to;
  if (!to || !isNewsletterStatus(to)) {
    return c.json({ error: "A valid target 'to' status is required" }, 400);
  }
  // 'sending' is reached only through the /send endpoint (it performs the send).
  if (to === "sending") {
    return c.json({ error: "Use POST /issues/:id/send to start a send" }, 400);
  }
  if (!canTransition(issue.status, to)) {
    return c.json(
      { error: `Cannot move an issue from '${issue.status}' to '${to}'` },
      409,
    );
  }

  // Approving or blocking (reject) is destructive → super_admin + step-up.
  if (to === "approved" || to === "blocked") {
    const gate = requireSensitive(c);
    if (gate) return gate;
  }

  const patch: Record<string, unknown> = { status: to };

  if (to === "ready_for_qa") {
    const qa = runIssueQa(toRenderable(issue));
    patch.qa_results = qa;
    if (!qa.passed) {
      return c.json(
        { error: "QA failed — fix the flagged checks before QA review", qa },
        422,
      );
    }
  }
  if (to === "approved") {
    patch.approved_by = c.get("userId");
    patch.approved_at = new Date().toISOString();
    patch.block_reason = null;
  }
  if (to === "blocked") {
    patch.block_reason = (body.reason ?? "").trim() || "Blocked by operator";
  }
  if (to === "draft") {
    // Reopen clears a prior approval/block.
    patch.approved_by = null;
    patch.approved_at = null;
    patch.block_reason = null;
  }

  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .update(patch)
    .eq("id", issue.id)
    .select(ISSUE_COLS)
    .maybeSingle();
  if (error || !data) {
    captureException(error ?? new Error("update returned no row"), {
      tags: { area: "admin-newsletter.console" },
    });
    return c.json({ error: "Failed to transition issue" }, 500);
  }

  await writeAuditLog(c, {
    action: "newsletter.issue.transition",
    targetType: "newsletter_issue",
    targetId: issue.id,
    before: { status: issue.status },
    after: { status: to },
    details: body.reason ? { reason: body.reason } : undefined,
  });

  return c.json({ issue: data as unknown as NewsletterIssueRow });
});

// ── Autonomous pre-send QA / guardrail gate (US-924) ─────────────────────────

// POST /api/admin/newsletter/issues/:id/qa-gate — run the full automated
// guardrail gate (structural compliance QA + AI editor brand-voice/factual pass)
// and transition the issue accordingly: pass → approved (or awaiting_review when
// require-approval is on) / fail → blocked (with reasons + an ops alert). This is
// the same gate the autonomous engine runs unattended; the console exposes it so
// an operator can trigger + inspect it. Auto-approving is destructive →
// super_admin + step-up; audited.
adminNewsletterRoutes.post("/issues/:id/qa-gate", async (c) => {
  const gate = requireSensitive(c);
  if (gate) return gate;

  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);
  if (!isEditable(issue.status)) {
    return c.json(
      { error: `An issue in '${issue.status}' cannot be re-gated` },
      409,
    );
  }

  let result;
  try {
    result = await runIssueGuardrailGate(issue.id, { actorUserId: c.get("userId") });
  } catch (err) {
    captureException(err, { tags: { area: "admin-newsletter.qa-gate" } });
    return c.json({ error: "QA gate failed to run" }, 500);
  }
  if (!result) {
    return c.json({ error: "Issue could not be gated (not in a gateable state)" }, 409);
  }

  await writeAuditLog(c, {
    action: "newsletter.issue.qa_gate",
    targetType: "newsletter_issue",
    targetId: issue.id,
    before: { status: issue.status },
    after: { status: result.outcome },
    details: {
      outcome: result.outcome,
      reasons: result.reasons,
      spamScore: result.qaReport.spamScore,
      aiHardFlag: result.aiEditor.hardFlag,
    },
  });

  return c.json({
    ok: true,
    outcome: result.outcome,
    reasons: result.reasons,
    issue: (await loadIssue(issue.id)) ?? null,
  });
});

// ── Send ─────────────────────────────────────────────────────────────────────

// POST /api/admin/newsletter/issues/:id/send — send an approved issue now.
// super_admin + step-up; audited. Honors the kill-switch + pause brake. Resolves
// confirmed subscribers, routes every send through the marketing coordinator
// (consent + suppression + frequency cap + drip precedence), records the
// per-recipient ledger + counters, then marks the issue sent.
adminNewsletterRoutes.post("/issues/:id/send", async (c) => {
  const gate = requireSensitive(c);
  if (gate) return gate;

  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);

  if (!canTransition(issue.status, "sending")) {
    return c.json(
      { error: `An issue in '${issue.status}' cannot be sent (must be approved)` },
      409,
    );
  }

  // Safety brakes.
  if (!(await isFeatureEnabled("newsletter"))) {
    return c.json({ error: "The newsletter program is halted (kill-switch off)" }, 409);
  }
  if (await getSetting<boolean>("newsletter_send_paused", false)) {
    return c.json({ error: "Newsletter sending is paused" }, 409);
  }

  // US-927: if the issue carries 2+ subject variants and A/B testing is enabled,
  // run the A/B TEST phase (send the holdout with variants assigned) instead of a
  // single send. The finalize cron — or POST /issues/:id/ab/finalize — then picks
  // the winner and sends it to the remainder after the measurement window.
  const abConfig = await resolveAbConfig(issue);
  if (issueWantsAbTest(issue as unknown as AbIssueRow, abConfig)) {
    const start = await startAbTest(issue as unknown as AbIssueRow, abConfig);
    if (!start.ok) {
      return c.json({ error: `A/B test could not start (${start.reason})` }, 409);
    }
    await writeAuditLog(c, {
      action: "newsletter.issue.ab_start",
      targetType: "newsletter_issue",
      targetId: issue.id,
      details: {
        variants: start.variants.map((v) => v.id),
        holdout: start.holdoutSize,
        remainder: start.remainderSize,
        summary: start.summary,
      },
    });
    return c.json({
      ok: true,
      phase: "testing",
      issue: (await loadIssue(issue.id)) ?? null,
      summary: start.summary,
      ab: {
        variants: start.variants,
        holdoutSize: start.holdoutSize,
        remainderSize: start.remainderSize,
        measurementHours: abConfig.measurementHours,
      },
    });
  }

  // Resolve the confirmed list (capped for a bounded synchronous send).
  const { data: subs, error: subErr } = await supabaseAdmin
    .from("email_subscribers")
    .select("email, user_id")
    .eq("status", "confirmed")
    .limit(MAX_SEND_RECIPIENTS);
  if (subErr) {
    captureException(subErr, { tags: { area: "admin-newsletter.send" } });
    return c.json({ error: "Failed to resolve recipients" }, 500);
  }
  const recipients = (subs ?? []) as { email: string; user_id: string | null }[];

  // Lock the issue for sending.
  await supabaseAdmin
    .from("newsletter_issues")
    .update({
      status: "sending",
      send_started_at: new Date().toISOString(),
      recipients_total: recipients.length,
      sent_count: 0,
      skipped_count: 0,
      failed_count: 0,
    })
    .eq("id", issue.id);
  // Clear any prior partial ledger (idempotent re-send).
  await supabaseAdmin.from("newsletter_issue_recipients").delete().eq("issue_id", issue.id);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const renderable = toRenderable(issue);
  // US-921: resolve every recipient's activity ONCE for the batch (no N+1).
  const pctx = await resolvePersonalizationForBatch(
    recipients,
    issue.personalize !== false,
    Date.now(),
  );

  for (const r of recipients) {
    // Standalone leads with no linked account can't get a consent check or a
    // signed unsubscribe link — skip with a recorded reason (drill-in shows it).
    if (!r.user_id) {
      skipped++;
      await supabaseAdmin.from("newsletter_issue_recipients").insert({
        issue_id: issue.id,
        email: r.email,
        status: "skipped",
        skip_reason: "no_account",
      });
      continue;
    }

    try {
      const unsubscribeUrl = await marketingUnsubscribeUrl(r.user_id);
      let renderableForRecipient = renderable;
      let subjectForRecipient = issue.subject || issue.title;
      if (pctx.enabled) {
        const activity = r.user_id ? pctx.activity.get(r.user_id) ?? null : null;
        const p = personalizeIssueSections(renderable.sections, activity, {
          siteUrl: pctx.siteUrl,
          trialSoonDays: pctx.trialSoonDays,
        });
        renderableForRecipient = { ...renderable, sections: p.sections };
        subjectForRecipient = substituteTokens(subjectForRecipient, p.tokens);
      }
      const html = renderNewsletterHtml(renderableForRecipient, {
        unsubscribeUrl,
        preferenceCenterUrl: accountPreferenceCenterUrl(),
        postalAddress: Deno.env.get("COMPANY_POSTAL_ADDRESS")?.trim() ||
          "Pearson Media LLC, Iowa, USA",
      });
      const result = await coordinateMarketingSend({
        to: r.email,
        userId: r.user_id,
        source: "weekly_newsletter",
        category: `newsletter:${issue.id}`,
        subject: subjectForRecipient,
        html,
      });

      if (result.action === "drop") {
        skipped++;
        await supabaseAdmin.from("newsletter_issue_recipients").insert({
          issue_id: issue.id,
          email: r.email,
          subscriber_user_id: r.user_id,
          status: "skipped",
          skip_reason: result.reason,
        });
      } else {
        // send or defer — both durably accepted.
        sent++;
        await supabaseAdmin.from("newsletter_issue_recipients").insert({
          issue_id: issue.id,
          email: r.email,
          subscriber_user_id: r.user_id,
          status: "sent",
          sent_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      failed++;
      captureException(err, { tags: { area: "admin-newsletter.send" } });
      await supabaseAdmin.from("newsletter_issue_recipients").insert({
        issue_id: issue.id,
        email: r.email,
        subscriber_user_id: r.user_id,
        status: "failed",
      });
    }
  }

  const { data: finalRow } = await supabaseAdmin
    .from("newsletter_issues")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      sent_count: sent,
      skipped_count: skipped,
      failed_count: failed,
    })
    .eq("id", issue.id)
    .select(ISSUE_COLS)
    .maybeSingle();

  await writeAuditLog(c, {
    action: "newsletter.issue.send",
    targetType: "newsletter_issue",
    targetId: issue.id,
    details: { total: recipients.length, sent, skipped, failed },
  });

  return c.json({
    ok: true,
    issue: (finalRow as unknown as NewsletterIssueRow) ?? null,
    summary: { total: recipients.length, sent, skipped, failed },
  });
});

// ── A/B subject test (US-927) ────────────────────────────────────────────────

// GET /api/admin/newsletter/issues/:id/ab — the A/B test state: variants, phase,
// per-variant holdout engagement so far, the (chosen or projected) winner, and
// config. Read-only transparency surface (AC4).
adminNewsletterRoutes.get("/issues/:id/ab", async (c) => {
  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);

  const variants = normalizeVariants(issue.subject_variants, issue.subject);
  const config = await resolveAbConfig(issue as unknown as AbIssueRow);

  // Per-variant holdout engagement (rolled up from the ledger).
  const { data: holdout } = await supabaseAdmin
    .from("newsletter_issue_recipients")
    .select("variant, opened_at, clicked_at")
    .eq("issue_id", issue.id)
    .eq("is_ab_holdout", true)
    .limit(MAX_SEND_RECIPIENTS);
  const rows = (holdout ?? []) as Array<{ variant: string | null; opened_at: string | null; clicked_at: string | null }>;
  const perVariant: Record<string, { sent: number; opened: number; clicked: number }> = {};
  for (const v of variants) perVariant[v.id] = { sent: 0, opened: 0, clicked: 0 };
  for (const r of rows) {
    if (!r.variant || !perVariant[r.variant]) continue;
    const pv = perVariant[r.variant]!;
    pv.sent += 1;
    if (r.opened_at || r.clicked_at) pv.opened += 1;
    if (r.clicked_at) pv.clicked += 1;
  }

  return c.json({
    enabled: config.enabled,
    phase: issue.ab_phase,
    metric: issue.ab_metric,
    variants,
    config: {
      testFraction: config.testFraction,
      measurementHours: config.measurementHours,
      minSample: config.minSample,
    },
    testStartedAt: issue.ab_test_started_at,
    winnerVariant: issue.ab_winner_variant,
    winnerSource: issue.ab_winner_source,
    perVariant,
  });
});

// POST /api/admin/newsletter/issues/:id/ab/winner — operator override of the
// winning variant (AC4: visible/overridable). Settable while the test is running;
// the finalize pass then honors it instead of auto-selecting. super_admin +
// step-up; audited.
adminNewsletterRoutes.post("/issues/:id/ab/winner", async (c) => {
  const gate = requireSensitive(c);
  if (gate) return gate;

  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);
  if (issue.ab_phase !== "testing") {
    return c.json({ error: "A winner can only be overridden while the A/B test is running" }, 409);
  }

  const body = (await c.req.json().catch(() => ({}))) as { variant?: string };
  const variants = normalizeVariants(issue.subject_variants, issue.subject);
  if (!body.variant || !variantById(variants, body.variant)) {
    return c.json({ error: "A valid variant id is required" }, 400);
  }

  const { error } = await supabaseAdmin
    .from("newsletter_issues")
    .update({ ab_winner_variant: body.variant, ab_winner_source: "operator" })
    .eq("id", issue.id);
  if (error) {
    captureException(error, { tags: { area: "admin-newsletter.ab" } });
    return c.json({ error: "Failed to set winner override" }, 500);
  }

  await writeAuditLog(c, {
    action: "newsletter.issue.ab_winner_override",
    targetType: "newsletter_issue",
    targetId: issue.id,
    details: { variant: body.variant },
  });

  return c.json({ ok: true, winnerVariant: body.variant, winnerSource: "operator" });
});

// POST /api/admin/newsletter/issues/:id/ab/finalize — finalize the running test
// NOW (skip the measurement-window wait): pick the winner from holdout engagement
// (or the operator override), send it to the remainder, mark the issue sent.
// super_admin + step-up; audited. The cron does this autonomously on schedule.
adminNewsletterRoutes.post("/issues/:id/ab/finalize", async (c) => {
  const gate = requireSensitive(c);
  if (gate) return gate;

  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);
  if (issue.ab_phase !== "testing") {
    return c.json({ error: `No running A/B test to finalize (phase '${issue.ab_phase}')` }, 409);
  }

  const config = await resolveAbConfig(issue as unknown as AbIssueRow);
  const result = await finalizeAbTest(issue as unknown as AbIssueRow, config, Date.now(), { force: true });
  if (!result.ok) {
    return c.json({ error: `Finalize failed (${result.reason})` }, 409);
  }

  await writeAuditLog(c, {
    action: "newsletter.issue.ab_finalize",
    targetType: "newsletter_issue",
    targetId: issue.id,
    details: {
      winner: result.winnerId,
      source: result.winnerSource,
      metric: result.metric,
      remainder: result.remainderSummary,
    },
  });

  return c.json({
    ok: true,
    winnerVariant: result.winnerId,
    winnerSource: result.winnerSource,
    metric: result.metric,
    scores: result.scores,
    remainderSummary: result.remainderSummary,
    issue: (await loadIssue(issue.id)) ?? null,
  });
});

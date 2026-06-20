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
import { marketingUnsubscribeUrl } from "../lib/unsubscribe.ts";
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
import {
  NEWSLETTER_TOPICS,
  selectWeightedKey,
  SUBJECT_STYLES,
  subjectStyleById,
  topicById,
} from "../lib/newsletter-tuning.ts";
import { recomputeNewsletterTuning } from "../lib/newsletter-tuning-job.ts";

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
  "pillar, angle, subject_style, send_hour";

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
  const [paused, requireApproval, killSwitchEnabled] = await Promise.all([
    getSetting<boolean>("newsletter_send_paused", false),
    getSetting<boolean>("newsletter_require_approval", true),
    isFeatureEnabled("newsletter"),
  ]);

  const { data: queued } = await supabaseAdmin
    .from("newsletter_issues")
    .select("status, scheduled_for")
    .not("scheduled_for", "is", null)
    .in("status", ["draft", "ready_for_qa", "awaiting_review", "approved"]);

  const next = nextScheduledRun(
    ((queued ?? []) as { status: NewsletterStatus; scheduled_for: string | null }[]).map((r) => ({
      status: r.status,
      scheduledFor: r.scheduled_for,
    })),
    Date.now(),
  );

  return c.json({
    paused: Boolean(paused),
    requireApproval: Boolean(requireApproval),
    killSwitchEnabled: killSwitchEnabled,
    nextScheduledRun: next,
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

// Uniform-weight fallback (cold start, before any engagement is recorded) so the
// assembler still rotates across the catalog instead of always picking the first.
function uniformWeights(ids: string[]): Record<string, number> {
  return Object.fromEntries(ids.map((id) => [id, 1]));
}

// The next future UTC datetime whose hour == `hour`. Pure given `nowMs`.
function nextSendAt(hour: number, nowMs: number): string {
  const d = new Date(nowMs);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(hour);
  if (d.getTime() <= nowMs) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

// US-928: the self-tuning bias the assembler reads. Topic + subject-style
// selection are weighted by the computed stores (favoring higher-engaging, away
// from paused), and the send time consumes the per-hour stats. All data-driven —
// the cron populates the stores from engagement; this just consumes them.
async function loadAssemblerBias(): Promise<{
  topicWeights: Record<string, number>;
  styleWeights: Record<string, number>;
  bestHour: number | null;
}> {
  const [topicWeights, styleWeights, hourStats] = await Promise.all([
    getSetting<Record<string, number>>("newsletter_topic_weights", {}),
    getSetting<Record<string, number>>("newsletter_subject_style_weights", {}),
    getSetting<{ bestHour: number | null }>("newsletter_send_hour_stats", { bestHour: null }),
  ]);
  return {
    topicWeights: topicWeights ?? {},
    styleWeights: styleWeights ?? {},
    bestHour: typeof hourStats?.bestHour === "number" ? hourStats.bestHour : null,
  };
}

// POST /api/admin/newsletter/issues/build-next — build the next issue now. With
// no autonomous content engine wired yet this scaffolds an editable draft; the
// engine (sibling story) will populate richer AI content into the same shape.
//
// US-928: topic, subject style, and send hour are now chosen by the self-tuning
// weights (engagement-biased, with the exploration floor keeping under-tested
// topics in rotation and paused topics excluded). The chosen dimensions are
// stamped on the issue so the next analysis pass can attribute its engagement.
adminNewsletterRoutes.post("/issues/build-next", async (c) => {
  const bias = await loadAssemblerBias();
  const nowMs = Date.now();
  const seed = `nl-${nowMs}`;

  // A weighted pick that can't resolve to a catalog entry (empty/stale weights)
  // falls back to a uniform pick over the live catalog — always resolvable.
  const topic =
    topicById(selectWeightedKey(bias.topicWeights, seed) ?? "") ??
    topicById(selectWeightedKey(uniformWeights(NEWSLETTER_TOPICS.map((t) => t.id)), seed)!)!;

  const style =
    subjectStyleById(selectWeightedKey(bias.styleWeights, `${seed}:style`) ?? "") ??
    subjectStyleById(
      selectWeightedKey(uniformWeights(SUBJECT_STYLES.map((s) => s.id)), `${seed}:style`)!,
    )!;

  // Send-time optimization: use the learned best hour, else a sensible default.
  const sendHour = bias.bestHour ?? 14;
  const scheduledFor = nextSendAt(sendHour, nowMs);

  const sections: NewsletterSection[] = [
    {
      heading: topic.label,
      body:
        `<p>Draft issue on <strong>${topic.label}</strong> (pillar: ${topic.pillar}). ` +
        `Suggested subject style: <em>${style.label}</em> — ${style.guidance} ` +
        `Edit these sections before sending.</p>`,
    },
  ];
  const qa = runIssueQa({ subject: "", sections });

  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .insert({
      title: topic.label,
      subject: "",
      sections,
      status: "draft",
      qa_results: qa,
      pillar: topic.pillar,
      angle: topic.angle,
      subject_style: style.id,
      send_hour: sendHour,
      scheduled_for: scheduledFor,
      created_by: c.get("userId"),
    })
    .select(ISSUE_COLS)
    .maybeSingle();
  if (error || !data) {
    captureException(error ?? new Error("insert returned no row"), {
      tags: { area: "admin-newsletter.console" },
    });
    return c.json({ error: "Failed to build issue" }, 500);
  }

  await writeAuditLog(c, {
    action: "newsletter.issue.build",
    targetType: "newsletter_issue",
    targetId: (data as unknown as NewsletterIssueRow).id,
    details: { topic: topic.id, subjectStyle: style.id, sendHour },
  });

  return c.json({ issue: data as unknown as NewsletterIssueRow }, 201);
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
  };

  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.subject === "string") patch.subject = body.subject;
  if ("preheader" in body) patch.preheader = body.preheader ?? null;
  if (Array.isArray(body.sections)) patch.sections = body.sections;
  if (typeof body.audience === "string") patch.audience = body.audience;
  if ("scheduledFor" in body) patch.scheduled_for = body.scheduledFor || null;

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
    postalAddress: Deno.env.get("COMPANY_POSTAL_ADDRESS")?.trim() ||
      "Pearson Media LLC, Iowa, USA",
  });
  return c.json({ html, subject: issue.subject });
});

// POST /api/admin/newsletter/issues/:id/test-send — send ONE test email to an
// admin address. Bypasses marketing gating (it's a transactional preview), and
// is prefixed [TEST]. Audited.
adminNewsletterRoutes.post("/issues/:id/test-send", async (c) => {
  const issue = await loadIssue(c.req.param("id"));
  if (!issue) return c.json({ error: "Issue not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  const email = (body.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.json({ error: "A valid test recipient email is required" }, 400);
  }

  const html = renderNewsletterHtml(toRenderable(issue), {
    unsubscribeUrl: "https://gradethread.com/unsubscribe?preview=1",
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
      const html = renderNewsletterHtml(renderable, {
        unsubscribeUrl,
        postalAddress: Deno.env.get("COMPANY_POSTAL_ADDRESS")?.trim() ||
          "Pearson Media LLC, Iowa, USA",
      });
      const result = await coordinateMarketingSend({
        to: r.email,
        userId: r.user_id,
        source: "weekly_newsletter",
        category: `newsletter:${issue.id}`,
        subject: issue.subject || issue.title,
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

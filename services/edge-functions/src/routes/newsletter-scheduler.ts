// US-923: Make.com kickoff trigger for the autonomous newsletter.
//
// The ONE allowed external touchpoint. A single Make.com (or Coolify cron) scenario
// hits POST /api/newsletter/scheduler/tick on a simple schedule; everything after the
// trigger is automated. Each tick:
//   1. CREATE — when the program is due (self-gated on the configured cadence), build
//      the next editable draft via the shared assembler and fire an issue.created
//      webhook. Re-triggers within the same period are no-ops, so the Make schedule
//      can over-fire safely (AC2/AC4).
//   2. ADVANCE — push gateable issues that already carry real content through the
//      autonomous pre-send guardrail gate (US-924) toward `approved`. Bare scaffolds
//      (no subject yet — awaiting the copywriter) are left as drafts (no AI cost).
//   3. DISPATCH — release due approved issues through the gated weekly dispatcher
//      (cadence guard + send-time optimization), firing an issue.sent webhook for any
//      issue that completes this tick.
//
// A job-lock prevents overlapping runs and the whole run is recorded to cron_runs so
// it shows in the jobs console (US-881). The webhook URL + signing secret are env /
// settings config, never hardcoded (AC6).
//
// Auth mirrors content-scheduler.ts / drip.ts: a signed timestamped job request OR the
// static X-Internal-Job-Secret (NEWSLETTER_INTERNAL_JOB_SECRET, with _OLD overlap
// rotation), constant-time; otherwise it falls back to an admin JWT (the dashboard
// "Run now" button). Mounted at /api/newsletter/scheduler with its own auth baked in,
// so it is NOT under any /api/* JWT group in main.ts.

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { adminAuthMiddleware } from "../middleware/admin-auth.ts";
import { verifyJobSecret, verifySignedJobRequest } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { getSetting } from "../lib/system-settings.ts";
import { captureException } from "../lib/observability.ts";
import { recordCronRun } from "../lib/cron-runs.ts";
import { assembleNextIssue } from "../lib/newsletter-assembler.ts";
import {
  dispatchNewsletterWebhook,
  kickoffDue,
  type NewsletterWebhookData,
} from "../lib/newsletter-webhook.ts";
import { runIssueGuardrailGate } from "../lib/newsletter-qa-job.ts";
import { loadScheduleConfig, runNewsletterDispatch } from "../lib/newsletter-dispatch-job.ts";

type SchedulerEnv = { Variables: { userId?: string } };

export const newsletterSchedulerRoutes = new Hono<SchedulerEnv>();

// ── Auth (mirrors content-scheduler.ts schedulerAuth / drip.ts dripAuth) ──
const schedulerAuth = createMiddleware<SchedulerEnv>(async (c, next) => {
  const secrets = [
    Deno.env.get("NEWSLETTER_INTERNAL_JOB_SECRET"),
    Deno.env.get("NEWSLETTER_INTERNAL_JOB_SECRET_OLD"),
  ];

  // Preferred: signed timestamped request (HMAC, freshness window, single-use).
  if (c.req.header("X-Internal-Job-Signature")) {
    if (await verifySignedJobRequest(c, secrets)) {
      await next();
      return;
    }
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Static header secret (constant-time, dual-secret overlap rotation).
  if (await verifyJobSecret(c.req.header("X-Internal-Job-Secret"), secrets)) {
    await next();
    return;
  }

  // Fall back to admin JWT (dashboard "Run now"). The secret path leaves the context
  // without a user, so SchedulerEnv is looser than AuthEnv/AdminEnv — these
  // middlewares only read headers + c.set, so reusing the context is sound.
  await authMiddleware(
    c as unknown as Parameters<typeof authMiddleware>[0],
    async () => {
      await adminAuthMiddleware(
        c as unknown as Parameters<typeof adminAuthMiddleware>[0],
        next,
      );
    },
  );
});

newsletterSchedulerRoutes.use("/*", schedulerAuth);

const LOCK_LEASE_SECONDS = 600;
// Bound the per-tick autonomous gate fan-out (each gate may run an AI editor call).
const ADVANCE_BATCH = 10;

interface TickSummary {
  created: string | null;
  createdSkipped: boolean;
  advanced: number;
  released: number;
  sentNotified: number;
  webhooks: { created: boolean; sent: number };
}

// Fire-and-forget webhook with the standard issue payload. Never throws.
async function notify(
  event: "issue.created" | "issue.sent",
  data: NewsletterWebhookData,
  nowIso: string,
): Promise<boolean> {
  try {
    const r = await dispatchNewsletterWebhook({ event, timestamp: nowIso, data });
    return r.delivered;
  } catch (err) {
    captureException(err, { tags: { area: "newsletter-kickoff.webhook" } });
    return false;
  }
}

// ── POST /tick ──
// One autonomous run: create (cadence-gated) → advance → dispatch. Make/Coolify hits
// this on a simple schedule; it self-gates so calling more often than weekly is safe.
newsletterSchedulerRoutes.post("/tick", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean };
  const force = body.force === true;
  const startedMs = Date.now();
  const triggeredBy = c.req.header("X-Triggered-By")?.trim() || "schedule";

  // Overlap guard: never two concurrent ticks (double-creation / double-send hazard).
  const lock = await acquireJobLock("newsletter-kickoff", LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  const summary: TickSummary = {
    created: null,
    createdSkipped: false,
    advanced: 0,
    released: 0,
    sentNotified: 0,
    webhooks: { created: false, sent: 0 },
  };

  try {
    // Master kill-switch halts the whole program. Fail-open so a fresh deploy runs.
    if (!(await isFeatureEnabled("newsletter"))) {
      await recordCronRun({
        jobName: "newsletter-kickoff",
        status: "skipped",
        httpStatus: 200,
        durationMs: Date.now() - startedMs,
        triggeredBy,
        detail: { reason: "newsletter halted" },
      });
      return c.json({ ok: true, skipped: true, reason: "newsletter halted" });
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const schedule = await loadScheduleConfig();

    // 1. CREATION — cadence-gated. Re-triggers within the same period are no-ops.
    const { data: latest } = await supabaseAdmin
      .from("newsletter_issues")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastCreatedRaw = (latest as { created_at: string | null } | null)?.created_at ?? null;
    const lastCreatedMs = lastCreatedRaw ? Date.parse(lastCreatedRaw) : null;

    if (force || kickoffDue(lastCreatedMs, schedule.cadencePeriodDays, nowMs)) {
      const result = await assembleNextIssue(c.get("userId") ?? null, nowMs);
      if (result.issue) {
        summary.created = result.issue.id;
        summary.webhooks.created = await notify(
          "issue.created",
          {
            id: result.issue.id,
            title: result.issue.title,
            subject: result.issue.subject,
            status: result.issue.status,
            scheduled_for: result.issue.scheduled_for,
            pillar: result.issue.pillar,
          },
          nowIso,
        );
      } else {
        // Assemble failed — log + record an error heartbeat but keep going so the
        // dispatch/advance steps still run for existing issues.
        captureException(new Error(result.error ?? "assemble failed"), {
          tags: { area: "newsletter-kickoff.assemble" },
        });
      }
    } else {
      summary.createdSkipped = true;
    }

    // 2. ADVANCE — gate issues that already carry real content (non-empty subject)
    //    toward approval. Bare scaffolds (no subject) wait for the copywriter.
    const { data: gateable } = await supabaseAdmin
      .from("newsletter_issues")
      .select("id, subject, status")
      .in("status", ["draft", "ready_for_qa"])
      .neq("subject", "")
      .order("created_at", { ascending: true })
      .limit(ADVANCE_BATCH);
    for (const row of (gateable ?? []) as { id: string; subject: string | null }[]) {
      if (!row.subject || !row.subject.trim()) continue;
      try {
        await runIssueGuardrailGate(row.id, { actorUserId: null });
        summary.advanced++;
      } catch (err) {
        captureException(err, { tags: { area: "newsletter-kickoff.gate" } });
      }
    }

    // 3. DISPATCH — release due approved issues (honors the send-pause brake; the
    //    dispatcher self-checks the quiet period). Fire issue.sent for completions.
    const paused = await getSetting<boolean>("newsletter_send_paused", false);
    if (!paused) {
      try {
        const dispatch = await runNewsletterDispatch(nowMs);
        summary.released = dispatch.released;
        if (!dispatch.skipped) {
          for (const r of dispatch.issues) {
            if (!r.completed) continue;
            const { data: issueRow } = await supabaseAdmin
              .from("newsletter_issues")
              .select(
                "id, title, subject, status, scheduled_for, sent_at, " +
                  "recipients_total, sent_count, skipped_count, failed_count, pillar",
              )
              .eq("id", r.issueId)
              .maybeSingle();
            const ir = issueRow as
              | (NewsletterWebhookData & { status: string })
              | null;
            if (!ir || ir.status !== "sent") continue;
            const delivered = await notify(
              "issue.sent",
              {
                id: ir.id,
                title: ir.title,
                subject: ir.subject,
                status: ir.status,
                scheduled_for: ir.scheduled_for,
                sent_at: ir.sent_at,
                recipients_total: ir.recipients_total,
                sent_count: ir.sent_count,
                skipped_count: ir.skipped_count,
                failed_count: ir.failed_count,
                pillar: ir.pillar,
              },
              nowIso,
            );
            summary.sentNotified++;
            if (delivered) summary.webhooks.sent++;
          }
        }
      } catch (err) {
        captureException(err, { tags: { area: "newsletter-kickoff.dispatch" } });
      }
    }

    await recordCronRun({
      jobName: "newsletter-kickoff",
      status: "success",
      httpStatus: 200,
      durationMs: Date.now() - startedMs,
      triggeredBy,
      rowsProcessed: summary.advanced + summary.released,
      detail: { ...summary },
    });

    return c.json({ ok: true, ...summary });
  } finally {
    await lock.release();
  }
});

// Lightweight ping — lets the scheduler validate the secret + URL before turning the
// cron on (mirrors content-scheduler's /test).
newsletterSchedulerRoutes.post("/test", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

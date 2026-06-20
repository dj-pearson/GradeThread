// US-929: daily lifecycle email-journey evaluation tick.
//
// ONE scheduled trigger (Coolify cron / Make.com) drives the whole lifecycle
// engine with zero per-message human input. For every ENABLED journey it:
//   1. ENROLLS users whose state matches the journey's trigger (signup ⇒ welcome;
//      trial_ends_at within N days ⇒ trial-nurture; no activity for N days ⇒
//      win-back; first_grade/first_sale events ⇒ activation), idempotently (the
//      UNIQUE (journey_id,user_id) index means each user runs a series once).
//   2. EVALUATES due enrollments against the ordered, day-offset steps via the
//      PURE planner (lib/email-journey.ts planJourneyTick) and sends the ONE due
//      step per enrollment per tick (catch-up safe).
//   3. EXITS early when the journey GOAL is met (trial-nurture stops on convert —
//      finally closing the gap where US-383 downgrades a trial without warning;
//      win-back stops once the user is active again), or on opt-out/suppression.
//
// Reuses the shared send stack: marketing journeys route through
// coordinateMarketingSend (consent US-911 + suppression US-914 + the
// cross-program frequency cap US-934 + one-click unsubscribe), and
// lifecycle-transactional journeys (welcome) send durably without a cap or
// unsubscribe link. Step copy reuses the {{token}} renderer + the branded
// emailLayout, and may be AI-personalized (best-effort {{aiIntro}}).
//
// Mounted in main.ts as POST /api/jobs/journey-tick, OUTSIDE the /api/* JWT
// groups, gated by X-Internal-Job-Secret (same pattern as the other crons). The
// /api/jobs/* middleware records the run to cron_runs automatically.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { coordinateMarketingSend } from "../lib/marketing-coordinator.ts";
import { marketingUnsubscribeUrl } from "../lib/unsubscribe.ts";
import { buildJourneyEmailHtml, sendJourneyTransactionalEmail } from "../lib/email.ts";
import { marketingOptedOutEmail } from "../lib/drip-graph.ts";
import { personalizeJourneyIntro } from "../lib/journey-personalize.ts";
import {
  isMarketingClass,
  type JourneyEmailClass,
  journeyGoalMet,
  type JourneyStepDef,
  type JourneyTrigger,
  type JourneyUserState,
  planJourneyTick,
  renderJourneyStep,
} from "../lib/email-journey.ts";

const ENROLL_BATCH = 500;
const EVAL_BATCH = 200;
const LOCK_LEASE_SECONDS = 600;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function siteUrl(): string {
  return Deno.env.get("PUBLIC_SITE_URL")?.trim() || "https://gradethread.com";
}

interface JourneyRow {
  id: string;
  journey_key: string;
  name: string;
  trigger: JourneyTrigger;
  email_class: JourneyEmailClass;
  trigger_window_days: number;
}

interface EnrollmentRow {
  id: string;
  journey_id: string;
  user_id: string;
  enrolled_at: string;
}

interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  subscription_status: string | null;
  trial_ends_at: string | null;
  last_active_at: string | null;
  notification_preferences: Record<string, unknown> | null;
}

interface TickCounts {
  enrolled: number;
  sent: number;
  skipped: number;
  completed: number;
  exited: number;
}

// ── Step loading ──
async function loadSteps(journeyId: string): Promise<JourneyStepDef[]> {
  const { data, error } = await supabaseAdmin
    .from("email_journey_steps")
    .select("step_order, offset_days, subject, body_html, cta_label, cta_url, ai_personalize, enabled")
    .eq("journey_id", journeyId)
    .order("step_order", { ascending: true });
  if (error) {
    console.warn(`[journey-tick] load steps failed (${journeyId}):`, error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    stepOrder: Number(r.step_order),
    offsetDays: Number(r.offset_days),
    subject: String(r.subject ?? ""),
    bodyHtml: String(r.body_html ?? ""),
    ctaLabel: (r.cta_label as string | null) ?? null,
    ctaUrl: (r.cta_url as string | null) ?? null,
    aiPersonalize: r.ai_personalize === true,
    enabled: r.enabled !== false,
  }));
}

// ── Enrollment ──
// Resolve the candidate user ids whose state matches a journey's trigger. Each
// query is bounded; whatever doesn't fit is picked up on a later tick (the UNIQUE
// index keeps re-enrollment a no-op).
async function candidateIds(
  journey: JourneyRow,
  nowMs: number,
  nowIso: string,
): Promise<string[]> {
  const cutoffIso = new Date(nowMs - journey.trigger_window_days * DAY_MS).toISOString();
  switch (journey.trigger) {
    case "signup": {
      const { data } = await supabaseAdmin
        .from("users")
        .select("id")
        .gte("created_at", cutoffIso)
        .order("created_at", { ascending: false })
        .limit(ENROLL_BATCH);
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    }
    case "trial_ending": {
      const windowEndIso = new Date(nowMs + journey.trigger_window_days * DAY_MS).toISOString();
      const { data } = await supabaseAdmin
        .from("users")
        .select("id")
        .eq("subscription_status", "trialing")
        .gt("trial_ends_at", nowIso)
        .lte("trial_ends_at", windowEndIso)
        .order("trial_ends_at", { ascending: true })
        .limit(ENROLL_BATCH);
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    }
    case "inactivity": {
      // last_active_at (US-932 recency signal) older than the window, on an
      // account at least that old (so a brand-new signup isn't "inactive").
      const { data } = await supabaseAdmin
        .from("users")
        .select("id")
        .lt("last_active_at", cutoffIso)
        .lt("created_at", cutoffIso)
        .order("last_active_at", { ascending: true })
        .limit(ENROLL_BATCH);
      return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    }
    case "first_grade":
    case "first_sale": {
      // The user_events first-occurrence key (US-932), within the window.
      const { data } = await supabaseAdmin
        .from("user_events")
        .select("user_id")
        .eq("event_key", journey.trigger)
        .gte("occurred_at", cutoffIso)
        .order("occurred_at", { ascending: false })
        .limit(ENROLL_BATCH);
      const ids = ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
      return [...new Set(ids)];
    }
  }
}

async function enrollForJourney(
  journey: JourneyRow,
  nowMs: number,
  nowIso: string,
): Promise<number> {
  const candidates = await candidateIds(journey, nowMs, nowIso);
  if (candidates.length === 0) return 0;

  // Exclude anyone already enrolled in THIS journey (idempotent — never re-enroll).
  const { data: existing } = await supabaseAdmin
    .from("email_journey_enrollments")
    .select("user_id")
    .eq("journey_id", journey.id)
    .in("user_id", candidates);
  const enrolled = new Set(
    ((existing ?? []) as Array<{ user_id: string }>).map((r) => r.user_id),
  );
  let newIds = candidates.filter((id) => !enrolled.has(id));
  if (newIds.length === 0) return 0;

  // Marketing journeys must never enroll a marketing-opted-out user (consent,
  // US-911). Transactional (welcome) carries no opt-out, so it skips this filter.
  if (isMarketingClass(journey.email_class)) {
    const { data: prefRows } = await supabaseAdmin
      .from("users")
      .select("id, notification_preferences")
      .in("id", newIds);
    const optedOut = new Set(
      ((prefRows ?? []) as Array<{ id: string; notification_preferences: Record<string, unknown> | null }>)
        .filter((u) => marketingOptedOutEmail(u.notification_preferences))
        .map((u) => u.id),
    );
    newIds = newIds.filter((id) => !optedOut.has(id));
  }
  if (newIds.length === 0) return 0;

  const rows = newIds.map((user_id) => ({
    journey_id: journey.id,
    user_id,
    enrolled_at: nowIso,
    // Evaluate on this run — the first step (offset 0) is then due immediately.
    next_step_at: nowIso,
  }));

  // ignoreDuplicates so a racing/retried enroll path is a no-op (the UNIQUE index
  // makes "one enrollment per journey" a DB invariant).
  const { data: inserted, error } = await supabaseAdmin
    .from("email_journey_enrollments")
    .upsert(rows, { onConflict: "journey_id,user_id", ignoreDuplicates: true })
    .select("id");
  if (error) {
    console.error(`[journey-tick] enroll insert failed (${journey.journey_key}):`, error.message);
    return 0;
  }
  return inserted?.length ?? 0;
}

// ── Per-enrollment helpers ──
async function loadSentOrdinals(enrollmentId: string): Promise<Set<number>> {
  const { data } = await supabaseAdmin
    .from("email_journey_step_sends")
    .select("step_order")
    .eq("enrollment_id", enrollmentId)
    .not("sent_at", "is", null);
  return new Set(((data ?? []) as Array<{ step_order: number }>).map((r) => r.step_order));
}

async function upsertStepSend(
  enrollment: EnrollmentRow,
  stepOrder: number,
  recipient: string | null,
  sentAtIso: string | null,
  skipReason: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("email_journey_step_sends")
    .upsert(
      {
        enrollment_id: enrollment.id,
        journey_id: enrollment.journey_id,
        step_order: stepOrder,
        recipient,
        sent_at: sentAtIso,
        skip_reason: skipReason,
      },
      { onConflict: "enrollment_id,step_order" },
    );
  if (error) {
    console.warn("[journey-tick] step_send upsert failed:", error.message);
  }
}

async function exitEnrollment(id: string, reason: string, nowIso: string): Promise<void> {
  await supabaseAdmin
    .from("email_journey_enrollments")
    .update({ exited_at: nowIso, exit_reason: reason, next_step_at: null })
    .eq("id", id);
}

async function completeEnrollment(id: string, currentStep: number, nowIso: string): Promise<void> {
  await supabaseAdmin
    .from("email_journey_enrollments")
    .update({ completed_at: nowIso, current_step: currentStep, next_step_at: null })
    .eq("id", id);
}

interface DispatchOutcome {
  sent: boolean;
  /** Terminal exit instead of a send (opted-out / suppressed / no address). */
  exitReason?: string;
}

// Render + deliver one due step through the shared send stack.
async function dispatchStep(
  journey: JourneyRow,
  user: UserRow,
  state: JourneyUserState,
  step: JourneyStepDef,
): Promise<DispatchOutcome> {
  if (!user.email) return { sent: false, exitReason: "no_address" };

  // Optional AI personalization — best-effort, gated by the content_ai
  // kill-switch; any failure leaves {{aiIntro}} empty (static template).
  if (step.aiPersonalize && (await isFeatureEnabled("content_ai"))) {
    const intro = await personalizeJourneyIntro({
      journeyKey: journey.journey_key,
      stepOrder: step.stepOrder,
      firstName: state.firstName ?? null,
      context: step.subject,
      userId: user.id,
    });
    state.aiIntro = intro ?? "";
  }

  const rendered = renderJourneyStep(step, state);
  const category = `journey:${journey.journey_key}:${step.stepOrder}`;

  if (isMarketingClass(journey.email_class)) {
    const unsubscribeUrl = await marketingUnsubscribeUrl(user.id).catch(() => "");
    const html = buildJourneyEmailHtml(rendered.contentHtml, {
      unsubscribeUrl: unsubscribeUrl || undefined,
    });
    const res = await coordinateMarketingSend({
      to: user.email,
      userId: user.id,
      prefs: user.notification_preferences,
      source: "journey",
      category,
      subject: rendered.subject,
      html,
    });
    // drop = opted-out / suppressed → leave the journey. send/defer are both
    // durable (a deferred send is re-queued to the outbox), so the step is done.
    if (res.action === "drop") return { sent: false, exitReason: res.reason };
    return { sent: res.sent || res.deferred };
  }

  // Lifecycle-transactional (welcome): never capped, no unsubscribe link; durable
  // via the email_deliveries outbox. delivered || enqueued ⇒ handled.
  await sendJourneyTransactionalEmail({
    to: user.email,
    subject: rendered.subject,
    contentHtml: rendered.contentHtml,
    category,
  });
  return { sent: true };
}

async function processEnrollment(
  journey: JourneyRow,
  steps: JourneyStepDef[],
  enrollment: EnrollmentRow,
  nowMs: number,
  nowIso: string,
  counts: TickCounts,
): Promise<void> {
  const { data: u } = await supabaseAdmin
    .from("users")
    .select("id, email, full_name, subscription_status, trial_ends_at, last_active_at, notification_preferences")
    .eq("id", enrollment.user_id)
    .maybeSingle();
  if (!u) return; // user deleted → enrollment cascades; nothing to do.
  const user = u as unknown as UserRow;

  const enrolledAtMs = enrollment.enrolled_at ? Date.parse(enrollment.enrolled_at) : nowMs;
  const lastActiveMs = user.last_active_at ? Date.parse(user.last_active_at) : null;
  const state: JourneyUserState = {
    firstName: (user.full_name ?? "").trim().split(/\s+/)[0] || null,
    trialEndsAt: user.trial_ends_at,
    dashboardUrl: `${siteUrl()}/dashboard`,
    converted: user.subscription_status === "active",
    reactivated: lastActiveMs !== null && lastActiveMs > enrolledAtMs,
  };

  // Goal-exit beats everything (trial-nurture stops on convert; win-back on re-activation).
  const goal = journeyGoalMet(journey.trigger, state);
  if (goal.met) {
    await exitEnrollment(enrollment.id, goal.reason ?? "goal_met", nowIso);
    counts.exited++;
    return;
  }

  const sent = await loadSentOrdinals(enrollment.id);
  const plan = planJourneyTick(steps, enrolledAtMs, sent, nowMs);

  if (plan.status === "complete") {
    const maxSent = sent.size ? Math.max(...sent) : 0;
    await completeEnrollment(enrollment.id, maxSent, nowIso);
    counts.completed++;
    return;
  }
  if (plan.status === "wait" || !plan.step) {
    await supabaseAdmin
      .from("email_journey_enrollments")
      .update({ next_step_at: plan.dueAtMs ? new Date(plan.dueAtMs).toISOString() : nowIso })
      .eq("id", enrollment.id);
    return;
  }

  // status === "send"
  const step = plan.step;
  const outcome = await dispatchStep(journey, user, state, step);

  if (outcome.exitReason) {
    await upsertStepSend(enrollment, step.stepOrder, user.email, null, outcome.exitReason);
    await exitEnrollment(enrollment.id, outcome.exitReason, nowIso);
    counts.exited++;
    return;
  }
  if (!outcome.sent) {
    // Transient failure — retry on a later tick (back off ~1h to avoid a tight loop).
    counts.skipped++;
    await supabaseAdmin
      .from("email_journey_enrollments")
      .update({ next_step_at: new Date(nowMs + HOUR_MS).toISOString() })
      .eq("id", enrollment.id);
    return;
  }

  await upsertStepSend(enrollment, step.stepOrder, user.email, nowIso, null);
  sent.add(step.stepOrder);
  counts.sent++;

  // Re-plan to compute the next due time / completion.
  const next = planJourneyTick(steps, enrolledAtMs, sent, nowMs);
  if (next.status === "complete") {
    await completeEnrollment(enrollment.id, step.stepOrder, nowIso);
    counts.completed++;
  } else {
    await supabaseAdmin
      .from("email_journey_enrollments")
      .update({
        current_step: step.stepOrder,
        next_step_at: next.dueAtMs ? new Date(next.dueAtMs).toISOString() : nowIso,
      })
      .eq("id", enrollment.id);
  }
}

// ── POST /api/jobs/journey-tick ──
export async function handleJourneyTickCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Fleet-wide kill-switch. Fail-open (no row → enabled) so a fresh deploy runs;
  // an operator-disabled flag halts every journey send within the cache TTL.
  if (!(await isFeatureEnabled("lifecycle_journeys"))) {
    return c.json({ ok: true, skipped: true, reason: "feature disabled" });
  }

  const lock = await acquireJobLock("journey-tick", LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  const counts: TickCounts = { enrolled: 0, sent: 0, skipped: 0, completed: 0, exited: 0 };

  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const { data: journeyRows, error: jErr } = await supabaseAdmin
      .from("email_journeys")
      .select("id, journey_key, name, trigger, email_class, trigger_window_days")
      .eq("enabled", true);
    if (jErr) {
      console.error("[journey-tick] load journeys failed:", jErr.message);
      return c.json({ error: "Failed to load journeys" }, 500);
    }
    const journeys = (journeyRows ?? []) as JourneyRow[];

    for (const journey of journeys) {
      const steps = await loadSteps(journey.id);
      if (steps.length === 0) continue; // nothing to send — skip enrolling too.

      // 1. Enroll new matches (idempotent).
      try {
        counts.enrolled += await enrollForJourney(journey, nowMs, nowIso);
      } catch (e) {
        console.error(
          `[journey-tick] enroll failed (${journey.journey_key}):`,
          e instanceof Error ? e.message : String(e),
        );
      }

      // 2/3. Evaluate due, active enrollments (bounded, resumable batch).
      const { data: due, error: dErr } = await supabaseAdmin
        .from("email_journey_enrollments")
        .select("id, journey_id, user_id, enrolled_at")
        .eq("journey_id", journey.id)
        .is("exited_at", null)
        .is("completed_at", null)
        .or(`next_step_at.is.null,next_step_at.lte.${nowIso}`)
        .order("next_step_at", { ascending: true, nullsFirst: true })
        .limit(EVAL_BATCH);
      if (dErr) {
        console.error(`[journey-tick] load enrollments failed (${journey.journey_key}):`, dErr.message);
        continue;
      }

      for (const row of (due ?? []) as EnrollmentRow[]) {
        try {
          await processEnrollment(journey, steps, row, nowMs, nowIso, counts);
        } catch (e) {
          counts.skipped++;
          console.error(
            `[journey-tick] enrollment ${row.id} failed:`,
            e instanceof Error ? e.message : String(e),
          );
        }
      }
    }

    return c.json({ ok: true, journeys: journeys.length, ...counts });
  } finally {
    await lock.release();
  }
}

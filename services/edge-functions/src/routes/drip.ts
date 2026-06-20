// US-943: Autonomous trial-conversion drip orchestration tick.
//
// ONE scheduled trigger (Make.com / Coolify cron) drives the whole drip engine
// with zero per-message human input:
//   1. ENROLL new trialists that match the campaign's entry trigger.
//   2. EVALUATE active enrollments against the persisted step-graph definition
//      (drip_campaigns.graph, validated/edited by the US-945 builder) using the
//      PURE planner in lib/drip-graph.ts (planTick).
//   3. DISPATCH the one due step per enrollment (bounded, resumable batch) —
//      honoring consent (US-911), suppression (US-914) + CAN-SPAM unsubscribe.
//   4. EXIT instantly on conversion (records the attribution ledger), and on
//      journey completion / opt-out.
//
// Builds on / supersedes the generic journey engine: it reuses the drip
// analytics tables (00253), the editable definition (00255), the deliverEmail
// outbox + suppression, the marketing-unsubscribe link, and the per-step copy
// renderer. Records to the jobs console (US-881) via cron_runs.
//
// Auth mirrors content-scheduler.ts: a signed timestamped job request OR the
// static X-Internal-Job-Secret (DRIP_INTERNAL_JOB_SECRET, with _OLD overlap
// rotation), constant-time; otherwise it falls back to an admin JWT (the
// dashboard "Run now" button). Mounted at /api/drip with its own auth baked in,
// so it is NOT under any /api/* JWT group in main.ts.

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { adminAuthMiddleware } from "../middleware/admin-auth.ts";
import { verifyJobSecret, verifySignedJobRequest } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import { recordCronRun } from "../lib/cron-runs.ts";
import { deliverEmail } from "../lib/email.ts";
import { marketingUnsubscribeUrl } from "../lib/unsubscribe.ts";
import {
  buildLostFeaturesHtml,
  type DripGraph,
  type DripStep,
  type DripUserState,
  isIncentiveEligible,
  lostProFeatures,
  marketingOptedOutEmail,
  planTick,
  renderStep,
} from "../lib/drip-graph.ts";
import { resolveIncentive, type ResolvedIncentive } from "../lib/drip-incentive.ts";
import { getPlanMatrix } from "../lib/pricing-config.ts";

type DripEnv = { Variables: { userId?: string } };

export const dripRoutes = new Hono<DripEnv>();

// ── Auth (mirrors content-scheduler.ts schedulerAuth) ──
const dripAuth = createMiddleware<DripEnv>(async (c, next) => {
  const secrets = [
    Deno.env.get("DRIP_INTERNAL_JOB_SECRET"),
    Deno.env.get("DRIP_INTERNAL_JOB_SECRET_OLD"),
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

  // Fall back to admin JWT (dashboard "Run now"). The secret path leaves the
  // context without a user, so DripEnv is looser than AuthEnv/AdminEnv — these
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

dripRoutes.use("/*", dripAuth);

// ── Bounds ──
// Enrollment + evaluation are bounded per tick; whatever doesn't fit is picked
// up on the next run (resumable batch — processed enrollments get their
// next_evaluation_at advanced, so they fall out of the due query).
const ENROLL_BATCH = 500;
const EVAL_BATCH = 200;
const LOCK_LEASE_SECONDS = 600;
const DAY_MS = 24 * 60 * 60 * 1000;

interface TickCounts {
  enrolled: number;
  advanced: number;
  sent: number;
  exited: number;
  skipped: number;
  /** Dry-run only: sends that WOULD have fired. */
  wouldSend: number;
}

interface CampaignDef {
  campaign: string;
  status: "active" | "paused" | "killed";
  graph: DripGraph;
}

// US-911 marketing consent: `marketingOptedOutEmail` (drip-graph.ts) is the pure
// predicate — a recipient who opted out of marketing email must not enter or
// receive the drip. Used at enrollment (entry filter, US-941) and dispatch (exit).

interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  plan: string | null;
  subscription_status: string | null;
  trial_ends_at: string | null;
  grades_used_this_month: number | null;
  created_at: string | null;
  notification_preferences: Record<string, unknown> | null;
}

interface EnrollmentRow {
  id: string;
  user_id: string;
  campaign: string;
  enrolled_at: string;
  trial_started_at: string | null;
  converted_at: string | null;
  incentive_enabled: boolean;
}

function buildUserState(
  user: UserRow,
  enrollment: EnrollmentRow,
  nowMs: number,
): DripUserState & { userId: string; enrolledAtMs: number } {
  const enrolledAtMs = enrollment.enrolled_at
    ? Date.parse(enrollment.enrolled_at)
    : (user.created_at ? Date.parse(user.created_at) : nowMs);
  const trialEndMs = user.trial_ends_at ? Date.parse(user.trial_ends_at) : null;
  const converted = !!enrollment.converted_at ||
    user.subscription_status === "active";
  return {
    userId: user.id,
    firstName: (user.full_name ?? "").trim().split(/\s+/)[0] || null,
    trialEndsAt: user.trial_ends_at,
    converted,
    plan: user.plan,
    subscriptionStatus: user.subscription_status,
    gradesUsed: user.grades_used_this_month ?? 0,
    trialDaysRemaining: trialEndMs ? Math.ceil((trialEndMs - nowMs) / DAY_MS) : 0,
    daysSinceSignup: Math.floor((nowMs - enrolledAtMs) / DAY_MS),
    enrolledAtMs,
  };
}

// US-940: campaign-wide recap personalization computed ONCE per tick (the same
// for every recipient): the grounded "what you lose on Free" copy (derived from
// the live plan matrix, AC5), the recommended plan, and the subscribe deep-link.
interface Personalization {
  lostFeatures: string;
  recommendedPlan: string;
  checkoutUrl: string;
}

async function buildPersonalization(): Promise<Personalization> {
  let lostFeatures = "";
  try {
    const matrix = await getPlanMatrix();
    const labels = lostProFeatures(
      matrix.pro.gateFlags as unknown as Record<string, boolean>,
      matrix.free.gateFlags as unknown as Record<string, boolean>,
    );
    // Headline metered caps the recap should also name (grounded in the matrix).
    labels.push(
      `Unlimited grading (Free includes only ${matrix.free.includedStandardGradesPerMonth}/month)`,
      "Shareable condition certificates & full reports",
    );
    lostFeatures = buildLostFeaturesHtml(labels);
  } catch (e) {
    console.warn(
      "[drip-tick] lost-features copy build failed:",
      e instanceof Error ? e.message : String(e),
    );
  }
  return {
    lostFeatures,
    recommendedPlan: "Pro",
    checkoutUrl: "https://gradethread.com/dashboard/billing?upgrade=pro",
  };
}

// US-940: real per-user activity for the mid-trial recap. All-time counts so the
// recap reflects everything done in the trial; head-only count queries are cheap.
// Tenant-scoped by user_id (US-268 — the service-role client bypasses RLS).
async function loadActivity(userId: string): Promise<{
  gradesCount: number;
  listingsCount: number;
  salesCount: number;
  certificatesCount: number;
  /** Epoch ms of the most recent real activity (latest grade/listing/sale), or
   * null if the user has done nothing yet. Drives the US-939 inactivity nudge. */
  lastActivityMs: number | null;
}> {
  const num = (
    res: { count: number | null; error: { message: string } | null },
    label: string,
  ): number => {
    if (res.error) {
      console.warn(`[drip-tick] ${label} count failed:`, res.error.message);
      return 0;
    }
    return res.count ?? 0;
  };
  // US-939: most-recent created_at per activity table (one row each, cheap). The
  // max is the user's "last_active_at" proxy — there's no such column on users,
  // so real activity timestamps are the grounded signal. Tenant-scoped (US-268).
  const latestMs = (
    res: { data: Array<{ created_at: string | null }> | null; error: { message: string } | null },
    label: string,
  ): number | null => {
    if (res.error) {
      console.warn(`[drip-tick] ${label} latest failed:`, res.error.message);
      return null;
    }
    const ts = res.data?.[0]?.created_at;
    return ts ? Date.parse(ts) : null;
  };
  const [grades, certs, listings, sales, lastGrade, lastListing, lastSale] = await Promise.all([
    supabaseAdmin.from("grade_reports").select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    supabaseAdmin.from("grade_reports").select("id", { count: "exact", head: true })
      .eq("user_id", userId).not("certificate_id", "is", null),
    supabaseAdmin.from("listings").select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    supabaseAdmin.from("sales").select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    supabaseAdmin.from("grade_reports").select("created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(1),
    supabaseAdmin.from("listings").select("created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(1),
    supabaseAdmin.from("sales").select("created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(1),
  ]);
  const lastTimes = [
    latestMs(lastGrade, "grade_reports"),
    latestMs(lastListing, "listings"),
    latestMs(lastSale, "sales"),
  ].filter((t): t is number => t !== null);
  return {
    gradesCount: num(grades, "grade_reports"),
    certificatesCount: num(certs, "certificates"),
    listingsCount: num(listings, "listings"),
    salesCount: num(sales, "sales"),
    lastActivityMs: lastTimes.length ? Math.max(...lastTimes) : null,
  };
}

async function loadCampaign(campaign: string): Promise<CampaignDef | null> {
  const { data } = await supabaseAdmin
    .from("drip_campaigns")
    .select("campaign, status, graph")
    .eq("campaign", campaign)
    .maybeSingle();
  return (data as CampaignDef | null) ?? null;
}

// ── Enrollment ──
// Entry trigger for trial_conversion: an active no-card trialist not yet enrolled
// in this campaign. (Other campaigns would define their own predicate here.)
async function enrollNewTrialists(
  campaign: string,
  nowIso: string,
): Promise<number> {
  if (campaign !== "trial_conversion") return 0;

  const { data: trialists } = await supabaseAdmin
    .from("users")
    .select("id, created_at, trial_ends_at, notification_preferences")
    .eq("subscription_status", "trialing")
    .not("trial_ends_at", "is", null)
    .order("created_at", { ascending: true })
    .limit(ENROLL_BATCH);
  const candidates = ((trialists ?? []) as Array<
    {
      id: string;
      created_at: string | null;
      trial_ends_at: string | null;
      notification_preferences: Record<string, unknown> | null;
    }
  >)
    // US-941 entry condition: never enrol a marketing-opted-out user — the drip
    // (incl. the win-back tail) is marketing mail, so they must receive none.
    .filter((t) => !marketingOptedOutEmail(t.notification_preferences));
  if (candidates.length === 0) return 0;

  // Exclude anyone who already has an enrollment for this campaign (idempotent —
  // never re-enroll a user who completed or is mid-journey).
  const ids = candidates.map((t) => t.id);
  const { data: existing } = await supabaseAdmin
    .from("drip_enrollments")
    .select("user_id")
    .eq("campaign", campaign)
    .in("user_id", ids);
  const enrolled = new Set(
    (existing ?? []).map((r) => (r as { user_id: string }).user_id),
  );

  const rows = candidates
    .filter((t) => !enrolled.has(t.id))
    .map((t) => ({
      user_id: t.id,
      campaign,
      enrolled_at: nowIso,
      trial_started_at: t.created_at,
      signup_week: t.created_at ? t.created_at.slice(0, 10) : null,
      incentive_enabled: false,
      // Evaluate on this run (the entry step is delay 0 from enrollment).
      next_evaluation_at: nowIso,
    }));
  if (rows.length === 0) return 0;

  const { data: inserted, error } = await supabaseAdmin
    .from("drip_enrollments")
    .insert(rows)
    .select("id");
  if (error) {
    console.error("[drip-tick] enroll insert failed:", error.message);
    return 0;
  }
  return inserted?.length ?? 0;
}

// Record a conversion in the attribution ledger (one per enrollment) so the
// US-944 optimizer/analytics can attribute conversions to the steps a converter
// saw. Best-effort + idempotent (unique on enrollment_id). MRR + Stripe
// reconciliation are filled by the billing reconciliation job (Stripe stays the
// source of truth); the engine just records that the conversion happened.
async function recordAttribution(
  enrollment: EnrollmentRow,
  user: UserRow,
  stepOrdinal: number | null,
  phase: "in_trial" | "win_back",
  variant: string | null,
  nowIso: string,
): Promise<void> {
  const { error } = await supabaseAdmin.from("drip_attributions").insert({
    enrollment_id: enrollment.id,
    user_id: user.id,
    campaign: enrollment.campaign,
    step: stepOrdinal,
    phase,
    variant,
    incentive_enabled: enrollment.incentive_enabled,
    mrr_cents: 0,
    stripe_reconciled: false,
    converted_at: nowIso,
  });
  // 23505 = unique violation: already attributed, fine.
  if (error && error.code !== "23505") {
    console.warn("[drip-tick] attribution insert failed:", error.message);
  }
}

// Exit an enrollment: stamps exited_at + exit_reason and clears
// next_evaluation_at so it falls out of the due query. US-941: exiting IS the
// hand-back to the standard cadence — while an enrollment is active the user is
// in the focused trial-conversion drip; once it exits (day-28 `completed` or
// `converted`/opt-out) the drip no longer holds them and they're back in the
// general (occasional) newsletter audience. No separate pause flag to flip: the
// active enrollment is the "pause", and exit un-pauses it.
async function exitEnrollment(
  enrollmentId: string,
  reason: "converted" | "trial_expired" | "unsubscribed" | "completed" | "suppressed",
  nowIso: string,
  convertedAt?: string,
): Promise<void> {
  await supabaseAdmin
    .from("drip_enrollments")
    .update({
      exited_at: nowIso,
      exit_reason: reason,
      next_evaluation_at: null,
      ...(convertedAt ? { converted_at: convertedAt } : {}),
    })
    .eq("id", enrollmentId);
}

// Sent step ordinals for an enrollment (drip_sends.step where actually sent).
async function loadSentOrdinals(enrollmentId: string): Promise<Set<number>> {
  const { data } = await supabaseAdmin
    .from("drip_sends")
    .select("step")
    .eq("enrollment_id", enrollmentId)
    .not("sent_at", "is", null);
  return new Set((data ?? []).map((r) => (r as { step: number }).step));
}

interface SendOutcome {
  /** Did an email actually go out (and a drip_sends row get recorded)? */
  sent: boolean;
  /** A terminal exit was triggered instead of a send (opt-out / suppressed). */
  exitReason?: "unsubscribed" | "suppressed";
}

// Render + deliver one due step, honoring consent + suppression, and record the
// send. Returns whether mail went out, or an exit reason when the recipient
// should leave the journey (marketing opt-out).
async function dispatchStep(
  campaign: string,
  enrollment: EnrollmentRow,
  user: UserRow,
  userState: DripUserState,
  step: DripStep,
  ordinal: number,
  variantId: string,
  nowIso: string,
  resolved: ResolvedIncentive | null,
): Promise<SendOutcome> {
  // US-911 consent: a marketing opt-out ends the drip (CAN-SPAM honor opt-out).
  if (marketingOptedOutEmail(user.notification_preferences)) {
    return { sent: false, exitReason: "unsubscribed" };
  }
  if (!user.email) {
    // No address to reach — treat as suppressed so we stop re-trying forever.
    return { sent: false, exitReason: "suppressed" };
  }

  // US-942: surface the conversion incentive ONLY when the campaign incentive is
  // configured/on AND this step+user passes the server-side eligibility gate
  // (win-back/post-trial, never already-paid). Otherwise the {{incentive}} token
  // renders empty (value-only variant) and no code is exposed.
  const incentiveEligible = !!resolved && isIncentiveEligible(step, userState);

  const rendered = renderStep(
    step,
    userState,
    variantId,
    incentiveEligible ? resolved!.incentive : null,
  );
  if (!rendered) {
    console.warn(`[drip-tick] step '${step.id}' rendered empty — skipping send`);
    return { sent: false };
  }

  const unsubscribeUrl = await marketingUnsubscribeUrl(user.id).catch(() => "");
  const html = unsubscribeUrl
    ? `${rendered.html}<p style="margin-top:24px;color:#999;font-size:12px">` +
      `<a href="${unsubscribeUrl}" style="color:#999">Unsubscribe</a></p>`
    : rendered.html;

  // deliverEmail already short-circuits hard-bounced/complained recipients
  // (US-914 suppression) and returns true for that terminal no-op.
  const ok = await deliverEmail({
    to: user.email,
    subject: rendered.subject,
    html,
    category: "marketing",
  });
  if (!ok) return { sent: false };

  const { error } = await supabaseAdmin.from("drip_sends").insert({
    enrollment_id: enrollment.id,
    campaign,
    step: ordinal,
    phase: step.phase,
    variant: variantId,
    sent_at: nowIso,
  });
  if (error) {
    console.warn("[drip-tick] drip_sends insert failed:", error.message);
  }

  // US-942: the incentive just went out → (1) stash a time-boxed pending coupon
  // on the user so the next checkout pre-applies it (one-click conversion,
  // payments.ts), and (2) mark the enrollment incentive-on so the conversion
  // attribution ledger (and the incentive-lift analytics) credit this arm. The
  // webhook clears the pending coupon once the subscription lands.
  if (incentiveEligible) {
    const { error: couponErr } = await supabaseAdmin
      .from("users")
      .update({
        pending_drip_coupon: resolved!.couponId,
        pending_drip_coupon_expires_at: resolved!.expiresAt,
      })
      .eq("id", user.id);
    if (couponErr) {
      console.warn("[drip-tick] pending coupon stamp failed:", couponErr.message);
    }
    if (!enrollment.incentive_enabled) {
      const { error: enrollErr } = await supabaseAdmin
        .from("drip_enrollments")
        .update({ incentive_enabled: true })
        .eq("id", enrollment.id);
      if (enrollErr) {
        console.warn("[drip-tick] incentive flag update failed:", enrollErr.message);
      }
    }
  }
  return { sent: true };
}

// Evaluate + dispatch one enrollment. Mutates `counts`. `dryRun` logs what would
// send without sending, recording nothing (so a real run later still fires it).
async function processEnrollment(
  def: CampaignDef,
  enrollment: EnrollmentRow,
  nowMs: number,
  nowIso: string,
  dryRun: boolean,
  counts: TickCounts,
  resolvedIncentive: ResolvedIncentive | null,
  personalization: Personalization,
): Promise<void> {
  const { data: u } = await supabaseAdmin
    .from("users")
    .select(
      "id, email, full_name, plan, subscription_status, trial_ends_at, " +
        "grades_used_this_month, created_at, notification_preferences",
    )
    .eq("id", enrollment.user_id)
    .maybeSingle();
  if (!u) {
    // User vanished (deletion cascades the enrollment) — nothing to do.
    return;
  }
  const user = u as unknown as UserRow;
  const userState = buildUserState(user, enrollment, nowMs);

  // Exit-on-goal: convert beats everything.
  if (userState.converted) {
    const sent = await loadSentOrdinals(enrollment.id);
    const lastOrdinal = sent.size > 0 ? Math.max(...sent) : null;
    const phase: "in_trial" | "win_back" =
      lastOrdinal !== null && def.graph.steps[lastOrdinal - 1]?.phase === "win_back"
        ? "win_back"
        : "in_trial";
    if (!dryRun) {
      await recordAttribution(enrollment, user, lastOrdinal, phase, null, nowIso);
      await exitEnrollment(enrollment.id, "converted", nowIso, nowIso);
    }
    counts.exited++;
    return;
  }

  // US-940: hydrate the recap personalization (real per-user activity + the
  // grounded loss copy / subscribe deep-link) BEFORE planTick — the day-7 recap
  // branches on `totalActivity` (zero-activity → re-activation variant) and the
  // day-10 deep-dive branches on `certificatesCount` (skip if used).
  const activity = await loadActivity(enrollment.user_id);
  userState.gradesCount = activity.gradesCount;
  userState.listingsCount = activity.listingsCount;
  userState.salesCount = activity.salesCount;
  userState.certificatesCount = activity.certificatesCount;
  userState.totalActivity = activity.gradesCount + activity.listingsCount +
    activity.salesCount + activity.certificatesCount;
  // US-939: whole days since last real activity. A never-active trialist is
  // anchored to signup (enrolledAtMs), so the inactivity nudge fires once they've
  // been silent for 3 trial days. Reactivating resets this (latest activity moves
  // forward), so the branch re-evaluates and skips the nudge next tick.
  userState.daysSinceActive = Math.max(
    0,
    Math.floor((nowMs - (activity.lastActivityMs ?? userState.enrolledAtMs)) / DAY_MS),
  );
  userState.lostFeatures = personalization.lostFeatures;
  userState.recommendedPlan = personalization.recommendedPlan;
  userState.checkoutUrl = personalization.checkoutUrl;

  const sentOrdinals = await loadSentOrdinals(enrollment.id);
  let plan = planTick(def.graph, userState, sentOrdinals, nowMs);

  if (plan.status === "send" && plan.send) {
    const step = def.graph.steps[plan.send.ordinal - 1]!;
    if (dryRun) {
      counts.wouldSend++;
      console.log(
        `[drip-tick][dry-run] WOULD send step '${plan.send.stepId}' (ordinal ` +
          `${plan.send.ordinal}, variant ${plan.send.variantId}) to user ${user.id}`,
      );
      // Don't advance — leave next_evaluation_at so a real run fires it.
      return;
    }
    const outcome = await dispatchStep(
      def.campaign,
      enrollment,
      user,
      userState,
      step,
      plan.send.ordinal,
      plan.send.variantId,
      nowIso,
      resolvedIncentive,
    );
    if (outcome.exitReason) {
      await exitEnrollment(enrollment.id, outcome.exitReason, nowIso);
      counts.exited++;
      return;
    }
    if (outcome.sent) {
      counts.sent++;
      counts.advanced++;
      sentOrdinals.add(plan.send.ordinal);
      // Re-plan to compute the real next-evaluation time (or completion).
      plan = planTick(def.graph, userState, sentOrdinals, nowMs);
    } else {
      // Transient send failure — retry on the next tick (leave the cursor put).
      counts.skipped++;
      return;
    }
  } else {
    counts.skipped++;
  }

  if (plan.status === "complete") {
    await exitEnrollment(enrollment.id, "completed", nowIso);
    counts.exited++;
  } else {
    await supabaseAdmin
      .from("drip_enrollments")
      .update({
        next_evaluation_at: plan.nextEvaluationMs
          ? new Date(plan.nextEvaluationMs).toISOString()
          : nowIso,
      })
      .eq("id", enrollment.id);
  }
}

// ── POST /tick ──
// One autonomous run: enroll → evaluate → dispatch → exit. Make/Coolify hits
// this on a simple schedule (e.g. hourly); it self-gates on next_evaluation_at.
dripRoutes.post("/tick", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    dryRun?: boolean;
    campaign?: string;
  };
  const dryRun = body.dryRun === true;
  const campaign = (body.campaign ?? "trial_conversion").trim() || "trial_conversion";
  const startedMs = Date.now();
  const triggeredBy = c.req.header("X-Triggered-By")?.trim() || "schedule";

  // Overlap guard: never two concurrent ticks (double-sends are not recoverable).
  const lock = await acquireJobLock("drip-tick", LOCK_LEASE_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  const counts: TickCounts = {
    enrolled: 0,
    advanced: 0,
    sent: 0,
    exited: 0,
    skipped: 0,
    wouldSend: 0,
  };

  try {
    const def = await loadCampaign(campaign);
    if (!def) {
      await recordCronRun({
        jobName: "drip-tick",
        status: "error",
        httpStatus: 404,
        durationMs: Date.now() - startedMs,
        triggeredBy,
        detail: { reason: "unknown campaign", campaign },
      });
      return c.json({ error: `Unknown campaign '${campaign}'` }, 404);
    }

    // Paused / killed → do nothing (a healthy, deliberate skip).
    if (def.status !== "active") {
      await recordCronRun({
        jobName: "drip-tick",
        status: "skipped",
        httpStatus: 200,
        durationMs: Date.now() - startedMs,
        triggeredBy,
        detail: { reason: `campaign ${def.status}`, campaign, dryRun },
      });
      return c.json({ ok: true, skipped: true, reason: `campaign ${def.status}`, campaign });
    }

    // US-943 fleet-wide kill-switch: the admin builder's "kill" flips the linked
    // feature flag off (admin-drip.ts) so every replica hard-stops within the
    // flag cache TTL. Fail-open (no row → enabled) so a fresh deploy still runs;
    // an operator-disabled flag stops sending even before the next status read.
    if (!(await isFeatureEnabled("trial_conversion_drip"))) {
      await recordCronRun({
        jobName: "drip-tick",
        status: "skipped",
        httpStatus: 200,
        durationMs: Date.now() - startedMs,
        triggeredBy,
        detail: { reason: "feature flag disabled", campaign, dryRun },
      });
      return c.json({ ok: true, skipped: true, reason: "feature disabled", campaign });
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // US-942: resolve the campaign's conversion incentive once per tick (one
    // Stripe coupon lookup, shared across the batch). null when the incentive is
    // off, misconfigured, or the coupon fails the max-discount guardrail — in
    // which case every send falls back to the value-only email.
    const resolvedIncentive = await resolveIncentive(def.graph.incentive, nowMs);

    // US-940: campaign-wide recap personalization (grounded loss copy + subscribe
    // deep-link), resolved once and shared across the batch.
    const personalization = await buildPersonalization();

    // 1. Enroll new trialists (skipped in dry-run — enrolling is itself a write).
    if (!dryRun) {
      counts.enrolled = await enrollNewTrialists(campaign, nowIso);
    }

    // 2/3. Evaluate the due, active enrollments (bounded, resumable batch).
    const { data: due, error: dueErr } = await supabaseAdmin
      .from("drip_enrollments")
      .select(
        "id, user_id, campaign, enrolled_at, trial_started_at, converted_at, incentive_enabled",
      )
      .eq("campaign", campaign)
      .is("exited_at", null)
      .or(`next_evaluation_at.is.null,next_evaluation_at.lte.${nowIso}`)
      .order("next_evaluation_at", { ascending: true, nullsFirst: true })
      .limit(EVAL_BATCH);
    if (dueErr) {
      await recordCronRun({
        jobName: "drip-tick",
        status: "error",
        httpStatus: 500,
        durationMs: Date.now() - startedMs,
        triggeredBy,
        detail: { reason: "load enrollments failed", error: dueErr.message },
      });
      return c.json({ error: "Failed to load enrollments" }, 500);
    }

    for (const row of (due ?? []) as EnrollmentRow[]) {
      try {
        await processEnrollment(
          def, row, nowMs, nowIso, dryRun, counts, resolvedIncentive, personalization,
        );
      } catch (e) {
        // One bad enrollment must not abort the batch.
        counts.skipped++;
        console.error(
          `[drip-tick] enrollment ${row.id} failed:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    const processed = (due ?? []).length;
    await recordCronRun({
      jobName: "drip-tick",
      status: "success",
      httpStatus: 200,
      durationMs: Date.now() - startedMs,
      triggeredBy,
      rowsProcessed: counts.sent,
      detail: { campaign, dryRun, processed, ...counts },
    });

    return c.json({
      ok: true,
      campaign,
      dryRun,
      processed,
      counts,
    });
  } finally {
    await lock.release();
  }
});

// Lightweight ping — lets the scheduler validate the secret + URL before turning
// the cron on (mirrors content-scheduler's /test).
dripRoutes.post("/test", (c) => {
  return c.json({ ok: true, ts: new Date().toISOString() });
});

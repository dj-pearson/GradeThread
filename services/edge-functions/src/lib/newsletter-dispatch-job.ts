// US-926: Weekly newsletter dispatch — DB-touching orchestration.
//
// The autonomous release step. Run frequently (hourly) by the dispatch cron, it:
//   1. Assigns a SEND WINDOW (next configured weekday/hour) to every approved
//      issue that doesn't have one yet — the scheduling step.
//   2. Releases each DUE approved issue through the same gated sender the console
//      uses (coordinateMarketingSend → consent + suppression + frequency cap +
//      durable outbox), applying a per-period CADENCE GUARD and, when enabled,
//      per-recipient SEND-TIME OPTIMIZATION (stagger toward each recipient's best
//      open hour across the STO window — a slow issue stays `sending` across ticks
//      until its staggering span closes).
//   3. Honors a holiday/QUIET PERIOD: while active, dispatch is skipped entirely
//      without touching the cadence clock, so a week is cleanly skipped.
//
// Pure schedule/cadence/STO math lives in newsletter-schedule.ts; per-recipient
// delivery reuses deliverIssueRecipient from newsletter-ab-job.ts so dispatch
// inherits the identical delivery + idempotency guarantees. Issues carrying A/B
// subject variants are released through startAbTest (the A/B finalize cron then
// completes them) so the two engines compose.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { captureException } from "./observability.ts";
import {
  type AbIssueRow,
  deliverIssueRecipient,
  issueWantsAbTest,
  resolveAbConfig,
  startAbTest,
} from "./newsletter-ab-job.ts";
import {
  bestOpenHour,
  isQuietPeriod,
  nextSendWindow,
  planRecipientSend,
  type ScheduleConfig,
  stoSpanEndMs,
  withinCadence,
} from "./newsletter-schedule.ts";
import { resolvePersonalizationForBatch } from "./newsletter-personalization-job.ts";

const MAX_SEND_RECIPIENTS = 1000;
// Cap the engagement-history scan that powers per-recipient send-time optimization.
const STO_HISTORY_SCAN = 5000;
const STO_HISTORY_WINDOW_DAYS = 180;

// Columns the dispatch path needs (superset of the A/B columns so issueWantsAbTest works).
const DISPATCH_ISSUE_COLS =
  "id, title, subject, preheader, sections, status, scheduled_for, send_started_at, " +
  "subject_variants, ab_metric, ab_test_fraction, ab_measurement_hours, ab_phase, " +
  "ab_test_started_at, ab_winner_variant, ab_winner_source, personalize";

interface DispatchIssueRow extends AbIssueRow {
  scheduled_for: string | null;
  send_started_at: string | null;
}

export async function loadScheduleConfig(): Promise<ScheduleConfig> {
  const [weekday, hour, timezone, cadenceDays, stoEnabled, stoWindowHours, quietUntil] = await Promise.all([
    getSetting<number>("newsletter_schedule_weekday", 2),
    getSetting<number>("newsletter_schedule_hour", 14),
    getSetting<string>("newsletter_schedule_timezone", "UTC"),
    getSetting<number>("newsletter_cadence_period_days", 7),
    getSetting<boolean>("newsletter_send_time_optimization_enabled", false),
    getSetting<number>("newsletter_sto_window_hours", 12),
    getSetting<string>("newsletter_quiet_period_until", ""),
  ]);
  return {
    weekday: Number(weekday),
    hour: Number(hour),
    timezone: typeof timezone === "string" ? timezone : "UTC",
    cadencePeriodDays: Number(cadenceDays),
    stoEnabled: Boolean(stoEnabled),
    stoWindowHours: Number(stoWindowHours),
    quietPeriodUntil: typeof quietUntil === "string" && quietUntil.trim().length > 0 ? quietUntil.trim() : null,
  };
}

// ── Step 1: assign send windows to approved issues lacking one ─────────────────

async function assignSendWindows(config: ScheduleConfig, nowMs: number): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .select("id")
    .eq("status", "approved")
    .is("scheduled_for", null)
    .limit(100);
  if (error) {
    captureException(error, { tags: { area: "newsletter-dispatch.schedule" } });
    return 0;
  }
  const rows = (data ?? []) as { id: string }[];
  let assigned = 0;
  for (const r of rows) {
    const when = nextSendWindow(config, nowMs);
    const { error: upErr } = await supabaseAdmin
      .from("newsletter_issues")
      .update({ scheduled_for: when })
      .eq("id", r.id)
      .is("scheduled_for", null);
    if (!upErr) assigned++;
  }
  return assigned;
}

// ── Recipient resolution + guards ──────────────────────────────────────────────

async function resolveConfirmed(): Promise<{ email: string; user_id: string | null }[]> {
  const { data, error } = await supabaseAdmin
    .from("email_subscribers")
    .select("email, user_id")
    .eq("status", "confirmed")
    .limit(MAX_SEND_RECIPIENTS);
  if (error) {
    captureException(error, { tags: { area: "newsletter-dispatch.resolve" } });
    return [];
  }
  return (data ?? []) as { email: string; user_id: string | null }[];
}

/** Recipients (by user id + email) who received any OTHER issue inside the cadence period. */
async function loadCadenceBlocked(
  config: ScheduleConfig,
  nowMs: number,
  excludeIssueId: string,
): Promise<{ users: Set<string>; emails: Set<string> }> {
  const users = new Set<string>();
  const emails = new Set<string>();
  if (config.cadencePeriodDays <= 0) return { users, emails };
  const cutoff = new Date(nowMs - config.cadencePeriodDays * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("newsletter_issue_recipients")
    .select("email, subscriber_user_id, sent_at, issue_id, status")
    .eq("status", "sent")
    .gte("sent_at", cutoff)
    .neq("issue_id", excludeIssueId)
    .limit(STO_HISTORY_SCAN);
  if (error) {
    captureException(error, { tags: { area: "newsletter-dispatch.cadence" } });
    return { users, emails };
  }
  for (const r of (data ?? []) as { email: string; subscriber_user_id: string | null; sent_at: string | null }[]) {
    const lastMs = r.sent_at ? Date.parse(r.sent_at) : NaN;
    if (!withinCadence(Number.isFinite(lastMs) ? lastMs : null, config.cadencePeriodDays, nowMs)) continue;
    if (r.subscriber_user_id) users.add(r.subscriber_user_id);
    if (r.email) emails.add(r.email.toLowerCase());
  }
  return { users, emails };
}

/** Per-user best open hour (UTC) from recent newsletter open history — powers STO. */
async function loadBestOpenHours(nowMs: number): Promise<Map<string, number>> {
  const cutoff = new Date(nowMs - STO_HISTORY_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("newsletter_issue_recipients")
    .select("subscriber_user_id, opened_at")
    .not("opened_at", "is", null)
    .gte("opened_at", cutoff)
    .limit(STO_HISTORY_SCAN);
  if (error) {
    captureException(error, { tags: { area: "newsletter-dispatch.sto" } });
    return new Map();
  }
  const hoursByUser = new Map<string, number[]>();
  for (const r of (data ?? []) as { subscriber_user_id: string | null; opened_at: string | null }[]) {
    if (!r.subscriber_user_id || !r.opened_at) continue;
    const t = Date.parse(r.opened_at);
    if (!Number.isFinite(t)) continue;
    const arr = hoursByUser.get(r.subscriber_user_id) ?? [];
    arr.push(new Date(t).getUTCHours());
    hoursByUser.set(r.subscriber_user_id, arr);
  }
  const best = new Map<string, number>();
  for (const [uid, hours] of hoursByUser) {
    const h = bestOpenHour(hours);
    if (h != null) best.set(uid, h);
  }
  return best;
}

/**
 * Emails already recorded in this issue's ledger (idempotency across ticks).
 *
 * US-2316 AC4: `failed` rows are deliberately NOT excluded. Excluding every row
 * regardless of status made `failed` a tombstone — a recipient whose send threw
 * once was never offered to a later tick, so the reclaim arm in
 * deliverIssueRecipient was unreachable and a transient SMTP error cost that
 * person the issue permanently. Retrying is safe because the reclaim is
 * conditional on the status it read, so two ticks cannot both take one row.
 *
 * `pending` IS excluded, and that is the deliberate trade documented on
 * campaign-claim.ts: a claim that was never finalised is left alone rather than
 * risking a duplicate.
 */
async function loadLedgerEmails(issueId: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from("newsletter_issue_recipients")
    .select("email")
    .neq("status", "failed")
    .eq("issue_id", issueId)
    .limit(MAX_SEND_RECIPIENTS);
  return new Set(((data ?? []) as { email: string }[]).map((r) => r.email.toLowerCase()));
}

async function refreshCounters(issueId: string): Promise<{ sent: number; skipped: number; failed: number }> {
  const { data } = await supabaseAdmin
    .from("newsletter_issue_recipients")
    .select("status")
    .eq("issue_id", issueId)
    .limit(MAX_SEND_RECIPIENTS);
  const counts = { sent: 0, skipped: 0, failed: 0 };
  for (const r of (data ?? []) as { status: string }[]) {
    if (r.status === "sent") counts.sent++;
    else if (r.status === "skipped") counts.skipped++;
    else if (r.status === "failed") counts.failed++;
  }
  await supabaseAdmin
    .from("newsletter_issues")
    .update({ sent_count: counts.sent, skipped_count: counts.skipped, failed_count: counts.failed })
    .eq("id", issueId);
  return counts;
}

// ── Per-issue dispatch ─────────────────────────────────────────────────────────

export interface IssueDispatchResult {
  issueId: string;
  mode: "ab" | "plain" | "deferred";
  sent: number;
  skipped: number;
  failed: number;
  deferred: number;
  completed: boolean;
}

async function dispatchPlainIssue(
  issue: DispatchIssueRow,
  config: ScheduleConfig,
  nowMs: number,
): Promise<IssueDispatchResult> {
  const windowStartMs = issue.scheduled_for ? Date.parse(issue.scheduled_for) : nowMs;
  const base = Number.isFinite(windowStartMs) ? windowStartMs : nowMs;

  const recipients = await resolveConfirmed();
  recipients.sort((a, b) => a.email.localeCompare(b.email));

  // Lock the issue into `sending` on first entry (don't clear the ledger — the
  // upsert path is idempotent and STO continuation re-enters across ticks).
  if (issue.status === "approved") {
    await supabaseAdmin
      .from("newsletter_issues")
      .update({
        status: "sending",
        send_started_at: new Date(nowMs).toISOString(),
        recipients_total: recipients.length,
      })
      .eq("id", issue.id)
      .eq("status", "approved");
  }

  const [cadence, bestHours, alreadyRecorded, pctx] = await Promise.all([
    loadCadenceBlocked(config, nowMs, issue.id),
    config.stoEnabled ? loadBestOpenHours(nowMs) : Promise.resolve(new Map<string, number>()),
    loadLedgerEmails(issue.id),
    // US-921: resolve every recipient's activity ONCE per batch (no N+1).
    resolvePersonalizationForBatch(recipients, issue.personalize !== false, nowMs),
  ]);

  let deferred = 0;
  for (const r of recipients) {
    const emailKey = r.email.toLowerCase();
    if (alreadyRecorded.has(emailKey)) continue; // terminal row already exists

    // Cadence guard — recipient got another issue within the period.
    if ((r.user_id && cadence.users.has(r.user_id)) || cadence.emails.has(emailKey)) {
      await supabaseAdmin.from("newsletter_issue_recipients").upsert({
        issue_id: issue.id,
        email: r.email,
        subscriber_user_id: r.user_id,
        status: "skipped",
        skip_reason: "cadence",
      }, { onConflict: "issue_id,email", ignoreDuplicates: true });
      continue;
    }

    // Send-time optimization — stagger toward the recipient's best open hour.
    const bestHour = r.user_id ? bestHours.get(r.user_id) ?? null : null;
    const plan = planRecipientSend(
      { stoEnabled: config.stoEnabled, bestHour, windowStartMs: base, stoWindowHours: config.stoWindowHours },
      nowMs,
    );
    if (!plan.due) {
      deferred++;
      continue; // a later tick within the STO window will send them
    }

    await deliverIssueRecipient({
      issue,
      recipient: r,
      subjectLine: issue.subject || issue.title,
      variantId: null,
      isHoldout: false,
      personalization: pctx.enabled
        ? {
          activity: r.user_id ? pctx.activity.get(r.user_id) ?? null : null,
          siteUrl: pctx.siteUrl,
          trialSoonDays: pctx.trialSoonDays,
        }
        : null,
    });
  }

  const counts = await refreshCounters(issue.id);

  // Finalize once nothing is left deferred OR the STO window has fully closed.
  const spanClosed = nowMs >= stoSpanEndMs(base, config.stoWindowHours);
  const completed = deferred === 0 || spanClosed;
  if (completed) {
    await supabaseAdmin
      .from("newsletter_issues")
      .update({ status: "sent", sent_at: new Date(nowMs).toISOString() })
      .eq("id", issue.id);
  }

  return {
    issueId: issue.id,
    mode: deferred > 0 && !completed ? "deferred" : "plain",
    sent: counts.sent,
    skipped: counts.skipped,
    failed: counts.failed,
    deferred,
    completed,
  };
}

async function dispatchIssue(
  issue: DispatchIssueRow,
  config: ScheduleConfig,
  nowMs: number,
): Promise<IssueDispatchResult> {
  // Issues with 2+ subject variants run the A/B flow (start the holdout; the A/B
  // finalize cron sends the winner to the remainder). Only from `approved`.
  if (issue.status === "approved") {
    const abConfig = await resolveAbConfig(issue);
    if (issueWantsAbTest(issue, abConfig)) {
      const start = await startAbTest(issue, abConfig);
      return {
        issueId: issue.id,
        mode: "ab",
        sent: start.summary.sent,
        skipped: start.summary.skipped,
        failed: start.summary.failed,
        deferred: start.remainderSize,
        completed: false,
      };
    }
  }
  return dispatchPlainIssue(issue, config, nowMs);
}

// ── Top-level pass ──────────────────────────────────────────────────────────────

export interface DispatchResult {
  skipped: boolean;
  reason?: string;
  scheduledWindows: number;
  released: number;
  rowsProcessed: number;
  issues: IssueDispatchResult[];
}

/**
 * One dispatch pass: honor the quiet period, assign windows to approved issues,
 * then release every due issue (approved + due, or a plain issue still `sending`
 * mid-STO). Bounded + lock-guarded by the caller.
 */
export async function runNewsletterDispatch(nowMs: number): Promise<DispatchResult> {
  const config = await loadScheduleConfig();

  if (isQuietPeriod(config.quietPeriodUntil, nowMs)) {
    return { skipped: true, reason: "quiet_period", scheduledWindows: 0, released: 0, rowsProcessed: 0, issues: [] };
  }

  const scheduledWindows = await assignSendWindows(config, nowMs);

  const nowIso = new Date(nowMs).toISOString();
  // Due approved issues — their window has opened.
  const { data: dueApproved, error: dueErr } = await supabaseAdmin
    .from("newsletter_issues")
    .select(DISPATCH_ISSUE_COLS)
    .eq("status", "approved")
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", nowIso)
    .limit(50);
  if (dueErr) {
    captureException(dueErr, { tags: { area: "newsletter-dispatch.due" } });
  }

  // Plain issues still sending mid-STO (NOT A/B tests — those finalize on their own cron).
  const { data: inFlight } = config.stoEnabled
    ? await supabaseAdmin
      .from("newsletter_issues")
      .select(DISPATCH_ISSUE_COLS)
      .eq("status", "sending")
      .eq("ab_phase", "none")
      .limit(50)
    : { data: [] };

  const issues = [
    ...((dueApproved ?? []) as unknown as DispatchIssueRow[]),
    ...((inFlight ?? []) as unknown as DispatchIssueRow[]),
  ];

  const results: IssueDispatchResult[] = [];
  let rowsProcessed = 0;
  for (const issue of issues) {
    try {
      const r = await dispatchIssue(issue, config, nowMs);
      results.push(r);
      rowsProcessed += r.sent + r.skipped + r.failed;
    } catch (err) {
      captureException(err, { tags: { area: "newsletter-dispatch.issue" } });
    }
  }

  return {
    skipped: false,
    scheduledWindows,
    released: results.length,
    rowsProcessed,
    issues: results,
  };
}

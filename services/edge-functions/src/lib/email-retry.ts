// Email outbox retry cron (US-498).
//
// Sweeps email_deliveries rows that are due (status='pending', next_attempt_at
// <= now), re-attempts the SMTP send, and applies exponential backoff. After
// max_attempts the row is moved to 'dead_letter' and reported to the error
// tracker so a permanently-failing critical email is surfaced, not silently
// lost. A delivered row flips to 'sent'.

import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";
import { deliverEmail } from "./email.ts";
import { getSuppression } from "./email-suppression.ts";
import { acquireJobLock } from "./job-lock.ts";
import { captureException, logEvent, recordMetric } from "./observability.ts";

const BATCH_LIMIT = 50;

// Backoff schedule per attempt number (minutes): ~1m, 5m, 15m, 1h, 6h.
export function backoffMs(attempts: number): number {
  const mins = [1, 5, 15, 60, 360];
  return (mins[Math.min(attempts, mins.length - 1)] ?? 360) * 60_000;
}

interface DeliveryRow {
  id: string;
  recipient: string;
  subject: string;
  html: string;
  category: string;
  attempts: number;
  max_attempts: number;
}

export interface EmailRetryResult {
  scanned: number;
  sent: number;
  retried: number;
  dead_lettered: number;
  skipped: number;
}

export async function retryPendingEmails(): Promise<EmailRetryResult> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("email_deliveries")
    .select("id, recipient, subject, html, category, attempts, max_attempts")
    .eq("status", "pending")
    .lte("next_attempt_at", nowIso)
    .order("next_attempt_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    captureException(error, { route: "email-retry.scan" });
    throw new Error(`email-retry scan failed: ${error.message}`);
  }

  const due = (data ?? []) as DeliveryRow[];
  let sent = 0;
  let retried = 0;
  let deadLettered = 0;
  let skipped = 0;

  for (const row of due) {
    // US-914: don't retry a queued send to a now-suppressed address — mark the
    // outbox row terminal (status='skipped' with the reason) and move on.
    const suppression = await getSuppression(row.recipient);
    if (suppression) {
      await supabaseAdmin
        .from("email_deliveries")
        .update({ status: "skipped", skip_reason: `suppressed:${suppression.reason}` })
        .eq("id", row.id);
      skipped += 1;
      recordMetric("email.retry_skipped_suppressed", 1, { category: row.category });
      continue;
    }

    const ok = await deliverEmail({
      to: row.recipient,
      subject: row.subject,
      html: row.html,
      category: row.category,
    });
    const attempts = row.attempts + 1;

    if (ok) {
      await supabaseAdmin
        .from("email_deliveries")
        .update({ status: "sent", attempts, sent_at: new Date().toISOString(), last_error: null })
        .eq("id", row.id);
      sent += 1;
      recordMetric("email.retry_sent", 1, { category: row.category });
      continue;
    }

    if (attempts >= row.max_attempts) {
      await supabaseAdmin
        .from("email_deliveries")
        .update({ status: "dead_letter", attempts, last_error: "exhausted retries" })
        .eq("id", row.id);
      deadLettered += 1;
      recordMetric("email.dead_lettered", 1, { category: row.category });
      // A dead-lettered CRITICAL email is an operational event — surface it.
      captureException(
        new Error(`Email dead-lettered after ${attempts} attempts (category=${row.category})`),
        { level: "warn", route: "email-retry", tags: { category: row.category }, extra: { id: row.id } },
      );
      continue;
    }

    await supabaseAdmin
      .from("email_deliveries")
      .update({
        attempts,
        next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
        last_error: "retry send failed",
      })
      .eq("id", row.id);
    retried += 1;
  }

  if (due.length > 0) {
    logEvent("info", "email.retry_sweep", { scanned: due.length, sent, retried, deadLettered, skipped });
  }
  return { scanned: due.length, sent, retried, dead_lettered: deadLettered, skipped };
}

// Cron entry point. OUTSIDE /api/* JWT groups; guards with the shared job secret
// and an overlap lock (mirrors the other crons).
export async function handleEmailRetryCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // US-2311: lease is 2x the */5 schedule interval. At <= 1x, a run
  // that overruns by a second is displaced by the very next tick.
  const lock = await acquireJobLock("email-retry", 600);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await retryPendingEmails();
    return c.json({ ok: true, ...result });
  } catch (err) {
    captureException(err, { route: "email-retry.cron" });
    return c.json({ error: "Email retry sweep failed" }, 500);
  } finally {
    await lock.release();
  }
}

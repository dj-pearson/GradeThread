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
  /**
   * US-2315: rows whose processing THREW rather than returning a send result.
   * Named `failed` on purpose — the cron recorder (lib/cron-run-outcome.ts,
   * US-2312) reads that key out of the response body, so a sweep that throws on
   * every row now records as an error run and raises job.failed instead of
   * answering 200 with a tidy summary.
   */
  failed: number;
}

/**
 * US-2315: advance a row that THREW, so it cannot block the batch forever.
 *
 * The scan orders by next_attempt_at ASC. Before this, `attempts` and
 * `next_attempt_at` were only ever written after deliverEmail RETURNED — so a
 * row where getSuppression or deliverEmail threw kept its original
 * next_attempt_at, sorted first on the very next run, threw again, and aborted
 * the remaining 49 rows of the batch. Every five minutes. Indefinitely. The
 * only visible symptom was a 500 from the cron.
 *
 * Never throws: it is the recovery path, and a failure here would re-create the
 * exact stall it exists to prevent.
 */
async function advanceThrownRow(
  row: DeliveryRow,
  err: unknown,
  patch: EmailRetryDeps["patch"],
): Promise<"retried" | "dead_letter"> {
  const attempts = row.attempts + 1;
  const message = err instanceof Error ? err.message : String(err);
  const terminal = attempts >= row.max_attempts;
  try {
    await patch(
      row.id,
      terminal
        ? {
          status: "dead_letter",
          attempts,
          last_error: `threw: ${message}`.slice(0, 500),
        }
        : {
          attempts,
          next_attempt_at: new Date(Date.now() + backoffMs(attempts))
            .toISOString(),
          last_error: `threw: ${message}`.slice(0, 500),
        },
    );
  } catch {
    // Even the bookkeeping write failed (DB blip). The row keeps its old
    // next_attempt_at and will be retried — that is the pre-existing behaviour,
    // and it is still better than aborting the rest of this batch.
  }
  return terminal ? "dead_letter" : "retried";
}

/**
 * The three external calls the row loop makes, injectable so the
 * one-poison-row-must-not-block-the-batch guarantee (US-2315) is a UNIT TEST
 * rather than a claim. Mirrors the `rpc` seam in job-lock.ts.
 *
 * `patch` stands in for the four different UPDATEs the loop issues; a test only
 * needs to know THAT a row was advanced, not which columns changed.
 */
export interface EmailRetryDeps {
  getSuppression: typeof getSuppression;
  deliverEmail: typeof deliverEmail;
  patch: (id: string, values: Record<string, unknown>) => Promise<void>;
}

const realDeps: EmailRetryDeps = {
  getSuppression,
  deliverEmail,
  patch: async (id, values) => {
    await supabaseAdmin.from("email_deliveries").update(values).eq("id", id);
  },
};

export async function retryPendingEmails(
  deps: EmailRetryDeps = realDeps,
): Promise<EmailRetryResult> {
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
  return await sweepDueRows(due, deps);
}

/**
 * The row loop, over rows already fetched. Exported so US-2315's guarantee can
 * be asserted against a batch containing a row that always throws.
 */
export async function sweepDueRows(
  due: DeliveryRow[],
  deps: EmailRetryDeps = realDeps,
): Promise<EmailRetryResult> {
  let sent = 0;
  let retried = 0;
  let deadLettered = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of due) {
    try {
      // US-914: don't retry a queued send to a now-suppressed address — mark the
      // outbox row terminal (status='skipped' with the reason) and move on.
      const suppression = await deps.getSuppression(row.recipient);
      if (suppression) {
        await deps.patch(row.id, {
          status: "skipped",
          skip_reason: `suppressed:${suppression.reason}`,
        });
        skipped += 1;
        recordMetric("email.retry_skipped_suppressed", 1, {
          category: row.category,
        });
        continue;
      }

      const ok = await deps.deliverEmail({
        to: row.recipient,
        subject: row.subject,
        html: row.html,
        category: row.category,
      });
      const attempts = row.attempts + 1;

      if (ok) {
        await deps.patch(row.id, {
          status: "sent",
          attempts,
          sent_at: new Date().toISOString(),
          last_error: null,
        });
        sent += 1;
        recordMetric("email.retry_sent", 1, { category: row.category });
        continue;
      }

      if (attempts >= row.max_attempts) {
        await deps.patch(row.id, {
          status: "dead_letter",
          attempts,
          last_error: "exhausted retries",
        });
        deadLettered += 1;
        recordMetric("email.dead_lettered", 1, { category: row.category });
        // A dead-lettered CRITICAL email is an operational event — surface it.
        captureException(
          new Error(
            `Email dead-lettered after ${attempts} attempts (category=${row.category})`,
          ),
          {
            level: "warn",
            route: "email-retry",
            tags: { category: row.category },
            extra: { id: row.id },
          },
        );
        continue;
      }

      await deps.patch(row.id, {
        attempts,
        next_attempt_at: new Date(Date.now() + backoffMs(attempts))
          .toISOString(),
        last_error: "retry send failed",
      });
      retried += 1;
    } catch (err) {
      // US-2315: one poison row must not take the other 49 with it.
      failed += 1;
      const outcome = await advanceThrownRow(row, err, deps.patch);
      if (outcome === "dead_letter") deadLettered += 1;
      else retried += 1;
      captureException(err, {
        level: "warn",
        route: "email-retry.row",
        tags: { category: row.category },
        extra: { id: row.id, outcome },
      });
    }
  }

  if (due.length > 0) {
    logEvent("info", "email.retry_sweep", {
      scanned: due.length,
      sent,
      retried,
      deadLettered,
      skipped,
      failed,
    });
  }
  return {
    scanned: due.length,
    sent,
    retried,
    dead_lettered: deadLettered,
    skipped,
    failed,
  };
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

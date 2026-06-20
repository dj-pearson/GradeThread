// Cron-run ledger + schedule registry (US-584).
//
// Two responsibilities:
//   1. recordCronRun() — append one row to cron_runs per /api/jobs/* hit. Called
//      from the thin middleware in main.ts so EVERY scheduled job's last run,
//      outcome, and duration is observable without instrumenting each handler.
//   2. CRON_REGISTRY + nextCronRun() — the static schedule of every Coolify
//      cron (mirrors LAUNCH_CHECKLIST §3) so the admin Jobs dashboard can show
//      each job's schedule and compute its next fire time, then join the
//      latest cron_runs row for the last-run/outcome.

import { supabaseAdmin } from "./supabase.ts";
import { logEvent } from "./observability.ts";

export type CronRunStatus = "success" | "error" | "skipped";

export interface CronRunInsert {
  jobName: string;
  status: CronRunStatus;
  httpStatus?: number;
  durationMs?: number;
  detail?: Record<string, unknown>;
  // US-881: who fired this run — 'schedule' (Coolify cron) or 'admin:<uuid>'
  // (manual Run-now from the Operations console). The middleware reads it from
  // the X-Triggered-By header, defaulting to 'schedule'.
  triggeredBy?: string;
  // US-881: optional count of items the run processed.
  rowsProcessed?: number;
}

// Best-effort: a ledger write must never break the cron itself. Never throws.
export async function recordCronRun(run: CronRunInsert): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("cron_runs").insert({
      job_name: run.jobName,
      status: run.status,
      http_status: run.httpStatus ?? null,
      duration_ms: run.durationMs ?? null,
      detail: run.detail ?? {},
      triggered_by: run.triggeredBy ?? "schedule",
      rows_processed: run.rowsProcessed ?? null,
    });
    if (error) logEvent("warn", "cron_run.record_failed", { job: run.jobName, error: error.message });
  } catch (err) {
    logEvent("warn", "cron_run.record_failed", {
      job: run.jobName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Schedule registry ────────────────────────────────────────────────
// `name` is the cron_runs.job_name — for /api/jobs/<seg> crons it's the last
// path segment (what the middleware records). `recorded: false` marks crons
// served outside /api/jobs/* (eBay/Google, handled inside /api/flipdesk/*),
// which the ledger doesn't capture today: their schedule + next-run still show,
// last-run is unknown.

export interface CronDef {
  name: string;
  label: string;
  schedule: string; // standard 5-field cron (UTC)
  category: string;
  endpoint: string;
  recorded: boolean;
}

export const CRON_REGISTRY: CronDef[] = [
  // /api/jobs/* family — captured by the cron_runs middleware.
  { name: "reprice-scan", label: "Repricing scan", schedule: "0 */6 * * *", category: "repricing", endpoint: "/api/jobs/reprice-scan", recorded: true },
  { name: "reprice-rules", label: "Repricing rules", schedule: "0 */6 * * *", category: "repricing", endpoint: "/api/jobs/reprice-rules", recorded: true },
  { name: "automation-rules", label: "Listing automation rules", schedule: "0 * * * *", category: "listings", endpoint: "/api/jobs/automation-rules", recorded: true },
  { name: "autolister-reclaim", label: "AutoLister reclaim", schedule: "*/5 * * * *", category: "autolister", endpoint: "/api/jobs/autolister-reclaim", recorded: true },
  { name: "publish-batch-reclaim", label: "Publish-batch reclaim", schedule: "*/5 * * * *", category: "publish", endpoint: "/api/jobs/publish-batch-reclaim", recorded: true },
  { name: "grading-monitor", label: "Grading regression monitor", schedule: "0 */12 * * *", category: "grading", endpoint: "/api/jobs/grading-monitor", recorded: true },
  { name: "stuck-submissions", label: "Stuck-submission recovery", schedule: "*/10 * * * *", category: "grading", endpoint: "/api/jobs/stuck-submissions", recorded: true },
  { name: "push-token-prune", label: "Push-token prune", schedule: "0 3 * * *", category: "maintenance", endpoint: "/api/jobs/push-token-prune", recorded: true },
  { name: "sync-reaper", label: "eBay sync reaper", schedule: "*/15 * * * *", category: "sync", endpoint: "/api/jobs/sync-reaper", recorded: true },
  { name: "email-retry", label: "Email outbox retry", schedule: "*/5 * * * *", category: "email", endpoint: "/api/jobs/email-retry", recorded: true },
  { name: "integrity-scan", label: "DB integrity scan", schedule: "0 7 * * *", category: "maintenance", endpoint: "/api/jobs/integrity-scan", recorded: true },
  { name: "data-retention", label: "Data-retention purge", schedule: "0 4 * * *", category: "maintenance", endpoint: "/api/jobs/data-retention", recorded: true },
  { name: "condition-index-refresh", label: "Condition Index refresh", schedule: "0 8 * * *", category: "content", endpoint: "/api/jobs/condition-index-refresh", recorded: true },
  { name: "trial-expiry", label: "Trial-expiry downgrade", schedule: "15 0 * * *", category: "billing", endpoint: "/api/jobs/trial-expiry", recorded: true },
  // US-929: daily lifecycle email-journey tick (welcome / trial-nurture / win-back).
  { name: "journey-tick", label: "Lifecycle email-journey tick", schedule: "30 13 * * *", category: "growth", endpoint: "/api/jobs/journey-tick", recorded: true },
  // US-928: daily newsletter self-tuning — recompute topic/subject/send-hour weights from engagement.
  { name: "newsletter-tuning", label: "Newsletter self-tuning", schedule: "45 12 * * *", category: "growth", endpoint: "/api/jobs/newsletter-tuning", recorded: true },
  { name: "abuse-scan", label: "Abuse-signal scan", schedule: "0 */6 * * *", category: "safety", endpoint: "/api/jobs/abuse-scan", recorded: true },
  { name: "listing-prompt-promote", label: "Listing-prompt auto-promote", schedule: "0 9 * * *", category: "grading", endpoint: "/api/jobs/listing-prompt-promote", recorded: true },
  { name: "ebay-pending-webhooks", label: "eBay parked-webhook drain", schedule: "*/15 * * * *", category: "sync", endpoint: "/api/jobs/ebay-pending-webhooks", recorded: true },
  { name: "gsc-sync", label: "Search Console sync", schedule: "30 6 * * *", category: "seo", endpoint: "/api/jobs/gsc-sync", recorded: true },
  { name: "growth-dispatch", label: "Scheduled-campaign dispatch", schedule: "*/15 * * * *", category: "growth", endpoint: "/api/jobs/growth-dispatch", recorded: true },
  { name: "north-star-digest", label: "North Star weekly digest", schedule: "0 14 * * 1", category: "growth", endpoint: "/api/jobs/north-star-digest", recorded: true },
  // US-943: served under /api/drip/* (own auth) but records to cron_runs itself.
  { name: "drip-tick", label: "Trial-drip orchestration tick", schedule: "0 * * * *", category: "growth", endpoint: "/api/drip/tick", recorded: true },
  // Served under /api/flipdesk/* — not in the ledger (next-run still computed).
  { name: "ebay-token-refresh", label: "eBay token refresh", schedule: "0 * * * *", category: "sync", endpoint: "/api/flipdesk/ebay/oauth/refresh", recorded: false },
  { name: "ebay-orders-sync", label: "eBay listings/orders sync", schedule: "*/30 * * * *", category: "sync", endpoint: "/api/flipdesk/ebay/listings/pull", recorded: false },
  { name: "ebay-performance-sync", label: "eBay performance sync", schedule: "0 */6 * * *", category: "sync", endpoint: "/api/flipdesk/ebay/sync/performance", recorded: false },
  { name: "ebay-publish-due", label: "Scheduled publish-due", schedule: "*/5 * * * *", category: "publish", endpoint: "/api/flipdesk/ebay/jobs/publish-due", recorded: false },
  { name: "google-sheet-sync", label: "Google Sheet sync", schedule: "*/5 * * * *", category: "sync", endpoint: "/api/flipdesk/google/sync/push", recorded: false },
];

// ── Minimal cron next-run computation ────────────────────────────────
// Supports the subset used above: '*', '*/n', comma lists, and single ints per
// of the 5 fields (min hour dom month dow), interpreted in UTC (Coolify cron
// runs UTC). Minute-steps forward from `from` up to a 45-day horizon — every
// registered cron fires at least daily, so a match is always found well inside
// it. Returns an ISO timestamp, or null if no match (defensive).

function fieldMatcher(field: string, min: number, max: number): (v: number) => boolean {
  // "*" or "*/n"
  if (field === "*") return () => true;
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    return (v) => step > 0 && (v - min) % step === 0;
  }
  // comma list / single int
  const allowed = new Set<number>();
  for (const part of field.split(",")) {
    const n = Number(part);
    if (Number.isInteger(n) && n >= min && n <= max) allowed.add(n);
  }
  return (v) => allowed.has(v);
}

export function nextCronRun(schedule: string, from: Date): string | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = parts;
  const matchMin = fieldMatcher(minF, 0, 59);
  const matchHour = fieldMatcher(hourF, 0, 23);
  const matchDom = fieldMatcher(domF, 1, 31);
  const matchMon = fieldMatcher(monF, 1, 12);
  const matchDow = fieldMatcher(dowF, 0, 6); // 0 = Sunday

  // Start at the next whole minute after `from`.
  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);

  const horizon = from.getTime() + 45 * 24 * 60 * 60_000;
  while (t.getTime() <= horizon) {
    const domOk = matchDom(t.getUTCDate());
    const dowOk = matchDow(t.getUTCDay());
    // cron DOM/DOW semantics: when both are restricted, either may match.
    const dayOk =
      domF === "*" || dowF === "*" ? domOk && dowOk : domOk || dowOk;
    if (
      matchMin(t.getUTCMinutes()) &&
      matchHour(t.getUTCHours()) &&
      matchMon(t.getUTCMonth() + 1) &&
      dayOk
    ) {
      return t.toISOString();
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return null;
}

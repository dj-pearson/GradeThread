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
  // US-1561: which secret header value the Coolify task must send. Absent =
  // the shared default FLIPDESK_INTERNAL_JOB_SECRET; the drip/content/
  // newsletter ticks each authenticate with their own env var.
  secretEnv?: string;
  // US-1561: what a HEALTHY (possibly idle) run returns, for the operator
  // clicking Run Now. Absent = the family default: 200 with `{"ok":true,...}`
  // where an idle run reports skipped/zero counts.
  healthy?: string;
  // US-1561: one-off-at-launch backfills — run once (safe to re-run), then
  // the schedule may be removed/disabled once the backlog reads zero.
  oneOff?: boolean;
}

/** US-1561: the shared default secret env var (see CronDef.secretEnv). */
export const DEFAULT_JOB_SECRET_ENV = "FLIPDESK_INTERNAL_JOB_SECRET";

export const CRON_REGISTRY: CronDef[] = [
  // /api/jobs/* family — captured by the cron_runs middleware.
  { name: "reprice-scan", label: "Repricing scan", schedule: "0 */6 * * *", category: "repricing", endpoint: "/api/jobs/reprice-scan", recorded: true },
  { name: "reprice-rules", label: "Repricing rules", schedule: "0 */6 * * *", category: "repricing", endpoint: "/api/jobs/reprice-rules", recorded: true },
  { name: "automation-rules", label: "Listing automation rules", schedule: "0 * * * *", category: "listings", endpoint: "/api/jobs/automation-rules", recorded: true },
  { name: "autolister-reclaim", label: "AutoLister reclaim", schedule: "*/5 * * * *", category: "autolister", endpoint: "/api/jobs/autolister-reclaim", recorded: true },
  { name: "publish-batch-reclaim", label: "Publish-batch reclaim", schedule: "*/5 * * * *", category: "publish", endpoint: "/api/jobs/publish-batch-reclaim", recorded: true },
  // US-1790: B2B batch-grading reclaim — resumes stale grading batches.
  { name: "grading-batch-reclaim", label: "Grading-batch reclaim", schedule: "*/5 * * * *", category: "grading", endpoint: "/api/jobs/grading-batch-reclaim", recorded: true },
  { name: "grading-monitor", label: "Grading regression monitor", schedule: "0 */12 * * *", category: "grading", endpoint: "/api/jobs/grading-monitor", recorded: true },
  // US-1773: cross-garment durability aggregation (daily) backing the public durability rankings.
  { name: "durability-aggregate", label: "Durability aggregation", schedule: "0 2 * * *", category: "grading", endpoint: "/api/jobs/durability-aggregate", recorded: true },
  // US-1557: weekly per-category review-threshold calibration (shadow-first).
  { name: "confidence-calibration", label: "Confidence calibration", schedule: "0 13 * * 0", category: "grading", endpoint: "/api/jobs/confidence-calibration", recorded: true },
  { name: "stuck-submissions", label: "Stuck-submission recovery", schedule: "*/10 * * * *", category: "grading", endpoint: "/api/jobs/stuck-submissions", recorded: true },
  { name: "push-token-prune", label: "Push-token prune", schedule: "0 3 * * *", category: "maintenance", endpoint: "/api/jobs/push-token-prune", recorded: true },
  { name: "sync-reaper", label: "eBay sync reaper", schedule: "*/15 * * * *", category: "sync", endpoint: "/api/jobs/sync-reaper", recorded: true },
  { name: "email-retry", label: "Email outbox retry", schedule: "*/5 * * * *", category: "email", endpoint: "/api/jobs/email-retry", recorded: true },
  { name: "integrity-scan", label: "DB integrity scan", schedule: "0 7 * * *", category: "maintenance", endpoint: "/api/jobs/integrity-scan", recorded: true },
  { name: "data-retention", label: "Data-retention purge", schedule: "0 4 * * *", category: "maintenance", endpoint: "/api/jobs/data-retention", recorded: true },
  // US-2004: the watcher that watches the watchers — alerts when any recorded
  // job below has missed its schedule. Hourly: frequent enough that a stalled
  // payout/retention job is caught the same day, cheap enough to be free.
  { name: "cron-fleet-health", label: "Cron fleet health", schedule: "17 * * * *", category: "maintenance", endpoint: "/api/jobs/cron-fleet-health", recorded: true },
  { name: "condition-index-refresh", label: "Condition Index refresh", schedule: "0 8 * * *", category: "content", endpoint: "/api/jobs/condition-index-refresh", recorded: true },
  // US-1746: propose new Value/Condition Index seeds from graded demand (weekly; off until enabled in settings).
  { name: "condition-index-seedgen", label: "Condition Index seed generation", schedule: "0 9 * * 1", category: "content", endpoint: "/api/jobs/condition-index-seedgen", recorded: true },
  { name: "trial-expiry", label: "Trial-expiry downgrade", schedule: "15 0 * * *", category: "billing", endpoint: "/api/jobs/trial-expiry", recorded: true },
  // US-1112: consignor auto-payout sweep — pay each consignor their share when a consigned item sells.
  { name: "consignor-payouts", label: "Consignor auto-payouts", schedule: "*/30 * * * *", category: "flipdesk", endpoint: "/api/jobs/consignor-payouts", recorded: true },
  // US-1295: affiliate auto-payout sweep — accrue affiliate conversions + pay eligible balances over Stripe Connect.
  { name: "affiliate-payouts", label: "Affiliate auto-payouts", schedule: "15 */6 * * *", category: "growth", endpoint: "/api/jobs/affiliate-payouts", recorded: true },
  { name: "agent-tick", label: "Agentic OS agent tick", schedule: "*/10 * * * *", category: "agents", endpoint: "/api/jobs/agent-tick", recorded: true },
  { name: "operator-brief", label: "Daily operator brief", schedule: "0 13 * * *", category: "agents", endpoint: "/api/jobs/operator-brief", recorded: true },
  // US-1607: weekly agent-eval golden-scenario gate (writes agents.eval_pass /
  // eval_results). Registered here so the cron-drift guard stays green — the
  // route (main.ts) shipped in d62b9bb3 without a registry entry.
  { name: "agent-eval", label: "Weekly agent-eval gate", schedule: "0 15 * * 0", category: "agents", endpoint: "/api/jobs/agent-eval", recorded: true },
  // US-929: daily lifecycle email-journey tick (welcome / trial-nurture / win-back).
  { name: "journey-tick", label: "Lifecycle email-journey tick", schedule: "30 13 * * *", category: "growth", endpoint: "/api/jobs/journey-tick", recorded: true },
  // US-928: daily newsletter self-tuning — recompute topic/subject/send-hour weights from engagement.
  { name: "newsletter-tuning", label: "Newsletter self-tuning", schedule: "45 12 * * *", category: "growth", endpoint: "/api/jobs/newsletter-tuning", recorded: true },
  // US-917: weekly evergreen topic-bank refill — top the email topic bank up toward target when low.
  { name: "newsletter-topic-bank-refill", label: "Newsletter topic-bank refill", schedule: "0 5 * * 1", category: "growth", endpoint: "/api/jobs/newsletter-topic-bank-refill", recorded: true },
  // US-927: finalize A/B subject tests whose measurement window elapsed (pick winner → send remainder).
  { name: "newsletter-ab-finalize", label: "Newsletter A/B finalize", schedule: "*/15 * * * *", category: "growth", endpoint: "/api/jobs/newsletter-ab-finalize", recorded: true },
  // US-926: weekly dispatch — assign send windows + release due issues (cadence guard + send-time optimization). Hourly so STO can stagger.
  { name: "newsletter-dispatch", label: "Newsletter weekly dispatch", schedule: "0 * * * *", category: "growth", endpoint: "/api/jobs/newsletter-dispatch", recorded: true },
  { name: "abuse-scan", label: "Abuse-signal scan", schedule: "0 */6 * * *", category: "safety", endpoint: "/api/jobs/abuse-scan", recorded: true },
  // US-1124: Garment Passport backfill/repair — seed passports for grade_reports left NULL by the live-seed race window.
  { name: "passport-backfill", label: "Garment Passport backfill", schedule: "*/15 * * * *", category: "maintenance", endpoint: "/api/jobs/passport-backfill", recorded: true, oneOff: true },
  { name: "listing-prompt-promote", label: "Listing-prompt auto-promote", schedule: "0 9 * * *", category: "grading", endpoint: "/api/jobs/listing-prompt-promote", recorded: true },
  { name: "ebay-pending-webhooks", label: "eBay parked-webhook drain", schedule: "*/15 * * * *", category: "sync", endpoint: "/api/jobs/ebay-pending-webhooks", recorded: true },
  // US-1965: order-sync backstop — sweeps the stalest active eBay connections
  // and fires the incremental idempotent order pull, so a dropped/unsubscribed
  // notification never becomes a permanently missing sale. Reuses the per-tenant
  // sync lock + idempotent ingest, so it composes with the webhook path.
  { name: "ebay-order-backstop", label: "eBay order-sync backstop", schedule: "*/30 * * * *", category: "sync", endpoint: "/api/jobs/ebay-order-backstop", recorded: true, healthy: "200 with {ok:true, candidates, started, alreadyRunning, ...}; started/candidates can be 0 when every connection synced recently" },
  // US-1964: re-asserts the app-level eBay Notification API destinations +
  // topic subscriptions and warns on any required topic left unsubscribed. A
  // healthy config is a no-op, so this runs infrequently — it's drift detection.
  { name: "ebay-notification-reconcile", label: "eBay notification reconcile", schedule: "17 */6 * * *", category: "sync", endpoint: "/api/jobs/ebay-notification-reconcile", recorded: true, healthy: "200 with {ok:true, healthy:true, missingBuckets:[]}; created/enabled empty on a steady-state run" },
  { name: "gsc-sync", label: "Search Console sync", schedule: "30 6 * * *", category: "seo", endpoint: "/api/jobs/gsc-sync", recorded: true },
  { name: "growth-dispatch", label: "Scheduled-campaign dispatch", schedule: "*/15 * * * *", category: "growth", endpoint: "/api/jobs/growth-dispatch", recorded: true },
  { name: "north-star-digest", label: "North Star weekly digest", schedule: "0 14 * * 1", category: "growth", endpoint: "/api/jobs/north-star-digest", recorded: true },
  // US-1803: buyer notification digest — daily run; weekly-mode buyers flushed on Mondays.
  { name: "buyer-digest", label: "Buyer notification digest", schedule: "0 13 * * *", category: "buyer", endpoint: "/api/jobs/buyer-digest", recorded: true },
  { name: "condition-alerts", label: "Buyer condition-alerts matching", schedule: "*/15 * * * *", category: "buyer", endpoint: "/api/jobs/condition-alerts", recorded: true },
  // US-943: served under /api/drip/* (own auth) but records to cron_runs itself.
  { name: "drip-tick", label: "Trial-drip orchestration tick", schedule: "0 * * * *", category: "growth", endpoint: "/api/drip/tick", recorded: true, secretEnv: "DRIP_INTERNAL_JOB_SECRET" },
  // US-923: the ONE external trigger that kicks off the autonomous newsletter run.
  // Served under /api/newsletter/scheduler/* (own auth); records to cron_runs itself.
  // Hourly so it self-gates on cadence and the Make schedule stays simple.
  { name: "newsletter-kickoff", label: "Newsletter kickoff trigger", schedule: "0 * * * *", category: "growth", endpoint: "/api/newsletter/scheduler/tick", recorded: true, secretEnv: "NEWSLETTER_INTERNAL_JOB_SECRET" },
  // ── US-1561: previously-undocumented /api/jobs/* crons ─────────────────────
  // US-1064: AI spend guardrails — pause AI features when budget ceilings hit.
  { name: "ai-budget-guardrails", label: "AI budget guardrails", schedule: "*/15 * * * *", category: "ops", endpoint: "/api/jobs/ai-budget-guardrails", recorded: true },
  // US-811: App Store expiry backstop — lapse appstore-billed users whose Apple
  // expiry notification was lost (72h grace on stale period_end).
  { name: "appstore-expiry-sweep", label: "App Store expiry sweep", schedule: "45 1 * * *", category: "billing", endpoint: "/api/jobs/appstore-expiry-sweep", recorded: true },
  { name: "googleplay-expiry-sweep", label: "Google Play expiry sweep", schedule: "50 1 * * *", category: "billing", endpoint: "/api/jobs/googleplay-expiry-sweep", recorded: true },
  // US-1145: hourly audit-log anomaly scan (impossible travel, burst actions).
  { name: "audit-anomaly-scan", label: "Audit anomaly scan", schedule: "5 * * * *", category: "safety", endpoint: "/api/jobs/audit-anomaly-scan", recorded: true },
  // US-893: Stripe-vs-DB reconciliation — precompute divergences for the admin console.
  { name: "billing-reconciliation", label: "Billing reconciliation", schedule: "0 5 * * *", category: "billing", endpoint: "/api/jobs/billing-reconciliation", recorded: true },
  // US-1822: buyer guarantee claims-pool accrual (once/period) + claim↔drawdown reconciliation.
  { name: "guarantee-pool", label: "Guarantee pool accrual + reconcile", schedule: "0 4 * * *", category: "billing", endpoint: "/api/jobs/guarantee-pool", recorded: true },
  // US-1827: recompute Connoisseur portfolios + fire value-peak / significant-move alerts.
  { name: "portfolio-alerts", label: "Portfolio value alerts", schedule: "0 7 * * *", category: "buyer", endpoint: "/api/jobs/portfolio-alerts", recorded: true },
  // US-1832: re-match active demand-board wants + notify buyer/seller on new matches.
  { name: "demand-matches", label: "Demand-board match notifications", schedule: "30 */6 * * *", category: "buyer", endpoint: "/api/jobs/demand-matches", recorded: true },
  // Seals legacy certificates into the integrity chain. ONE-OFF at launch;
  // idempotent, safe to re-run; disable once the backlog reads zero.
  { name: "cert-integrity-backfill", label: "Cert-integrity backfill", schedule: "0 6 * * *", category: "maintenance", endpoint: "/api/jobs/cert-integrity-backfill", recorded: true, oneOff: true },
  // US-877: daily content freshness pass (stale posts re-dated/refreshed).
  { name: "content-refresh", label: "Content freshness refresh", schedule: "30 4 * * *", category: "content", endpoint: "/api/jobs/content-refresh", recorded: true },
  // US-875: content-system watchdog — flags stalled autonomous content runs.
  { name: "content-watchdog", label: "Content watchdog", schedule: "0 */3 * * *", category: "content", endpoint: "/api/jobs/content-watchdog", recorded: true },
  // US-1535: weekly few-shot exemplar assembly + eval (learnings loop).
  { name: "exemplar-assembly", label: "Grading exemplar assembly", schedule: "0 12 * * 0", category: "grading", endpoint: "/api/jobs/exemplar-assembly", recorded: true },
  // US-1072: weekly keyword-research ingestion (no-ops without Google Ads env).
  { name: "keyword-research", label: "Keyword research ingest", schedule: "0 6 * * 1", category: "seo", endpoint: "/api/jobs/keyword-research", recorded: true },
  // US-1698: daily Ads Command Center sync — structure + last-30-days metrics
  // (no-ops without Google Ads env).
  { name: "ads-sync", label: "Google Ads sync", schedule: "0 8 * * *", category: "ads", endpoint: "/api/jobs/ads-sync", recorded: true },
  // US-1704: daily offline conversion upload (no-ops without Google Ads env).
  { name: "ads-conversions-upload", label: "Google Ads conversion upload", schedule: "30 8 * * *", category: "ads", endpoint: "/api/jobs/ads-conversions-upload", recorded: true },
  // US-1055: poll open offers/messages per connection → seller notifications.
  { name: "marketplace-events", label: "Marketplace event notifications", schedule: "*/15 * * * *", category: "sync", endpoint: "/api/jobs/marketplace-events", recorded: true },
  // US-1150: passport-chain integrity scan (tamper evidence sweep).
  { name: "passport-integrity-scan", label: "Passport integrity scan", schedule: "0 */6 * * *", category: "maintenance", endpoint: "/api/jobs/passport-integrity-scan", recorded: true },
  // US-1518: item-photo thumbnail backfill — drain-to-zero, then keeps up with
  // new iOS uploads; cheap when idle.
  { name: "thumbnail-backfill", label: "Photo thumbnail backfill", schedule: "*/5 * * * *", category: "maintenance", endpoint: "/api/jobs/thumbnail-backfill", recorded: true },
  // Served under /api/flipdesk/* — not in the ledger (next-run still computed).
  { name: "ebay-token-refresh", label: "eBay token refresh", schedule: "0 * * * *", category: "sync", endpoint: "/api/flipdesk/ebay/oauth/refresh", recorded: false },
  { name: "ebay-orders-sync", label: "eBay listings/orders sync", schedule: "*/30 * * * *", category: "sync", endpoint: "/api/flipdesk/ebay/listings/pull", recorded: false },
  // US-1645: recorded via the eBay-cron recorder (cronNameForPath) so a missed
  // run signals in the cron_runs ledger.
  { name: "ebay-performance-sync", label: "eBay performance sync", schedule: "0 */6 * * *", category: "sync", endpoint: "/api/flipdesk/ebay/sync/performance", recorded: true },
  { name: "ebay-publish-due", label: "Scheduled publish-due", schedule: "*/5 * * * *", category: "publish", endpoint: "/api/flipdesk/ebay/jobs/publish-due", recorded: true },
  // Recorded via recordEbayCron mounted on the sync/push path (cronNameForPath),
  // so a missed/failed 5-min sheet sync signals in the cron_runs ledger + ops stream.
  { name: "google-sheet-sync", label: "Google Sheet sync", schedule: "*/5 * * * *", category: "sync", endpoint: "/api/flipdesk/google/sync/push", recorded: true },
  // Nightly photo archive sweep (cold-storage old originals).
  { name: "photo-archive", label: "Photo archive sweep", schedule: "0 4 * * *", category: "maintenance", endpoint: "/api/flipdesk/images/archive", recorded: false },
  // Payout reconciliation sweep (auto-link payout rows to sales).
  { name: "reconciliation-sweep", label: "Payout reconciliation sweep", schedule: "0 5 * * *", category: "flipdesk", endpoint: "/api/flipdesk/reconciliation/run", recorded: false },
  // US-1047: auto leave-feedback (no-op unless system setting feedback.auto_leave).
  { name: "ebay-leave-feedback", label: "eBay auto leave-feedback", schedule: "0 10 * * *", category: "sync", endpoint: "/api/flipdesk/ebay/jobs/leave-feedback", recorded: true, healthy: "200; no-op unless system setting feedback.auto_leave=true" },
  // US-561: promoted-listings performance sync.
  { name: "ebay-promoted-sync", label: "eBay promoted-listings sync", schedule: "0 */6 * * *", category: "sync", endpoint: "/api/flipdesk/ebay/jobs/promoted-sync", recorded: true },
  // US-852: autonomous content tick — its OWN secret; idle returns skipped:true.
  { name: "content-tick", label: "Content scheduler tick", schedule: "0 * * * *", category: "content", endpoint: "/api/content/scheduler/tick", recorded: false, secretEnv: "CONTENT_INTERNAL_JOB_SECRET", healthy: "200 with skipped:true when idle (cadence gate) — NOT ok:true" },
  // US-882: weekly content digest email to admins.
  { name: "content-digest", label: "Content weekly digest", schedule: "0 14 * * 1", category: "content", endpoint: "/api/content/scheduler/digest", recorded: false, secretEnv: "CONTENT_INTERNAL_JOB_SECRET" },
  // US-1870: nightly Inventory Equity snapshot → the equity-over-time trend.
  { name: "equity-snapshot", label: "Inventory Equity snapshot", schedule: "15 5 * * *", category: "flipdesk", endpoint: "/api/jobs/equity-snapshot", recorded: true },
];

// US-1645: resolve a request path to its CRON_REGISTRY job name (by exact
// endpoint), or null when the path isn't a recorded cron. The /api/jobs/*
// recorder derives the name from the last path segment, but crons served
// elsewhere (the eBay crons under /api/flipdesk/ebay/*) have a name that differs
// from their last segment ("ebay-publish-due" vs ".../publish-due"), so their
// recorder resolves the canonical registry name through this.
export function cronNameForPath(path: string): string | null {
  const clean = path.replace(/\/+$/, "");
  const def = CRON_REGISTRY.find((d) => d.recorded && d.endpoint === clean);
  return def ? def.name : null;
}

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

// ── US-1561: canonical doc rendering ─────────────────────────────────
//
// COOLIFY.md and LAUNCH_CHECKLIST.md embed this exact rendering between
// `<!-- cron-registry:start -->` / `<!-- cron-registry:end -->` markers; the
// drift test (cron-registry-drift_test.ts) regenerates it and fails when the
// docs diverge from the registry. Update the registry, re-run
// `deno run scripts/render-cron-docs.ts`, paste — never hand-edit the table.

/** Markdown table of every scheduled job, generated from CRON_REGISTRY. */
export function renderCronDocs(): string {
  const lines: string[] = [
    "| Task | Schedule (UTC) | Endpoint (POST) | Secret env | Notes |",
    "|---|---|---|---|---|",
  ];
  const sorted = [...CRON_REGISTRY].sort((a, b) => a.name.localeCompare(b.name));
  for (const def of sorted) {
    const secret = def.secretEnv ?? DEFAULT_JOB_SECRET_ENV;
    const notes: string[] = [];
    if (def.oneOff) notes.push("ONE-OFF at launch (idempotent; disable once drained)");
    if (def.healthy) notes.push(def.healthy);
    if (!def.recorded) notes.push("not in the cron_runs ledger");
    lines.push(
      `| ${def.name} | \`${def.schedule}\` | \`${def.endpoint}\` | \`$${secret}\` | ${notes.join("; ")} |`,
    );
  }
  lines.push(
    "",
    `_${sorted.length} scheduled jobs. Default healthy response: 200 \`{"ok":true,...}\` (idle runs report skipped/zero counts). Generated from \`src/lib/cron-runs.ts\` CRON_REGISTRY — do not hand-edit._`,
  );
  return lines.join("\n");
}

/**
 * Copy-paste setup blocks — one numbered entry per scheduled job — for the
 * one-time Coolify registration run-down (CRON_SETUP.md embeds this between the
 * `<!-- cron-setup:start/end -->` markers; the drift test regenerates it). Every
 * task's Container is the edge-functions service and its Name is the heading, so
 * the only per-task fields to paste are Frequency + Command.
 */
export function renderCronSetupGuide(): string {
  const sorted = [...CRON_REGISTRY].sort((a, b) => a.name.localeCompare(b.name));
  const blocks: string[] = [];
  sorted.forEach((def, i) => {
    const secret = def.secretEnv ?? DEFAULT_JOB_SECRET_ENV;
    const notes: string[] = [];
    if (def.oneOff) notes.push("ONE-OFF at launch (idempotent; disable once drained)");
    if (def.healthy) notes.push(def.healthy);
    const cmd = `curl -fsS -X POST -H "X-Internal-Job-Secret: $${secret}" http://localhost:8787${def.endpoint}`;
    blocks.push(
      `### ${i + 1}. ${def.name}`,
      `**Frequency:** \`${def.schedule}\`${notes.length ? `  ·  _${notes.join("; ")}_` : ""}`,
      "",
      "```bash",
      cmd,
      "```",
      "",
    );
  });
  return blocks.join("\n").trimEnd();
}


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
// path segment (what the middleware records).
//
// `recorded: false` means cron-fleet-health CANNOT SEE THE JOB AT ALL — no
// ledger row, so a task that was never created in Coolify and a task that died
// look identical, which is the failure the fleet alert exists to catch. Treat it
// as a gap to close, not a category (US-2616/US-2617).
//
// It used to be the default for anything served outside /api/jobs/*, described
// as "the ledger doesn't capture them today". That was a statement about where
// the recorder was MOUNTED rather than about what was possible: main.ts applies
// recordEbayCron by path, and it keys on the internal-job header rather than on
// which secret validates it — so a mount was all most of them needed.
//
// What genuinely still cannot be recorded, and why:
//   • oneOff backfills — no cadence to miss. That is the whole list now.
//
// US-2310's three unreachable crons all left this set in US-2617, and the three
// needed three different answers, which is the reason to check before fixing:
// ebay-orders-sync was DELETED (ebay-order-backstop was already the working
// version of the same sweep), while photo-archive and reconciliation-sweep each
// got the /jobs/ route + fleet loop they actually needed. Look for the job that
// already does it, then write the loop.

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
  // US-2272: re-render the frozen verified-seller credential block on live eBay
  // listings of graded items. Daily is the right cadence — the block only moves
  // when the seller's grade count/average moves, and a revise is an eBay write.
  { name: "credentials-refresh", label: "Seller-credential refresh", schedule: "40 5 * * *", category: "listings", endpoint: "/api/jobs/credentials-refresh", recorded: true, healthy: "200 with {ok:true, revised, up_to_date, capped:false}; revised is 0 on a steady-state run" },
  { name: "autolister-reclaim", label: "AutoLister reclaim", schedule: "*/5 * * * *", category: "autolister", endpoint: "/api/jobs/autolister-reclaim", recorded: true },
  { name: "publish-batch-reclaim", label: "Publish-batch reclaim", schedule: "*/5 * * * *", category: "publish", endpoint: "/api/jobs/publish-batch-reclaim", recorded: true },
  // US-1790: B2B batch-grading reclaim — resumes stale grading batches.
  { name: "grading-batch-reclaim", label: "Grading-batch reclaim", schedule: "*/5 * * * *", category: "grading", endpoint: "/api/jobs/grading-batch-reclaim", recorded: true },
  // US-2518: CSV inventory-import reclaim — resumes a run whose worker died, so
  // a closed tab or a redeploy never strands a half-imported catalog.
  { name: "flipdesk-import-reclaim", label: "CSV import reclaim", schedule: "*/5 * * * *", category: "maintenance", endpoint: "/api/jobs/flipdesk-import-reclaim", recorded: true },
  { name: "grading-monitor", label: "Grading regression monitor", schedule: "0 */12 * * *", category: "grading", endpoint: "/api/jobs/grading-monitor", recorded: true },
  // US-2035: weekly by design — it costs vision calls per sample, and reproducibility
  // moves with a model or prompt change rather than hourly. No-ops unless sampling is on.
  { name: "grading-self-consistency", label: "Regrade reproducibility sample", schedule: "20 4 * * 1", category: "grading", endpoint: "/api/jobs/grading-self-consistency", recorded: true },
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
  // US-2845: read comp listings for condition, most-demanded cells first.
  // Hourly is the cadence the demand queue can actually feed: eight cells at up
  // to twelve reads is the batch, and a shorter tick would spend the daily
  // budget before lunch. INERT until the `comp_read` feature flag is enabled,
  // which waits on the US-2842 calibration spike.
  { name: "comp-read", label: "Comp condition reads", schedule: "25 * * * *", category: "content", endpoint: "/api/jobs/comp-read", recorded: true, healthy: "200 with {ok:true, skipped:true, reason:\"comp_read feature flag is off\"} until the flag is enabled — it ships OFF pending the US-2842 spike. Also skips on a breached comp_read budget." },
  // The reclaim half. Every durable queue needs one or a dead worker strands
  // its cells forever; runs more often than the batch it repairs.
  { name: "comp-read-reclaim", label: "Comp read reclaim", schedule: "*/10 * * * *", category: "content", endpoint: "/api/jobs/comp-read-reclaim", recorded: true, healthy: "200 with {ok:true, requeued:0, failed:0} on a healthy queue. Runs whether or not the flag is on: a queue left by a disabled worker still needs draining." },
  { name: "trial-expiry", label: "Trial-expiry downgrade", schedule: "15 0 * * *", category: "billing", endpoint: "/api/jobs/trial-expiry", recorded: true },
  // US-1112: consignor auto-payout sweep — pay each consignor their share when a consigned item sells.
  { name: "consignor-payouts", label: "Consignor auto-payouts", schedule: "*/30 * * * *", category: "flipdesk", endpoint: "/api/jobs/consignor-payouts", recorded: true },
  // US-2228 AC3: copy each monthly recurring expense forward. Daily and early,
  // so the entry is in the seller's books the morning it is due. Re-running is
  // free — a partial unique index makes a duplicate month impossible.
  { name: "expense-recurrence", label: "Recurring expense sweep", schedule: "20 5 * * *", category: "flipdesk", endpoint: "/api/jobs/expense-recurrence", recorded: true },
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
  // US-1859: re-engagement nudges (streak-at-risk / near-miss / quests /
  // expiring rewards) + the attribution pass that scores the sent AND holdout
  // arms. Daily, mid-afternoon UTC — one pass a day is well inside the engine's
  // own per-user frequency cap, so a busier schedule would only re-derive the
  // same refusals.
  // US-2972: pipeline-XP sweep. Queue is user_reward_state.last_pipeline_sweep_at
  // ascending nulls-first, 200 sellers per run, so successive runs cover everyone.
  { name: "rewards-sweep", label: "Pipeline XP sweep", schedule: "30 6 * * *", category: "growth", endpoint: "/api/jobs/rewards-sweep", recorded: true, healthy: "200 with {ok:true, queued, swept, marksGranted, xpAdded, leveledUp, failed}; marksGranted settles near 0 once the backfill has drained" },
  { name: "reward-nudges", label: "Reward re-engagement nudges", schedule: "0 15 * * *", category: "growth", endpoint: "/api/jobs/reward-nudges", recorded: true, healthy: "200 with {ok:true, evaluated, sent, holdout, skipped, scanned, converted}; sent can be 0 — most evaluated users are frequency-capped or have no true candidate" },
  // US-1863: Thrift Radar — recompute venue x window x brand aggregates from the
  // de-identified scan events, publish only what clears the k-anonymity floor,
  // then retire raw events past the retention window into the month archive.
  // Hourly: the whole aggregate set is rebuilt each run (idempotent), and the
  // freshness signal the map sells is only as good as the last recompute.
  { name: "radar-aggregate", label: "Thrift Radar aggregation", schedule: "20 * * * *", category: "maintenance", endpoint: "/api/jobs/radar-aggregate", recorded: true, healthy: "200 with {ok:true, events, venues, aggregates, suppressed, removed, kFloor, pruned}; suppressed > 0 is NORMAL and means the k-anonymity floor withheld those venues" },
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
  // US-2617: RECORDED as of 2026-08-15. It was `recorded: false` with the note
  // "served under /api/flipdesk/* — not in the ledger", which described where it
  // lives rather than a reason it could not be seen. The handler already gates
  // on requireJobSecret (flipdesk-ebay.ts:633), so it was reachable as a cron
  // the whole time; the only thing missing was the recordEbayCron mount, which
  // main.ts applies by path.
  //
  // Worth the change because of what this job IS: if the hourly refresh stops,
  // seller eBay tokens expire and their listings stop syncing — a silent
  // failure, and exactly the blast radius jobs-cron-fleet.ts names as the
  // reason the fleet alert exists. It was one of eight registry entries the
  // monitor never examined (US-2616).
  { name: "ebay-token-refresh", label: "eBay token refresh", schedule: "0 * * * *", category: "sync", endpoint: "/api/flipdesk/ebay/oauth/refresh", recorded: true },
  // ebay-orders-sync WAS HERE, and US-2617 deleted it rather than fixing it.
  //
  // It pointed at /api/flipdesk/ebay/listings/pull, a SELLER route that reads
  // workspaceOwnerId ?? userId from the JWT, so a scheduler holding only the job
  // secret 401'd before the handler ran — every 30 minutes, invisibly, since
  // recorded:false meant no ledger row either (US-2310).
  //
  // The reason it is a DELETE and not a new /jobs/ route: ebay-order-backstop
  // (US-1965, above) is already that route. Same */30 cadence, same
  // triggerEbaySyncForUser per owner, plus a freshness window and a unit-tested
  // stalest-first selector. So the fleet sync has been running correctly the
  // whole time and this entry described a second, permanently-401ing copy of it.
  // Building the /jobs/orders-sync route it was asking for would have shipped a
  // duplicate sweep against one eBay rate-limit bucket.
  //
  // ⚠️ OPERATOR: DELETE the Coolify scheduled task named ebay-orders-sync. It has
  // never succeeded, and leaving it costs a 401 every 30 minutes forever.
  // US-1645: recorded via the eBay-cron recorder (cronNameForPath) so a missed
  // run signals in the cron_runs ledger.
  { name: "ebay-performance-sync", label: "eBay performance sync", schedule: "0 */6 * * *", category: "sync", endpoint: "/api/flipdesk/ebay/sync/performance", recorded: true },
  // US-2683: eBay's own buyer search terms, from the Promoted Listings reports.
  // Daily, because the reports cover a 30-day window and eBay regenerates them
  // on its own clock — a tighter cadence re-downloads the same numbers. A
  // healthy run is usually mostly no_campaign: the report only exists for a
  // seller running Priority, and most are not.
  { name: "ebay-search-terms", label: "eBay search-term ingest", schedule: "25 6 * * *", category: "sync", endpoint: "/api/jobs/ebay-search-terms", recorded: true, healthy: "200 with {ok:true, owners, stored, no_campaign, ...}; owners is 0 on an account with no Priority campaigns" },
  // US-2690: learn what the market calls the style codes we have seen. Hourly is
  // the cadence the budget implies, not an urgency claim — the backlog is finite
  // and shrinks every tick, and a faster clock would only spend the same shared
  // eBay allowance the Add flow and the comps ladder draw on.
  { name: "style-code-sweep", label: "Style-code index sweep", schedule: "35 * * * *", category: "sync", endpoint: "/api/jobs/style-code-sweep", recorded: true, healthy: "200 with {ok:true, considered, swept, deferred, learned, noHits}; swept is 0 once every known code is confirmed or cooling off" },
  // US-2784: the other direction — crawl a BRAND's live listings and keep the
  // codes sellers already typed into structured fields, so the index holds
  // garments nobody here has listed. Nightly and overnight: the budget is
  // shared with the Add flow, and a brand's inventory does not turn over fast
  // enough for a second pass the same day to reach anything new.
  { name: "style-code-discovery", label: "Style-code brand discovery", schedule: "10 3 * * *", category: "sync", endpoint: "/api/jobs/style-code-discovery", recorded: true, healthy: "200 with {ok:true, considered, crawled, deferred, scanned, inspected, declared, codes, newCodes, names}; newCodes falls toward 0 as a brand's pages are exhausted, and deferred is non-zero whenever more brands are eligible than the budget covers" },
  { name: "ebay-publish-due", label: "Scheduled publish-due", schedule: "*/5 * * * *", category: "publish", endpoint: "/api/flipdesk/ebay/jobs/publish-due", recorded: true },
  // Recorded via recordEbayCron mounted on the sync/push path (cronNameForPath),
  // so a missed/failed 5-min sheet sync signals in the cron_runs ledger + ops stream.
  { name: "google-sheet-sync", label: "Google Sheet sync", schedule: "*/5 * * * *", category: "sync", endpoint: "/api/flipdesk/google/sync/push", recorded: true },
  // Nightly photo archive sweep (cold-storage old originals).
  // ⚠️ THE ENDPOINT CHANGED (US-2617). This pointed at
  // /api/flipdesk/images/archive, a SELLER route behind authMiddleware, so the
  // Coolify task 401'd every night and left no ledger row (US-2310). Unlike
  // ebay-orders-sync there was no working equivalent to defer to, so it got the
  // /jobs/ route + fleet loop: routes/jobs-photo-archive.ts walks owners with
  // archivable photos and re-enters the per-owner archival for each.
  // The Coolify task URL must be updated or the job stays broken;
  // /api/flipdesk/images/archive is still the seller's own "Archive now".
  { name: "photo-archive", label: "Photo archive sweep", schedule: "0 4 * * *", category: "maintenance", endpoint: "/api/jobs/photo-archive", recorded: true, healthy: "200 {owners,eligible_owners,archived,freed_bytes,...}; skipped:true with reason r2_not_configured is healthy, and archived 0 is normal once the backlog drains" },
  // Payout reconciliation sweep (auto-link payout rows to sales).
  // ⚠️ THE ENDPOINT CHANGED (US-2617), the last of the three US-2310 found.
  // This pointed at /api/flipdesk/reconciliation/run, a SELLER route, so the
  // nightly task 401'd and left no ledger row. Checked for an existing
  // equivalent first (guarantee-pool and ebay-notification-reconcile both
  // reconcile something else entirely) and then wrote the loop:
  // routes/jobs-reconciliation-sweep.ts. The Coolify task URL must be updated;
  // /api/flipdesk/reconciliation/run is still the seller's own "Auto-match".
  { name: "reconciliation-sweep", label: "Payout reconciliation sweep", schedule: "0 5 * * *", category: "flipdesk", endpoint: "/api/jobs/reconciliation-sweep", recorded: true, healthy: "200 {owners,eligible_owners,auto_matched,ambiguous,...}; ambiguous is not an error — those rows are queued for the seller on purpose" },
  // US-1047: auto leave-feedback (no-op unless system setting feedback.auto_leave).
  { name: "ebay-leave-feedback", label: "eBay auto leave-feedback", schedule: "0 10 * * *", category: "sync", endpoint: "/api/flipdesk/ebay/jobs/leave-feedback", recorded: true, healthy: "200; no-op unless system setting feedback.auto_leave=true" },
  // US-561: promoted-listings performance sync.
  { name: "ebay-promoted-sync", label: "eBay promoted-listings sync", schedule: "0 */6 * * *", category: "sync", endpoint: "/api/flipdesk/ebay/jobs/promoted-sync", recorded: true },
  // US-852: autonomous content tick — its OWN secret; idle returns skipped:true.
  { name: "content-tick", label: "Content scheduler tick", schedule: "0 * * * *", category: "content", endpoint: "/api/content/scheduler/tick", recorded: true, secretEnv: "CONTENT_INTERNAL_JOB_SECRET", healthy: "200 with skipped:true when idle (cadence gate) — NOT ok:true" },
  // US-882: weekly content digest email to admins.
  { name: "content-digest", label: "Content weekly digest", schedule: "0 14 * * 1", category: "content", endpoint: "/api/content/scheduler/digest", recorded: true, secretEnv: "CONTENT_INTERNAL_JOB_SECRET" },
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
// COOLIFY.md and vault/10-ops/launch-checklist.md embed this exact rendering between
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


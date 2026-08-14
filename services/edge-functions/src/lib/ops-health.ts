// US-883: System health & infrastructure dashboard — pure logic.
//
// The system_health() RPC (migration 00207) returns the raw numbers; this module
// turns them (plus tunable thresholds + edge runtime info) into the green/amber/
// red status tiles the dashboard renders. Kept pure (no I/O) so it's unit-tested
// without a DB — the route (routes/admin-ops.ts GET /health) does the I/O and
// hands the payload here.

// Process start anchor — captured once at module import for an uptime figure.
export const PROCESS_STARTED_AT_MS = Date.now();

export type HealthStatus = "green" | "amber" | "red" | "unknown";

export interface ThresholdBand {
  amber: number;
  red: number;
}

export interface HealthThresholds {
  webhookDlqOpen: ThresholdBand;
  emailDlqOpen: ThresholdBand;
  disputesOpen: ThresholdBand;
  reviewsOpen: ThresholdBand;
  jobFailures24h: ThresholdBand;
  storagePct: ThresholdBand;
  storageBytesCapGb: number;
  slowestJobMs: ThresholdBand;
  pipelineBacklog: ThresholdBand;
}

// Sensible defaults applied when the system_settings row is missing or partial,
// so a deleted/empty registry row degrades to "still colors tiles" rather than
// "everything green / no thresholds".
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  webhookDlqOpen: { amber: 1, red: 25 },
  emailDlqOpen: { amber: 1, red: 25 },
  disputesOpen: { amber: 5, red: 20 },
  reviewsOpen: { amber: 10, red: 50 },
  jobFailures24h: { amber: 1, red: 10 },
  storagePct: { amber: 70, red: 90 },
  storageBytesCapGb: 50,
  slowestJobMs: { amber: 30_000, red: 120_000 },
  pipelineBacklog: { amber: 5, red: 25 },
};

const GB = 1024 * 1024 * 1024;

export interface TableStat {
  name: string;
  rows: number;
  bytes: number;
}

export interface BucketStat {
  bucket: string;
  objects: number;
  bytes: number;
}

export interface SlowestJob {
  job: string;
  durationMs: number | null;
  status: string;
  at: string;
}

export interface DayPoint {
  day: string;
  count: number;
}

export interface HealthMetrics {
  tables: TableStat[];
  storage: { buckets: BucketStat[]; totalObjects: number; totalBytes: number };
  queues: {
    disputesOpen: number;
    reviewsOpen: number;
    webhookDlqOpen: number;
    emailDlqOpen: number;
  };
  jobs: { failuresLast24h: number; maxDurationMs: number; slowest: SlowestJob[] };
  // US-899: cross-tenant listing/AutoLister pipeline backlog. Optional — the
  // system_health() RPC doesn't return it; the /health route computes it and
  // attaches it before building the report, so older payloads degrade to 0.
  pipeline?: { backlog: number };
  // US-2565: is the credit ledger's append-only trigger present AND enabled?
  //
  // Same shape as `pipeline` and for the same reason: system_health() does not
  // return it, the /health route reads ledger_append_only_enforced() and
  // attaches it, and a payload without the field degrades to "unknown" rather
  // than to a false green. `null` is a THIRD state, not a synonym for false —
  // "we could not tell" and "the guard is gone" are different incidents and the
  // tile says which.
  ledgerAppendOnly?: boolean | null;
  trends: {
    jobFailuresByDay: DayPoint[];
    submissionErrorsByDay: Array<{ day: string; total: number; failed: number }>;
  };
  thresholds: Partial<Record<string, unknown>>;
  generatedAt: string;
}

export interface EdgeRuntime {
  uptimeSeconds: number;
  version: string;
  env: string;
  supabaseReachable: boolean;
  dbLatencyMs: number | null;
}

export interface HealthTile {
  key: string;
  label: string;
  status: HealthStatus;
  value: string;
  detail?: string;
  trend?: number[];
}

export interface HealthReport {
  overall: HealthStatus;
  tiles: HealthTile[];
  runtime: EdgeRuntime;
  metrics: HealthMetrics;
  thresholds: HealthThresholds;
  generatedAt: string;
}

// Higher value = worse. value >= red → red; >= amber → amber; else green.
// A non-finite value (no data) → "unknown".
export function classify(value: number | null | undefined, band: ThresholdBand): HealthStatus {
  if (value == null || !Number.isFinite(value)) return "unknown";
  if (value >= band.red) return "red";
  if (value >= band.amber) return "amber";
  return "green";
}

function band(raw: unknown, fallback: ThresholdBand): ThresholdBand {
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const amber = Number(o.amber);
    const red = Number(o.red);
    if (Number.isFinite(amber) && Number.isFinite(red)) return { amber, red };
  }
  return fallback;
}

// Merge a (possibly partial / untrusted) registry object over the defaults.
export function mergeThresholds(raw: Partial<Record<string, unknown>> | null | undefined): HealthThresholds {
  const r = (raw ?? {}) as Record<string, unknown>;
  const capGb = Number(r.storageBytesCapGb);
  return {
    webhookDlqOpen: band(r.webhookDlqOpen, DEFAULT_HEALTH_THRESHOLDS.webhookDlqOpen),
    emailDlqOpen: band(r.emailDlqOpen, DEFAULT_HEALTH_THRESHOLDS.emailDlqOpen),
    disputesOpen: band(r.disputesOpen, DEFAULT_HEALTH_THRESHOLDS.disputesOpen),
    reviewsOpen: band(r.reviewsOpen, DEFAULT_HEALTH_THRESHOLDS.reviewsOpen),
    jobFailures24h: band(r.jobFailures24h, DEFAULT_HEALTH_THRESHOLDS.jobFailures24h),
    storagePct: band(r.storagePct, DEFAULT_HEALTH_THRESHOLDS.storagePct),
    storageBytesCapGb:
      Number.isFinite(capGb) && capGb > 0 ? capGb : DEFAULT_HEALTH_THRESHOLDS.storageBytesCapGb,
    slowestJobMs: band(r.slowestJobMs, DEFAULT_HEALTH_THRESHOLDS.slowestJobMs),
    pipelineBacklog: band(r.pipelineBacklog, DEFAULT_HEALTH_THRESHOLDS.pipelineBacklog),
  };
}

export function storagePct(bytes: number, capGb: number): number {
  const cap = capGb * GB;
  if (!(cap > 0)) return 0;
  return (bytes / cap) * 100;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// "worst wins" — red beats amber beats green. "unknown" never worsens the
// overall (so a missing-data tile doesn't false-alarm the whole dashboard).
export function overallStatus(tiles: HealthTile[]): HealthStatus {
  let worst: HealthStatus = "green";
  for (const t of tiles) {
    if (t.status === "red") return "red";
    if (t.status === "amber") worst = "amber";
  }
  return worst;
}

/**
 * US-2565: is the credit ledger still immutable?
 *
 * The append-only trigger (migration 00597) is the only thing stopping an
 * UPDATE or DELETE on grade_credit_transactions, service_role included. A guard
 * nobody can see the state of is a guard that gets dropped during some future
 * incident and never restored — so this puts it on the dashboard, where "the
 * ledger is immutable" becomes a measurement rather than a belief.
 *
 * RED, not amber, when it is gone. This is the difference between a ledger that
 * is evidence in a dispute and one that is merely a log, and there is no partial
 * version of that.
 *
 * `null` is UNKNOWN and deliberately not red: before 00597 is applied the RPC
 * does not exist, and a deploy-order gap must not page anyone. "unknown" also
 * never worsens the overall status (see overallStatus), which is the right
 * behaviour for a fact we failed to read rather than one we read as bad.
 */
export function ledgerAppendOnlyTile(enforced: boolean | null | undefined): HealthTile {
  if (enforced === true) {
    return {
      key: "ledgerAppendOnly",
      label: "Ledger immutability",
      status: "green",
      value: "enforced",
      detail: "grade_credit_transactions rejects UPDATE/DELETE for every role",
    };
  }
  if (enforced === false) {
    return {
      key: "ledgerAppendOnly",
      label: "Ledger immutability",
      status: "red",
      value: "NOT enforced",
      detail:
        "the append-only trigger is missing or disabled — the credit ledger can " +
        "be rewritten. Re-apply migration 00597.",
    };
  }
  return {
    key: "ledgerAppendOnly",
    label: "Ledger immutability",
    status: "unknown",
    value: "unknown",
    detail: "ledger_append_only_enforced() did not answer (migration 00597 applied?)",
  };
}

// Build the full report from the RPC payload + runtime. Pure + total: tolerates
// missing fields (treats them as 0 / empty) so a partial payload never throws.
export function buildHealthReport(metrics: HealthMetrics, runtime: EdgeRuntime): HealthReport {
  const t = mergeThresholds(metrics.thresholds);
  const q = metrics.queues ?? { disputesOpen: 0, reviewsOpen: 0, webhookDlqOpen: 0, emailDlqOpen: 0 };
  const jobs = metrics.jobs ?? { failuresLast24h: 0, maxDurationMs: 0, slowest: [] };
  const storage = metrics.storage ?? { buckets: [], totalObjects: 0, totalBytes: 0 };
  const failuresTrend = (metrics.trends?.jobFailuresByDay ?? []).map((d) => d.count);
  const pipelineBacklog = metrics.pipeline?.backlog ?? 0;

  const pct = storagePct(storage.totalBytes, t.storageBytesCapGb);

  const tiles: HealthTile[] = [
    {
      key: "supabase",
      label: "Database",
      status: runtime.supabaseReachable ? "green" : "red",
      value: runtime.supabaseReachable ? "reachable" : "unreachable",
      detail: runtime.dbLatencyMs != null ? `${runtime.dbLatencyMs} ms round-trip` : undefined,
    },
    {
      key: "webhookDlq",
      label: "Webhook DLQ",
      status: classify(q.webhookDlqOpen, t.webhookDlqOpen),
      value: `${q.webhookDlqOpen}`,
      detail: "unresolved dead-lettered webhooks",
    },
    {
      key: "emailDlq",
      label: "Email DLQ",
      status: classify(q.emailDlqOpen, t.emailDlqOpen),
      value: `${q.emailDlqOpen}`,
      detail: "dead-lettered emails",
    },
    {
      key: "disputes",
      label: "Open disputes",
      status: classify(q.disputesOpen, t.disputesOpen),
      value: `${q.disputesOpen}`,
      detail: "open / under review",
    },
    {
      key: "reviews",
      label: "Review queue",
      status: classify(q.reviewsOpen, t.reviewsOpen),
      value: `${q.reviewsOpen}`,
      detail: "grades awaiting human review",
    },
    {
      key: "jobFailures",
      label: "Job failures (24h)",
      status: classify(jobs.failuresLast24h, t.jobFailures24h),
      value: `${jobs.failuresLast24h}`,
      detail: "failed cron runs in last 24h",
      trend: failuresTrend,
    },
    {
      key: "slowestJob",
      label: "Slowest job (24h)",
      status: classify(jobs.maxDurationMs, t.slowestJobMs),
      value: jobs.maxDurationMs > 0 ? `${(jobs.maxDurationMs / 1000).toFixed(1)}s` : "—",
      detail: jobs.slowest?.[0]?.job ? `slowest: ${jobs.slowest[0].job}` : undefined,
    },
    {
      key: "storage",
      label: "Storage usage",
      status: classify(pct, t.storagePct),
      value: `${pct.toFixed(1)}%`,
      detail: `${formatBytes(storage.totalBytes)} of ${t.storageBytesCapGb} GB · ${storage.totalObjects} objects`,
    },
    {
      key: "listingPipeline",
      label: "Listing pipeline",
      status: classify(pipelineBacklog, t.pipelineBacklog),
      value: `${pipelineBacklog}`,
      detail: "failed / stuck generation & publish backlog (US-899)",
    },
    ledgerAppendOnlyTile(metrics.ledgerAppendOnly),
  ];

  return {
    overall: overallStatus(tiles),
    tiles,
    runtime,
    metrics: { ...metrics, storage, queues: q, jobs },
    thresholds: t,
    generatedAt: metrics.generatedAt ?? new Date().toISOString(),
  };
}

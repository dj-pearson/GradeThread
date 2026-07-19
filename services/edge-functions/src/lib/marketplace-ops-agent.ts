// US-1598 / AGENTIC-OS Phase 1 (Module L): the Marketplace Ops agent's domain
// logic — FlipDesk operational health across tenants (operator view). OPERATOR-
// SCOPE AGGREGATES ONLY: counts + batch/resource ids + ages, never a raw tenant
// row, handle, title, or any PII. It reports and proposes UNSTICK paths that go
// THROUGH existing reclaim/sweep jobs; it NEVER mutates a tenant's listings or
// inventory (vault/70-agent/agentic-os-map.md §3.L + §5).
//
// Reuses the pure pipeline-oversight helpers (US-899) so this agent's "stuck"
// agrees byte-for-byte with the admin cockpit + the reclaim sweepers.

import { ageMs, isBatchIssue, isStuckBatch } from "./pipeline-oversight.ts";

// ── Which existing reclaim/sweep cron owns each issue kind ───────────────────

export type IssueKind = "generation_batch" | "publish_batch" | "sync_conflict" | "orphan_sale";

// The registered cron a retry_job proposal targets to unstick each issue kind.
export const RECLAIM_CRON_FOR: Record<IssueKind, string> = {
  generation_batch: "autolister-reclaim",
  publish_batch: "publish-batch-reclaim",
  sync_conflict: "sync-reaper",
  orphan_sale: "reconciliation-sweep",
};

// ── Marketplace connection verdicts (aggregate, per marketplace) ─────────────

export interface ConnectionRow {
  marketplace: string | null;
  is_active: boolean | null;
  token_expires_at: string | null;
  refresh_error: string | null;
}

export interface MarketplaceVerdict {
  marketplace: string;
  total: number;
  active: number;
  errored: number;
  expiring_soon: number; // token expires within 7 days
  verdict: "healthy" | "degraded" | "down";
}

const DAY_MS = 24 * 3600_000;

// Per-marketplace verdict from connection aggregates. "down" when every
// connection is inactive/errored, "degraded" when some are, else "healthy". Pure.
export function computeMarketplaceVerdicts(
  connections: readonly ConnectionRow[],
  nowMs: number,
): MarketplaceVerdict[] {
  const byMk = new Map<string, { total: number; active: number; errored: number; expiring: number }>();
  for (const c of connections) {
    const mk = c.marketplace ?? "unknown";
    const agg = byMk.get(mk) ?? { total: 0, active: 0, errored: 0, expiring: 0 };
    agg.total++;
    if (c.is_active) agg.active++;
    if (c.refresh_error) agg.errored++;
    if (c.token_expires_at) {
      const dt = Date.parse(c.token_expires_at) - nowMs;
      if (dt > 0 && dt < 7 * DAY_MS) agg.expiring++;
    }
    byMk.set(mk, agg);
  }
  return [...byMk.entries()]
    .map(([marketplace, a]) => {
      const verdict: MarketplaceVerdict["verdict"] = a.active === 0 && a.total > 0
        ? "down"
        : a.errored > 0 || a.expiring > 0
        ? "degraded"
        : "healthy";
      return { marketplace, total: a.total, active: a.active, errored: a.errored, expiring_soon: a.expiring, verdict };
    })
    .sort((x, y) => y.errored - x.errored);
}

// ── Batch backlog (generation + publish) ─────────────────────────────────────

export interface BatchRow {
  id: string;
  status: string;
  updated_at: string | null;
}

export interface BatchBacklog {
  stuck: number;
  failed: number;
}

export interface StuckItem {
  kind: IssueKind;
  id: string;
  age_ms: number;
  remediation_cron: string;
}

export interface BatchSummary {
  generation: BatchBacklog;
  publish: BatchBacklog;
  stuck_items: StuckItem[];
}

function summarizeOneBatchSet(
  rows: readonly BatchRow[],
  kind: "generation_batch" | "publish_batch",
  now: Date,
): { backlog: BatchBacklog; items: StuckItem[] } {
  let stuckCount = 0, failed = 0;
  const items: StuckItem[] = [];
  for (const r of rows) {
    const stuck = isStuckBatch(r.status, r.updated_at, now);
    // isBatchIssue keeps this agent's issue-set aligned with the cockpit view.
    if (!isBatchIssue(r.status, stuck)) continue;
    if (r.status === "failed" || r.status === "partial") failed++;
    if (stuck) {
      stuckCount++;
      items.push({ kind, id: r.id, age_ms: ageMs(r.updated_at, now) ?? 0, remediation_cron: RECLAIM_CRON_FOR[kind] });
    }
  }
  return { backlog: { stuck: stuckCount, failed }, items };
}

export function summarizeBatchBacklog(
  generation: readonly BatchRow[],
  publish: readonly BatchRow[],
  nowMs: number,
): BatchSummary {
  const now = new Date(nowMs);
  const g = summarizeOneBatchSet(generation, "generation_batch", now);
  const p = summarizeOneBatchSet(publish, "publish_batch", now);
  const stuckItems = [...g.items, ...p.items].sort((a, b) => b.age_ms - a.age_ms).slice(0, 15);
  return { generation: g.backlog, publish: p.backlog, stuck_items: stuckItems };
}

// ── The assembled memo ───────────────────────────────────────────────────────

export interface MarketplaceOpsTelemetry {
  connections: readonly ConnectionRow[];
  generationBatches: readonly BatchRow[];
  publishBatches: readonly BatchRow[];
  openSyncConflicts: number;
  orphanSales: number;
  priorBacklogTotal: number | null; // yesterday's snapshot, for the trend
  nowMs: number;
}

export type Trend = "up" | "down" | "flat" | "unknown";

export interface MarketplaceOpsMemo {
  summary: string;
  marketplaces: MarketplaceVerdict[];
  batches: BatchSummary;
  sync_conflicts: number;
  orphan_sales: number;
  backlog: { total: number; prior: number | null; trend: Trend };
  stuck_items: StuckItem[];
  all_clear: boolean;
}

export function computeBacklogTotal(t: {
  batches: BatchSummary;
  openSyncConflicts: number;
  orphanSales: number;
}): number {
  return (
    t.batches.generation.stuck + t.batches.generation.failed +
    t.batches.publish.stuck + t.batches.publish.failed +
    t.openSyncConflicts + t.orphanSales
  );
}

function trendOf(current: number, prior: number | null): Trend {
  if (prior === null) return "unknown";
  if (current > prior) return "up";
  if (current < prior) return "down";
  return "flat";
}

export function assembleMarketplaceOpsMemo(t: MarketplaceOpsTelemetry): MarketplaceOpsMemo {
  const marketplaces = computeMarketplaceVerdicts(t.connections, t.nowMs);
  const batches = summarizeBatchBacklog(t.generationBatches, t.publishBatches, t.nowMs);
  const total = computeBacklogTotal({ batches, openSyncConflicts: t.openSyncConflicts, orphanSales: t.orphanSales });
  const trend = trendOf(total, t.priorBacklogTotal);

  const unhealthy = marketplaces.filter((m) => m.verdict !== "healthy");
  const allClear = total === 0 && unhealthy.length === 0;

  const parts: string[] = [];
  if (allClear) {
    parts.push("Marketplace ops healthy: no stuck batches, no open sync conflicts, no orphan sales, all connections healthy.");
  } else {
    if (unhealthy.length) parts.push(`${unhealthy.length} marketplace(s) degraded/down`);
    const stuckBatches = batches.generation.stuck + batches.publish.stuck;
    if (stuckBatches) parts.push(`${stuckBatches} stuck batch(es)`);
    const failedBatches = batches.generation.failed + batches.publish.failed;
    if (failedBatches) parts.push(`${failedBatches} failed batch(es)`);
    if (t.openSyncConflicts) parts.push(`${t.openSyncConflicts} open sync conflict(s)`);
    if (t.orphanSales) parts.push(`${t.orphanSales} orphan sale(s)`);
    if (trend !== "unknown") parts.push(`backlog ${trend} vs prior (${t.priorBacklogTotal}→${total})`);
  }

  return {
    summary: parts.join("; ") + ".",
    marketplaces,
    batches,
    sync_conflicts: t.openSyncConflicts,
    orphan_sales: t.orphanSales,
    backlog: { total, prior: t.priorBacklogTotal, trend },
    stuck_items: batches.stuck_items,
    all_clear: allClear,
  };
}

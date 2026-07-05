// US-1598: Marketplace Ops agent pure domain logic — marketplace verdicts,
// batch backlog + stuck items, backlog total/trend, and the assembled memo.
// No env/DB (pure module, over pipeline-oversight helpers).
import { assertEquals } from "@std/assert";
import {
  assembleMarketplaceOpsMemo,
  type BatchRow,
  computeBacklogTotal,
  computeMarketplaceVerdicts,
  type ConnectionRow,
  RECLAIM_CRON_FOR,
  summarizeBatchBacklog,
} from "../lib/marketplace-ops-agent.ts";

const NOW = Date.parse("2026-07-05T00:00:00.000Z");
const MIN = 60_000;
const stale = new Date(NOW - 60 * MIN).toISOString(); // past the 15m stuck window
const fresh = new Date(NOW - 60_000).toISOString();

// ── Marketplace verdicts ─────────────────────────────────────────────────────

Deno.test("computeMarketplaceVerdicts: down when nothing active, degraded on error/expiry", () => {
  const conns: ConnectionRow[] = [
    { marketplace: "ebay", is_active: false, token_expires_at: null, refresh_error: "expired" },
    { marketplace: "poshmark", is_active: true, token_expires_at: new Date(NOW + 3 * 86400_000).toISOString(), refresh_error: null },
    { marketplace: "mercari", is_active: true, token_expires_at: new Date(NOW + 200 * 86400_000).toISOString(), refresh_error: null },
  ];
  const v = computeMarketplaceVerdicts(conns, NOW);
  assertEquals(v.find((x) => x.marketplace === "ebay")!.verdict, "down");
  assertEquals(v.find((x) => x.marketplace === "poshmark")!.verdict, "degraded"); // expiring <7d
  assertEquals(v.find((x) => x.marketplace === "mercari")!.verdict, "healthy");
});

// ── Batch backlog ────────────────────────────────────────────────────────────

Deno.test("summarizeBatchBacklog: stuck running batch → item with the right reclaim cron", () => {
  const gen: BatchRow[] = [
    { id: "g-stuck", status: "running", updated_at: stale },
    { id: "g-fresh", status: "running", updated_at: fresh }, // not stuck yet
    { id: "g-failed", status: "failed", updated_at: fresh },
  ];
  const pub: BatchRow[] = [{ id: "p-stuck", status: "pending", updated_at: stale }];
  const s = summarizeBatchBacklog(gen, pub, NOW);
  assertEquals(s.generation.stuck, 1);
  assertEquals(s.generation.failed, 1);
  assertEquals(s.publish.stuck, 1);
  // Sorted by age desc; both stuck items present with their crons.
  const byId = Object.fromEntries(s.stuck_items.map((i) => [i.id, i.remediation_cron]));
  assertEquals(byId["g-stuck"], RECLAIM_CRON_FOR.generation_batch);
  assertEquals(byId["p-stuck"], RECLAIM_CRON_FOR.publish_batch);
  assertEquals(s.stuck_items.length, 2);
});

Deno.test("summarizeBatchBacklog: healthy/terminal batches contribute no stuck items", () => {
  const gen: BatchRow[] = [
    { id: "done", status: "completed", updated_at: stale },
    { id: "live", status: "running", updated_at: fresh },
  ];
  const s = summarizeBatchBacklog(gen, [], NOW);
  assertEquals(s.generation.stuck, 0);
  assertEquals(s.stuck_items.length, 0);
});

// ── Backlog total + memo ─────────────────────────────────────────────────────

Deno.test("computeBacklogTotal: sums stuck + failed batches + conflicts + orphans", () => {
  const batches = summarizeBatchBacklog(
    [{ id: "g", status: "running", updated_at: stale }],
    [{ id: "p", status: "failed", updated_at: fresh }],
    NOW,
  );
  assertEquals(computeBacklogTotal({ batches, openSyncConflicts: 2, orphanSales: 3 }), 1 + 1 + 2 + 3);
});

Deno.test("assembleMarketplaceOpsMemo: all-clear when nothing is wrong", () => {
  const memo = assembleMarketplaceOpsMemo({
    connections: [{ marketplace: "ebay", is_active: true, token_expires_at: new Date(NOW + 200 * 86400_000).toISOString(), refresh_error: null }],
    generationBatches: [],
    publishBatches: [],
    openSyncConflicts: 0,
    orphanSales: 0,
    priorBacklogTotal: 0,
    nowMs: NOW,
  });
  assertEquals(memo.all_clear, true);
  assertEquals(memo.backlog.trend, "flat");
});

Deno.test("assembleMarketplaceOpsMemo: stuck batch + trend vs prior break all-clear", () => {
  const memo = assembleMarketplaceOpsMemo({
    connections: [],
    generationBatches: [{ id: "g", status: "running", updated_at: stale }],
    publishBatches: [],
    openSyncConflicts: 1,
    orphanSales: 0,
    priorBacklogTotal: 0, // was 0, now 2 → up
    nowMs: NOW,
  });
  assertEquals(memo.all_clear, false);
  assertEquals(memo.backlog.total, 2);
  assertEquals(memo.backlog.trend, "up");
  assertEquals(memo.stuck_items[0].id, "g");
});

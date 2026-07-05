// US-1658: the review-queue reorder mapping — ranking → persistable order.
// review-queue-order.ts imports supabase.ts (throws without env), so prime the
// env before dynamic-importing, mirroring agent-tools_test.ts. Only the PURE
// functions are exercised here; the impure gather/persist is covered via the
// ToolIO seam in agent-tools_test.ts.
import { assert, assertEquals } from "@std/assert";
import type { PendingReviewRow } from "../lib/review-queue-order.ts";
import type { ReviewInfoContext } from "../lib/review-info-value.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
const { computeReviewQueueOrder, assembleReviewQueueArtifact, REVIEW_QUEUE_ORDER_KEY } = await import(
  "../lib/review-queue-order.ts"
);

// A context where "hat" is a novel (uncovered) category and "shirt" is
// well-covered; a flat 0.75 review threshold; the "clean" combo already common.
function ctx(): ReviewInfoContext {
  return {
    goldenByCategory: { shirt: 40 },
    exemplarsByCategory: {},
    comboCounts: { clean: 5 },
    thresholdForCategory: () => 0.75,
  };
}

function row(over: Partial<PendingReviewRow>): PendingReviewRow {
  return {
    report_id: "r",
    submission_id: "s",
    garment_category: "shirt",
    confidence: 0.9, // far from threshold → calibration gap ~0 (novelty dominates)
    defect_types: [],
    waiting_ms: 3600_000,
    overdue: false,
    ...over,
  };
}

Deno.test("computeReviewQueueOrder: empty queue → empty order + explicit rationale", () => {
  const res = computeReviewQueueOrder([], ctx());
  assertEquals(res.order, []);
  assertEquals(res.rationale, "No pending reviews to reorder.");
});

Deno.test("computeReviewQueueOrder: ranks the novel-category review above the well-covered one", () => {
  const rows = [
    row({ report_id: "covered", garment_category: "shirt" }),
    row({ report_id: "novel", garment_category: "hat" }),
  ];
  const res = computeReviewQueueOrder(rows, ctx(), { slaAgeMs: 1_000_000_000 });
  assertEquals(res.order.map((e) => e.report_id), ["novel", "covered"]);
  assertEquals(res.order[0].rank, 1);
  assertEquals(res.order[1].rank, 2);
  // The novel item scores strictly higher (novelty is the leading factor).
  assert(res.order[0].info_value > res.order[1].info_value);
  assert(res.order[0].reasons.includes("novel category"));
});

Deno.test("computeReviewQueueOrder: SLA guard floats an aged review above a high-info fresh one", () => {
  const rows = [
    row({ report_id: "fresh_high_info", garment_category: "hat", waiting_ms: 1_000 }),
    row({ report_id: "aged_low_info", garment_category: "shirt", waiting_ms: 60_000, overdue: true }),
  ];
  // slaAgeMs below the aged item's wait → it floats first despite lower info value.
  const res = computeReviewQueueOrder(rows, ctx(), { slaAgeMs: 30_000 });
  assertEquals(res.order[0].report_id, "aged_low_info");
  assertEquals(res.order[0].sla_floated, true);
  assertEquals(res.order[1].report_id, "fresh_high_info");
  assertEquals(res.order[1].sla_floated, false);
  assert(res.rationale.includes("SLA-floated"));
});

Deno.test("computeReviewQueueOrder: ranks are dense + 1-based over the whole set", () => {
  const rows = ["a", "b", "c", "d"].map((id, i) =>
    row({ report_id: id, garment_category: i % 2 === 0 ? "hat" : "shirt" })
  );
  const res = computeReviewQueueOrder(rows, ctx(), { slaAgeMs: 1_000_000_000 });
  assertEquals(res.order.map((e) => e.rank), [1, 2, 3, 4]);
  // Every input row appears exactly once (a reorder, never a drop).
  assertEquals(new Set(res.order.map((e) => e.report_id)).size, 4);
});

Deno.test("assembleReviewQueueArtifact: stamps meta + count around the computed order", () => {
  const computed = computeReviewQueueOrder([row({ garment_category: "hat" })], ctx(), {
    slaAgeMs: 1_000_000_000,
  });
  const artifact = assembleReviewQueueArtifact(computed, {
    computedAtIso: "2026-07-05T00:00:00.000Z",
    computedBy: "admin-1",
    proposalId: "prop-1",
  });
  assertEquals(artifact.count, 1);
  assertEquals(artifact.computed_at, "2026-07-05T00:00:00.000Z");
  assertEquals(artifact.computed_by, "admin-1");
  assertEquals(artifact.proposal_id, "prop-1");
  assertEquals(artifact.order.length, 1);
  assertEquals(REVIEW_QUEUE_ORDER_KEY, "grading.review_queue_order");
});

// US-3456: the bulk cross-list planner and summary. The fan-out itself is
// crossPushPlatform, whose already-live and already-queued skips are pinned in
// cross-push_test.ts; what is pinned here is that forty items and three
// channels plan to exactly one hundred and twenty calls, that a duplicate id
// plans once, and that eBay is refused rather than fanned out.

// US-2379: the static import graph reaches src/lib/supabase.ts, so the env
// stub loads first. Kept as the first import on purpose.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  batchLabelFor,
  type BulkRow,
  MAX_BATCH_LABEL_LENGTH,
  MAX_BULK_CROSS_PUSH_ITEMS,
  planBulkCrossPush,
  summarizeBulkRows,
} from "../lib/cross-push-bulk.ts";
import { planCrossPushSkip } from "../lib/cross-push.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

Deno.test("40 items to 3 extension channels plan 120 calls, and a duplicated id plans once", () => {
  const ids = Array.from({ length: 40 }, (_, i) => uuid(i + 1));
  const plan = planBulkCrossPush([...ids, ids[0], ids[7]], ["poshmark", "mercari", "vinted", "mercari"]);
  assertEquals(plan.refused, null);
  assertEquals(plan.itemIds.length, 40);
  assertEquals(plan.platforms, ["poshmark", "mercari", "vinted"]);
  assertEquals(plan.itemIds.length * plan.platforms.length, 120);
  assertEquals(plan.droppedItems, 2);
});

Deno.test("an item already live on a channel is skipped, not listed twice", () => {
  // The per-item decision the route delegates to crossPushPlatform.
  assertEquals(
    planCrossPushSkip({ listing_status: "active", listing_url: "https://poshmark.com/listing/1" }, false),
    "already_live",
  );
  assertEquals(planCrossPushSkip({ listing_status: "draft", listing_url: null }, true), "already_queued");
  assertEquals(planCrossPushSkip(null, false), null);
});

Deno.test("eBay is refused with the batch it should use named; unknown platforms are refused; the cap holds", () => {
  const withEbay = planBulkCrossPush([uuid(1)], ["ebay", "poshmark"]);
  assert(withEbay.refused?.includes("publish-batch"));
  assert(planBulkCrossPush([uuid(1)], ["tiktok"]).refused?.startsWith("Unsupported platform"));
  assertEquals(planBulkCrossPush([uuid(1)], []).refused, "platforms must be a non-empty array.");
  assertEquals(planBulkCrossPush(["not-a-uuid"], ["poshmark"]).refused, "item_ids must name at least one item.");
  const many = planBulkCrossPush(Array.from({ length: 150 }, (_, i) => uuid(i + 1)), ["poshmark"]);
  assertEquals(many.itemIds.length, MAX_BULK_CROSS_PUSH_ITEMS);
  assertEquals(many.droppedItems, 50);
});

Deno.test("the batch label is trimmed, collapsed and bounded; blank is none", () => {
  assertEquals(batchLabelFor("  Sunday   drop "), "Sunday drop");
  assertEquals(batchLabelFor(""), null);
  assertEquals(batchLabelFor(42), null);
  assertEquals(batchLabelFor("x".repeat(200))!.length, MAX_BATCH_LABEL_LENGTH);
});

Deno.test("the summary counts every outcome once", () => {
  const row = (outcome: BulkRow["outcome"]): BulkRow => ({
    item_id: uuid(1),
    platform: "poshmark",
    outcome,
    listing_row_id: null,
    listing_url: null,
    error: null,
  });
  const s = summarizeBulkRows([
    row("published"),
    row("queued"),
    row("queued"),
    row("already_live"),
    row("already_queued"),
    row("no_source"),
    row("not_found"),
    row("blocked"),
  ]);
  assertEquals(s, { rows: 8, published: 1, queued: 2, skipped: 2, noSource: 1, notFound: 1, blocked: 1 });
});

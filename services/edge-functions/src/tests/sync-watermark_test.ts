// US-2320 [P0]: an injected failure mid-pass must leave the cursor unmoved.
//
// The defect: the eBay orders pass caught everything, logged it, carried on,
// and then stamped `last_synced_at = now()` unconditionally. eBay 500s at order
// 200 of 500 → orders 1-199 saved, 200-500 never written, cursor says "now", so
// the next incremental pull asks only for orders modified since now. Those 301
// orders are gone: no sales rows, no payouts, no net_profit, no
// inventory_items.status='sold'. The response was 202 {ok:true} and the UI said
// "Synced just now". The backstop cron selects stale owners by that same
// column, so it cannot recover them either.
//
// Nothing about the individual steps was wrong, which is the pattern worth
// remembering: "log and continue" is correct for a listings pass and is data
// loss for a CURSOR pass, because the cursor is a promise that everything
// before it was persisted.

import { assertEquals } from "@std/assert";
import { planOrdersWatermark } from "../lib/sync-watermark.ts";
import { assert } from "@std/assert";

const NOW = "2026-08-01T12:00:00.000Z";

Deno.test("US-2320: a clean pass advances to now, as it always did", () => {
  assertEquals(
    planOrdersWatermark({ fetchComplete: true, failedOrders: [], now: NOW }),
    { advance: true, to: NOW, reason: "clean" },
  );
});

Deno.test("US-2320: a fetch that threw mid-pass leaves the cursor UNMOVED", () => {
  // The story's scenario. We got some orders and do not know what we missed,
  // so there is no safe value to move to — only re-asking the same window can
  // find out.
  assertEquals(
    planOrdersWatermark({ fetchComplete: false, failedOrders: [], now: NOW }),
    { advance: false, reason: "fetch_incomplete" },
  );
});

Deno.test("US-2320: hitting the page ceiling is incomplete, not success", () => {
  // Same input shape as a throw, because it is the same problem: the ceiling
  // used to only push a warning string into errors[] while the cursor advanced
  // anyway, so everything past the ceiling was dropped and never re-asked for.
  assertEquals(
    planOrdersWatermark({ fetchComplete: false, failedOrders: [], now: NOW })
      .advance,
    false,
  );
});

Deno.test("US-2320: orders that failed to PERSIST rewind the cursor to the earliest of them", () => {
  // A complete fetch is a different situation: we know exactly which orders did
  // not land and when they were modified. Rewinding to the earliest re-pulls it
  // and everything after it. eBay's lastmodifieddate filter is inclusive, so
  // handing back the failed order's own timestamp re-fetches that order.
  const plan = planOrdersWatermark({
    fetchComplete: true,
    failedOrders: [
      { orderId: "o-9", lastModifiedDate: "2026-07-30T09:00:00.000Z" },
      { orderId: "o-2", lastModifiedDate: "2026-07-28T04:30:00.000Z" },
      { orderId: "o-5", lastModifiedDate: "2026-07-29T22:00:00.000Z" },
    ],
    now: NOW,
  });
  assertEquals(plan, {
    advance: true,
    to: "2026-07-28T04:30:00.000Z",
    reason: "rewound",
  });
});

Deno.test("US-2320: rewinding, not freezing, is what stops a poison order stalling the sync", () => {
  // The reason per-order failures rewind instead of freezing: one permanently
  // malformed order would otherwise pin the cursor forever and the seller would
  // re-pull the whole 90-day window on every sync until a human noticed. The
  // cursor still MOVES here — just not past the failure.
  const plan = planOrdersWatermark({
    fetchComplete: true,
    failedOrders: [{ orderId: "bad", lastModifiedDate: "2026-07-31T00:00:00.000Z" }],
    now: NOW,
  });
  assert(plan.advance);
  assertEquals(plan.to !== NOW, true, "must not jump to now");
});

Deno.test("US-2320: a failure we cannot place in time freezes the cursor", () => {
  // No lastModifiedDate means no safe rewind target, and guessing one is how
  // the original bug worked. Freezing costs a re-pull of a window we already
  // have; guessing costs the orders.
  for (const bad of [null, "", "not-a-date"]) {
    assertEquals(
      planOrdersWatermark({
        fetchComplete: true,
        failedOrders: [{ orderId: "o-1", lastModifiedDate: bad }],
        now: NOW,
      }),
      { advance: false, reason: "undatable_failure" },
      `${String(bad)} must not be rewound to`,
    );
  }
});

Deno.test("US-2320: a bogus future timestamp can never push the cursor past now", () => {
  // A rewind that moves the cursor FORWARD is the original defect wearing a
  // different hat — everything modified between now and that date would be
  // skipped.
  const plan = planOrdersWatermark({
    fetchComplete: true,
    failedOrders: [{ orderId: "o-1", lastModifiedDate: "2099-01-01T00:00:00.000Z" }],
    now: NOW,
  });
  assertEquals(plan, { advance: true, to: NOW, reason: "rewound" });
});

Deno.test("US-2320: the eBay route gates its cursor on this decision", async () => {
  // Source assertions, because the defect was an ABSENT condition — there is no
  // wrong value to catch, only an `await update({ last_synced_at: ... })` with
  // nothing in front of it. Each of these pins one link of the chain that made
  // the loss silent and permanent.
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );

  assert(src.includes("planOrdersWatermark("), "the cursor must be planned, not stamped");
  assert(
    !/\.update\(\{ last_synced_at: new Date\(\)\.toISOString\(\) \}\)/.test(src),
    "an unconditional now() stamp is exactly the bug",
  );
  // The orders catch must mark the fetch incomplete. Without this the catch
  // still logs and carries on and the cursor still moves.
  assert(
    src.includes("ordersFetchComplete = false"),
    "the orders catch must record that the fetch did not complete",
  );
  // AC4: the Supabase errors that used to be destructured away.
  assert(src.includes("sale insert failed"), "insert errors must be read, not discarded");
  assert(src.includes("sale update failed"), "update errors must be read, not discarded");
  // AC3: a partial sync has to say so. `errors` drives recordSyncRun's
  // status:'partial', which is what the Reconciliation page reads.
  assert(src.includes("This sync is PARTIAL"), "a partial sync must be reported as one");
});

Deno.test("US-2320: the paged order fetch reports whether it finished", async () => {
  // The ceiling used to be a warning STRING and nothing more, which is
  // unreadable to the caller that has to make the cursor decision.
  const src = await Deno.readTextFile(
    new URL("../lib/ebay-client.ts", import.meta.url),
  );
  assert(src.includes("return { orders: all, complete: completed };"));
  assert(src.includes("RecentOrdersResult"));
});

// US-783: eBay publish atomicity — a local-write failure after a live publish
// must NOT be reported as a publish failure.
import { assert, assertEquals } from "@std/assert";
import { finalizePublishedListing } from "../lib/ebay-publish-finalize.ts";

Deno.test("persist succeeds first try → not sync_pending, no reconcile", async () => {
  let reconciled = false;
  const r = await finalizePublishedListing({
    persist: () => Promise.resolve(),
    recordReconcile: () => { reconciled = true; return Promise.resolve(); },
  });
  assertEquals(r.syncPending, false);
  assertEquals(r.attempts, 1);
  assertEquals(reconciled, false);
});

Deno.test("persist fails then succeeds on retry → not sync_pending", async () => {
  let calls = 0;
  let reconciled = false;
  const r = await finalizePublishedListing({
    persist: () => {
      calls += 1;
      if (calls < 2) return Promise.reject(new Error("transient db error"));
      return Promise.resolve();
    },
    recordReconcile: () => { reconciled = true; return Promise.resolve(); },
  });
  assertEquals(r.syncPending, false);
  assertEquals(r.attempts, 2);
  assertEquals(reconciled, false);
});

Deno.test("persist fails persistently → sync_pending + reconcile marker recorded", async () => {
  let persistCalls = 0;
  let reconciled = false;
  const r = await finalizePublishedListing({
    persist: () => { persistCalls += 1; return Promise.reject(new Error("db down")); },
    recordReconcile: () => { reconciled = true; return Promise.resolve(); },
    maxRetries: 2,
  });
  assertEquals(r.syncPending, true); // the live listing is reported as success-with-sync-pending
  assertEquals(persistCalls, 3); // 1 + 2 retries
  assert(reconciled, "a reconcile marker must be recorded so the pull-sync adopts the orphan");
});

Deno.test("a failing reconcile marker still returns sync_pending (best-effort)", async () => {
  const r = await finalizePublishedListing({
    persist: () => Promise.reject(new Error("db down")),
    recordReconcile: () => Promise.reject(new Error("marker write also failed")),
    maxRetries: 1,
  });
  // Even if the marker write fails, we never throw / never report publish failure.
  assertEquals(r.syncPending, true);
});

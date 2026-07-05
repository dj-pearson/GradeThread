// US-1644: a user resume must be refused while a batch's worker is still live
// (fresh heartbeat), or resetting its jobs to 'pending' double-runs them.
import { assertEquals } from "@std/assert";
import { isBatchHeartbeatFresh } from "../lib/batch-heartbeat.ts";

const NOW = Date.parse("2026-06-20T12:00:00.000Z");
const STALE_MS = 15 * 60_000; // 15 min

Deno.test("a running batch with a recent heartbeat is fresh → refuse resume", () => {
  const oneMinAgo = new Date(NOW - 60_000).toISOString();
  assertEquals(isBatchHeartbeatFresh("running", oneMinAgo, STALE_MS, NOW), true);
});

Deno.test("a running batch whose heartbeat is stale is resumable", () => {
  const twentyMinAgo = new Date(NOW - 20 * 60_000).toISOString();
  assertEquals(isBatchHeartbeatFresh("running", twentyMinAgo, STALE_MS, NOW), false);
});

Deno.test("a non-running batch (pending/completed/failed) is always resumable", () => {
  const oneMinAgo = new Date(NOW - 60_000).toISOString();
  assertEquals(isBatchHeartbeatFresh("pending", oneMinAgo, STALE_MS, NOW), false);
  assertEquals(isBatchHeartbeatFresh("completed", oneMinAgo, STALE_MS, NOW), false);
  assertEquals(isBatchHeartbeatFresh("failed", oneMinAgo, STALE_MS, NOW), false);
});

Deno.test("a missing or unparseable heartbeat is treated as resumable (not fresh)", () => {
  assertEquals(isBatchHeartbeatFresh("running", null, STALE_MS, NOW), false);
  assertEquals(isBatchHeartbeatFresh("running", undefined, STALE_MS, NOW), false);
  assertEquals(isBatchHeartbeatFresh("running", "not-a-date", STALE_MS, NOW), false);
});

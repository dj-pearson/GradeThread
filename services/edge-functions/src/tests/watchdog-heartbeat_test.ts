// US-2447: the host-watchdog heartbeat receiver, tested by CALLING it.
//
// The source-scan half lives in scripts/host-schedules.test.mjs and is the
// weaker half by construction: sabotaging the gate to `if (false)` left both
// `requireJobSecret` and `401` in the file, so a token search stayed green over
// a dead gate. This file is the one that cannot be fooled that way.
//
// Why the gate matters more than it looks: this endpoint writes the single row
// that /health/ready reports as `hostWatchdog`. An unauthenticated writer could
// forge a heartbeat, and an absent watchdog would then read as healthy — the
// detector converted into a source of false confidence, which is worse than the
// blind spot it was built to fill.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { watchdogHeartbeatHandler } from "../routes/jobs-watchdog-heartbeat.ts";

function appUnderTest() {
  const app = new Hono();
  app.post("/api/jobs/watchdog-heartbeat", (c) => watchdogHeartbeatHandler(c));
  return app;
}

Deno.test("US-2447: an unauthenticated heartbeat is refused before any write", async () => {
  Deno.env.set("FLIPDESK_INTERNAL_JOB_SECRET", "the-real-secret");
  const res = await appUnderTest().request("/api/jobs/watchdog-heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "healthy" }),
  });
  assertEquals(res.status, 401);
  const body = await res.json() as { error?: string; ok?: unknown };
  assertEquals(body.error, "Unauthorized");
  // The absence of `ok` is the real assertion: reaching the upsert against the
  // dummy env would have produced a 500, not a 401, so a 401 proves the gate
  // short-circuited ahead of the write rather than the write merely failing.
  assertEquals(body.ok, undefined);
});

Deno.test("US-2447: a WRONG secret is refused too, not just a missing one", async () => {
  // A gate that only checks for the header's presence would pass this.
  Deno.env.set("FLIPDESK_INTERNAL_JOB_SECRET", "the-real-secret");
  const res = await appUnderTest().request("/api/jobs/watchdog-heartbeat", {
    method: "POST",
    headers: { "X-Internal-Job-Secret": "not-the-secret" },
  });
  assertEquals(res.status, 401);
});

Deno.test("US-2447: an empty configured secret cannot be satisfied", async () => {
  // Fail-closed. An unset secret on the host must not turn the endpoint into an
  // open write, which is the shape that would make the whole check dishonest.
  Deno.env.delete("FLIPDESK_INTERNAL_JOB_SECRET");
  Deno.env.delete("FLIPDESK_INTERNAL_JOB_SECRET_OLD");
  const res = await appUnderTest().request("/api/jobs/watchdog-heartbeat", {
    method: "POST",
    headers: { "X-Internal-Job-Secret": "" },
  });
  assertEquals(res.status, 401);
  Deno.env.set("FLIPDESK_INTERNAL_JOB_SECRET", "the-real-secret");
});

Deno.test("US-2447: the heartbeat key is the one /health/ready reads", async () => {
  // Two modules name this string. If they drift, the watchdog checks in
  // faithfully and the health surface reports "unconfigured" forever — a
  // detector that has quietly stopped detecting, which is the exact failure
  // this whole story is about.
  const { WATCHDOG_HEARTBEAT_KEY } = await import(
    "../routes/jobs-watchdog-heartbeat.ts"
  );
  const healthSrc = await Deno.readTextFile(
    new URL("../routes/health.ts", import.meta.url),
  );
  assert(
    healthSrc.includes("WATCHDOG_HEARTBEAT_KEY"),
    "health.ts must read the key from the heartbeat module, not re-spell it",
  );
  assert(
    !/getSetting<[^>]*>\(\s*"ops\./.test(healthSrc),
    "health.ts must not hard-code the settings key string",
  );
  assertEquals(WATCHDOG_HEARTBEAT_KEY, "ops.edge_watchdog_last_seen");
});

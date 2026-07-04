// US-584: verify the minimal cron next-run computation used by the admin Jobs
// dashboard (the cron-health view). Pure logic, no DB — but cron-runs.ts imports
// supabase.ts (throws at init without env), so set dummy creds + dynamic import.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { nextCronRun, CRON_REGISTRY, cronNameForPath } = await import(
  "../lib/cron-runs.ts"
);

const FROM = new Date("2026-06-12T10:02:00Z");

Deno.test("nextCronRun: */5 steps to the next 5-minute mark", () => {
  assertEquals(nextCronRun("*/5 * * * *", FROM), "2026-06-12T10:05:00.000Z");
});

Deno.test("nextCronRun: hour step */6 picks the next 6-hourly slot", () => {
  assertEquals(nextCronRun("0 */6 * * *", FROM), "2026-06-12T12:00:00.000Z");
});

Deno.test("nextCronRun: a daily time already passed today rolls to tomorrow", () => {
  // 06:30 < 10:02 today → next is tomorrow.
  assertEquals(nextCronRun("30 6 * * *", FROM), "2026-06-13T06:30:00.000Z");
});

Deno.test("nextCronRun: a daily time later today fires today", () => {
  assertEquals(nextCronRun("15 0 * * *", new Date("2026-06-12T00:00:00Z")), "2026-06-12T00:15:00.000Z");
});

Deno.test("nextCronRun: malformed schedule returns null", () => {
  assertEquals(nextCronRun("not a cron", FROM), null);
  assertEquals(nextCronRun("* * *", FROM), null);
});

Deno.test("CRON_REGISTRY: every entry produces a computable next run", () => {
  for (const def of CRON_REGISTRY) {
    const next = nextCronRun(def.schedule, FROM);
    assertEquals(typeof next, "string", `no next-run for ${def.name} (${def.schedule})`);
  }
});

// US-1645: the eBay crons record via cronNameForPath (their registry name
// differs from the last path segment), so the resolver must map their endpoint
// to the canonical name and ignore unregistered / unrecorded paths.
Deno.test("cronNameForPath resolves recorded eBay cron endpoints to their registry name", () => {
  assertEquals(
    cronNameForPath("/api/flipdesk/ebay/jobs/publish-due"),
    "ebay-publish-due",
  );
  assertEquals(
    cronNameForPath("/api/flipdesk/ebay/jobs/promoted-sync"),
    "ebay-promoted-sync",
  );
  assertEquals(
    cronNameForPath("/api/flipdesk/ebay/jobs/leave-feedback"),
    "ebay-leave-feedback",
  );
  assertEquals(
    cronNameForPath("/api/flipdesk/ebay/sync/performance"),
    "ebay-performance-sync",
  );
  // Trailing slash tolerated.
  assertEquals(
    cronNameForPath("/api/flipdesk/ebay/jobs/publish-due/"),
    "ebay-publish-due",
  );
});

Deno.test("cronNameForPath returns null for unregistered or unrecorded paths", () => {
  // Not a cron path at all.
  assertEquals(cronNameForPath("/api/flipdesk/ebay/listings/pull"), null);
  // A registered-but-NOT-recorded cron must not record through this recorder.
  assertEquals(cronNameForPath("/api/flipdesk/ebay/oauth/refresh"), null);
  assertEquals(cronNameForPath("/api/flipdesk/nope"), null);
});

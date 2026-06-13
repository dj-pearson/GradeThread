// US-492: readiness-summary unit tests.
//
// summarizeReadiness is pure. health.ts imports the service-role supabase
// client at load, so set dummy env BEFORE the dynamic import.
//
//   deno test --allow-env src/tests/health_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { summarizeReadiness } = await import("../routes/health.ts");

Deno.test("ready when DB is up and no env is missing", () => {
  const s = summarizeReadiness(true, []);
  assert(s.ready);
  assertEquals(s.httpStatus, 200);
  assertEquals(s.body.status, "ready");
  assertEquals(s.body.checks.database, "ok");
  assertEquals(s.body.checks.env, "ok");
  assertEquals(s.body.missing_env, undefined);
});

Deno.test("not ready (503) when the database is unreachable", () => {
  const s = summarizeReadiness(false, []);
  assert(!s.ready);
  assertEquals(s.httpStatus, 503);
  assertEquals(s.body.status, "not_ready");
  assertEquals(s.body.checks.database, "fail");
});

Deno.test("not ready (503) when a critical env var is missing", () => {
  const s = summarizeReadiness(true, ["ANTHROPIC_API_KEY"]);
  assert(!s.ready);
  assertEquals(s.httpStatus, 503);
  assertEquals(s.body.checks.env, "missing");
  assertEquals(s.body.missing_env, ["ANTHROPIC_API_KEY"]);
});

Deno.test("not ready when both DB and env fail", () => {
  const s = summarizeReadiness(false, ["SUPABASE_URL"]);
  assert(!s.ready);
  assertEquals(s.httpStatus, 503);
  assertEquals(s.body.checks.database, "fail");
  assertEquals(s.body.checks.env, "missing");
});

// US-573: memory summary (/health/metrics) is pure and unit-tested here.
const { summarizeMemory } = await import("../lib/grading-capacity.ts");
const MB = 1048576;

Deno.test("memory: ok pressure with comfortable headroom", () => {
  const m = summarizeMemory(
    { rss: 600 * MB, heapUsed: 200 * MB, heapTotal: 300 * MB, external: 100 * MB },
    2048,
  );
  assertEquals(m.rss_mb, 600);
  assertEquals(m.limit_mb, 2048);
  assertEquals(m.rss_pct_of_limit, 29.3); // 600/2048
  assertEquals(m.headroom_pct, 70.7);
  assertEquals(m.pressure, "ok");
});

Deno.test("memory: elevated pressure crosses the 70% scale-out line", () => {
  const m = summarizeMemory(
    { rss: 1500 * MB, heapUsed: 0, heapTotal: 0, external: 0 },
    2048,
  );
  assertEquals(m.pressure, "elevated"); // ~73%
});

Deno.test("memory: critical pressure at >=85%", () => {
  const m = summarizeMemory(
    { rss: 1800 * MB, heapUsed: 0, heapTotal: 0, external: 0 },
    2048,
  );
  assertEquals(m.pressure, "critical"); // ~88%
});

Deno.test("memory: unknown pressure / null pct when no limit configured", () => {
  const m = summarizeMemory(
    { rss: 600 * MB, heapUsed: 0, heapTotal: 0, external: 0 },
    null,
  );
  assertEquals(m.limit_mb, null);
  assertEquals(m.rss_pct_of_limit, null);
  assertEquals(m.headroom_pct, null);
  assertEquals(m.pressure, "unknown");
});

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

const { summarizeReadiness, summarizeSchema, releaseReadiness } = await import(
  "../routes/health.ts"
);

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

// ── schema-drift visibility (US-1566) ──────────────────────────────────────
// Drift was only ever visible in container logs, so "is prod actually
// migrated?" could not be answered by anyone without log access — which is how
// US-1566's premise went ~130 migrations stale without anyone noticing it had
// been fixed. /health/ready now reports it.
// (summarizeSchema comes from the dynamic import above — a static import here
// would be hoisted above the dummy-env setup and blow up on SUPABASE_URL.)

Deno.test("summarizeSchema: classifies the four drift states", () => {
  assertEquals(summarizeSchema("00475", "00475").status, "match");
  // Ahead is the NORMAL state in the migrate-then-deploy window this repo
  // mandates — the SQL lands before the edge build that expects it.
  assertEquals(summarizeSchema("00474", "00475").status, "ahead");
  assertEquals(summarizeSchema("00475", "00474").status, "behind");
  // A failed/absent version read must degrade to "unknown", never to a
  // confident wrong answer.
  assertEquals(summarizeSchema("00475", null).status, "unknown");
});

Deno.test("summarizeSchema: reports both sides so drift is diagnosable", () => {
  const s = summarizeSchema("00475", "00470");
  assertEquals(s.expected, "00475");
  assertEquals(s.applied, "00470");
  // "behind" alone would say something is wrong; the pair says WHAT to apply.
  assertEquals(s.status, "behind");
});

Deno.test("schema drift never affects the ready decision", () => {
  // The boot guard already refuses to start a production edge that is behind,
  // and "ahead" is normal mid-deploy. Gating readiness on drift would pull
  // healthy containers out of rotation during every correct deploy.
  for (const applied of ["00475", "00470", "00999", null]) {
    const r = summarizeReadiness(true, [], {}, summarizeSchema("00475", applied));
    assertEquals(r.ready, true, `drift (applied=${applied}) must not flip ready`);
    assertEquals(r.httpStatus, 200);
  }
  // ...and a real dependency failure still fails, schema block present or not.
  assertEquals(summarizeReadiness(false, [], {}, summarizeSchema("00475", "00475")).ready, false);
});

Deno.test("schema block is omitted entirely when not supplied", () => {
  // Back-compat: existing callers/tests that pass three args get the old shape.
  const body = summarizeReadiness(true, [], {}).body;
  assertEquals("schema" in body, false);
});

// ── US-2001: release attributability ────────────────────────────────
// Prod measured {"env":"production","release":"dev"} on 2026-07-18 while the
// frontend correctly carried a real SHA. Every edge Sentry event, log and trace
// was tagged with a value that cannot be traced to a commit — and nothing
// reported that as a problem, because the `observability` feature group looks
// only at whether a DSN is present.

Deno.test("US-2001: a real SHA is ok", () => {
  assertEquals(
    releaseReadiness("c9631342084bfd9e96883321a07a390d3be1e814", "production"),
    "ok",
  );
});

Deno.test("US-2001: the Dockerfile's literal default is degraded in production", () => {
  const r = releaseReadiness("dev", "production");
  assert(r.startsWith("unattributable:"), `expected degraded, got "${r}"`);
  // The operator reading /health/ready needs to know WHAT to fix, not just that
  // something is wrong.
  assert(r.includes("GIT_SHA"), "must name the build arg that is missing");
  assert(!r.includes("[non-production]"));
});

Deno.test("US-2001: releaseSha()'s no-env fallback is degraded too", () => {
  // "dev" comes from the Dockerfile ARG; "unknown" comes from releaseSha() when
  // no SHA env var is set at all. Both are unattributable and both must report.
  assert(releaseReadiness("unknown", "production").startsWith("unattributable:"));
  assert(releaseReadiness("", "production").startsWith("unattributable:"));
  assert(releaseReadiness("   ", "production").startsWith("unattributable:"));
  assert(releaseReadiness("DEV", "production").startsWith("unattributable:"));
});

Deno.test("US-2001: an untagged non-production build is flagged, not alarming", () => {
  const r = releaseReadiness("dev", "development");
  assert(r.includes("[non-production]"), "local builds are expected to be untagged");
});

Deno.test("US-2001: a degraded release NEVER flips the service to not_ready", () => {
  // Deliberate: refusing readiness on an untagged build would pull grading and
  // payments out of rotation to protect observability. The feature entry is
  // informational, exactly like every other one.
  const s = summarizeReadiness(true, [], {
    release: releaseReadiness("dev", "production"),
  });
  assert(s.ready, "observability degradation must not take the container down");
  assertEquals(s.httpStatus, 200);
  assertEquals(s.body.status, "ready");
  assert(String(s.body.features?.release).startsWith("unattributable:"));
});

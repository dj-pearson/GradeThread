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

const {
  summarizeReadiness,
  summarizeSchema,
  releaseReadiness,
  watchdogReadiness,
  WATCHDOG_STALE_AFTER_MS,
} = await import("../routes/health.ts");

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

Deno.test("US-2620: a hole under the maximum outranks 'match'", () => {
  // Production reported {"expected":"00606","applied":"00606","status":"match",
  // "missing":["00594"]} — a migration that never ran, sitting next to a field
  // saying the schema matched. Both versions are MAXIMA, and a max cannot see a
  // hole beneath it. launch-checklist's "All migrations applied" row tells an
  // operator to look for status:"match" and caveats the maximum in prose, which
  // is not where anyone looks mid-incident.
  const gap = summarizeSchema("00606", "00606", {
    missing: ["00594"],
    unexpected: [],
    checked: true,
  });
  assertEquals(gap.status, "incomplete");
  assertEquals(gap.missing, ["00594"]);

  // Complete set → the version relation stands.
  const clean = summarizeSchema("00606", "00606", {
    missing: [],
    unexpected: [],
    checked: true,
  });
  assertEquals(clean.status, "match");

  // ONLY "match" is overridden. Relabelling a worse state would hide a more
  // severe finding behind a less severe word — this fix, inverted.
  const behind = summarizeSchema("00606", "00600", {
    missing: ["00594"],
    unexpected: [],
    checked: true,
  });
  assertEquals(behind.status, "behind");
  const unknown = summarizeSchema("00606", null, {
    missing: ["00594"],
    unexpected: [],
    checked: true,
  });
  assertEquals(unknown.status, "unknown");

  // An unread set is not a clean one, and must not be dressed as either.
  const unread = summarizeSchema("00606", "00606", {
    missing: [],
    unexpected: [],
    checked: false,
  });
  assertEquals(unread.status, "match");
  assertEquals(unread.complete, false);
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

// ── US-2447: the host hang-watchdog feature entry ──────────────────────────
//
// The watchdog is the only thing that ends an edge hang (`restart:
// unless-stopped` fires on process EXIT and a hang never exits), it lives on the
// host, and until this entry existed nothing off-host could say whether it was
// still installed. The 2026-08-09 occurrence ran at least ~8 minutes against a
// documented ~60s cap with no way to tell late from absent.

const NOW = 1_800_000_000_000;

Deno.test("US-2447: a null heartbeat reports unconfigured, not ok", () => {
  // This is what prod will say until an operator installs the script, and
  // saying so is the entire point — the true state today IS unknown, and the
  // silence it replaces was the bug.
  const r = watchdogReadiness(null, NOW);
  assert(r.startsWith("unconfigured:"), r);
  assert(r.includes("edge-watchdog.sh"), "must name what to install");
});

Deno.test("US-2447: a garbage or zero timestamp is unconfigured, never ok", () => {
  // The value comes from a jsonb column. A 0 or a NaN reading as "fresh" would
  // report a watchdog that has never run as healthy, which is the one direction
  // this check must not fail in.
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert(
      watchdogReadiness(bad, NOW).startsWith("unconfigured:"),
      `${bad} must not read as a heartbeat`,
    );
  }
});

Deno.test("US-2447: a recent heartbeat is ok, an old one names its age", () => {
  assertEquals(watchdogReadiness(NOW - 60_000, NOW), "ok");
  assertEquals(watchdogReadiness(NOW - WATCHDOG_STALE_AFTER_MS, NOW), "ok");
  const stale = watchdogReadiness(NOW - WATCHDOG_STALE_AFTER_MS - 60_000, NOW);
  assert(stale.startsWith("stale:"), stale);
  assert(stale.includes("16m"), `must state the age, got: ${stale}`);
});

Deno.test("US-2447: a heartbeat from the future is clock skew, not a third verdict", () => {
  // The question is "did something check in recently". It did. Inventing a
  // "skewed" state here would put a second failure mode in front of an operator
  // who is trying to answer a yes/no.
  assertEquals(watchdogReadiness(NOW + 3_600_000, NOW), "ok");
});

Deno.test("US-2447: a missing watchdog NEVER flips the service to not_ready", () => {
  // Same trade as the release entry above, and the sharper version of it:
  // pulling the edge out of rotation to protest a missing safety net would
  // cause the outage the safety net exists to shorten.
  const s = summarizeReadiness(true, [], {
    hostWatchdog: watchdogReadiness(null, NOW),
  });
  assert(s.ready, "a missing safety net must not take the container down");
  assertEquals(s.httpStatus, 200);
  assertEquals(s.body.status, "ready");
  assert(String(s.body.features?.hostWatchdog).startsWith("unconfigured:"));
});

// ---------------------------------------------------------------------------
// US-2603: the applied SET on /health/ready.
//
// The bug this closes is not hypothetical. On 2026-08-15 prod reported
// {"expected":"00603","applied":"00606","status":"ahead"} while the owner
// confirmed only SOME of 00604-00606 had run. `applied` is a max, and a max
// cannot see a hole beneath it — so the very next edge deploy would have read
// expected 00606 / applied 00606 and printed "match" against a database missing
// whatever was skipped. checkSchemaCompleteness has computed the right answer
// since US-2009; it only ever wrote it to a container log.

Deno.test("US-2603: a gap under the watermark is named, and now outranks the max", () => {
  const s = summarizeSchema("00606", "00606", {
    missing: ["00605"],
    unexpected: [],
    checked: true,
  });
  assertEquals(s.missing, ["00605"], "the endpoint names the hole");
  // THIS ASSERTION USED TO READ `status === "match"`, with the note "the max
  // comparison is genuinely satisfied". That was true and it was the wrong
  // thing to publish (US-2620). Adding `missing` fixed half the problem: the
  // hole became visible to anyone who read the whole object. But
  // vault/10-ops/launch-checklist.md's "All migrations applied" row tells an
  // operator to look for `status:"match"` and caveats the maximum in prose,
  // which is not where anyone looks mid-incident — so the field they were sent
  // to read still said the schema was fine while the object named a migration
  // missing from it.
  assertEquals(s.status, "incomplete");
});

Deno.test("US-2603: a complete set adds no noise", () => {
  const s = summarizeSchema("00606", "00606", {
    missing: [],
    unexpected: [],
    checked: true,
  });
  assertEquals(s.missing, undefined);
  assertEquals(s.unexpected, undefined);
  assertEquals(s.complete, undefined, "clean is the absence of a finding, not a field");
});

Deno.test("US-2603: an unreadable set NEVER renders as clean", () => {
  const s = summarizeSchema("00606", "00606", {
    missing: [],
    unexpected: [],
    checked: false,
  });
  assertEquals(s.complete, false, "'we do not know' must be distinguishable from 'clean'");
  assertEquals(s.missing, undefined, "and must not publish an empty set that reads as proof");
});

Deno.test("US-2603: phantoms are reported separately from gaps", () => {
  // Opposite meanings: `missing` is a migration that never ran, `unexpected` is
  // a version the DB recorded with no file in this build (a rollback, or a
  // deploy from a branch). Merging them into one count would make an operator
  // apply the wrong fix.
  const s = summarizeSchema("00606", "00607", {
    missing: [],
    unexpected: ["00607"],
    checked: true,
  });
  assertEquals(s.unexpected, ["00607"]);
  assertEquals(s.missing, undefined);
});

Deno.test("US-2603: schema completeness is omitted entirely when the DB is down", () => {
  // dbOk false means the read never happened. Reporting `complete:false` would
  // be true but redundant — the database check already failed loudly.
  const s = summarizeSchema("00606", null);
  assertEquals(s.status, "unknown");
  assertEquals(s.complete, undefined);
});

Deno.test("US-2603: a gap does NOT flip the container out of rotation", () => {
  // Same trade as the release and watchdog entries above. Pulling the edge from
  // rotation over a diagnostic would convert a visibility win into an outage,
  // and the schema block has never been allowed to affect `ready`.
  const r = summarizeReadiness(true, [], {}, summarizeSchema("00606", "00606", {
    missing: ["00605"],
    unexpected: [],
    checked: true,
  }));
  assert(r.ready);
  assertEquals(r.httpStatus, 200);
  assertEquals(r.body.schema?.missing, ["00605"]);
});

Deno.test("US-2603: the completeness read is cached, and failures are not", async () => {
  const { cachedSchemaCompleteness, resetSchemaCompletenessCache, SCHEMA_COMPLETENESS_TTL_MS } =
    await import("../routes/health.ts");

  resetSchemaCompletenessCache();
  let reads = 0;
  const ok = () => {
    reads++;
    return Promise.resolve({ missing: ["00605"], unexpected: [], checked: true });
  };

  const t0 = 1_000_000;
  assertEquals((await cachedSchemaCompleteness(t0, ok)).missing, ["00605"]);
  await cachedSchemaCompleteness(t0 + 1_000, ok);
  await cachedSchemaCompleteness(t0 + SCHEMA_COMPLETENESS_TTL_MS - 1, ok);
  assertEquals(reads, 1, "an uptime monitor polling every few seconds pays for one read");

  await cachedSchemaCompleteness(t0 + SCHEMA_COMPLETENESS_TTL_MS, ok);
  assertEquals(reads, 2, "and a migration applied while the container is up shows within a minute");

  // A failed read must not be held: caching "we do not know" would keep
  // answering "we do not know" for a minute after the blip cleared.
  resetSchemaCompletenessCache();
  let fails = 0;
  const bad = () => {
    fails++;
    return Promise.resolve({ missing: [], unexpected: [], checked: false });
  };
  await cachedSchemaCompleteness(t0, bad);
  await cachedSchemaCompleteness(t0 + 1_000, bad);
  assertEquals(fails, 2, "a failed read is retried, not cached");
  resetSchemaCompletenessCache();
});

// ── The SHAPE is a contract with the external uptime monitor (US-2447) ──
//
// scripts/ops/uptime-check.mjs reads `features.hostWatchdog` out of this body to
// report, in the text of an incident issue, whether the edge-hang watchdog was
// alive. It spent its whole life reading `checks.features.hostWatchdog` — a path
// that does not exist here — and returned undefined on every run, silently,
// because an optional chain over a wrong path is indistinguishable from a
// healthy field.
//
// The monitor now has its own test against a captured response. This is the
// OTHER half: the producer must not move the field out from under it. Two
// components, one contract, and until now neither side pinned it.
Deno.test("US-2447: `features` is a TOP-LEVEL key, beside `checks` and not inside it", () => {
  const s = summarizeReadiness(true, [], { hostWatchdog: "unconfigured: nobody home" });
  const body = s.body as Record<string, unknown>;

  assert("features" in body, "the uptime monitor reads body.features — it must stay top-level");
  const checks = body.checks as Record<string, unknown>;
  assert(
    !("features" in checks),
    "features must NOT be nested under checks: that is the exact path the monitor " +
      "wrongly read for months, and putting it there would make the broken read " +
      "start working while the correct one silently stops",
  );
  assertEquals(
    (body.features as Record<string, string>).hostWatchdog,
    "unconfigured: nobody home",
    "hostWatchdog must survive to body.features.hostWatchdog verbatim",
  );
});

Deno.test("US-2447: readiness stays a decision about DB and env, not about features", () => {
  // The monitor treats a non-ok feature as a NOTE, never a failure, on the
  // grounds that hostWatchdog reads unconfigured on any host that has not
  // installed the script — paging on it would mean an alert every ten minutes
  // forever. That reasoning only holds while a bad feature cannot flip the
  // status, so pin it here rather than trusting the two files to agree.
  const withBadFeature = summarizeReadiness(true, [], {
    hostWatchdog: "unconfigured: nobody home",
    release: 'unattributable: release="unknown"',
  });
  assertEquals(withBadFeature.httpStatus, 200);
  assertEquals((withBadFeature.body as Record<string, unknown>).status, "ready");
});

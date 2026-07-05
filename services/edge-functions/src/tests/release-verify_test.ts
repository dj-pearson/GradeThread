// US-1610: release verification pure logic — deploy detection, baseline
// comparison (regression + clean), memo verdicts, and state rollover.
import { assert, assertEquals } from "@std/assert";
import {
  assembleReleaseMemo,
  compareRelease,
  DEFAULT_THRESHOLDS,
  detectDeploy,
  nextReleaseState,
  type ReleaseMetrics,
} from "../lib/release-verify.ts";

const m = (over: Partial<ReleaseMetrics> = {}): ReleaseMetrics => ({ job_failures_24h: 0, webhook_dlq: 0, email_dlq: 0, ...over });

// ── Deploy detection ─────────────────────────────────────────────────────────

Deno.test("detectDeploy: a changed SHA is a deploy; same or unknown is not", () => {
  assertEquals(detectDeploy("b", "a").deployed, true);
  assertEquals(detectDeploy("a", "a").deployed, false);
  assertEquals(detectDeploy(null, "a").deployed, false); // unknown current
  assertEquals(detectDeploy("b", null).deployed, true); // first known SHA
  const d = detectDeploy("newsha", "oldsha");
  assertEquals(d.from_sha, "oldsha");
  assertEquals(d.to_sha, "newsha");
});

// ── Comparison ───────────────────────────────────────────────────────────────

Deno.test("compareRelease: no baseline → not comparable, never a regression", () => {
  const c = compareRelease(null, m({ job_failures_24h: 100 }));
  assertEquals(c.comparable, false);
  assertEquals(c.regressed, false);
});

Deno.test("compareRelease: a metric up past both the absolute floor AND ratio band regresses", () => {
  const c = compareRelease(m({ job_failures_24h: 1 }), m({ job_failures_24h: 12 }));
  assertEquals(c.regressed, true);
  assertEquals(c.regressions[0].metric, "job_failures_24h");
  assertEquals(c.regressions[0].delta, 11);
});

Deno.test("compareRelease: small noise under the floor is NOT a regression", () => {
  // +2 absolute (< min_absolute 3) even though it doubled → not flagged.
  assertEquals(compareRelease(m({ webhook_dlq: 2 }), m({ webhook_dlq: 4 }), DEFAULT_THRESHOLDS).regressed, false);
  // +5 absolute but only +12% (< 50% ratio band) → not flagged.
  assertEquals(compareRelease(m({ email_dlq: 40 }), m({ email_dlq: 45 })).regressed, false);
});

// ── Memo verdicts ────────────────────────────────────────────────────────────

Deno.test("assembleReleaseMemo: verdict per case", () => {
  const noDeploy = assembleReleaseMemo(detectDeploy("a", "a"), m(), compareRelease(m(), m()));
  assertEquals(noDeploy.verdict, "no_deploy");

  const firstSeen = assembleReleaseMemo(detectDeploy("a", null), m(), compareRelease(null, m()));
  assertEquals(firstSeen.verdict, "insufficient_baseline");

  const clean = assembleReleaseMemo(detectDeploy("b", "a"), m({ job_failures_24h: 1 }), compareRelease(m({ job_failures_24h: 1 }), m({ job_failures_24h: 1 })));
  assertEquals(clean.verdict, "clean");

  const regressed = assembleReleaseMemo(detectDeploy("b", "a"), m({ job_failures_24h: 20 }), compareRelease(m({ job_failures_24h: 1 }), m({ job_failures_24h: 20 })));
  assertEquals(regressed.verdict, "regression");
  assert(regressed.summary.includes("Regression"));
});

// ── State rollover ───────────────────────────────────────────────────────────

Deno.test("nextReleaseState: adopts the current SHA + sets the baseline to the just-seen metrics", () => {
  const s = nextReleaseState(detectDeploy("newsha", "oldsha"), m({ job_failures_24h: 3 }), "2026-07-05T00:00:00.000Z");
  assertEquals(s.last_sha, "newsha");
  assertEquals(s.baseline?.job_failures_24h, 3);
  assertEquals(s.checked_at, "2026-07-05T00:00:00.000Z");
  // No deploy → keeps the (unchanged) SHA, refreshes the baseline.
  const s2 = nextReleaseState(detectDeploy("a", "a"), m({ webhook_dlq: 9 }), "2026-07-05T01:00:00.000Z");
  assertEquals(s2.last_sha, "a");
  assertEquals(s2.baseline?.webhook_dlq, 9);
});

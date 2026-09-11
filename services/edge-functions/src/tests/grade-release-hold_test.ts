// US-3326: a finished grade waits for the turnaround the customer paid for.
//
//   deno test --allow-net --allow-env --allow-read src/tests/grade-release-hold_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  computeReleaseAt,
  holdEnabled,
  isBeforeRelease,
} from "../lib/grade-release.ts";

const PAID = "2026-09-10T12:00:00.000Z";

Deno.test("release_at is paid time plus the tier's hours", () => {
  assertEquals(
    computeReleaseAt({ enabled: true, tier: "standard", slaHours: 48, paidAt: PAID }),
    "2026-09-12T12:00:00.000Z",
  );
  assertEquals(
    computeReleaseAt({ enabled: true, tier: "premium", slaHours: 12, paidAt: PAID }),
    "2026-09-11T00:00:00.000Z",
  );
});

Deno.test("Express is never held: its promise is as soon as it is ready", () => {
  assertEquals(
    computeReleaseAt({ enabled: true, tier: "express", slaHours: 1, paidAt: PAID }),
    null,
  );
});

Deno.test("hold off = no release_at, so every path is today's", () => {
  assertEquals(
    computeReleaseAt({ enabled: false, tier: "standard", slaHours: 48, paidAt: PAID }),
    null,
  );
});

Deno.test("a broken SLA holds nothing rather than holding forever", () => {
  for (const slaHours of [0, -5, NaN, null, undefined]) {
    assertEquals(
      computeReleaseAt({ enabled: true, tier: "standard", slaHours, paidAt: PAID }),
      null,
    );
  }
});

Deno.test("the clock starts at payment, then creation, then now", () => {
  assertEquals(
    computeReleaseAt({
      enabled: true,
      tier: "premium",
      slaHours: 12,
      paidAt: null,
      createdAt: PAID,
    }),
    "2026-09-11T00:00:00.000Z",
  );
  const now = Date.parse(PAID);
  assertEquals(
    computeReleaseAt({ enabled: true, tier: "premium", slaHours: 12, now }),
    "2026-09-11T00:00:00.000Z",
  );
  // A missing tier is Standard, the cheapest promise.
  assertEquals(
    computeReleaseAt({ enabled: true, tier: null, slaHours: 48, paidAt: PAID }),
    "2026-09-12T12:00:00.000Z",
  );
});

Deno.test("isBeforeRelease: null and past are released; only the future is held", () => {
  const now = Date.parse(PAID);
  assertEquals(isBeforeRelease(null, now), false);
  assertEquals(isBeforeRelease("2026-09-10T11:59:59.000Z", now), false);
  assertEquals(isBeforeRelease(PAID, now), false);
  assertEquals(isBeforeRelease("2026-09-10T12:00:01.000Z", now), true);
  assertEquals(isBeforeRelease("not a date", now), false);
});

Deno.test("the setting fails closed: only literal true turns the hold on", () => {
  assertEquals(holdEnabled({ enabled: true }), true);
  for (const v of [null, undefined, {}, { enabled: false }, { enabled: "true" as unknown as boolean }]) {
    assertEquals(holdEnabled(v), false);
  }
});

// ── source guards ───────────────────────────────────────────────────────────

const SRC = new URL("../", import.meta.url);
function read(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, SRC)).replace(/\r\n/g, "\n");
}
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert(start >= 0, `${signature} not found`);
  const next = src.indexOf("\nexport ", start + signature.length);
  return src.slice(start, next < 0 ? undefined : next);
}

const pipeline = stripComments(read("lib/grading-pipeline.ts"));

Deno.test("finalize holds BEFORE any go-live wiring, and only when not forced", () => {
  const body = fnBody(pipeline, "export async function finalizeGradeReview(");
  const hold = body.indexOf("if (!release.force && isBeforeRelease(r.release_at))");
  const goLive = body.indexOf("applyTerminalCompletion(");
  const finalizeWrite = body.indexOf("finalized_at: nowIso");
  assert(hold > 0, "hold branch missing");
  assert(hold < finalizeWrite, "hold must come before finalized_at is written");
  assert(hold < goLive, "hold must come before the go-live wiring");
  // Exactly-once go-live still rests on the atomic finalized_at flip.
  assert(/\.is\("finalized_at", null\)\s*\n\s*\.select\("id"\)/.test(body));
});

Deno.test("one release path: the job and a super admin both go through releaseHeldGrade", () => {
  const release = fnBody(pipeline, "export async function releaseHeldGrade(");
  assert(release.includes("{ force: true, reviewedAt: g.reviewed_at }"));
  const job = stripComments(read("routes/jobs-grade-release.ts"));
  assert(job.includes("releaseHeldGrade("));
  assert(!job.includes("finalizeGradeReview("), "the job must not finalize around releaseHeldGrade");
});

Deno.test("hold off = the report insert is byte-identical (release_at only when set)", () => {
  assert(pipeline.includes("...(releaseAt ? { release_at: releaseAt } : {}),"));
  assert(/if \(holdEnabled\(holdSetting\)\) \{/.test(pipeline));
});

Deno.test("the early preliminary notice waits while the grade is held", () => {
  assert(/if \(!isBeforeRelease\(releaseAt\)\) \{\s*\n\s*sendPreliminaryNotices\(/.test(pipeline));
});

Deno.test("service-role owner reads hide a held grade the way RLS does", () => {
  assert(stripComments(read("routes/grade.ts")).includes("isBeforeRelease(heldUntil)"));
  const api = stripComments(read("lib/api-grades.ts"));
  assertEquals((api.match(/isBeforeRelease\(/g) ?? []).length, 2, "both API reads (single and list)");
});

Deno.test("00786: owner and workspace policies hide rows until release_at; the setting ships off", () => {
  const sql = Deno.readTextFileSync(
    new URL("../../../../supabase/migrations/00786_grade_release_hold.sql", import.meta.url),
  );
  const guard = "(grade_reports.release_at IS NULL OR grade_reports.release_at <= now())";
  assertEquals(sql.split(guard).length - 1, 2);
  assert(sql.includes(`'{"enabled": false}'::jsonb`));
  assert(sql.includes("'pending', 'approved', 'modified', 'held'"));
});

// ── the job refuses callers without the secret ─────────────────────────────

Deno.test("the release job is job-secret gated", async () => {
  Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
  Deno.env.set(
    "SUPABASE_SERVICE_ROLE_KEY",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
  );
  Deno.env.set("FLIPDESK_INTERNAL_JOB_SECRET", "grade-release-test-secret");
  const { Hono } = await import("hono");
  const { handleGradeReleaseCron } = await import("../routes/jobs-grade-release.ts");
  const app = new Hono();
  app.post("/api/jobs/grade-release", (c) => handleGradeReleaseCron(c));
  const res = await app.request("/api/jobs/grade-release", { method: "POST" });
  assertEquals(res.status, 401);
  const wrong = await app.request("/api/jobs/grade-release", {
    method: "POST",
    headers: { "X-Internal-Job-Secret": "nope" },
  });
  assertEquals(wrong.status, 401);
});

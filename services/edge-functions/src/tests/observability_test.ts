// US-491/497/508: observability module — release identity, structured logging
// with redaction, metric emission, correlation ids, and Sentry transport gating.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  captureException,
  isErrorTrackingConfigured,
  logEvent,
  newCorrelationId,
  recordMetric,
  releaseSha,
  timed,
} from "../lib/observability.ts";

// Capture console output for one fn() call.
function captureConsole(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    fn();
  } finally {
    Object.assign(console, orig);
  }
  return lines;
}

Deno.test("releaseSha reads RELEASE_SHA and truncates to 40 chars", () => {
  // cachedRelease memoizes, so this asserts the shape rather than a specific env.
  const sha = releaseSha();
  assert(sha.length <= 40);
  assert(sha.length > 0);
});

Deno.test("newCorrelationId is a unique uuid", () => {
  const a = newCorrelationId();
  const b = newCorrelationId();
  assert(a !== b);
  assert(/^[0-9a-f-]{36}$/.test(a));
});

Deno.test("logEvent emits one structured JSON line with the event + fields", () => {
  const lines = captureConsole(() =>
    logEvent("info", "test.event", { correlationId: "cid-1", foo: "bar" })
  );
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed.level, "info");
  assertEquals(parsed.event, "test.event");
  assertEquals(parsed.correlationId, "cid-1");
  assertEquals(parsed.foo, "bar");
  assert(typeof parsed.ts === "string");
});

Deno.test("logEvent redacts secrets and emails in fields", () => {
  const lines = captureConsole(() =>
    logEvent("warn", "leak", {
      email: "person@example.com",
      key: "sk_live_abcdefgh12345678",
    })
  );
  const line = lines[0];
  assert(!line.includes("person@example.com"), "email must be redacted");
  assert(!line.includes("sk_live_abcdefgh12345678"), "stripe key must be redacted");
  assertStringIncludes(line, "[redacted");
});

Deno.test("logEvent survives unserializable fields", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const lines = captureConsole(() => logEvent("error", "bad", circular));
  assertEquals(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed.event, "bad");
});

Deno.test("recordMetric emits a metric line", () => {
  const lines = captureConsole(() =>
    recordMetric("grade.latency", 1234, { unit: "ms", route: "grade.submit" })
  );
  const parsed = JSON.parse(lines[0]);
  assertEquals(parsed.event, "metric");
  assertEquals(parsed.metric, "grade.latency");
  assertEquals(parsed.value, 1234);
});

Deno.test("timed records ok outcome and returns the value", async () => {
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => captured.push(a.join(" "));
  try {
    const out = await timed("op", () => Promise.resolve(42), { route: "x" });
    assertEquals(out, 42);
  } finally {
    console.log = orig;
  }
  const metric = captured.map((l) => JSON.parse(l)).find((p) => p.event === "metric");
  assert(metric, "expected a metric line");
  assertEquals(metric.outcome, "ok");
});

Deno.test("timed records error outcome and re-throws", async () => {
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => captured.push(a.join(" "));
  let threw = false;
  try {
    await timed("op", () => Promise.reject(new Error("boom")));
  } catch {
    threw = true;
  } finally {
    console.log = orig;
  }
  assert(threw, "timed must re-throw");
  const metric = captured.map((l) => JSON.parse(l)).find((p) => p.event === "metric");
  assertEquals(metric.outcome, "error");
});

Deno.test("captureException never throws and always logs locally", () => {
  // No SENTRY_DSN in the test env → local-log-only path; must not throw.
  const lines = captureConsole(() =>
    captureException(new Error("kaboom"), { route: "r", correlationId: "cid" })
  );
  const parsed = lines.map((l) => JSON.parse(l)).find((p) => p.event === "exception");
  assert(parsed, "expected an exception breadcrumb");
  assertStringIncludes(parsed.error, "kaboom");
});

Deno.test("isErrorTrackingConfigured reflects SENTRY_DSN presence", () => {
  // Default test env has no DSN.
  assertEquals(isErrorTrackingConfigured(), !!Deno.env.get("SENTRY_DSN")?.trim());
});

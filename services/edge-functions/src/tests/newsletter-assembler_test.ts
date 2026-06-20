import { assert, assertEquals } from "@std/assert";

// US-922: the assembler's pure helpers (period key, scheduled-instant, what's-new
// block, step ledger) live in a module that statically imports lib/supabase.ts, so
// set env FIRST then dynamic-import (mirrors ops-jobs_test.ts).
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

const {
  ASSEMBLY_STEPS,
  buildWhatsNewSection,
  computePeriodKey,
  initBuildSteps,
  nextSendAt,
} = await import("../lib/newsletter-assembler.ts");

const DAY = 86_400_000;

Deno.test("computePeriodKey is stable within a period and advances across periods", () => {
  const base = 7 * 150 * DAY; // aligned to a 7-day period boundary
  const a = computePeriodKey(base, 7);
  const b = computePeriodKey(base + 3 * DAY, 7); // same 7-day window
  const c = computePeriodKey(base + 8 * DAY, 7); // next window
  assertEquals(a, b);
  assert(a !== c);
});

Deno.test("computePeriodKey guards a zero/negative cadence", () => {
  // Falls back to a 1-day period rather than dividing by zero.
  assert(computePeriodKey(5 * DAY, 0).startsWith("p"));
  assert(computePeriodKey(5 * DAY, -3).startsWith("p"));
});

Deno.test("nextSendAt returns the next future instant at the target hour", () => {
  const now = Date.UTC(2026, 5, 20, 10, 30); // 10:30 UTC
  const at14 = new Date(nextSendAt(14, now));
  assertEquals(at14.getUTCHours(), 14);
  assert(at14.getTime() > now);
  // An hour already past today rolls to tomorrow.
  const at9 = new Date(nextSendAt(9, now));
  assertEquals(at9.getUTCHours(), 9);
  assert(at9.getTime() > now);
});

Deno.test("buildWhatsNewSection is null when there's nothing new (evergreen lean)", () => {
  assertEquals(buildWhatsNewSection([]), null);
});

Deno.test("buildWhatsNewSection escapes titles + summaries", () => {
  const sec = buildWhatsNewSection([
    { id: "1", title: "A & B <tag>", summary: "x > y", productFocus: "both", publishedAt: "2026-06-01" },
  ]);
  assert(sec !== null);
  assert(sec!.body.includes("A &amp; B &lt;tag&gt;"));
  assert(sec!.body.includes("x &gt; y"));
  assert(!sec!.body.includes("<tag>"));
});

Deno.test("initBuildSteps starts every step pending", () => {
  const steps = initBuildSteps();
  for (const step of ASSEMBLY_STEPS) {
    assertEquals(steps[step].status, "pending");
  }
});

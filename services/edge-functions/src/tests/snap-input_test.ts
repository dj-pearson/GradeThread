// SNAP-03 / SNAP-09: the pure parts of POST /api/grade/snap.
import { assert, assertEquals } from "@std/assert";
import {
  normalizeSnapText,
  SNAP_BRAND_MAX,
  SNAP_KEYWORD_MAX,
  snapImageRejection,
  snapLimitBody,
  snapUsageAfterReserve,
} from "../lib/snap-input.ts";

Deno.test("normalizeSnapText strips control characters and collapses whitespace", () => {
  const raw = `  Pata${String.fromCharCode(0)}gonia\n\t${String.fromCharCode(0x1b)}[31m  ${
    String.fromCharCode(0x85)
  }`;
  assertEquals(normalizeSnapText(raw, SNAP_BRAND_MAX), "Pata gonia [31m");
});

Deno.test("normalizeSnapText bounds a huge value", () => {
  assertEquals(normalizeSnapText("a".repeat(300), SNAP_BRAND_MAX)?.length, 80);
  assertEquals(normalizeSnapText("b".repeat(200_000), SNAP_BRAND_MAX)?.length, 80);
  assertEquals(normalizeSnapText("c".repeat(300), SNAP_KEYWORD_MAX)?.length, 200);
});

Deno.test("normalizeSnapText treats whitespace-only and non-strings as absent", () => {
  assertEquals(normalizeSnapText("   \n\t ", SNAP_BRAND_MAX), undefined);
  assertEquals(normalizeSnapText(String.fromCharCode(0, 1, 2), SNAP_BRAND_MAX), undefined);
  assertEquals(normalizeSnapText(42, SNAP_BRAND_MAX), undefined);
  assertEquals(normalizeSnapText(null, SNAP_BRAND_MAX), undefined);
  assertEquals(normalizeSnapText({ toString: () => "x" }, SNAP_BRAND_MAX), undefined);
});

Deno.test("snapLimitBody says 'free' only to the free plan", () => {
  const free = snapLimitBody("free", 15);
  assert(free.error.includes("15 free Snap-to-Value checks"));
  assertEquals(free.code, "SNAP_LIMIT_REACHED");
  assertEquals(free.action, "upgrade");
  for (const plan of ["starter", "pro"]) {
    const paid = snapLimitBody(plan, 60);
    assert(!/\bfree\b/i.test(paid.error), `${plan}: ${paid.error}`);
    assert(paid.error.includes("60 Snap-to-Value checks"));
    assertEquals(paid.code, "SNAP_LIMIT_REACHED");
  }
});

Deno.test("snapImageRejection maps size refusals to plain copy", () => {
  assertEquals(snapImageRejection("File too large (5000000 bytes; max 4500000)").status, 413);
  const small = snapImageRejection("Image too small (300x200; the longest side must be at least 500px)");
  assertEquals(small.status, 400);
  assert(small.error.includes("500 pixels"));
  const other = snapImageRejection("Unrecognized or unsupported image format");
  assertEquals(other.status, 400);
  assert(other.error.startsWith("Invalid image:"));
});

Deno.test("snapUsageAfterReserve counts the reserved snap in the current month", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const u = snapUsageAfterReserve({ usedBefore: 11, resetAt: "2026-09-02T00:00:00Z", cap: 15, now });
  assertEquals(u, { used: 12, cap: 15, resets_at: "2026-10-01T00:00:00.000Z" });
});

Deno.test("snapUsageAfterReserve starts over after a month rollover", () => {
  const now = new Date("2026-10-01T00:05:00Z");
  const u = snapUsageAfterReserve({ usedBefore: 15, resetAt: "2026-09-14T00:00:00Z", cap: 15, now });
  assertEquals(u.used, 1);
  assertEquals(u.resets_at, "2026-11-01T00:00:00.000Z");
  // December rolls into next year.
  const dec = snapUsageAfterReserve({
    usedBefore: 0,
    resetAt: "2026-12-01T00:00:00Z",
    cap: 15,
    now: new Date("2026-12-31T23:00:00Z"),
  });
  assertEquals(dec.resets_at, "2027-01-01T00:00:00.000Z");
});

Deno.test("snapUsageAfterReserve reports an unlimited plan as a null cap", () => {
  const u = snapUsageAfterReserve({
    usedBefore: 400,
    resetAt: "2026-09-01T00:00:00Z",
    cap: -1,
    now: new Date("2026-09-24T00:00:00Z"),
  });
  assertEquals(u.cap, null);
  assertEquals(u.used, 401);
});

Deno.test("snapUsageAfterReserve tolerates a missing counter", () => {
  const u = snapUsageAfterReserve({ usedBefore: null, resetAt: null, cap: 15 });
  assertEquals(u.used, 1);
});

// Source guards on the handler: these are wiring, and the route itself needs a
// database and a model to run.
const grade = await Deno.readTextFile(new URL("../routes/grade.ts", import.meta.url));
const at = grade.indexOf('gradeRoutes.post("/snap"');
const handler = grade.slice(at, grade.indexOf("\ngradeRoutes.", at + 10));

Deno.test("the /snap handler bounds brand and keyword before use", () => {
  assert(handler.includes("normalizeSnapText(body.brand, SNAP_BRAND_MAX)"));
  assert(handler.includes("normalizeSnapText(body.keyword, SNAP_KEYWORD_MAX)"));
  assert(!handler.includes("body.brand.trim()"));
});

Deno.test("a reserve_snap error is a 503, not the allowance wall", () => {
  const err = handler.indexOf("if (reserveError)");
  const wall = handler.indexOf("snapLimitBody(effPlan, snapCap)");
  assert(err > -1 && wall > err, "the error branch must come before the limit branch");
  assert(handler.slice(err, wall).includes('code: "SNAP_UNAVAILABLE"'));
  assert(handler.slice(err, wall).includes("503"));
});

Deno.test("the AI ceiling is reported as capacity after the refund", () => {
  const refund = handler.indexOf("await refundReservedSnap(ownerId);");
  const ceiling = handler.indexOf("err instanceof AiCeilingError");
  assert(refund > -1 && ceiling > refund);
  assert(handler.slice(ceiling, ceiling + 600).includes('code: "AI_AT_CAPACITY"'));
});

Deno.test("the snap image cap matches the vision limit", () => {
  assert(handler.includes("maxBytes: SNAP_MAX_IMAGE_BYTES"));
  assert(handler.includes("minDimension: SNAP_MIN_IMAGE_EDGE"));
});

Deno.test("the response carries usage and the review signal, and comps are cached", () => {
  assert(handler.includes("needs_review: grade.needsHumanReview"));
  assert(handler.includes("caps_applied: grade.capsApplied"));
  assert(handler.includes("screenshot_detected:"));
  assert(handler.includes("    usage,\n"));
  assert(handler.includes("cachedSuggestCategories(compQuery)"));
  assert(handler.includes("cachedValueAtGrade("));
  assert(!/[^d]suggestCategories\(/.test(handler.replace(/cachedSuggestCategories/g, "")));
});

Deno.test("the snap limiter is owner-keyed and fails closed", async () => {
  const main = await Deno.readTextFile(new URL("../main.ts", import.meta.url));
  const i = main.indexOf('"grade-snap"');
  const block = main.slice(i, i + 500);
  assert(block.includes("failClosed: true"));
  assert(block.includes('c.get("workspaceOwnerId") ?? c.get("userId")'));
});

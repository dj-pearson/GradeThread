// US-485: partial-success image partitioning unit tests.
//
// partitionImageResults is pure. ai-grading.ts imports the service-role supabase
// client at load, so set dummy env BEFORE the dynamic import.
//
//   deno test --allow-env src/tests/grading-partial_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { partitionImageResults } = await import("../lib/ai-grading.ts");

const REQUIRED = ["front", "back", "label"] as const;

// Minimal stand-in for a successful PerImageAnalysis (the partitioner only
// checks truthiness + imageType).
// deno-lint-ignore no-explicit-any
const ok = (image_type: string): any => ({ image_type, detected_issues: [] });

Deno.test("all images succeed → all usable, nothing failed", () => {
  const r = partitionImageResults(
    [
      { imageType: "front", result: ok("front") },
      { imageType: "back", result: ok("back") },
      { imageType: "label", result: ok("label") },
      { imageType: "detail", result: ok("detail") },
    ],
    REQUIRED,
  );
  assertEquals(r.usable.length, 4);
  assertEquals(r.failedRequired, []);
  assertEquals(r.failedOptional, []);
});

Deno.test("an optional image failure is tolerated (degrade gracefully)", () => {
  const r = partitionImageResults(
    [
      { imageType: "front", result: ok("front") },
      { imageType: "back", result: ok("back") },
      { imageType: "label", result: ok("label") },
      { imageType: "defect", result: null }, // flaky optional image
      { imageType: "detail2", result: null },
    ],
    REQUIRED,
  );
  assertEquals(r.usable.length, 3);
  assertEquals(r.failedRequired, []);
  assertEquals(r.failedOptional, ["defect", "detail2"]);
});

Deno.test("a required core-angle failure is surfaced (will fail the grade)", () => {
  const r = partitionImageResults(
    [
      { imageType: "front", result: null }, // core angle failed
      { imageType: "back", result: ok("back") },
      { imageType: "label", result: ok("label") },
    ],
    REQUIRED,
  );
  assertEquals(r.usable.length, 2);
  assertEquals(r.failedRequired, ["front"]);
  assertEquals(r.failedOptional, []);
});

Deno.test("a 'detail' (non-core) failure is optional, not required", () => {
  const r = partitionImageResults(
    [
      { imageType: "front", result: ok("front") },
      { imageType: "back", result: ok("back") },
      { imageType: "label", result: ok("label") },
      { imageType: "detail", result: null },
    ],
    REQUIRED,
  );
  assertEquals(r.failedRequired, []);
  assertEquals(r.failedOptional, ["detail"]);
  assert(r.usable.length === 3);
});

Deno.test("total wipeout → all required types reported failed", () => {
  const r = partitionImageResults(
    [
      { imageType: "front", result: null },
      { imageType: "back", result: null },
      { imageType: "label", result: null },
    ],
    REQUIRED,
  );
  assertEquals(r.usable.length, 0);
  assertEquals(r.failedRequired.sort(), ["back", "front", "label"]);
});

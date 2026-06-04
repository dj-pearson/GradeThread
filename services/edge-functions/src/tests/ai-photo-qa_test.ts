// US-537: normalizeQaResult coerces the model's tool output into a clean shape.
// Pure — no Anthropic call — so set dummy supabase env before importing
// (ai-config/supabase load at module init).
//   deno test --allow-env src/tests/ai-photo-qa_test.ts
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { normalizeQaResult } = await import("../lib/ai-photo-qa.ts");

Deno.test("clamps score to 0-100 and rounds", () => {
  assertEquals(normalizeQaResult(150, [], 3).score, 100);
  assertEquals(normalizeQaResult(-5, [], 3).score, 0);
  assertEquals(normalizeQaResult(83.6, [], 3).score, 84);
  assertEquals(normalizeQaResult("nope", [], 3).score, 0);
});

Deno.test("maps valid issues and keeps in-range photo_index", () => {
  const { issues } = normalizeQaResult(
    70,
    [
      { type: "blurry", severity: "high", message: "Front shot is soft.", photo_index: 1 },
      { type: "missing_angle", severity: "medium", message: "No back shot.", photo_index: null },
    ],
    4,
  );
  assertEquals(issues.length, 2);
  assertEquals(issues[0], {
    type: "blurry",
    severity: "high",
    message: "Front shot is soft.",
    photoIndex: 1,
  });
  assertEquals(issues[1]!.photoIndex, null);
});

Deno.test("coerces unknown type/severity and out-of-range index", () => {
  const { issues } = normalizeQaResult(
    50,
    [
      { type: "weird", severity: "catastrophic", message: "Odd.", photo_index: 99 },
    ],
    3,
  );
  assertEquals(issues[0]!.type, "other");
  assertEquals(issues[0]!.severity, "medium");
  assertEquals(issues[0]!.photoIndex, null); // 99 > photoCount 3
});

Deno.test("drops issues with no message and tolerates non-array", () => {
  const a = normalizeQaResult(60, [{ type: "dark", severity: "low" }], 2);
  assertEquals(a.issues.length, 0); // missing message
  const b = normalizeQaResult(60, "not-an-array", 2);
  assertEquals(b.issues, []);
});

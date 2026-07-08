// US-1715: admin brand-knowledge route — buildPatch write-safety boundary.
// The route imports supabase at load (service-role), so set dummy env before the
// dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildPatch } = await import("../routes/admin-brand-knowledge.ts");

function ok(r: unknown): Record<string, unknown> {
  assert(r && typeof r === "object" && "patch" in (r as object), "expected a patch");
  return (r as { patch: Record<string, unknown> }).patch;
}
function err(r: unknown): string {
  assert(r && typeof r === "object" && "error" in (r as object), "expected an error");
  return (r as { error: string }).error;
}

Deno.test("keeps only editable columns and drops the rest", () => {
  const patch = ok(buildPatch("brand_styles", {
    style_name: "ABC Pant",
    visual_fingerprint: "gusseted crotch",
    brand_key: "hacker", // NOT editable — must be dropped
    id: "x", // not editable
  }));
  assertEquals(patch.style_name, "ABC Pant");
  assertEquals(patch.visual_fingerprint, "gusseted crotch");
  assert(!("brand_key" in patch), "brand_key must never be writable");
  assert(!("id" in patch));
});

Deno.test("rejects an all-non-editable patch as empty", () => {
  assertEquals(
    err(buildPatch("brand_styles", { brand_key: "x", bogus: 1 })),
    "No editable fields in the request",
  );
});

Deno.test("validates confidence is a number in [0,1]", () => {
  assertEquals(ok(buildPatch("brand_knowledge", { confidence: 0.8 })).confidence, 0.8);
  assertEquals(ok(buildPatch("brand_knowledge", { confidence: 0 })).confidence, 0);
  assertEquals(ok(buildPatch("brand_knowledge", { confidence: 1 })).confidence, 1);
  assertEquals(ok(buildPatch("brand_knowledge", { confidence: null })).confidence, null);
  assert(err(buildPatch("brand_knowledge", { confidence: 1.5 })).includes("confidence"));
  assert(err(buildPatch("brand_knowledge", { confidence: -1 })).includes("confidence"));
  assert(err(buildPatch("brand_knowledge", { confidence: "high" })).includes("confidence"));
});

Deno.test("verified must be a boolean", () => {
  assertEquals(ok(buildPatch("brand_colorways", { verified: true })).verified, true);
  assertEquals(ok(buildPatch("brand_colorways", { verified: false })).verified, false);
  assert(err(buildPatch("brand_colorways", { verified: "yes" })).includes("verified"));
});

Deno.test("each table exposes its own editable columns only", () => {
  // brand_size_charts owns `rows`; brand_styles does not.
  assert("rows" in ok(buildPatch("brand_size_charts", { rows: [] })));
  assertEquals(
    err(buildPatch("brand_styles", { rows: [] })),
    "No editable fields in the request",
  );
  // brand_style_codes owns `pattern`.
  assert("pattern" in ok(buildPatch("brand_style_codes", { pattern: "^x$" })));
});

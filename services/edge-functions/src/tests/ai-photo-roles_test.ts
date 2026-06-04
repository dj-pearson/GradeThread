// US-533: normalizeRoleResult maps the model's 1-based tool output onto the
// caller's photo ids with safe fallbacks. Pure — no Anthropic call — so set
// dummy supabase env before importing (ai-config/supabase load at module init).
//   deno test --allow-env src/tests/ai-photo-roles_test.ts
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { normalizeRoleResult, PHOTO_ROLES } = await import(
  "../lib/ai-photo-roles.ts"
);

const photos = [
  { id: "a", url: "http://x/a" },
  { id: "b", url: "http://x/b" },
  { id: "c", url: "http://x/c" },
];

Deno.test("maps cover + roles by 1-based index; cover is forced to front", () => {
  const { coverId, roles } = normalizeRoleResult(
    2,
    [
      { index: 1, role: "tag" },
      { index: 2, role: "detail" }, // model said detail, but it's the cover
      { index: 3, role: "defect" },
    ],
    photos,
  );
  assertEquals(coverId, "b");
  assertEquals(roles, { a: "tag", b: "front", c: "defect" });
});

Deno.test("unspecified photos default to detail", () => {
  const { roles } = normalizeRoleResult(1, [{ index: 2, role: "back" }], photos);
  // a -> cover (front), b -> back (specified), c -> default detail
  assertEquals(roles.a, "front");
  assertEquals(roles.b, "back");
  assertEquals(roles.c, "detail");
});

Deno.test("invalid cover index falls back to an explicit front, else first photo", () => {
  // No valid cover index, but photo 3 is explicitly a front.
  const r1 = normalizeRoleResult(99, [{ index: 3, role: "front" }], photos);
  assertEquals(r1.coverId, "c");

  // No valid cover index and no front -> first photo becomes the cover.
  const r2 = normalizeRoleResult(null, [{ index: 2, role: "tag" }], photos);
  assertEquals(r2.coverId, "a");
  assertEquals(r2.roles.a, "front");
});

Deno.test("out-of-range and unknown roles are ignored, not thrown", () => {
  const { roles } = normalizeRoleResult(
    1,
    [
      { index: 0, role: "tag" }, // out of range (1-based)
      { index: 9, role: "detail" }, // out of range
      { index: 2, role: "bogus" }, // unknown role
    ],
    photos,
  );
  assertEquals(roles.b, "detail"); // bogus ignored -> default detail
});

Deno.test("PHOTO_ROLES are all valid flipdesk_photo_type values", () => {
  // Guards against drift from the DB enum (front|back|tag|detail|defect|...).
  const enumValues = ["front", "back", "tag", "detail", "defect", "flatlay", "on_model"];
  for (const r of PHOTO_ROLES) {
    assertEquals(enumValues.includes(r), true, `role ${r} not in enum`);
  }
});

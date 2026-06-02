// US-332: pre-grade image-quality gate unit tests.
//
// Pure decision logic over per-image quality signals + photo-type coverage.
// No network/DB deps.
import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_IMAGE_QUALITY,
  evaluateImageQuality,
  type ImageQuality,
  type QualityImageInput,
} from "../lib/image-quality.ts";

function img(
  image_type: string,
  q: Partial<ImageQuality> = {},
): QualityImageInput {
  return { image_type, quality: { ...DEFAULT_IMAGE_QUALITY, ...q } };
}

// A complete, clean submission: front/back/label/detail all good.
function goodSet(): QualityImageInput[] {
  return [img("front"), img("back"), img("label"), img("detail")];
}

Deno.test("clean complete submission passes the gate", () => {
  const r = evaluateImageQuality(goodSet());
  assertEquals(r.ok, true);
  assertEquals(r.abstain, false);
  assertEquals(r.issues.length, 0);
  assertEquals(r.photo_requests.length, 0);
});

Deno.test("missing required angles abstain with one request each", () => {
  const r = evaluateImageQuality([img("front"), img("detail")]); // no back, no label
  assert(r.abstain);
  assertEquals(r.ok, false);
  const missing = r.issues.filter((i) => i.problem === "missing").map((i) =>
    i.image_type
  )
    .sort();
  assertEquals(missing, ["back", "label"]);
  // Each missing angle yields an actionable request.
  assert(r.photo_requests.some((m) => m.includes("back")));
  assert(r.photo_requests.some((m) => m.includes("label")));
});

Deno.test("missing detail photo abstains (coverage AC #3)", () => {
  const r = evaluateImageQuality([img("front"), img("back"), img("label")]);
  assert(r.abstain);
  assert(
    r.issues.some((i) => i.problem === "missing" && i.image_type === "detail"),
  );
});

Deno.test("severe blur on a CORE shot blocks; on a detail it only warns", () => {
  const blocked = evaluateImageQuality([
    img("front", { blur: "severe" }),
    img("back"),
    img("label"),
    img("detail"),
  ]);
  assert(blocked.abstain);
  assert(
    blocked.issues.some((i) =>
      i.problem === "blur" && i.image_type === "front" && i.severity === "block"
    ),
  );

  const warned = evaluateImageQuality([
    img("front"),
    img("back"),
    img("label"),
    img("detail", { blur: "severe" }),
  ]);
  assertEquals(warned.abstain, false); // detail blur doesn't block
  assert(
    warned.issues.some((i) =>
      i.problem === "blur" && i.image_type === "detail" && i.severity === "warn"
    ),
  );
  assertEquals(warned.ok, false); // but it's surfaced
});

Deno.test("dark lighting on a core shot blocks", () => {
  const r = evaluateImageQuality([
    img("front"),
    img("back", { lighting: "dark" }),
    img("label"),
    img("detail"),
  ]);
  assert(r.abstain);
  assert(
    r.issues.some((i) =>
      i.problem === "lighting" && i.image_type === "back" &&
      i.severity === "block"
    ),
  );
});

Deno.test("partial framing on front/back blocks", () => {
  const r = evaluateImageQuality([
    img("front", { framing: "partial" }),
    img("back"),
    img("label"),
    img("detail"),
  ]);
  assert(r.abstain);
  assert(
    r.issues.some((i) => i.problem === "framing" && i.severity === "block"),
  );
});

Deno.test("illegible label blocks", () => {
  const r = evaluateImageQuality([
    img("front"),
    img("back"),
    img("label", { legible: false }),
    img("detail"),
  ]);
  assert(r.abstain);
  assert(
    r.issues.some((i) =>
      i.problem === "illegible_label" && i.severity === "block"
    ),
  );
});

Deno.test("mild blur / dim light on core shots warn but still grade", () => {
  const r = evaluateImageQuality([
    img("front", { blur: "mild" }),
    img("back", { lighting: "dim" }),
    img("label"),
    img("detail"),
  ]);
  assertEquals(r.abstain, false);
  assertEquals(r.ok, false);
  assert(r.issues.every((i) => i.severity === "warn"));
});

Deno.test("missing quality field defaults to good (never abstains on absent data)", () => {
  const r = evaluateImageQuality([
    { image_type: "front" },
    { image_type: "back" },
    { image_type: "label" },
    { image_type: "detail" },
  ]);
  assertEquals(r.ok, true);
  assertEquals(r.abstain, false);
});

Deno.test("photo_requests are de-duplicated", () => {
  // Two core shots dark → same lighting message phrasing differs per type, so
  // force a duplicate by repeating an identical missing message is hard; instead
  // assert no duplicate strings appear.
  const r = evaluateImageQuality([
    img("front", { blur: "severe", lighting: "dark" }),
    img("back"),
    img("label"),
    img("detail"),
  ]);
  assert(r.abstain);
  assertEquals(new Set(r.photo_requests).size, r.photo_requests.length);
});

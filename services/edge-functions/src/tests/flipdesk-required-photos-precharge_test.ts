// US-2304: a FlipDesk grade with no tag photo must be refused BEFORE it is
// charged or sent to Claude Vision.
//
// The grading gate (image-quality.ts REQUIRED_IMAGE_TYPES) blocks on a missing
// label only after one vision call per image. Anything that reaches it without
// a label has already cost a charge and the AI spend, and ends in a refund.
// Two holes led there after the 2026-08-03 fix:
//
//   1. /validate counted every item_photos row, while /submit copies only rows
//      with a storage_path. A tag photo with no storage_path passed readiness
//      and was dropped at submit.
//   2. The submit loop never re-checked the photos it was about to copy.
//
// The pure half is asserted by behaviour. The ORDER is asserted by reading the
// source, the same way one-open-grade_test.ts does, because the order is what
// saves the money and no mocked database can see it.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

const {
  missingRequiredGradingImages,
  gradingReadinessBlockers,
  mapPhotoTypeForGrading,
  REQUIRED_GRADING_PHOTO_TYPES,
} = await import("../lib/grading-submit.ts");
const { REQUIRED_IMAGE_TYPES } = await import("../lib/image-quality.ts");

const SRC = await Deno.readTextFile(
  new URL("../lib/grading-submit.ts", import.meta.url),
);

/** Source with comments stripped, so a sentence cannot satisfy a scan. */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

const LOOP = codeOf(
  SRC.slice(SRC.indexOf("for (const item of validation.result.items)")),
);

Deno.test("US-2304: the label is required, in both lists", () => {
  // The owner's call (2026-08-03): FlipDesk grading requires the tag, the
  // same as the core grading spec. If this goes red, somebody changed the
  // decision, and US-2304's note should say so.
  assert((REQUIRED_IMAGE_TYPES as readonly string[]).includes("label"));
  assert((REQUIRED_GRADING_PHOTO_TYPES as readonly string[]).includes("tag"));
});

Deno.test("US-2304: missingRequiredGradingImages speaks FlipDesk photo names", () => {
  assertEquals(missingRequiredGradingImages(["front", "back", "label"]), []);
  assertEquals(
    missingRequiredGradingImages(["front", "back", "label", "detail"]),
    [],
  );
  assertEquals(missingRequiredGradingImages(["front", "back", "detail"]), ["tag"]);
  assertEquals(missingRequiredGradingImages([]), ["front", "back", "tag"]);
  // A second label is not the first one.
  assertEquals(missingRequiredGradingImages(["front", "back", "label_2"]), ["tag"]);
});

Deno.test("US-2304: the pre-charge check and readiness agree on every photo set", () => {
  // Readiness speaks FlipDesk photo types; the pre-charge check speaks the
  // grading image types the loop copies. For any set of photos that all have
  // a storage_path, both must name the same missing photos, or one of them
  // lets through what the other refuses.
  const pool = ["front", "back", "tag", "detail", "defect", "detail_2"];
  for (let mask = 0; mask < 1 << pool.length; mask++) {
    const photoTypes = pool.filter((_, i) => mask & (1 << i));
    const readiness = gradingReadinessBlockers({
      garment_type: "tops",
      garment_category: "t-shirt",
      title: "x",
      photoTypes,
    }).missingPhotos;
    const imageTypes = photoTypes
      .map((t) => mapPhotoTypeForGrading(t, null)?.imageType)
      .filter((t): t is string => typeof t === "string");
    assertEquals(
      missingRequiredGradingImages(imageTypes),
      readiness,
      `photos: [${photoTypes.join(", ")}]`,
    );
  }
});

Deno.test("US-2304: /submit refuses a missing required photo before any charge", () => {
  const check = LOOP.indexOf("missingRequiredGradingImages(");
  const subInsert = LOOP.indexOf('.from("submissions")');
  const charge = LOOP.indexOf("runPaymentPrecedence(");
  assert(check > 0, "the submit loop must call missingRequiredGradingImages");
  assert(
    check < subInsert,
    "the required-photo check must run before the submissions row is created",
  );
  assert(
    check < charge,
    "the required-photo check must run BEFORE runPaymentPrecedence. After it, " +
      "a tagless garment is charged, graded by Claude Vision and refunded.",
  );
  const seg = LOOP.slice(check, check + 600);
  assert(/code:\s*"missing_photos"/.test(seg), "refusal must carry code missing_photos");
  assert(/continue;/.test(seg), "refusal must skip the item, not throw into the refund path");
});

Deno.test("US-2304: the check reads the photos the loop copies", () => {
  // Checking a different list than the one copied is the defect this closes.
  const check = LOOP.indexOf("missingRequiredGradingImages(");
  assert(
    /missingRequiredGradingImages\(\s*eligible\.map\(/.test(LOOP.slice(check, check + 200)),
    "the check must be fed from `eligible`, the list the copy step iterates",
  );
  assert(
    /for \(let i = 0; i < eligible\.length; i\+\+\)/.test(LOOP),
    "the copy step must iterate `eligible`",
  );
});

Deno.test("US-2304: /validate counts only photos /submit can copy", () => {
  const code = codeOf(SRC);
  const start = code.indexOf("export async function buildValidation");
  const end = code.indexOf("export function mapPhotoTypeForGrading");
  assert(start > 0 && end > start, "buildValidation not found");
  const body = code.slice(start, end);
  const q = body.indexOf('.from("item_photos")');
  assert(q > 0, "buildValidation must read item_photos");
  assert(
    /\.not\("storage_path",\s*"is",\s*null\)/.test(body.slice(q, q + 300)),
    "readiness must skip item_photos rows with no storage_path, the same rows " +
      "the submit loop skips. Otherwise a tag with only a photo_url reads as " +
      "ready and is dropped after the charge.",
  );
});

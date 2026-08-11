// US-2019 — EDGE half of the shared grading-readiness guard.
//
// gradingReadinessBlockers is the AUTHORITY: /validate and /submit both gate on
// it. src/lib/grading-readiness.ts mirrors it so the web "Submit for grading"
// card can show readiness live. Two projects, no shared import — so one fixture,
// asserted by both suites, is the only thing that keeps them honest.
//
// See vault/70-agent/guards-that-cannot-fail.md: a mirror pinned by a comment
// is the shape that has already shipped wrong twice in this repo.

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  gradingReadinessBlockers,
  gradingImageTypeToPhotoType,
  mapPhotoTypeForGrading: mapPhotoTypeForGradingForTest,
  REQUIRED_GRADING_PHOTO_TYPES,
} = await import("../routes/flipdesk-grading.ts");
const { REQUIRED_IMAGE_TYPES } = await import("../lib/image-quality.ts");

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../../../src/test/fixtures/grading-readiness-cases.json",
      import.meta.url,
    ),
  ),
) as {
  cases: Array<{
    name: string;
    input: {
      garment_type: string | null;
      garment_category: string | null;
      title: string | null;
      photoTypes: string[];
    };
    expected: { blockers: string[]; warnings: string[]; missingPhotos: string[] };
  }>;
};

Deno.test("edge grading readiness matches the cross-project fixture", () => {
  assertEquals(
    fixture.cases.length > 10,
    true,
    "fixture looks truncated — it should cover a broad spread of states",
  );
  for (const c of fixture.cases) {
    const got = gradingReadinessBlockers({
      garment_type: c.input.garment_type,
      garment_category: c.input.garment_category,
      title: c.input.title,
      photoTypes: c.input.photoTypes,
    });
    assertEquals(got.blockers, c.expected.blockers, `case: ${c.name}`);
    assertEquals(got.warnings, c.expected.warnings, `case: ${c.name}`);
    assertEquals(got.missingPhotos, c.expected.missingPhotos, `case: ${c.name}`);
  }
});

Deno.test("edge: a defect photo does NOT satisfy the fabric close-up rule", () => {
  // Still not a substitute: a defect shot frames the flaw, not the weave. What
  // changed in US-2397 is the CONSEQUENCE — it warns and caps the grade instead
  // of refusing the submission.
  const got = gradingReadinessBlockers({
    garment_type: "jeans",
    garment_category: "denim",
    title: "X",
    photoTypes: ["front", "back", "defect"],
  });
  assertEquals(
    got.warnings.some((w) => w.includes("fabric close-up")),
    true,
  );
});

Deno.test("edge: a missing fabric close-up no longer blocks submission", () => {
  // US-2397, the whole point: good front/back coverage and nothing tagged
  // Detail is READY. If this ever goes back to blocking, sellers lose grades
  // they have the photos for.
  const got = gradingReadinessBlockers({
    garment_type: "jeans",
    garment_category: "denim",
    title: "Levi 501",
    // FLIPDESK photo types, so `tag` — not the grading `label` this used to
    // say. It passed either way while neither was required; US-2304 made the
    // tag required and the wrong name became a failure.
    photoTypes: ["front", "back", "tag", "defect"],
  });
  assertEquals(got.blockers, []);
  assertEquals(got.warnings.length, 1);
});

Deno.test("edge: blocker strings are the exact user-facing copy", () => {
  // The web card regex-matches these (onlyGarmentBlocks), so they are a
  // cross-project contract, not just messages.
  const got = gradingReadinessBlockers({
    garment_type: null,
    garment_category: null,
    title: null,
    photoTypes: [],
  });
  assertEquals(got.blockers[0], "Missing garment_type");
  assertEquals(got.blockers[1], "Missing garment_category");
  assertEquals(got.blockers[2], "Missing title");
  assertEquals(got.blockers[3], "Missing required photos: front, back, tag");
});

// ── US-2304 AC2: the two requirement lists cannot disagree ─────────────────
//
// This is the defect, not a symptom of it. flipdesk-grading required front+back
// while image-quality required front+back+label at severity `block`, and the
// gate runs at pipeline Step 4b — BEFORE any confidence scoring. So the comment
// justifying the shorter list ("the <0.75 → human-review path covers it") named
// a path that never executed. A FlipDesk item with no tag was charged, ran one
// Claude Vision call per image, abstained to needs_photos and was refunded: the
// money came back, the AI spend did not, and the seller round-tripped.
//
// Fixed by DERIVATION rather than by matching two literals, so the lists cannot
// drift apart again. These cases pin the derivation itself.
Deno.test("US-2304: the FlipDesk required list IS the grading gate's list", () => {
  assertEquals(
    [...REQUIRED_GRADING_PHOTO_TYPES],
    REQUIRED_IMAGE_TYPES.map(gradingImageTypeToPhotoType),
    "the FlipDesk requirement list stopped being derived from the grading gate",
  );
  // And the tag is actually in it — the derivation could be intact while the
  // gate itself quietly dropped `label`, which is the same seller-facing bug
  // arriving from the other side.
  assertEquals(REQUIRED_GRADING_PHOTO_TYPES.includes("tag"), true);
});

Deno.test("US-2304: the photo-type mapping round-trips", () => {
  // A wrong entry in GRADING_TO_PHOTO_TYPE would make the two lists agree on
  // paper while asking the seller for a photo type the UI cannot produce.
  for (const imageType of REQUIRED_IMAGE_TYPES) {
    const photoType = gradingImageTypeToPhotoType(imageType);
    assertEquals(
      mapPhotoTypeForGradingForTest(photoType)?.imageType ?? null,
      imageType,
      `${photoType} does not map back to ${imageType} — the requirement list ` +
        `asks for a photo type that never becomes this grading image type`,
    );
  }
});

// US-2471. Migration 00587 rewrote `measurement_chest` → (`measurement`,
// `chest`), and a bare `measurement` is the MeasureCard calibration frame that
// 00346 excludes from grading on purpose. Reading the type alone therefore sent
// every tape-measure photo to null and it silently stopped reaching the grader.
// The role is the only thing that tells the two apart.
Deno.test("US-2471: a measurement photo's role decides whether it grades", () => {
  assertEquals(
    mapPhotoTypeForGradingForTest("measurement", null),
    null,
    "the MeasureCard calibration frame must stay out of grading",
  );
  assertEquals(mapPhotoTypeForGradingForTest("measurement", "chest"), {
    imageType: "measurement_chest",
    imageRole: "chest",
  });
  assertEquals(
    mapPhotoTypeForGradingForTest("measurement", "shoulder"),
    null,
    "a dimension with no image_type enum value has nowhere to land",
  );
  // The retired type still round-trips, and hands its dimension on as the role
  // so the prompt site only ever has to speak roles.
  assertEquals(mapPhotoTypeForGradingForTest("measurement_inseam"), {
    imageType: "measurement_inseam",
    imageRole: "inseam",
  });
});

Deno.test("US-2471: a tag's role rides along to the grader", () => {
  // Both are `label`; which one holds the brand and which the size is exactly
  // what ai-extract could not tell before, and is now the role.
  assertEquals(mapPhotoTypeForGradingForTest("tag", "brand"), {
    imageType: "label",
    imageRole: "brand",
  });
  assertEquals(mapPhotoTypeForGradingForTest("tag", "size"), {
    imageType: "label",
    imageRole: "size",
  });
  assertEquals(mapPhotoTypeForGradingForTest("detail", "fabric"), {
    imageType: "detail",
    imageRole: "fabric",
  });
  // A type that takes no qualifier reports none, whatever it was handed.
  assertEquals(mapPhotoTypeForGradingForTest("front", "brand"), {
    imageType: "front",
    imageRole: null,
  });
  assertEquals(mapPhotoTypeForGradingForTest("flatlay", "fabric"), null);
});

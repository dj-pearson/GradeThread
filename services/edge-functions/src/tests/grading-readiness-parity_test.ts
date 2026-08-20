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
} = await import("../lib/grading-submit.ts");
const { REQUIRED_IMAGE_TYPES } = await import("../lib/image-quality.ts");
const { GRADE_IMAGE_TYPES } = await import("../lib/api-grade-ingest.ts");

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

// US-2695. `measurement_overlay` (00350) is the GENERATED annotated render, and
// the one `flipdesk_photo_type` that starts with `measurement_` without naming a
// dimension. The prefix branch handed it straight through as an `image_type`,
// which is a DIFFERENT enum that has never held that value. A seller who
// rendered a measurements photo and then submitted got the whole item back as
// `invalid input value for enum image_type: "measurement_overlay"` — after the
// credit was charged.
Deno.test("US-2695: the generated overlay is not grading evidence", () => {
  assertEquals(
    mapPhotoTypeForGradingForTest("measurement_overlay", null),
    null,
    "the annotated render is graphics we drew, not evidence about the garment",
  );
  assertEquals(
    mapPhotoTypeForGradingForTest("measurement_overlay", "overlay"),
    null,
  );
});

// The guard that keeps the NEXT one out. The photo types come from the
// migrations, so a `flipdesk_photo_type` added tomorrow is covered the day it
// lands instead of when somebody remembers to extend a list in a test file.
Deno.test("US-2695: no photo type maps to a name image_type lacks", async () => {
  const dir = new URL("../../../../supabase/migrations/", import.meta.url);
  const photoTypes = new Set<string>();
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(entry.name, dir));
    for (
      const m of sql.matchAll(
        /flipdesk_photo_type ADD VALUE IF NOT EXISTS '([a-z0-9_]+)'/g,
      )
    ) {
      photoTypes.add(m[1]!);
    }
    const created = sql.match(
      /CREATE TYPE public\.flipdesk_photo_type AS ENUM \(([^)]*)\)/,
    );
    for (const m of (created?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)) {
      photoTypes.add(m[1]!);
    }
  }
  // A parse that found nothing would satisfy every assertion below it.
  assertEquals(photoTypes.has("measurement_overlay"), true);
  assertEquals(photoTypes.has("front"), true);
  assertEquals(photoTypes.size >= 28, true, "enum parse came up short");

  const valid = GRADE_IMAGE_TYPES as readonly string[];
  for (const t of photoTypes) {
    for (
      const role of [null, "chest", "shoulder", "brand", "fabric", "overlay"]
    ) {
      const mapped = mapPhotoTypeForGradingForTest(t, role);
      if (mapped === null) continue;
      assertEquals(
        valid.includes(mapped.imageType),
        true,
        `(${t}, ${role}) maps to image_type "${mapped.imageType}", which the ` +
          `enum does not have — the insert fails after the credit is charged`,
      );
    }
  }
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

// US-3337: the seller's photo report card.
//
//   deno test --allow-net --allow-env --allow-read src/tests/photo-report-card_test.ts

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  buildPhotoReportCard,
  MIN_PHOTOS_FOR_TIP,
  parseReportLimit,
  PHOTO_REPORT_MAX_GRADES,
  problemsIn,
  slotFor,
} from "../lib/photo-report-card.ts";

const GOOD = { blur: "none", lighting: "ok", framing: "full", legible: true };
const img = (image_type: string, quality: unknown = GOOD) => ({ image_type, quality });
const grade = (...images: unknown[]) => ({ per_image_analysis: images });

Deno.test("image types fold into the slots a seller recognizes", () => {
  assertEquals(slotFor("detail_3"), "detail");
  assertEquals(slotFor("label_2"), "label");
  assertEquals(slotFor("measurement_chest"), "measurement");
  assertEquals(slotFor("FRONT"), "front");
  assertEquals(slotFor("video_frame"), null);
  assertEquals(slotFor(undefined), null);
});

Deno.test("a photo with no quality read is not measured, not counted as good", () => {
  assertEquals(problemsIn("front", undefined), null);
  const card = buildPhotoReportCard([grade({ image_type: "front" }, img("front"))]);
  assertEquals(card.photos_measured, 1);
  assertEquals(card.slots[0].photos, 1);
});

Deno.test("legibility counts on a label and nowhere else", () => {
  const unreadable = { ...GOOD, legible: false };
  assertEquals(problemsIn("label", unreadable), ["illegible"]);
  assertEquals(problemsIn("front", unreadable), []);
});

Deno.test("mild blur and dim light are problems; none and ok are not", () => {
  assertEquals(problemsIn("back", { ...GOOD, blur: "mild", lighting: "dim" }), ["blur", "lighting"]);
  assertEquals(problemsIn("back", { ...GOOD, framing: "partial" }), ["framing"]);
  assertEquals(problemsIn("back", GOOD), []);
});

Deno.test("rates per slot, and the tip names the weakest slot's commonest problem", () => {
  const dark = { ...GOOD, lighting: "dark" };
  const blurry = { ...GOOD, blur: "severe" };
  const card = buildPhotoReportCard([
    grade(img("front"), img("back", dark), img("label")),
    grade(img("front", blurry), img("back", dark), img("label")),
    grade(img("front"), img("back", { ...dark, blur: "mild" }), img("label")),
    grade(img("front"), img("back"), img("label")),
  ]);
  assertEquals(card.grades_counted, 4);
  const back = card.slots.find((s) => s.slot === "back")!;
  assertEquals(back.photos, 4);
  assertEquals(back.with_problems, 3);
  assertEquals(back.problem_rate, 0.75);
  assertEquals(back.problems.lighting, { count: 3, rate: 0.75 });
  assertEquals(back.problems.blur, { count: 1, rate: 0.25 });
  assertEquals(card.weakest?.slot, "back");
  assertEquals(card.weakest?.problem, "lighting");
  assertMatch(card.weakest!.tip, /back photos are often too dark/);
});

Deno.test("one bad photo in a thin slot does not earn a tip", () => {
  const card = buildPhotoReportCard([grade(img("defect", { ...GOOD, blur: "severe" }))]);
  assert(MIN_PHOTOS_FOR_TIP > 1);
  assertEquals(card.slots[0].problem_rate, 1);
  assertEquals(card.weakest, null);
});

Deno.test("clean photos: a card with rates and no tip", () => {
  const card = buildPhotoReportCard([grade(img("front"), img("back")), grade(img("front")), grade(img("front"))]);
  assertEquals(card.weakest, null);
  assertEquals(card.slots.map((s) => s.slot), ["front", "back"]);
});

Deno.test("no grades, or garbage rows: an empty card, never a throw", () => {
  assertEquals(buildPhotoReportCard([]), { grades_counted: 0, photos_measured: 0, slots: [], weakest: null });
  const card = buildPhotoReportCard([
    { per_image_analysis: null },
    { per_image_analysis: "oops" },
    { per_image_analysis: [null, 7, { image_type: 3 }] },
  ]);
  assertEquals(card.photos_measured, 0);
  assertEquals(card.grades_counted, 3);
});

Deno.test("the grade window is bounded", () => {
  assertEquals(parseReportLimit(undefined), 20);
  assertEquals(parseReportLimit("5"), 5);
  assertEquals(parseReportLimit("-3"), 20);
  assertEquals(parseReportLimit("999"), PHOTO_REPORT_MAX_GRADES);
});

// The route is owner-scoped and never ships the raw analysis. Its behavior is
// proven against a live stack by the US-3337 case in tenant-isolation_test.ts;
// this pins the shape so a refactor cannot quietly drop the scope.
Deno.test("the route scopes by owner and returns only the built card", () => {
  const src = Deno.readTextFileSync(new URL("../routes/grade.ts", import.meta.url)).replace(/\r\n/g, "\n");
  const start = src.indexOf('gradeRoutes.get("/photo-report-card"');
  assert(start > 0, "route exists");
  const body = src.slice(start, src.indexOf("\n});\n", start));
  assertMatch(body, /const ownerId = c\.get\("workspaceOwnerId"\) \?\? c\.get\("userId"\);/);
  assertMatch(body, /\.from\("submissions"\)\s*\.select\("id"\)\s*\.eq\("user_id", ownerId\)/);
  assertMatch(body, /\.in\("submission_id", ids\)/);
  assert(!/c\.req\.(param|json)\(/.test(body), "takes no id from the request");
  for (const m of body.matchAll(/return c\.json\(([^;]*)\);/g)) {
    assert(
      /^buildPhotoReportCard\(|^\{ error: /.test(m[1]),
      `every response is the built card or an error, got: ${m[1]}`,
    );
  }
});

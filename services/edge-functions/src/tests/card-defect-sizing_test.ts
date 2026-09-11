// US-3333: size a flaw from a MeasureCard in the same photo.
//
// The geometry cases run on the OpenCV-validated card fixtures the detector is
// already held to (fixtures/measure-card/manifest.json): a "flaw" box drawn
// between two marker centres is exactly 6 in long on the card plane, straight
// on and under a 15-degree tilt.
//
//   deno test --allow-net --allow-env --allow-read src/tests/card-defect-sizing_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { uint8ToBase64 as encodeBase64 } from "../lib/grading-image-encoding.ts";
import { Image } from "imagescript";
import {
  applyCardSizing,
  bboxLongestSideMm,
  bucketForMm,
  type CardFit,
  fitCardInImage,
  wantsCardSizing,
} from "../lib/card-defect-sizing.ts";
import type { PerImageAnalysis } from "../lib/ai-grading.ts";

const DIR = new URL("./fixtures/measure-card/", import.meta.url);
const manifest = JSON.parse(
  Deno.readTextFileSync(new URL("manifest.json", DIR)),
) as {
  fixtures: Array<{
    name: string;
    file: string;
    width: number;
    height: number;
    opencv: Array<{ id: number; center: [number, number] }>;
  }>;
};
const fixture = (name: string) => manifest.fixtures.find((f) => f.name === name)!;
const dataUri = (file: string) =>
  `data:image/png;base64,${encodeBase64(Deno.readFileSync(new URL(file, DIR)))}`;

/** A thin box from marker 10's centre to marker 11's: 6 in on the card. */
function sixInchBox(name: string): [number, number, number, number] {
  const f = fixture(name);
  const c10 = f.opencv.find((m) => m.id === 10)!.center;
  const c11 = f.opencv.find((m) => m.id === 11)!.center;
  return [c10[0] / f.width, c10[1] / f.height, (c11[0] - c10[0]) / f.width, 1 / f.height];
}

const SIX_IN_MM = 6 * 25.4;

for (const name of ["straight-on", "tilt-15"]) {
  Deno.test(`a 6 in span measures 6 in off the card (${name})`, async () => {
    const fit = await fitCardInImage(dataUri(fixture(name).file));
    assert(fit, `${name} should calibrate cleanly enough to size from`);
    const mm = bboxLongestSideMm(sixInchBox(name), fit);
    assert(mm !== null);
    assert(Math.abs(mm - SIX_IN_MM) / SIX_IN_MM < 0.03, `${name}: ${mm} mm, expected ~${SIX_IN_MM}`);
  });
}

Deno.test("no card in the photo: no fit, and the analysis comes back untouched", async () => {
  const blank = new Image(640, 480).fill(0xb4b4b4ff);
  const uri = `data:image/png;base64,${encodeBase64(await blank.encode())}`;
  assertEquals(await fitCardInImage(uri), null);
  const a = analysis();
  assertEquals(applyCardSizing(a, null), a);
});

Deno.test("a card with a covered marker is not trusted to move a grade", async () => {
  assertEquals(await fitCardInImage(dataUri(fixture("occluded-marker").file)), null);
});

Deno.test("an undecodable image fails closed, never throws", async () => {
  assertEquals(await fitCardInImage("data:image/png;base64,bm90IGFuIGltYWdl"), null);
  assertEquals(await fitCardInImage("not a data uri"), null);
});

// ── the pure rules ──────────────────────────────────────────────────────────

Deno.test("millimetres map onto the published buckets", () => {
  assertEquals(bucketForMm(2.9), "pinhole");
  assertEquals(bucketForMm(3), "small");
  assertEquals(bucketForMm(12.9), "small");
  assertEquals(bucketForMm(13), "medium");
  assertEquals(bucketForMm(50), "medium");
  assertEquals(bucketForMm(51), "large");
  // Coverage, not length: a panel-dominating call is never downgraded.
  assertEquals(bucketForMm(80, "extensive"), "extensive");
});

// An upright synthetic fit: 100 px per inch, 2000 x 1500 image.
const FIT: CardFit = { homography: [0.01, 0, 0, 0, 0.01, 0, 0, 0, 1], width: 2000, height: 1500 };

function analysis(): PerImageAnalysis {
  return {
    image_type: "defect",
    detected_issues: [
      // 30 px tall at 100 ppi = 0.3 in = 7.6 mm: small, though the model said large.
      { issue: "hole", severity: "moderate", size_bucket: "large", location: "hem", is_intentional: false, bbox: [0.5, 0.5, 0.005, 0.02] },
      { issue: "raw hem", severity: "minor", size_bucket: "large", location: "hem", is_intentional: true, bbox: [0.1, 0.1, 0.2, 0.2] },
      { issue: "stain", severity: "minor", size_bucket: "medium", location: "cuff", is_intentional: false },
    ],
    condition_signals: [],
    style_attributes: [],
    estimated_scores: {
      fabric_condition: 7, structural_integrity: 7, cosmetic_appearance: 7,
      functional_elements: 7, odor_cleanliness: 7,
    },
  } as PerImageAnalysis;
}

Deno.test("the card wins over the model's estimate, and says it was measured", () => {
  const out = applyCardSizing(analysis(), FIT);
  const [hole, rawHem, stain] = out.detected_issues as unknown as Array<Record<string, unknown>>;
  assertEquals(hole.size_bucket, "small");
  assertEquals(hole.size_source, "card");
  assertEquals(hole.size_mm, 7.6);
  // Intentional features and unlocalized flaws are left exactly as they were.
  assertEquals(rawHem.size_bucket, "large");
  assertEquals(rawHem.size_source, undefined);
  assertEquals(stain.size_bucket, "medium");
  assertEquals(stain.size_source, undefined);
});

Deno.test("only flaw close-ups with a localized genuine flaw pay for a decode", () => {
  assert(wantsCardSizing(analysis()));
  assert(!wantsCardSizing({ ...analysis(), image_type: "front" }));
  assert(!wantsCardSizing({ ...analysis(), detected_issues: [] }));
});

Deno.test("wired behind the flag, inside the pipeline, with no vision call", () => {
  const lib = Deno.readTextFileSync(new URL("../lib/card-defect-sizing.ts", import.meta.url));
  assert(!/ai-provider|getGradingProvider|analyzeImage/.test(lib), "card sizing must not call a model");
  const pipe = Deno.readTextFileSync(new URL("../lib/grading-pipeline.ts", import.meta.url))
    .replace(/\r\n/g, "\n");
  assert(/if \(cardSizingEnabled\(\)\) \{\n\s+for \(let i = 0; i < results\.length; i\+\+\)/.test(pipe));
  assert(pipe.includes("results[i] = { ...results[i], result: applyCardSizing(analysis, fit) };"));
});

// US-3529: vision input shaping is off by default, and when on, downscales the
// photos the model sees and skips measurement photos in the condition pass.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Image } from "imagescript";
import {
  isMeasurementImage,
  shrinkForVision,
  skipMeasurementFanout,
  visionLongEdge,
} from "../lib/vision-input-shaping.ts";
import { promptVersionSuffix } from "../lib/ai-grading.ts";

const NONE = { baseline: false, fabric: false, visual: false, tag: false };

async function jpeg(w: number, h: number): Promise<Uint8Array> {
  const img = new Image(w, h);
  img.fill(0x8080a0ff);
  return await img.encodeJPEG(90);
}

Deno.test("US-3529: both levers are off unless set, and junk stays off", () => {
  Deno.env.delete("GRADING_VISION_LONG_EDGE");
  Deno.env.delete("GRADING_SKIP_MEASUREMENT_FANOUT");
  assertEquals(visionLongEdge(), null);
  assertEquals(skipMeasurementFanout(), false);
  Deno.env.set("GRADING_VISION_LONG_EDGE", "100");
  assertEquals(visionLongEdge(), null, "below 512 is refused");
  Deno.env.set("GRADING_VISION_LONG_EDGE", "1568");
  assertEquals(visionLongEdge(), 1568);
  Deno.env.delete("GRADING_VISION_LONG_EDGE");
});

Deno.test("US-3529: a portrait photo is shrunk to the long edge; a small one is untouched", async () => {
  const big = await jpeg(1200, 2400);
  const out = await shrinkForVision(big, 1568);
  assertEquals(out.shrunk, true);
  const decoded = await Image.decode(out.bytes);
  assertEquals(decoded.height, 1568);
  assertEquals(decoded.width, 784);
  const small = await jpeg(800, 1000);
  const same = await shrinkForVision(small, 1568);
  assertEquals(same.shrunk, false);
  assert(same.bytes === small, "unchanged bytes are the same buffer");
});

Deno.test("US-3529: undecodable bytes pass through rather than failing a grade", async () => {
  const junk = new Uint8Array([1, 2, 3, 4]);
  const out = await shrinkForVision(junk, 1568);
  assertEquals(out.shrunk, false);
  assert(out.bytes === junk);
});

Deno.test("US-3529: measurement photos are recognised by type", () => {
  assert(isMeasurementImage("measurement_chest"));
  assert(!isMeasurementImage("front"));
});

Deno.test("US-3529: the grade suffix records both eras, appended last", () => {
  assertEquals(promptVersionSuffix({ ...NONE, downscaled: true }), "+ds");
  assertEquals(
    promptVersionSuffix({
      ...NONE,
      imageTextGuard: true,
      downscaled: true,
      noMeasure: true,
    }),
    "+imgtext+ds+nomeasure",
  );
  assertEquals(promptVersionSuffix(NONE), "");
});

Deno.test("US-3529: the pipeline fans out over conditionImages and maps results by that list", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  assert(src.includes("staggerFirstCall(\n        conditionImages,"));
  assert(src.includes("imageType: conditionImages[i].imageType,"));
  // The escalation re-grade shapes its own list the same way.
  assert(src.includes("const shapedImages = skipMeasurement"));
  assert(src.includes("const imageDataPromises = shapedImages.map("));
});

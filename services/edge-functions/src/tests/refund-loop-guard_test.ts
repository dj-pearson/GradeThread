// US-3528: stop paying AI for grades that end up refunded.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Image } from "imagescript";
import {
  exposureVerdict,
  gradingMinImageEdge,
  maxRefundedPerDay,
  overRefundCap,
} from "../lib/refund-loop-guard.ts";
import { computePhashAndLuma } from "../lib/perceptual-hash.ts";

async function png(w: number, h: number, rgba: number): Promise<Uint8Array> {
  const img = new Image(w, h);
  img.fill(rgba);
  return await img.encode();
}

Deno.test("US-3528: defaults are 5 refunds a day and an 800px long edge", () => {
  Deno.env.delete("GRADING_MAX_REFUNDED_PER_DAY");
  Deno.env.delete("GRADING_MIN_IMAGE_EDGE");
  assertEquals(maxRefundedPerDay(), 5);
  assertEquals(gradingMinImageEdge(), 800);
});

Deno.test("US-3528: the refund cap trips at the limit, and 0 disables it", () => {
  assertEquals(overRefundCap(4, 5), false);
  assertEquals(overRefundCap(5, 5), true);
  assertEquals(overRefundCap(50, 0), false);
});

Deno.test("US-3528: only core photos that are essentially black or blown out are refused", () => {
  assert(exposureVerdict("front", 4)!.includes("too dark"));
  assert(exposureVerdict("label", 252)!.includes("washed out"));
  assertEquals(
    exposureVerdict("front", 30),
    null,
    "a black tee on a dark background passes",
  );
  assertEquals(
    exposureVerdict("detail", 3),
    null,
    "detail shots are not checked",
  );
  assertEquals(
    exposureVerdict("back", null),
    null,
    "an undecodable photo is not refused here",
  );
});

Deno.test("US-3528: luma comes from the same decode as the hash", async () => {
  const black = await computePhashAndLuma(await png(64, 48, 0x000000ff), "png");
  const white = await computePhashAndLuma(await png(64, 48, 0xffffffff), "png");
  const grey = await computePhashAndLuma(await png(64, 48, 0x808080ff), "png");
  assert(black.meanLuma! < 1 && white.meanLuma! > 254);
  assert(Math.abs(grey.meanLuma! - 128) < 1);
  assert(black.phash !== null);
  assertEquals(
    exposureVerdict("front", black.meanLuma),
    exposureVerdict("front", 0),
  );
});

Deno.test("US-3528: every grading entry point caps refunds and checks size and exposure", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
  const grade = await read("../routes/grade.ts");
  const api = await read("../routes/api-v1.ts");
  const ingest = await read("../lib/api-grade-ingest.ts");
  const flip = await read("../lib/grading-submit.ts");
  for (
    const [name, src] of [["grade", grade], ["api-v1", api], [
      "flipdesk",
      flip,
    ]] as const
  ) {
    assert(src.includes("refundedGradeCapReached("), `${name}: no refund cap`);
  }
  for (
    const [name, src] of [
      ["grade", grade],
      ["api-v1", api],
      ["ingest", ingest],
      ["flipdesk", flip],
    ] as const
  ) {
    assert(
      src.includes("minDimension: gradingMinImageEdge()"),
      `${name}: no size floor`,
    );
    assert(src.includes("exposureVerdict("), `${name}: no exposure check`);
  }
  // On the main path the checks run before the charge.
  assert(
    grade.indexOf("exposureVerdict(") < grade.indexOf("runPaymentPrecedence("),
  );
  assert(
    grade.indexOf("refundedGradeCapReached(") <
      grade.indexOf("runPaymentPrecedence("),
  );
});

// US-2890: the auto-upright pass.
//
// Most of these are refusals. That is deliberate: the risky half of this
// feature is not rotating a photo, it is rotating one it should have left
// alone, and there are four separate reasons to leave one alone.
//
// The one test that is not a refusal is the direction check, and it is the
// reason this file needs a decoder at all. rotateImageBytes and
// rotatePointQuarter have to agree about which way is clockwise; if they do
// not, the image turns one way and the calibration turns the other, every
// stored measurement lands mirrored, and nothing throws. So a real image with
// one marked corner is rotated for real and the corner is looked for exactly
// where the calibration math says it should be.

import { assertEquals, assertRejects } from "@std/assert";
import { Image } from "imagescript";
import {
  AUTO_UPRIGHT_SETTING_KEY,
  decideUpright,
  rotateImageBytes,
  uprightCalibration,
  uprightMessage,
  uprightRecipe,
  type UprightPhotoRow,
} from "../lib/measure-auto-upright.ts";
import { rotatePointQuarter, type Quarter } from "../lib/measure-quarter-turn.ts";

const BASE: UprightPhotoRow = {
  id: "p1",
  storage_path: "u1/i1/front_1.jpg",
  photo_type: "measurement",
  used_for_grading: false,
};

// ── the refusals ────────────────────────────────────────────────────────────

Deno.test("US-2890 AC6: off unless the setting says otherwise", () => {
  const d = decideUpright(BASE, 1, false);
  assertEquals(d.rotate, false);
  assertEquals(d.reason, "disabled");
});

Deno.test("US-2890 AC6: the setting key is the one the migration registers", () => {
  assertEquals(AUTO_UPRIGHT_SETTING_KEY, "measure.auto_upright_enabled");
});

Deno.test("US-2890 AC4: grading evidence is never rotated, however sideways", () => {
  for (const turns of [1, 2, 3]) {
    const d = decideUpright({ ...BASE, used_for_grading: true }, turns, true);
    assertEquals(d.rotate, false, `turn ${turns} rotated a grading photo`);
    assertEquals(d.reason, "grading_evidence");
  }
});

Deno.test("US-2890 AC4: the grading check runs before the turn is consulted", () => {
  // An upright grading photo and a sideways one must give the SAME reason.
  // If the turn were read first, an upright grading photo would report
  // "already_upright" and the refusal would look conditional on the angle.
  assertEquals(
    decideUpright({ ...BASE, used_for_grading: true }, 0, true).reason,
    "grading_evidence",
  );
});

Deno.test("an upright photo is left alone", () => {
  assertEquals(decideUpright(BASE, 0, true).reason, "already_upright");
});

Deno.test("a photo with no calibration is left alone rather than guessed at", () => {
  assertEquals(decideUpright(BASE, null, true).reason, "no_calibration");
  assertEquals(decideUpright(BASE, undefined, true).reason, "no_calibration");
});

Deno.test("a photo with no storage path is left alone", () => {
  assertEquals(
    decideUpright({ ...BASE, storage_path: null }, 1, true).reason,
    "no_storage_path",
  );
});

Deno.test("a turn outside 0..3 is normalised, not trusted", () => {
  assertEquals(decideUpright(BASE, 5, true).turns, 1);
  assertEquals(decideUpright(BASE, -1, true).turns, 3);
  assertEquals(decideUpright(BASE, 4, true).reason, "already_upright");
});

Deno.test("a sideways, non-grading photo with the setting on is rotated", () => {
  const d = decideUpright(BASE, 3, true);
  assertEquals(d.rotate, true);
  assertEquals(d.turns, 3);
  assertEquals(d.reason, null);
});

// ── the recipe ──────────────────────────────────────────────────────────────

Deno.test("the recipe is ABSOLUTE against the original, so turns compose", () => {
  // The US-2888 lesson: a photo already at 270 that gets one more quarter is at
  // 0, not at 90. Replacing rather than composing is how a second pass undoes
  // the first.
  const first = uprightRecipe(null, 1, "2026-01-01T00:00:00Z");
  assertEquals(first.rotation, 90);
  const second = uprightRecipe(first, 3, "2026-01-02T00:00:00Z");
  assertEquals(second.rotation, 0);
});

Deno.test("the recipe keeps the seller's own edits and marks itself automatic", () => {
  const prev = { v: 1, rotation: 0, fine: 4, crop: null, aspect: null, adjustments: { brightness: 8 }, bgRemoved: true };
  const out = uprightRecipe(prev, 1, "2026-01-01T00:00:00Z");
  assertEquals(out.fine, 4);
  assertEquals((out.adjustments as Record<string, number>).brightness, 8);
  assertEquals(out.bgRemoved, true);
  assertEquals(out.autoUpright, true);
});

Deno.test("a junk recipe degrades to a fresh one rather than throwing", () => {
  assertEquals(uprightRecipe("not an object", 2, "2026-01-01T00:00:00Z").rotation, 180);
  assertEquals(uprightRecipe(42, 1, "2026-01-01T00:00:00Z").rotation, 90);
});

// ── the calibration ─────────────────────────────────────────────────────────

Deno.test("US-2890 AC3: the calibration is carried, and the spent turn is cleared", () => {
  const calib = {
    homography: [0.02, 0, -1.5, 0, 0.02, -2.5, 0, 0, 1],
    ppi: 50,
    uprightTurns: 1 as const,
    lines: { chest: { e1: [20, 30], e2: [220, 30], inches: 20, label: "Chest" } },
  };
  const out = uprightCalibration(calib, 1, 400, 300);
  // The reading is unchanged - a rotation moves no distance.
  assertEquals(out.ppi, 50);
  assertEquals(out.lines.chest.inches, 20);
  // The endpoints moved by the same map the pixels did.
  assertEquals(out.lines.chest.e1, rotatePointQuarter([20, 30], 1, 400, 300));
  // And the turn is spent, so a second pass does not rotate it again. This is
  // the assertion that stops a cron loop spinning a photo forever.
  assertEquals(out.uprightTurns, 0);
});

// ── the direction, checked against real pixels ──────────────────────────────

/** A w x h image, black except for one white pixel at (mx, my). */
async function marked(w: number, h: number, mx: number, my: number): Promise<Uint8Array> {
  const img = new Image(w, h);
  img.fill(0x000000ff);
  img.setPixelAt(mx + 1, my + 1, 0xffffffff); // imagescript is 1-indexed
  return await img.encode();
}

/** Where is the single white pixel? 0-indexed. */
async function findMark(bytes: Uint8Array): Promise<[number, number] | null> {
  const img = await Image.decode(bytes);
  for (let y = 1; y <= img.height; y++) {
    for (let x = 1; x <= img.width; x++) {
      if ((img.getPixelAt(x, y) >>> 8) === 0xffffff) return [x - 1, y - 1];
    }
  }
  return null;
}

Deno.test("rotateImageBytes turns the pixels the same way the calibration math does", async () => {
  const W = 8;
  const H = 4;
  // Off both axes of symmetry, so a mirrored result cannot look correct.
  const MX = 6;
  const MY = 1;
  const src = await marked(W, H, MX, MY);

  for (const turns of [1, 2, 3] as Quarter[]) {
    const out = await rotateImageBytes(src, turns);
    const [ew, eh] = turns % 2 === 0 ? [W, H] : [H, W];
    assertEquals([out.width, out.height], [ew, eh], `turn ${turns} dimensions`);

    const found = await findMark(out.bytes);
    assertEquals(found !== null, true, `turn ${turns}: mark vanished`);
    // rotatePointQuarter maps the CORNER lattice, so a pixel INDEX is its
    // centre run through the same map and shifted back: index i is the sample
    // at i + 0.5. That relationship is exact, so this is an equality rather
    // than a tolerance - and it has to be, because the failure it catches is a
    // 90-vs-270 mix-up, which lands the mark a whole image away rather than a
    // pixel away.
    const centre = rotatePointQuarter([MX + 0.5, MY + 0.5], turns, W, H);
    const want = [centre[0] - 0.5, centre[1] - 0.5];
    assertEquals(
      found,
      want,
      `turn ${turns}: pixel landed at ${JSON.stringify(found)}, calibration says ${
        JSON.stringify(want)
      }`,
    );
  }
});

Deno.test("rotateImageBytes refuses bytes it cannot decode", async () => {
  await assertRejects(() => rotateImageBytes(new Uint8Array([1, 2, 3, 4]), 1));
});

Deno.test("the seller is told what happened and how to undo it", () => {
  const msg = uprightMessage(1);
  assertEquals(msg.includes("quarter turn right"), true);
  assertEquals(msg.includes("Revert to original"), true);
});

// ── the bucket, which is where this pass would have gone quietly wrong ───────

Deno.test("US-2890 AC2: the upright pass resolves the bucket the way all three clients do", async () => {
  // A SOURCE SCAN, and worth being honest about what it can and cannot do: it
  // cannot prove the bytes land in the right place. What it CAN do is fail the
  // moment someone reaches for the write-time router again, which is the actual
  // regression - it is one autocomplete away, it reads as obviously correct,
  // and its symptom is not an error.
  //
  // The failure it guards: bucketForItemPhoto(photo_type) routes a NEW object
  // by its type. US-2407 removed the type from the READ path precisely because
  // a seller changing the type dropdown then changed where the edge looked for
  // bytes that had not moved. If the preserved original lands in a bucket the
  // web's revertPhotoEdit does not look in, the undo AC2 requires fails and
  // says nothing.
  const src = await Deno.readTextFile(
    new URL("../lib/measure-upright-pass.ts", import.meta.url),
  );
  assertEquals(
    src.includes("readBucketForItemPhoto("),
    true,
    "the pass must resolve its bucket with readBucketForItemPhoto, the mirror of the web's bucketForItemPhotoRow",
  );
  assertEquals(
    src.includes("bucketForItemPhoto(row.photo_type)"),
    false,
    "bucketForItemPhoto is the WRITE-time router keyed on the type; using it here reintroduces the US-2407 bug",
  );
});

// US-1577: the card-free measurements overlay — geometry helpers + a real
// ImageScript render smoke (crop path, mask fallback, no-lines failure, and
// the unbranded contract).
//
//   deno test --allow-env --allow-read src/tests/measure-overlay_test.ts

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Image } from "imagescript";
import {
  cardBBoxPx,
  chooseCropRect,
  formatInches,
  invertHomography,
  lineInsideRect,
  renderMeasureOverlay,
  type OverlayLine,
} from "../lib/measure-overlay.ts";
import { applyHomography } from "../lib/measure-detect.ts";
import { MEASURE_CARD_V1 } from "../lib/measure-card.ts";

Deno.test("invertHomography round-trips points", () => {
  const H = [1.1, 0.02, 40, -0.03, 0.95, 22, 0.0001, 0.0002, 1];
  const inv = invertHomography(H)!;
  for (const [x, y] of [[10, 10], [300, 200], [55, 480]] as const) {
    const fwd = applyHomography(H, x, y);
    const back = applyHomography(inv, fwd[0], fwd[1]);
    assert(Math.hypot(back[0] - x, back[1] - y) < 1e-6);
  }
});

Deno.test("cardBBoxPx locates the card under a pure-scale calibration", () => {
  // 100 px/in: card inches [0..7.5]x[0..5.5] → px [0..750]x[0..550] (+pad).
  const H = [1 / 100, 0, 0, 0, 1 / 100, 0, 0, 0, 1];
  const box = cardBBoxPx(H, MEASURE_CARD_V1, 0)!;
  assert(Math.abs(box.x - 0) < 1e-6 && Math.abs(box.y - 0) < 1e-6);
  assert(Math.abs(box.w - 750) < 1e-6 && Math.abs(box.h - 550) < 1e-6);
});

Deno.test("chooseCropRect picks the biggest card-free side; null when card is centered", () => {
  // Card on the left of a 2000x1000 photo → crop = right side.
  const right = chooseCropRect(2000, 1000, { x: 0, y: 200, w: 700, h: 500 })!;
  assertEquals(right.x, 700);
  assertEquals(right.w, 1300);
  // Card dead-center with no dominant side → null (mask fallback).
  assertEquals(
    chooseCropRect(1000, 1000, { x: 200, y: 200, w: 600, h: 600 }),
    null,
  );
});

Deno.test("lineInsideRect and formatInches behave", () => {
  const r = { x: 100, y: 100, w: 400, h: 300 };
  const line: OverlayLine = {
    key: "chest",
    label: "Chest",
    e1: [150, 200],
    e2: [450, 200],
    inches: 22.25,
  };
  assert(lineInsideRect(line, r));
  assert(!lineInsideRect({ ...line, e2: [600, 200] }, r));
  assertEquals(formatInches("Chest", 22.25), "Chest: 22 1/4 in");
  assertEquals(formatInches("Length", 28), "Length: 28 in");
  assertEquals(formatInches("Hem", 0.5), "Hem: 1/2 in");
});

async function loadFont(): Promise<Uint8Array> {
  return await Deno.readFile(
    new URL("../../assets/Roboto-Bold.ttf", import.meta.url),
  );
}

function scene(): Image {
  // 1200x800 "photo": card-ish dark block on the left, garment blob right.
  const img = new Image(1200, 800);
  img.fill(0xb0b0b0ff);
  img.drawBox(40, 200, 300, 220, 0x222222ff); // stand-in card region
  img.drawBox(500, 150, 600, 500, 0x445588ff); // garment
  return img;
}

const LINES: OverlayLine[] = [
  { key: "chest", label: "Chest", e1: [520, 300], e2: [1080, 300], inches: 22 },
  { key: "length", label: "Length", e1: [800, 160], e2: [800, 640], inches: 28.5 },
];

Deno.test("render (crop path): card region gone, output = crop size, JPEG decodes", async () => {
  const crop = { x: 360, y: 0, w: 840, h: 800 };
  const jpeg = await renderMeasureOverlay({
    image: scene(),
    lines: LINES,
    crop,
    cardBox: { x: 40, y: 200, w: 300, h: 220 },
    font: await loadFont(),
  });
  const out = await Image.decode(jpeg);
  assertEquals(out.width, 840);
  assertEquals(out.height, 800);
});

Deno.test("render (mask fallback): full frame kept, card region flattened", async () => {
  const jpeg = await renderMeasureOverlay({
    image: scene(),
    lines: LINES,
    crop: null,
    cardBox: { x: 40, y: 200, w: 300, h: 220 },
    font: await loadFont(),
  });
  const out = (await Image.decode(jpeg)) as Image;
  assertEquals(out.width, 1200);
  // Center of the old card region should now match the surrounding table
  // tone, not the dark card fill.
  const px = out.getPixelAt(190, 310) >>> 0;
  const r = (px >>> 24) & 0xff;
  assert(r > 120, `card region still dark (r=${r})`);
});

Deno.test("render throws when no line fits the card-free frame", async () => {
  await assertRejects(
    () =>
      renderMeasureOverlay({
        image: scene(),
        lines: LINES,
        // A crop that excludes both lines entirely.
        crop: { x: 0, y: 0, w: 300, h: 100 },
        cardBox: null,
        font: undefined as unknown as Uint8Array,
      }),
    Error,
    "no measurement lines",
  );
});

Deno.test("unbranded contract: renderer draws no wordmark/URL/QR", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/measure-overlay.ts", import.meta.url),
  );
  assert(!/gradethread\.com/i.test(src), "no URLs in the render");
  // The only text drawn is the measurement label + value.
  assert(src.includes("formatInches(line.label, line.inches)"));
  assert(!src.includes("GradeThread Verified"));
});

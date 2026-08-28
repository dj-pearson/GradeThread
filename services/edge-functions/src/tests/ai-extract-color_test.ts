// Wiring the pixel colour measurement into the extract pipeline (US-2975).
//
// The measurement itself is proved in photo-neutral-color_test.ts. What is at
// stake HERE is that it rides along for free and never makes extraction worse:
//
//   - it reuses the bytes buildPhotoContent already downloads, so no photo is
//     fetched twice and no AI call is added;
//   - it measures the FRONT photo, not whichever photo happened to be first;
//   - a photo it cannot read leaves the prompt exactly as it is today; and
//   - a veto removes the colour from BOTH the field suggestion and the eBay
//     aspect, because leaving the aspect behind would publish the wrong colour
//     to eBay while the visible field looked empty.
//
//   deno test src/tests/ai-extract-color_test.ts

import { assert, assertEquals } from "@std/assert";
import { Image } from "imagescript";
import type { safeFetch } from "../lib/ssrf.ts";
import { measureNeutral } from "../lib/photo-neutral-color.ts";

// ai-extract.ts pulls in the service-role supabase client at load.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const { applyColorVeto, buildPhotoContent, buildPhotoContentWithColor } = await import(
  "../lib/ai-extract.ts"
);

// ── fixtures ────────────────────────────────────────────────────────────────

function srgb(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** A real PNG: a solid garment of `reflectance` centred on a white backdrop. */
async function garmentPng(reflectance: number, size = 240, inset = 40): Promise<Uint8Array> {
  const img = new Image(size, size);
  const subject = srgb(reflectance);
  const backdrop = srgb(0.9);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= inset && x < size - inset && y >= inset && y < size - inset;
      const v = inside ? subject : backdrop;
      const i = (y * size + x) * 4;
      img.bitmap[i] = v;
      img.bitmap[i + 1] = v;
      img.bitmap[i + 2] = v;
      img.bitmap[i + 3] = 255;
    }
  }
  return await img.encode();
}

function fetcherFor(byUrl: Record<string, Uint8Array>): typeof safeFetch {
  return ((url: string) => {
    const bytes = byUrl[String(url)];
    if (!bytes) return Promise.resolve({ status: 404, bytes: new Uint8Array(), contentType: null });
    return Promise.resolve({ status: 200, bytes, contentType: null });
  }) as typeof safeFetch;
}

// ── measuring the right photo, off the bytes already in hand ────────────────

Deno.test("buildPhotoContentWithColor measures the garment and still inlines every photo", async () => {
  const png = await garmentPng(0.05);
  const { content, colorReading } = await buildPhotoContentWithColor(
    [{ url: "https://x/front.png", type: "front" }],
    fetcherFor({ "https://x/front.png": png }),
  );
  assertEquals(content.length, 2); // caption + image, exactly as before
  assert(colorReading, "expected a reading from the front photo");
  assert(colorReading.lightness < 30, `expected a dark garment, got ${colorReading.lightness}`);
});

Deno.test("buildPhotoContentWithColor measures the front photo, not whichever came first", async () => {
  const dark = await garmentPng(0.05);
  const pale = await garmentPng(0.62);
  const { colorReading } = await buildPhotoContentWithColor(
    [
      { url: "https://x/detail.png", type: "detail" },
      { url: "https://x/front.png", type: "front" },
    ],
    fetcherFor({ "https://x/detail.png": pale, "https://x/front.png": dark }),
  );
  assert(colorReading, "expected a reading");
  const expected = measureNeutral(
    (await Image.decode(dark)).bitmap,
    240,
    240,
  );
  assert(expected, "fixture should be measurable");
  assertEquals(Math.round(colorReading.lightness), Math.round(expected.lightness));
});

Deno.test("buildPhotoContentWithColor returns no reading when no photo can show the garment", async () => {
  // Close-ups of labels say nothing about the garment's colour, so they are
  // never measured — a white care label would read as a white garment.
  const png = await garmentPng(0.05);
  const { content, colorReading } = await buildPhotoContentWithColor(
    [{ url: "https://x/tag.png", type: "tag" }],
    fetcherFor({ "https://x/tag.png": png }),
  );
  assertEquals(content.length, 2);
  assertEquals(colorReading, null);
});

Deno.test("buildPhotoContentWithColor survives a photo it cannot decode", async () => {
  // Truncated JPEG: valid magic bytes, no decodable image. The prompt must come
  // out exactly as it does today; only the measurement is lost.
  const junk = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const { content, colorReading } = await buildPhotoContentWithColor(
    [{ url: "https://x/front.jpg", type: "front" }],
    fetcherFor({ "https://x/front.jpg": junk }),
  );
  assertEquals(content.length, 2);
  assertEquals(colorReading, null);
});

Deno.test("buildPhotoContent keeps its old contract: content blocks only", async () => {
  const png = await garmentPng(0.05);
  const content = await buildPhotoContent(
    [{ url: "https://x/front.png", type: "front" }],
    fetcherFor({ "https://x/front.png": png }),
  );
  assert(Array.isArray(content));
  assertEquals(content.length, 2);
});

// ── applying the veto ───────────────────────────────────────────────────────

const suggestion = (value: string) => ({ value, confidence: 0.8, source: "photo:front" });
const attribute = (value: string) => ({ values: [value], confidence: 0.8, source: "photo:front" });

Deno.test("applyColorVeto strips a vetoed colour from the field AND the eBay aspect", async () => {
  const reading = measureNeutral((await Image.decode(await garmentPng(0.24))).bitmap, 240, 240);
  assert(reading, "fixture should be measurable");
  const suggestions = { color: suggestion("Purple"), brand: suggestion("Vuori") };
  const attributes = { color: attribute("Purple"), size: attribute("M") };

  const outcome = applyColorVeto(suggestions, attributes, reading);

  assert(outcome.vetoed, "a near-neutral garment cannot be purple");
  assertEquals(suggestions.color, undefined);
  assertEquals(attributes.color, undefined);
  assertEquals(suggestions.brand.value, "Vuori"); // nothing else touched
  assertEquals(attributes.size.values, ["M"]);
});

Deno.test("applyColorVeto leaves a colour the measurement supports alone", async () => {
  const reading = measureNeutral((await Image.decode(await garmentPng(0.05))).bitmap, 240, 240);
  assert(reading, "fixture should be measurable");
  const suggestions = { color: suggestion("Black") };
  const attributes = { color: attribute("Black") };

  const outcome = applyColorVeto(suggestions, attributes, reading);

  assertEquals(outcome.vetoed, false);
  assertEquals(suggestions.color.value, "Black");
  assertEquals(attributes.color.values, ["Black"]);
});

Deno.test("applyColorVeto does nothing without a reading", () => {
  const suggestions = { color: suggestion("Purple") };
  const attributes = { color: attribute("Purple") };
  const outcome = applyColorVeto(suggestions, attributes, null);
  assertEquals(outcome.vetoed, false);
  assertEquals(suggestions.color.value, "Purple");
  assertEquals(attributes.color.values, ["Purple"]);
});

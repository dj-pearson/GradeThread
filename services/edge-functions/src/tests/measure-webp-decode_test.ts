// A MeasureCard shot stored as WebP must calibrate.
//
// The web uploader (src/lib/item-photo-upload.ts -> compressImage) stores every
// non-PNG item photo as WebP. imagescript's Image.decode reads JPEG and PNG
// only, so /measure/calibrate, /measure/extract and /measure/autofill all
// answered "Could not decode the image." for a card photo added from the
// browser. These tests re-encode a real card fixture as WebP and prove the
// shared decoder hands the detector the same picture.
//
//   deno test --allow-read src/tests/measure-webp-decode_test.ts

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Image } from "imagescript";
import { decodeToImage } from "../lib/image-decode.ts";
import { calibrateAdaptive } from "../lib/measure-calibrate.ts";
import { MEASURE_CARD_VERSIONS } from "../lib/measure-card.ts";

const DIR = new URL("./fixtures/measure-card/", import.meta.url);
const manifest = JSON.parse(
  await Deno.readTextFile(new URL("manifest.json", DIR)),
) as { fixtures: Array<{ file: string; expect: string }> };
const good = manifest.fixtures.find((f) => f.expect === "calibrates")!;

async function fixtureAsWebp(): Promise<{ png: Uint8Array; webp: Uint8Array }> {
  const png = await Deno.readFile(new URL(good.file, DIR));
  const img = await Image.decode(png);
  const { encode } = await import("@jsquash/webp");
  const webp = new Uint8Array(
    await encode(
      {
        data: new Uint8ClampedArray(img.bitmap),
        width: img.width,
        height: img.height,
        colorSpace: "srgb",
      } as ImageData,
      { quality: 90 },
    ),
  );
  return { png, webp };
}

Deno.test("decodeToImage: WebP card photo decodes to the same size as the PNG", async () => {
  const { png, webp } = await fixtureAsWebp();
  // The bytes really are WebP, or this test proves nothing.
  assertEquals(new TextDecoder().decode(webp.subarray(8, 12)), "WEBP");
  await assertRejects(() => Image.decode(webp));
  const fromPng = await decodeToImage(png);
  const fromWebp = await decodeToImage(webp);
  assertEquals([fromWebp.width, fromWebp.height], [fromPng.width, fromPng.height]);
});

Deno.test("decodeToImage: the MeasureCard calibrates from a WebP photo", async () => {
  const { webp } = await fixtureAsWebp();
  const decoded = await decodeToImage(webp);
  const { result } = calibrateAdaptive(decoded, MEASURE_CARD_VERSIONS, {
    evidenceOnly: false,
  });
  assert(result.ok, `card should calibrate from WebP: ${JSON.stringify(result)}`);
});

Deno.test("decodeToImage: garbage bytes still throw", async () => {
  await assertRejects(() => decodeToImage(new Uint8Array([1, 2, 3, 4])));
});

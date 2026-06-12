// Server-side perceptual hash tests (US-480).
//
// Proves the reuse-detection hash is derived from the image bytes on the server
// and is deterministic — so identical image bytes uploaded by two different
// accounts always produce the same hash (Hamming distance 0 → flagged),
// regardless of any phash the client submits. computePhashFromImage has no
// client-hash parameter at all, so client influence is structurally impossible.
//
//   deno test --allow-net src/tests/perceptual-hash_test.ts

import { assert, assertEquals } from "@std/assert";
import { Image } from "imagescript";
import { computePhashFromImage, dHashFromRgba } from "../lib/perceptual-hash.ts";

// photo-reuse.ts loads the service-role supabase client at import — set dummy
// env BEFORE the dynamic import (mirrors photo-reuse_test.ts).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const { hammingHex, REUSE_MAX_HAMMING_DEFAULT } = await import("../lib/photo-reuse.ts");

const HEX16 = /^[0-9a-f]{16}$/;

// Build a left→right brightness gradient as a raw RGBA buffer.
function gradientRgba(w: number, h: number): Uint8Array {
  const buf = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      const i = (y * w + x) * 4;
      buf[i] = v;
      buf[i + 1] = v;
      buf[i + 2] = v;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

Deno.test("dHashFromRgba is deterministic and 16 hex chars", () => {
  const rgba = gradientRgba(40, 32);
  const a = dHashFromRgba(rgba, 40, 32);
  const b = dHashFromRgba(rgba, 40, 32);
  assert(a !== null);
  assertEquals(a, b);
  assert(HEX16.test(a!));
});

Deno.test("dHashFromRgba: bright→dark gradient → all comparison bits set", () => {
  // Each row strictly decreases left→right, so every 'left > right' comparison
  // is 1 → all 64 bits set → 0xffff...ffff.
  const rgba = gradientRgba(40, 32);
  // Reverse so brightness decreases to the right.
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 20; x++) {
      const i = (y * 40 + x) * 4;
      const j = (y * 40 + (39 - x)) * 4;
      for (let k = 0; k < 4; k++) {
        const t = rgba[i + k]!;
        rgba[i + k] = rgba[j + k]!;
        rgba[j + k] = t;
      }
    }
  }
  assertEquals(dHashFromRgba(rgba, 40, 32), "ffffffffffffffff");
});

Deno.test("dHashFromRgba: degenerate input → null (no fabricated hash)", () => {
  assertEquals(dHashFromRgba(new Uint8Array(0), 0, 0), null);
  assertEquals(dHashFromRgba(new Uint8Array(4), 10, 10), null); // buffer too small
});

Deno.test("computePhashFromImage: identical PNG bytes from two accounts → distance 0 (flagged)", async () => {
  const img = new Image(48, 36);
  for (let x = 1; x <= 48; x++) {
    for (let y = 1; y <= 36; y++) {
      const v = Math.round(((x - 1) / 47) * 255);
      img.setPixelAt(x, y, ((v << 24) | (v << 16) | (v << 8) | 0xff) >>> 0);
    }
  }
  const png = await img.encode();

  // Two different "accounts" upload the EXACT same bytes.
  const accountA = await computePhashFromImage(png, "png");
  const accountB = await computePhashFromImage(png, "png");
  assert(accountA !== null && accountB !== null);
  assert(HEX16.test(accountA!));

  const distance = hammingHex(accountA!, accountB!);
  assertEquals(distance, 0);
  assert(distance <= REUSE_MAX_HAMMING_DEFAULT, "would be flagged by reuse detection");
});

Deno.test("computePhashFromImage: a visually different image hashes differently", async () => {
  const gradient = new Image(48, 36);
  for (let x = 1; x <= 48; x++) {
    for (let y = 1; y <= 36; y++) {
      const v = Math.round(((x - 1) / 47) * 255);
      gradient.setPixelAt(x, y, ((v << 24) | (v << 16) | (v << 8) | 0xff) >>> 0);
    }
  }
  const checker = new Image(48, 36);
  for (let x = 1; x <= 48; x++) {
    for (let y = 1; y <= 36; y++) {
      const on = ((x >> 2) + (y >> 2)) % 2 === 0;
      checker.setPixelAt(x, y, on ? 0xffffffff : 0x000000ff);
    }
  }
  const hGradient = await computePhashFromImage(await gradient.encode(), "png");
  const hChecker = await computePhashFromImage(await checker.encode(), "png");
  assert(hGradient !== null && hChecker !== null);
  assert(
    hammingHex(hGradient!, hChecker!) > REUSE_MAX_HAMMING_DEFAULT,
    "distinct images should not collide within the reuse threshold",
  );
});

Deno.test("computePhashFromImage: WebP decode path is deterministic", async () => {
  const { encode: webpEncode } = await import("@jsquash/webp");
  const w = 48, h = 36;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.round((x / (w - 1)) * 255);
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const webp = new Uint8Array(
    await webpEncode({ data, width: w, height: h, colorSpace: "srgb" } as ImageData),
  );
  const a = await computePhashFromImage(webp, "webp");
  const b = await computePhashFromImage(webp, "webp");
  assert(a !== null, "webp should decode + hash");
  assert(HEX16.test(a!));
  assertEquals(a, b);
});

Deno.test("computePhashFromImage: corrupt bytes → null (never throws)", async () => {
  const garbage = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03]);
  assertEquals(await computePhashFromImage(garbage, "jpeg"), null);
});

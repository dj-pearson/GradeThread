// Garment colour measurement + the veto it feeds (US-2975).
//
// The AI reads colour off pixels a camera already lied about: auto-exposure
// brightens a black garment toward mid-grey and darkens a pale one, so charcoal
// comes back "black" and warm taupe comes back "purple". These tests pin the two
// claims that make the measurement worth trusting:
//
//   1. it is EXPOSURE-INVARIANT, because everything is measured against the
//      white reference inside the same frame rather than in absolute terms; and
//   2. it DECLINES rather than guesses whenever the frame cannot support a
//      reading (no white reference, subject too small, patterned surface).
//
// Every fixture here is a synthetic RGBA buffer, so there is no network, no
// decoder and no photo on disk in the loop.
//
//   deno test src/tests/photo-neutral-color_test.ts

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  describeMeasurement,
  measureNeutral,
  vetoColorClaim,
  VIVID_MIN_CHROMA,
} from "../lib/photo-neutral-color.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Encode a linear-light value (0..1) as one sRGB byte, the way a camera does. */
function encode(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

type Rgb = [number, number, number];

/**
 * A garment of linear reflectance `subject` centred on a backdrop of reflectance
 * `backdrop`, both scaled by `exposure` — i.e. the same scene shot brighter or
 * darker. `inset` is the border margin in cells, so the backdrop always reaches
 * the frame edge (that is what the background flood fill keys off).
 */
function scene(opts: {
  subject: Rgb;
  backdrop?: Rgb;
  exposure?: number;
  size?: number;
  inset?: number;
  /** Optional second subject shade, painted on alternating rows (a stripe). */
  stripe?: Rgb;
}): { rgba: Uint8Array; width: number; height: number } {
  const size = opts.size ?? 240;
  const inset = opts.inset ?? 40;
  const exposure = opts.exposure ?? 1;
  const backdrop = opts.backdrop ?? [0.9, 0.9, 0.9];
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inSubject = x >= inset && x < size - inset && y >= inset && y < size - inset;
      const striped = opts.stripe && inSubject && (y % 4 < 2);
      const src = striped ? opts.stripe! : inSubject ? opts.subject : backdrop;
      const i = (y * size + x) * 4;
      rgba[i] = encode(src[0] * exposure);
      rgba[i + 1] = encode(src[1] * exposure);
      rgba[i + 2] = encode(src[2] * exposure);
      rgba[i + 3] = 255;
    }
  }
  return { rgba, width: size, height: size };
}

const read = (o: Parameters<typeof scene>[0]) => {
  const s = scene(o);
  return measureNeutral(s.rgba, s.width, s.height);
};

// ── the measurement ─────────────────────────────────────────────────────────

Deno.test("measureNeutral: a near-black garment on white reads dark and neutral", () => {
  const r = read({ subject: [0.045, 0.045, 0.045] });
  assert(r, "expected a reading");
  assert(r.lightness < 30, `expected a dark lightness, got ${r.lightness}`);
  assert(r.chroma < 2, `expected a neutral chroma, got ${r.chroma}`);
});

Deno.test("measureNeutral: a mid-grey garment reads far lighter than a black one", () => {
  const black = read({ subject: [0.045, 0.045, 0.045] })!;
  const grey = read({ subject: [0.19, 0.19, 0.19] })!;
  assert(
    grey.lightness - black.lightness > 20,
    `black ${black.lightness} and grey ${grey.lightness} should be far apart`,
  );
});

Deno.test("measureNeutral: the same garment at three exposures reads the same lightness", () => {
  const subject: Rgb = [0.09, 0.09, 0.09];
  const dim = read({ subject, exposure: 0.6 })!;
  const mid = read({ subject, exposure: 0.8 })!;
  const bright = read({ subject, exposure: 1.0 })!;
  assertAlmostEquals(dim.lightness, mid.lightness, 2);
  assertAlmostEquals(mid.lightness, bright.lightness, 2);
});

Deno.test("measureNeutral: a grey garment under warm light still reads as a neutral", () => {
  // Tungsten-ish illuminant: red lifted, blue cut. Both garment and backdrop are
  // lit by it, which is exactly what the white-balance step exists to undo.
  const warm = (c: Rgb): Rgb => [c[0] * 1.25, c[1] * 1.0, c[2] * 0.68];
  const r = read({ subject: warm([0.19, 0.19, 0.19]), backdrop: warm([0.72, 0.72, 0.72]) });
  assert(r, "expected a reading");
  assert(
    r.chroma < VIVID_MIN_CHROMA,
    `warm light should not fake a colour, got chroma ${r.chroma}`,
  );
});

Deno.test("measureNeutral: a saturated garment reports chroma above the vivid floor", () => {
  const r = read({ subject: [0.28, 0.06, 0.30] })!; // a real purple
  assert(
    r.chroma > VIVID_MIN_CHROMA,
    `expected vivid chroma, got ${r.chroma}`,
  );
});

Deno.test("measureNeutral: declines when the frame has no white reference", () => {
  // Dark garment on a dark backdrop: nothing in frame can anchor the exposure.
  assertEquals(read({ subject: [0.05, 0.05, 0.05], backdrop: [0.08, 0.08, 0.08] }), null);
});

Deno.test("measureNeutral: declines when the subject is a speck in the frame", () => {
  assertEquals(read({ subject: [0.05, 0.05, 0.05], inset: 115 }), null);
});

Deno.test("measureNeutral: declines on a two-tone striped garment", () => {
  // Black-and-white stripes average to mid-grey. Reporting that average as the
  // garment colour is the exact false positive this guard exists to stop.
  assertEquals(
    read({ subject: [0.04, 0.04, 0.04], stripe: [0.75, 0.75, 0.75] }),
    null,
  );
});

Deno.test("measureNeutral: rejects a degenerate buffer instead of inventing a reading", () => {
  assertEquals(measureNeutral(new Uint8Array(0), 0, 0), null);
  assertEquals(measureNeutral(new Uint8Array(16), 40, 40), null); // buffer too short
});

// ── the prompt fact ─────────────────────────────────────────────────────────

Deno.test("describeMeasurement: states lightness, chroma and a sample the model can use", () => {
  const r = read({ subject: [0.19, 0.19, 0.19] })!;
  const line = describeMeasurement(r);
  assert(line.includes(String(Math.round(r.lightness))), `missing lightness: ${line}`);
  assert(line.includes(r.hex), `missing sample hex: ${line}`);
  assert(/neutral/i.test(line), `a low-chroma reading should say so: ${line}`);
});

Deno.test("describeMeasurement: does not call a saturated garment neutral", () => {
  const r = read({ subject: [0.28, 0.06, 0.30] })!;
  assert(!/\bneutral\b/i.test(describeMeasurement(r)), describeMeasurement(r));
});

// ── the veto ────────────────────────────────────────────────────────────────

const NEUTRAL_LIGHT = read({ subject: [0.30, 0.30, 0.30] })!; // clearly not black
const NEUTRAL_DARK = read({ subject: [0.045, 0.045, 0.045] })!; // clearly black
const NEUTRAL_WARM = read({ subject: [0.24, 0.21, 0.19] })!; // taupe: low chroma, warm

Deno.test("vetoColorClaim: rejects 'black' on a garment measured well above black", () => {
  const v = vetoColorClaim("Black", NEUTRAL_LIGHT);
  assert(v.vetoed, `expected a veto at lightness ${NEUTRAL_LIGHT.lightness}`);
});

Deno.test("vetoColorClaim: accepts 'black' on a garment that really is black", () => {
  assert(!vetoColorClaim("Black", NEUTRAL_DARK).vetoed);
});

Deno.test("vetoColorClaim: rejects 'white' on a garment measured far too dark", () => {
  assert(vetoColorClaim("White", NEUTRAL_DARK).vetoed);
});

Deno.test("vetoColorClaim: rejects a vivid colour word on a near-neutral garment", () => {
  // The reported bug: warm taupe trousers came back "Purple".
  const v = vetoColorClaim("Purple", NEUTRAL_WARM);
  assert(v.vetoed, `chroma ${NEUTRAL_WARM.chroma} cannot support "purple"`);
});

Deno.test("vetoColorClaim: leaves legitimately near-neutral colour words alone", () => {
  // Taupe, sage, olive and friends genuinely measure low chroma. Vetoing them
  // would break the fields the AI already gets right.
  for (const word of ["Taupe", "Beige", "Olive", "Khaki", "Sage", "Brown", "Navy", "Cream"]) {
    assert(!vetoColorClaim(word, NEUTRAL_WARM).vetoed, `${word} must not be vetoed`);
  }
});

Deno.test("vetoColorClaim: never vetoes when there is no reading", () => {
  assert(!vetoColorClaim("Purple", null).vetoed);
});

Deno.test("vetoColorClaim: never vetoes a colour word it does not know", () => {
  assert(!vetoColorClaim("Heather Oatmeal", NEUTRAL_WARM).vetoed);
  assert(!vetoColorClaim(null, NEUTRAL_WARM).vetoed);
});

Deno.test("vetoColorClaim: a veto explains itself", () => {
  const v = vetoColorClaim("Black", NEUTRAL_LIGHT);
  assert(v.vetoed && typeof v.reason === "string" && v.reason.length > 0, JSON.stringify(v));
});

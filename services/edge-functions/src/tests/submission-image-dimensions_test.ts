// US-2135 AC3: the delivered pixel dimensions are recorded, and they come from
// the server's own read of the bytes.
//
// WHY THIS IS NOT A CLIENT FIELD, which is the whole design and the thing a
// future edit would undo without noticing. `quality_score` beside it in the same
// row IS client-reported: measured in the browser on the compressed bytes and
// sent in the form, so an old client sends nothing and a canvas that cannot
// decode sends nothing. Width and height are parsed by validateImageUpload out
// of the header of the bytes the server is about to store — already, for the
// decompression-bomb ceiling and the US-529 minimum-long-edge floor — so they
// need no client cooperation and cannot be overstated by one.
//
// The parser was already there. The columns are new; the measurement is not.
//
//   deno test --allow-read src/tests/submission-image-dimensions_test.ts
import { assert, assertEquals } from "@std/assert";
import { validateImageUpload } from "../lib/upload-validation.ts";

const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));
const GRADE = read("../routes/grade.ts");
const MIGRATION = Deno.readTextFileSync(
  new URL("../../../../supabase/migrations/00613_submission_images_dimensions.sql", import.meta.url),
);

/** A 1x1 PNG, so the header parse is exercised on real bytes rather than mocked. */
function onePixelPng(): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
}

Deno.test("the validator really does return dimensions — this is not a new measurement", () => {
  // If this ever stops being true, the columns silently fill with null and the
  // feature looks shipped while recording nothing. That is the shape this repo
  // keeps finding, so it is asserted rather than assumed.
  const verdict = validateImageUpload(onePixelPng(), { allow: ["png"] });
  assert(verdict.ok, `a valid PNG was rejected: ${verdict.ok ? "" : verdict.reason}`);
  if (!verdict.ok) return;
  assertEquals(verdict.width, 1);
  assertEquals(verdict.height, 1);
});

Deno.test("both insert paths persist the server-parsed dimensions", () => {
  // The photo path and the video-frame path build the same row shape from two
  // different loops, and only one of them was ever going to be updated by
  // someone adding a column.
  const occurrences = [...GRADE.matchAll(/width: verdict\.width,\s*\n\s*height: verdict\.height,/g)];
  assertEquals(
    occurrences.length,
    2,
    "both the uploaded-photo loop and the video-frame loop must record dimensions",
  );
});

Deno.test("the dimensions come from the verdict, never from the form", () => {
  // A client-supplied width is a claim about a file we already hold. If someone
  // adds `widths` to the multipart body, this fails and asks why.
  assert(
    !/formData\.getAll\("widths"\)/.test(GRADE),
    "dimensions must not be read from the request body — the server parses them",
  );
  assert(
    !/formData\.getAll\("heights"\)/.test(GRADE),
    "dimensions must not be read from the request body — the server parses them",
  );
});

Deno.test("a video frame reports dimensions even though its quality_score is null", () => {
  // The asymmetry is deliberate and easy to 'tidy' away: nobody measured the
  // frame's sharpness, so that stays null, but the validator parsed the frame's
  // own header, so its size is as known as an uploaded photo's. Writing null
  // here would understate what we actually have.
  const frameLoop = GRADE.slice(
    GRADE.indexOf("const frameRecords: typeof imageRecords = []"),
    GRADE.indexOf("const frameRecords: typeof imageRecords = []") + 2600,
  );
  assert(frameLoop.includes("quality_score: null,"), "frame sharpness should stay unknown");
  assert(
    frameLoop.includes("width: verdict.width,"),
    "a frame's dimensions ARE known — the validator just parsed them",
  );
});

Deno.test("the migration adds nullable columns and no range CHECK", () => {
  assert(/ADD COLUMN IF NOT EXISTS width int/.test(MIGRATION), "width column missing");
  assert(/ADD COLUMN IF NOT EXISTS height int/.test(MIGRATION), "height column missing");
  // NOT NULL would fail every pre-existing row; a plausibility CHECK would turn
  // a future parser bug into a failed INSERT on a submission already paid for.
  assert(!/NOT NULL/i.test(MIGRATION), "these must stay nullable — null means unknown");
  assert(
    !/CHECK\s*\(/i.test(MIGRATION),
    "no range CHECK: the ceiling and floor are enforced at upload, where a " +
      "violation can still be refused",
  );
  assert(
    MIGRATION.includes("insert into public.applied_migrations (version) values ('00613')"),
    "self-record footer missing",
  );
});

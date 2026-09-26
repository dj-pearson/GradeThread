// US-3538: one photo in two slots is refused when either slot is core.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  duplicateCorePhoto,
  duplicatePhotoMessage,
} from "../lib/duplicate-photo-guard.ts";

const A = "f0f0f0f0f0f0f0f0";
const A_NEAR = "f0f0f0f0f0f0f0f3"; // 2 bits off
const B = "0f0f0f0f0f0f0f0f"; // far from A

Deno.test("US-3538: front reused as back is refused", () => {
  assertEquals(
    duplicateCorePhoto([{ imageType: "front", phash: A }, {
      imageType: "back",
      phash: A_NEAR,
    }]),
    { a: "front", b: "back" },
  );
});

Deno.test("US-3538: a detail that repeats the label is refused; two similar details are allowed", () => {
  assert(
    duplicateCorePhoto([{ imageType: "label", phash: A }, {
      imageType: "detail",
      phash: A,
    }]),
  );
  assertEquals(
    duplicateCorePhoto([{ imageType: "detail", phash: A }, {
      imageType: "detail_2",
      phash: A_NEAR,
    }]),
    null,
  );
});

Deno.test("US-3538: distinct photos and unhashed photos pass", () => {
  assertEquals(
    duplicateCorePhoto([{ imageType: "front", phash: A }, {
      imageType: "back",
      phash: B,
    }]),
    null,
  );
  assertEquals(
    duplicateCorePhoto([{ imageType: "front", phash: null }, {
      imageType: "back",
      phash: null,
    }]),
    null,
  );
  assert(
    duplicatePhotoMessage({ a: "front", b: "back" }).includes("same picture"),
  );
});

Deno.test("US-3538: every grading entry point checks, and on the main path before the charge", () => {
  const read = (p: string) =>
    Deno.readTextFileSync(new URL(p, import.meta.url));
  for (
    const f of [
      "../routes/grade.ts",
      "../routes/api-v1.ts",
      "../lib/api-grade-ingest.ts",
      "../lib/grading-submit.ts",
    ]
  ) {
    assert(read(f).includes("duplicateCorePhoto(["), f);
  }
  const grade = read("../routes/grade.ts");
  assert(
    grade.indexOf("duplicateCorePhoto([") <
      grade.indexOf("runPaymentPrecedence("),
  );
});

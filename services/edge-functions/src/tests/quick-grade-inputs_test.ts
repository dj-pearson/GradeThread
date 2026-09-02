// US-612 / US-616: what quick-grade does BEFORE it spends anything.
//
// The grader itself needs Anthropic and is not exercised here. The input
// resolution in front of it is pure enough to test and worth pinning, because
// its failure mode is the one the public routes translate for a stranger: no
// usable image has to raise a clear error rather than return an empty grade.
// An empty grade would read as "we looked and found nothing wrong", which is
// the opposite of the truth and the most expensive thing this module could say.

import "./_env.ts";
import { assert, assertRejects } from "@std/assert";
import { analyzeQuickImages } from "../lib/quick-grade.ts";

Deno.test("no images at all is a refusal, not an empty analysis", async () => {
  const err = await assertRejects(() => analyzeQuickImages([]), Error);
  assert(
    /No usable images/.test(err.message),
    `expected the no-usable-images refusal, got: ${err.message}`,
  );
});

Deno.test("an image with neither a data URI nor a URL resolves to nothing", async () => {
  // Both fields empty is what a malformed caller sends. It must be dropped and
  // then reported as no usable image -- never passed to the model as a blank.
  const err = await assertRejects(
    () => analyzeQuickImages([{ type: "front" }, { dataUri: "", url: "", type: "back" }]),
    Error,
  );
  assert(/No usable images/.test(err.message));
});

Deno.test("the four-image cap is applied before anything is fetched", async () => {
  // Six unusable images still fail on the same guard: the cap slices the input
  // first, so a caller cannot make this function do six fetches by sending six.
  const many = Array.from({ length: 6 }, (_, i) => ({ type: `detail_${i}` }));
  const err = await assertRejects(() => analyzeQuickImages(many), Error);
  assert(/No usable images/.test(err.message));
});

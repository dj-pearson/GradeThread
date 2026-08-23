// US-2817: the EDGE copy of the title-sync orchestration, asserted against the
// same fixture the web suite reads.
//
// The web copy has existed since US-1995. The edge one is new, because bulk
// re-identify is the first edge writer that replaces an old field value with a
// new one — every earlier edge path either regenerated titles wholesale or only
// ever filled blanks, where the substitution is a provable no-op.
//
// Two copies with no shared assertion is how the substitution half drifted
// before, so the fixture went in WITH the second copy rather than after it.

import { assert, assertEquals } from "@std/assert";
import {
  buildTitleSyncPatch,
  type TitleSyncPatch,
  type TitleSyncPatchInput,
} from "../lib/title-sync-patch.ts";

const FIXTURE = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../../../src/test/fixtures/title-sync-patch-cases.json",
      import.meta.url,
    ),
  ),
) as {
  buildTitleSyncPatch: {
    name: string;
    input: TitleSyncPatchInput;
    expected: TitleSyncPatch;
  }[];
};

Deno.test("shared fixture: buildTitleSyncPatch matches the web copy", () => {
  assert(
    FIXTURE.buildTitleSyncPatch.length > 0,
    "fixture is empty — wrong path?",
  );
  for (const c of FIXTURE.buildTitleSyncPatch) {
    assertEquals(
      buildTitleSyncPatch(c.input),
      c.expected,
      `fixture case: ${c.name}`,
    );
  }
});

Deno.test("buildTitleSyncPatch: an over-long title losing only its tail is not a substitution", () => {
  // syncTitle re-trims to eBay's 80-char cap. Treating that trim as a change
  // would silently truncate titles on every unrelated bulk write. Kept out of
  // the shared fixture because the input is 125 characters of filler.
  const long = "Nike " + "x".repeat(120);
  assertEquals(
    buildTitleSyncPatch({
      baseTitle: long,
      changes: [{ field: "brand", from: "Patagonia", to: "Arc'teryx" }],
    }),
    {},
  );
});

Deno.test("buildTitleSyncPatch: a null base title yields an empty patch", () => {
  // JSON cannot express `undefined`, and null vs "" reach different guards.
  assertEquals(
    buildTitleSyncPatch({
      baseTitle: null,
      changes: [{ field: "brand", from: "Patagonia", to: "Arc'teryx" }],
    }),
    {},
  );
  assertEquals(
    buildTitleSyncPatch({
      baseTitle: undefined,
      changes: [{ field: "brand", from: "Patagonia", to: "Arc'teryx" }],
    }),
    {},
  );
});

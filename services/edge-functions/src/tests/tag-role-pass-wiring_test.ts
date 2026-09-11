// US-3047 AC4: the tag-role pass is WIRED to the verdict it writes.
//
// ai-tag-ocr_test.ts holds the logic - tagRolePassAlreadyAnswered and
// readTagRolePassAnswers are pure and are called directly there. What a
// behavioural test cannot reach is generateListing, which needs a whole
// database and a whole photo set to run. So this file holds the other half:
// that the decision is actually consulted before the vision call, and that the
// verdict actually reaches the row the next run reads.
//
// It is a source scan, deliberately and only for wiring. Two rules it follows,
// both learned the hard way in this repo: comments are stripped BLOCK-FIRST and
// then by line, so the paragraph explaining a check cannot satisfy it; and the
// scan is scoped to the branch rather than the file, so a sibling's correctness
// cannot stand in for this one's.
//
//   deno test --allow-read src/tests/tag-role-pass-wiring_test.ts
import { assert } from "@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../lib/ai-listing.ts", import.meta.url),
);

/** Code only: block comments as blocks first, then whole-line // comments. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

/** The tag-role branch of generateListing, and nothing either side of it. */
function roleBranch(): string {
  const code = codeOnly(SRC);
  const start = code.indexOf(
    "if (tagPhotos.length === 0 && shouldRunTagRolePass(photos))",
  );
  assert(start >= 0, "the tag-role branch moved or was renamed");
  const end = code.indexOf("if (tagPhotos.length > 0)", start);
  assert(end > start, "the tag-OCR branch that closes the region moved");
  return code.slice(start, end);
}

Deno.test("the verdict is read BEFORE the vision call, not after it", () => {
  const branch = roleBranch();
  const decide = branch.indexOf("tagRolePassAlreadyAnswered(");
  const spend = branch.indexOf("await classifyPhotoRoles(");
  assert(decide >= 0, "nothing in the branch asks whether the answer is known");
  assert(spend >= 0, "the branch no longer calls classifyPhotoRoles");
  assert(
    decide < spend,
    "the recorded verdict is consulted AFTER the vision call has already been " +
      "paid for, which is the same bill with extra steps",
  );
  assert(
    branch.includes("readTagRolePassAnswers("),
    "the verdict is never parsed out of the enrichment rows",
  );
});

Deno.test("the vision call is gated on the answer, not merely informed by it", () => {
  const branch = roleBranch();
  // The guard has to sit between the decision and the spend. Asserting that
  // `!answered` appears SOMEWHERE would pass on a log line that mentions it.
  const decide = branch.indexOf("tagRolePassAlreadyAnswered(");
  const spend = branch.indexOf("await classifyPhotoRoles(");
  const between = branch.slice(decide, spend);
  assert(
    /if\s*\([^)]*!answered[^)]*\)\s*\{/.test(between),
    "no `if (... !answered ...)` stands between the decision and the vision call",
  );
});

Deno.test("the history read is tenant-scoped on both keys", () => {
  const branch = roleBranch();
  assert(
    branch.includes('.from("ai_enrichment_log")'),
    "the verdict is read from somewhere other than ai_enrichment_log",
  );
  // US-268: this is the service-role client, so the .eq pair IS the isolation.
  assert(
    branch.includes('.eq("user_id", ownerId)'),
    "the history read is not scoped to the owner - the service-role client " +
      "bypasses RLS, so an unscoped read is a cross-tenant read",
  );
  assert(
    branch.includes('.eq("inventory_item_id", itemId)'),
    "the history read is not scoped to this item",
  );
});

Deno.test("the verdict reaches the row the next run reads", () => {
  // Scoped to the enrichment insert rather than the whole file: the two keys
  // have to be on the payload that is written, not merely mentioned somewhere.
  const code = codeOnly(SRC);
  const start = code.indexOf('.from("ai_enrichment_log").insert({');
  assert(start >= 0, "the generation's enrichment insert moved or was renamed");
  const payload = code.slice(start, start + 4000);
  assert(
    payload.includes("photo_role_found_tag:"),
    "the generation records no verdict, so the next batch over a tagless item " +
      "pays for the same answer again",
  );
  assert(
    payload.includes("photo_role_photo_ids:"),
    "the verdict is recorded without the photos it was about, so a photo the " +
      "seller adds later would never be looked at",
  );
});

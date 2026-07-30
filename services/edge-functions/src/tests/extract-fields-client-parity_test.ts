// US-2269 drift guard. The extract endpoint returns a fixed set of field names
// (EXTRACT_FIELDS) and each client has to be able to PERSIST every one of them.
// iOS couldn't: `AIItemFieldWriter.FieldUpdate.assign` had no `condition_notes`
// case, so the AI's read of the garment's condition hit a `default: break` — the
// review screen counted it as applied and the column never changed. Silent, and
// invisible from either side alone.
//
// This lives on the EDGE side deliberately: EXTRACT_FIELDS is the source of
// truth, the Swift test suite can't run on a non-macOS dev host, and this can.
// Adding a field to EXTRACT_FIELDS without teaching both clients to store it now
// fails here.
import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("../../../../", import.meta.url);

const EXTRACT_LIB = new URL("services/edge-functions/src/lib/ai-extract.ts", REPO_ROOT);
const IOS_WRITER = new URL(
  "ios/GradeThread/AIExtract/AIItemFieldWriter.swift",
  REPO_ROOT,
);
const WEB_INTAKE = new URL("src/pages/flipdesk/intake.tsx", REPO_ROOT);

/** Pull the string literals out of a `const NAME = [ ... ] as const;` block. */
function arrayLiteral(src: string, declaration: RegExp): string[] {
  const m = declaration.exec(src);
  assert(m, `could not find the declaration ${declaration} — did it get renamed?`);
  return [...m[1]!.matchAll(/["']([a-z_0-9]+)["']/g)].map((x) => x[1]!);
}

Deno.test("US-2269: every EXTRACT_FIELDS name is persistable by the iOS writer", async () => {
  const extractSrc = await Deno.readTextFile(EXTRACT_LIB);
  const fields = arrayLiteral(
    extractSrc,
    /const EXTRACT_FIELDS = \[([\s\S]*?)\] as const;/,
  );
  assert(fields.length >= 10, `expected the full field set, saw ${fields.length}`);
  assert(fields.includes("condition_notes"), "the field this guard exists for");

  const swift = await Deno.readTextFile(IOS_WRITER);

  // 1. The Swift mirror of the list must match EXACTLY, order included — it is
  //    what the iOS parity XCTest iterates.
  const mirrored = arrayLiteral(
    swift,
    /static let serverExtractFields: \[String\] = \[([\s\S]*?)\]/,
  );
  assertEquals(
    mirrored,
    fields,
    "ios AIItemFieldWriter.serverExtractFields has drifted from EXTRACT_FIELDS",
  );

  // 2. And each field must actually have a case in `assign` — the mirror being
  //    right is worth nothing if the switch still drops the value.
  const assignBody =
    /mutating func assign\(field: String, value: String\) -> Bool \{([\s\S]*?)\n\s{8}\}/
      .exec(swift)?.[1] ?? "";
  assert(assignBody.length > 0, "could not locate FieldUpdate.assign in the Swift source");
  const missing = fields.filter((f) => !assignBody.includes(`case "${f}":`));
  assertEquals(
    missing,
    [],
    `these EXTRACT_FIELDS have no case in iOS FieldUpdate.assign, so the AI's ` +
      `value is applied in the review and dropped before the write: ${missing.join(", ")}`,
  );
});

// US-2268: `known_fields` is the seller's own values, and the extract route
// DELETES every known key from its suggestions before responding. So the set a
// client sends decides which fields the AI is allowed to compete on — and the two
// clients must agree, or the same item behaves differently depending on which app
// ran the fill.
Deno.test("US-2268: iOS and web send the same known_fields set", async () => {
  const swift = await Deno.readTextFile(
    new URL("ios/GradeThread/AIExtract/AIExtractInputs.swift", REPO_ROOT),
  );
  // The tuple list inside `var knownFields` — ("brand", brand), ("style", style)…
  const knownBlock = /var knownFields: \[String: KnownFieldValue\]\?\s*\{([\s\S]*?)\n\s{4}\}/
    .exec(swift)?.[1] ?? "";
  assert(knownBlock.length > 0, "could not locate AIExtractInputs.knownFields");
  const iosKeys = [...knownBlock.matchAll(/\("([a-z_]+)",/g)].map((m) => m[1]!).sort();
  assert(iosKeys.length >= 8, `expected the full known set, saw ${iosKeys.join(",")}`);

  // The web composer's ENRICHABLE list: { key: "brand", value: … } entries.
  const composer = await Deno.readTextFile(
    new URL("src/pages/flipdesk/composer.tsx", REPO_ROOT),
  );
  const enrichable = /const ENRICHABLE: \{[\s\S]*?\n\s{4}\? \[([\s\S]*?)\n\s{6}\]/
    .exec(composer)?.[1] ?? "";
  assert(enrichable.length > 0, "could not locate ENRICHABLE in composer.tsx");
  const webKeys = [...enrichable.matchAll(/key:\s*"([a-z_]+)"/g)].map((m) => m[1]!).sort();

  assertEquals(
    iosKeys,
    webKeys,
    "AIExtractInputs.knownFields (iOS) and ENRICHABLE (web composer) disagree — " +
      "the same item would let the AI overwrite different fields depending on " +
      "which client ran the fill",
  );

  // And every one of them must be a field the server can actually return,
  // otherwise it is a key the delete-step will never match.
  const extractSrc = await Deno.readTextFile(EXTRACT_LIB);
  const fields = arrayLiteral(
    extractSrc,
    /const EXTRACT_FIELDS = \[([\s\S]*?)\] as const;/,
  );
  const unknown = iosKeys.filter((k) => !fields.includes(k));
  assertEquals(unknown, [], `known_fields keys the server never suggests: ${unknown}`);
});

Deno.test("US-2269: the web intake applies every EXTRACT_FIELDS name too", async () => {
  const extractSrc = await Deno.readTextFile(EXTRACT_LIB);
  const fields = arrayLiteral(
    extractSrc,
    /const EXTRACT_FIELDS = \[([\s\S]*?)\] as const;/,
  );
  const intake = await Deno.readTextFile(WEB_INTAKE);
  const fillable = arrayLiteral(
    intake,
    /const AI_FILLABLE_FIELDS = \[([\s\S]*?)\] as const;/,
  );

  // The intake form is text-driven, so it deliberately doesn't offer the
  // garment_* classifiers (it derives those via deriveGarmentDefaults) or a
  // public `description` (that field is the seller's own copy there). Everything
  // else the AI can return must be applicable.
  const exempt = new Set(["garment_type", "garment_category", "description"]);
  const missing = fields.filter((f) => !exempt.has(f) && !fillable.includes(f));
  assertEquals(
    missing,
    [],
    `these EXTRACT_FIELDS are returned by the server but not applicable on the ` +
      `web intake form: ${missing.join(", ")}`,
  );
});

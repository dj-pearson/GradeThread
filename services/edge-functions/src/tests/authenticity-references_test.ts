// US-2218: known-genuine reference imagery for authentication tells.
//
// The rules under test:
//   1. Only VISUAL tells need a reference. Marking a date-code tell unverifiable
//      would make the limitation text noise reviewers learn to ignore.
//   2. Absence LOWERS confidence and NEVER raises suspicion — a gap in our
//      evidence is not an accusation about someone's garment.
//   3. Seller photos are never promoted into the corpus, and rights are
//      mandatory. Both are enforced in the schema, and pinned here.
//   4. No references => the prompt is byte-identical to the US-1769 block.
//
//   deno test --allow-env --allow-read src/tests/authenticity-references_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  assessTellVerifiability,
  referenceCaptionBlock,
  referenceConfidenceCap,
  referenceLimitation,
  REFERENCE_BUCKET,
  REFERENCE_CAP_ALL,
  REFERENCE_CAP_SOME,
  REFERENCE_SIGNED_URL_TTL_SECONDS,
  VISUAL_TELL_CATEGORIES,
} = await import("../lib/authenticity-references.ts");
const { buildTellsBlock } = await import("../lib/ai-authenticity.ts");

const tell = (category: string, claim: string) => ({
  category,
  claim,
  check: `check the ${category}`,
  confidence: 0.6,
  // deno-lint-ignore no-explicit-any
}) as any;

const ref = (tellCategory: string, caption = "a verified genuine example") => ({
  brandKey: "louisvuitton",
  style: "",
  tellCategory,
  storagePath: `louisvuitton/${tellCategory}.jpg`,
  caption,
  source: "owned photograph of an authenticated example",
  rights: "owned outright",
  confidence: 0.9,
  verified: true,
});

// The real seeded shape: LV's stamp tell literally says to compare against a
// known-genuine reference, which is the gap this story closes.
const LV_TELLS = [
  tell("stamp", "The heat stamp has crisp, evenly-spaced serifs."),
  tell("hardware", "Hardware is heavy solid brass."),
  tell("date_code", "Items 1980s-2020 carry a heat-stamped date code."),
];

// ── 1. Only visual tells need imagery ──────────────────────────────────────

Deno.test("US-2218: a visual tell with no reference is marked unverifiable", () => {
  const v = assessTellVerifiability(LV_TELLS, []);
  assertEquals(v.filter((x) => x.visuallyUnverifiable).map((x) => x.tell.category), [
    "stamp",
    "hardware",
  ]);
});

Deno.test("US-2218: a non-visual tell is NEVER marked unverifiable", () => {
  // A date code is READ, not looked at. Marking it would dilute the limitation
  // text until reviewers stop reading it.
  const v = assessTellVerifiability(LV_TELLS, []);
  const dateCode = v.find((x) => x.tell.category === "date_code");
  assertEquals(dateCode?.visuallyUnverifiable, false);
  // Widened to ReadonlySet<string>: the point is to check categories that are
  // NOT members, which a ReadonlySet<AuthTellCategory> will not accept as an
  // argument.
  const visual: ReadonlySet<string> = VISUAL_TELL_CATEGORIES;
  for (const c of ["date_code", "serial", "packaging", "material", "other"]) {
    assert(!visual.has(c), `${c} must not require imagery`);
  }
});

Deno.test("US-2218: a reference for the category clears its tell", () => {
  const v = assessTellVerifiability(LV_TELLS, [ref("stamp")]);
  assertEquals(v.find((x) => x.tell.category === "stamp")?.visuallyUnverifiable, false);
  // ...and does NOT clear a different category.
  assertEquals(v.find((x) => x.tell.category === "hardware")?.visuallyUnverifiable, true);
});

// ── 2. Absence lowers confidence, never raises suspicion ───────────────────

Deno.test("US-2218: no visual tells at all means no cap", () => {
  const v = assessTellVerifiability([tell("date_code", "x")], []);
  assertEquals(referenceConfidenceCap(v), 1);
});

Deno.test("US-2218: every visual tell unreferenced caps hardest", () => {
  assertEquals(referenceConfidenceCap(assessTellVerifiability(LV_TELLS, [])), REFERENCE_CAP_ALL);
});

Deno.test("US-2218: some referenced caps less hard", () => {
  const v = assessTellVerifiability(LV_TELLS, [ref("stamp")]);
  assertEquals(referenceConfidenceCap(v), REFERENCE_CAP_SOME);
  assert(REFERENCE_CAP_SOME > REFERENCE_CAP_ALL, "partial coverage must beat none");
});

Deno.test("US-2218: full visual coverage removes the cap", () => {
  const v = assessTellVerifiability(LV_TELLS, [ref("stamp"), ref("hardware")]);
  assertEquals(referenceConfidenceCap(v), 1);
});

Deno.test("US-2218: the cap can only LOWER confidence", () => {
  // The grading-engine contract: caps compose by min and never raise.
  for (const cap of [REFERENCE_CAP_ALL, REFERENCE_CAP_SOME, 1]) {
    assert(cap <= 1, "a cap above 1 would raise confidence");
    assert(cap > 0, "a cap of 0 would erase the assessment rather than temper it");
  }
});

Deno.test("US-2218: the limitation names the categories, not a count", () => {
  const text = referenceLimitation(assessTellVerifiability(LV_TELLS, []));
  assertStringIncludes(text, "hardware, stamp");
  assertStringIncludes(text, "weaker evidence");
  // It describes OUR gap, not the garment. No accusatory language.
  for (const word of ["counterfeit", "fake", "suspect", "inauthentic"]) {
    assert(!text.toLowerCase().includes(word), `must not say "${word}"`);
  }
});

Deno.test("US-2218: nothing unverifiable means no added limitation", () => {
  assertEquals(referenceLimitation(assessTellVerifiability(LV_TELLS, [ref("stamp"), ref("hardware")])), "");
  assertEquals(referenceLimitation([]), "");
});

// ── 3. The prompt reports UNVERIFIED rather than reasoning from memory ─────

Deno.test("US-2218: an unreferenced visual tell is marked in the prompt", () => {
  const block = buildTellsBlock(LV_TELLS, [], assessTellVerifiability(LV_TELLS, []));
  assertStringIncludes(block, "NO known-genuine reference image is held");
  assertStringIncludes(block, "report it as UNVERIFIED");
  // The tell is still PRESENT — the claim is useful context, it just cannot
  // carry a confident finding.
  assertStringIncludes(block, "crisp, evenly-spaced serifs");
});

Deno.test("US-2218: a referenced tell carries no such marker", () => {
  const v = assessTellVerifiability([LV_TELLS[0]], [ref("stamp")]);
  const block = buildTellsBlock([LV_TELLS[0]], [], v);
  assert(!block.includes("NO known-genuine reference"));
});

Deno.test("US-2218: no verifiability info leaves the block byte-identical", () => {
  // Strictly additive: the US-1769 grounded block is unchanged when this
  // feature has nothing to say.
  assertEquals(buildTellsBlock(LV_TELLS, [], []), buildTellsBlock(LV_TELLS, []));
});

Deno.test("US-2218: caption block is empty with no references", () => {
  assertEquals(referenceCaptionBlock(assessTellVerifiability(LV_TELLS, [])), "");
  const withRefs = referenceCaptionBlock(
    assessTellVerifiability(LV_TELLS, [ref("stamp", "serif spacing on a verified example")]),
  );
  assertStringIncludes(withRefs, "serif spacing on a verified example");
});

// ── 4. Rights, privacy and private storage ─────────────────────────────────

// Normalized to "\n": git checks .sql out with native line endings, so on
// Windows a multi-line assertion below would fail against a file CI reads as LF.
const MIGRATION = (await Deno.readTextFile(
  new URL("../../../../supabase/migrations/00500_authenticity_references.sql", import.meta.url),
)).replace(/\r\n/g, "\n");

Deno.test("US-2218: rights are mandatory at the schema level", () => {
  // A NULL default would have made omitting provenance the easy path.
  assert(
    /rights\s+text\s+NOT NULL/i.test(MIGRATION),
    "rights must be NOT NULL with no default",
  );
  assert(
    !/rights\s+text\s+NOT NULL\s+DEFAULT/i.test(MIGRATION),
    "rights must not have a default",
  );
  assert(/source\s+text\s+NOT NULL/i.test(MIGRATION));
});

Deno.test("US-2218: the bucket is PRIVATE and is not item-photos", () => {
  assertEquals(REFERENCE_BUCKET, "authenticity-references");
  // Widened to string on purpose. TypeScript narrows the exported const to a
  // literal type and can prove this comparison at compile time, which makes the
  // expression an error rather than an assertion — but the RUNTIME guard is
  // still what we want, so a later edit to the constant fails a test instead of
  // silently pointing at the public bucket.
  assert(
    (REFERENCE_BUCKET as string) !== "item-photos",
    "never the public bucket",
  );
  assertStringIncludes(MIGRATION, "'authenticity-references',\n  false,");
});

// Strip comments before asserting on source. The prose EXPLAINING these rules
// necessarily contains the forbidden strings ("never getPublicUrl", "no link to
// submission_images"), so a naive substring check fails on its own
// documentation. Assert on what executes, not on what it says about itself.
function codeOnly(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}
function sqlOnly(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    // `comment on ...` statements are documentation too. Match through the
    // CLOSING QUOTE before the semicolon: the comment prose itself contains
    // semicolons, so a plain `;` terminator truncates early and leaves the tail
    // of the sentence in the "executable" SQL. Same trap as the pack parser in
    // US-2216.
    .replace(/comment on [\s\S]*?';/gi, "");
}

Deno.test("US-2218: reads are signed and short-lived", () => {
  assert(REFERENCE_SIGNED_URL_TTL_SECONDS <= 900, "TTL must match the private-bucket rule");
  const src = codeOnly(
    Deno.readTextFileSync(new URL("../lib/authenticity-references.ts", import.meta.url)),
  );
  assertStringIncludes(src, "createSignedUrl");
  assert(!src.includes("getPublicUrl"), "a public URL would be permanent");
});

Deno.test("US-2218: there is NO path from seller photos into the corpus", () => {
  // US-1067's privacy rule applied here: a reference corpus that quietly
  // absorbs customer uploads is a privacy incident waiting to be found.
  const sql = sqlOnly(MIGRATION);
  assert(
    !/references\s+public\.submission_images/i.test(sql),
    "the table must not FK to submission_images",
  );
  assert(!/submission_images/i.test(sql), "no executable SQL may name submission_images");
  const src = codeOnly(
    Deno.readTextFileSync(new URL("../lib/authenticity-references.ts", import.meta.url)),
  );
  assert(!src.includes("submission_images"), "no code path may copy seller photos");
  assert(!src.includes('"submission-images"'), "nor read the seller bucket");
});

Deno.test("US-2218: the table is registered as service-role-only", () => {
  const guard = Deno.readTextFileSync(
    new URL("./rls-guard_test.ts", import.meta.url),
  );
  assertStringIncludes(guard, '"authenticity_references"');
  assertStringIncludes(MIGRATION, "ENABLE ROW LEVEL SECURITY");
});

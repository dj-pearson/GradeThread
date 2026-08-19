// US-2677: near-duplicate title detection.
//
// The number these tests defend is the THRESHOLD, and the way to defend a
// threshold is with cases from both sides of it that a reader can judge for
// themselves. So the fixtures below are the two real shapes: a template-written
// batch that differs only by size (should warn), and two genuinely different
// garments that happen to share a brand and a garment type (should not).
//
// Pure: no database, no eBay, no clock.

import { assert, assertEquals } from "@std/assert";

const {
  DUPLICATE_TITLE_OVERLAP,
  MIN_TITLE_TOKENS,
  distinctiveTokens,
  duplicateTitleWarning,
  findDuplicateTitles,
  findDuplicatesWithinBatch,
  titleOverlap,
} = await import("../lib/title-similarity.ts");

// ── tokens ─────────────────────────────────────────────────────────────────

Deno.test("words every thrift title carries are not distinguishing", () => {
  // "vintage" is a real SEARCH term and a useless discriminator, because half
  // a thrift seller's inventory is vintage. The two lists are different jobs.
  const tokens = distinctiveTokens("Vintage Nike Mens Size Large Tee NWOT");
  assertEquals(tokens.includes("vintage"), false);
  assertEquals(tokens.includes("mens"), false);
  assertEquals(tokens.includes("size"), false);
  assertEquals(tokens.includes("nwot"), false);
  assertEquals(tokens.includes("nike"), true);
  assertEquals(tokens.includes("tee"), true);
});

Deno.test("a repeated word counts once, so stuffing cannot inflate overlap", () => {
  assertEquals(distinctiveTokens("Nike Nike Nike Swoosh Tee"), ["nike", "swoosh", "tee"]);
});

Deno.test("punctuation and emoji are stripped, not treated as tokens", () => {
  assertEquals(
    distinctiveTokens("Nike -- Swoosh/Tee (Blue!)"),
    ["nike", "swoosh", "tee", "blue"],
  );
});

// ── the threshold, from both sides ─────────────────────────────────────────

Deno.test("a template-written pair differing only by size IS a near-duplicate", () => {
  const overlap = titleOverlap(
    "Nike Swoosh Embroidered Cotton T Shirt Blue Large",
    "Nike Swoosh Embroidered Cotton T Shirt Blue Medium",
  );
  assert(
    overlap >= DUPLICATE_TITLE_OVERLAP,
    `template-written pair scored ${overlap}, under the ${DUPLICATE_TITLE_OVERLAP} threshold`,
  );
});

Deno.test("two real garments sharing a brand and a type are NOT duplicates", () => {
  const overlap = titleOverlap(
    "Nike Swoosh Embroidered Cotton T Shirt Blue Large",
    "Nike Therma Fit Fleece Hoodie Black Full Zip Medium",
  );
  assert(
    overlap < DUPLICATE_TITLE_OVERLAP,
    `two different garments scored ${overlap}, at or over the threshold`,
  );
});

Deno.test("a short title inside a long one is NOT scored as a perfect match", () => {
  // This is the case that rules out the overlap coefficient, which divides by
  // the shorter side and would call this 1.0. It is not a duplicate; it is a
  // less descriptive title.
  const overlap = titleOverlap(
    "Nike Swoosh Cotton Tee",
    "Nike Swoosh Cotton Tee Single Stitch Faded Blue Large Made In USA",
  );
  assert(overlap < 1, "a contained title scored a perfect match");
  assert(overlap < DUPLICATE_TITLE_OVERLAP, `contained title scored ${overlap}`);
});

Deno.test("an identical title scores 1", () => {
  const t = "Carhartt Detroit Blanket Lined Duck Jacket Brown";
  assertEquals(titleOverlap(t, t), 1);
});

Deno.test("titles below the token floor are not compared at all", () => {
  // Overlap between very short titles is quantised so coarsely that the number
  // stops meaning anything, so it returns 0 rather than a misleading score.
  assertEquals(titleOverlap("Nike Tee", "Nike Tee"), 0);
  assertEquals(titleOverlap("", ""), 0);
});

Deno.test("the token floor is what MIN_TITLE_TOKENS says it is", () => {
  const short = Array.from({ length: MIN_TITLE_TOKENS - 1 }, (_, i) => `word${i}`).join(" ");
  const atFloor = Array.from({ length: MIN_TITLE_TOKENS }, (_, i) => `word${i}`).join(" ");
  assertEquals(titleOverlap(short, short), 0);
  assertEquals(titleOverlap(atFloor, atFloor), 1);
});

// ── findDuplicateTitles ────────────────────────────────────────────────────

const CANDIDATE = "Nike Swoosh Embroidered Cotton T Shirt Blue Large";

Deno.test("AC5: no other listing means no warning", () => {
  assertEquals(findDuplicateTitles(CANDIDATE, []), []);
});

Deno.test("only listings at or over the threshold are returned", () => {
  const findings = findDuplicateTitles(CANDIDATE, [
    { listingId: "l-dup", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Medium" },
    { listingId: "l-ok", title: "Levis 501 Straight Leg Denim Jeans Dark Wash 32x30" },
  ]);
  assertEquals(findings.map((f) => f.listingId), ["l-dup"]);
});

Deno.test("findings are ranked worst first, because one gets fixed at a time", () => {
  const findings = findDuplicateTitles(CANDIDATE, [
    { listingId: "l-near", title: "Nike Swoosh Embroidered Cotton T Shirt Green Small" },
    { listingId: "l-exact", title: CANDIDATE },
  ]);
  assertEquals(findings.length, 2, "the colour-and-size variant was not caught");
  assertEquals(findings[0]!.listingId, "l-exact");
  assert(findings[0]!.overlap >= findings[1]!.overlap);
});

Deno.test("the threshold separates the four shapes it was measured on", () => {
  // The numbers in DUPLICATE_TITLE_OVERLAP's doc comment, asserted rather than
  // written down, so a future reader can re-judge the threshold from cases
  // instead of trusting a paragraph.
  const sizeOnly = titleOverlap(
    CANDIDATE,
    "Nike Swoosh Embroidered Cotton T Shirt Blue Medium",
  );
  const colourAndSize = titleOverlap(
    CANDIDATE,
    "Nike Swoosh Embroidered Cotton T Shirt Green Small",
  );
  const contained = titleOverlap(
    "Nike Swoosh Cotton Tee",
    "Nike Swoosh Cotton Tee Single Stitch Faded Blue Large Made In USA",
  );
  const differentGarment = titleOverlap(
    CANDIDATE,
    "Nike Therma Fit Fleece Hoodie Black Full Zip Medium",
  );

  // Both template-written shapes are duplicates. The colour-and-size pair is
  // the one a 0.6 threshold used to miss, and it is the same nine tees.
  assert(sizeOnly >= DUPLICATE_TITLE_OVERLAP, "size-only pair: " + sizeOnly);
  assert(colourAndSize >= DUPLICATE_TITLE_OVERLAP, "colour+size pair: " + colourAndSize);
  // Neither of these is a duplicate.
  assert(contained < DUPLICATE_TITLE_OVERLAP, "contained title: " + contained);
  assert(differentGarment < DUPLICATE_TITLE_OVERLAP, "different garment: " + differentGarment);

  // And the gap is wide, which is the actual justification for one threshold.
  assert(
    Math.min(sizeOnly, colourAndSize) - Math.max(contained, differentGarment) > 0.15,
    "the duplicate and non-duplicate shapes are no longer well separated",
  );
});

Deno.test("AC3: the finding names the tokens the conflict owns and the candidate lacks", () => {
  // This is what a regenerate-to-differentiate action consumes: wording already
  // spoken for, which the new title should not lean on.
  const [finding] = findDuplicateTitles(CANDIDATE, [
    { listingId: "l-dup", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Medium" },
  ]);
  assert(finding);
  assertEquals(finding.conflictOnlyTokens, ["medium"]);
  assert(finding.sharedTokens.includes("swoosh"));
  assert(!finding.sharedTokens.includes("medium"));
});

Deno.test("the finding names the conflicting listing so the seller can open it", () => {
  const [finding] = findDuplicateTitles(CANDIDATE, [
    { listingId: "l-dup", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Medium" },
  ]);
  assertEquals(finding!.listingId, "l-dup");
  assertEquals(finding!.title, "Nike Swoosh Embroidered Cotton T Shirt Blue Medium");
});

Deno.test("the count is capped so one bad batch is not a wall of warnings", () => {
  const others = Array.from({ length: 12 }, (_, i) => ({
    listingId: `l-${i}`,
    title: `Nike Swoosh Embroidered Cotton T Shirt Blue Size${i}`,
  }));
  assertEquals(findDuplicateTitles(CANDIDATE, others).length, 3);
  assertEquals(findDuplicateTitles(CANDIDATE, others, { max: 1 }).length, 1);
});

Deno.test("a too-short candidate warns about nothing, whatever it is compared to", () => {
  assertEquals(findDuplicateTitles("Nike Tee", [{ listingId: "l", title: "Nike Tee" }]), []);
});

Deno.test("the warning line names the percentage and the conflicting title", () => {
  const [finding] = findDuplicateTitles(CANDIDATE, [
    { listingId: "l-dup", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Medium" },
  ]);
  const text = duplicateTitleWarning(finding!);
  assert(text.includes("Blue Medium"), text);
  assert(/\d+% the same/.test(text), text);
});

// ── AC6: the batch against itself ──────────────────────────────────────────

Deno.test("AC6: nine template-written tees are flagged at generation", () => {
  // None of these is live yet, so the per-listing check compares every one of
  // them against an empty set and passes all nine. They only become each
  // other's duplicates after publish, which is too late to be told.
  // Real size WORDS, not trailing digits: a digit is one character and gets
  // dropped in tokenizing, so nine "Size 1..9" titles would tokenize
  // identically and this would assert 1.0 overlap rather than near-duplicate
  // detection. The fixture has to be near-identical, not identical.
  const sizes = ["XS", "Small", "Medium", "Large", "XL", "XXL", "28", "30", "32"];
  const drafts = sizes.map((size, i) => ({
    id: `d-${i}`,
    title: `Vintage Nike Swoosh Single Stitch T Shirt ${size}`,
  }));
  const pairs = findDuplicatesWithinBatch(drafts);
  assert(pairs.length > 0, "a batch of nine near-identical titles produced no pairs");
  // 9 choose 2, each reported once.
  assertEquals(pairs.length, 36);
});

Deno.test("each pair is reported ONCE, in id order, not twice from both sides", () => {
  const pairs = findDuplicatesWithinBatch([
    { id: "b", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Large" },
    { id: "a", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Medium" },
  ]);
  assertEquals(pairs.length, 1);
  assertEquals(pairs[0]!.a, "a");
  assertEquals(pairs[0]!.b, "b");
});

Deno.test("a batch of genuinely different garments produces no pairs", () => {
  const pairs = findDuplicatesWithinBatch([
    { id: "a", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Large" },
    { id: "b", title: "Levis 501 Straight Leg Denim Jeans Dark Wash 32x30" },
    { id: "c", title: "Carhartt Detroit Blanket Lined Duck Jacket Brown XL" },
  ]);
  assertEquals(pairs, []);
});

Deno.test("a batch of one, or of none, produces no pairs", () => {
  assertEquals(findDuplicatesWithinBatch([]), []);
  assertEquals(
    findDuplicatesWithinBatch([{ id: "a", title: "Nike Swoosh Cotton T Shirt Blue Large" }]),
    [],
  );
});

Deno.test("batch pairs are ranked worst first", () => {
  const pairs = findDuplicatesWithinBatch([
    { id: "a", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Large" },
    { id: "b", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Medium" },
    { id: "c", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Large" },
  ]);
  assert(pairs.length >= 2);
  assertEquals(pairs[0]!.overlap, 1, "the identical pair was not ranked first");
});

Deno.test("the threshold is overridable, and overriding it actually changes the answer", () => {
  const drafts = [
    { id: "a", title: "Nike Swoosh Embroidered Cotton T Shirt Blue Large" },
    { id: "b", title: "Nike Therma Fit Fleece Hoodie Black Full Zip Medium" },
  ];
  assertEquals(findDuplicatesWithinBatch(drafts), []);
  assertEquals(findDuplicatesWithinBatch(drafts, { threshold: 0.05 }).length, 1);
});

Deno.test("the threshold is a fraction, not a percentage", () => {
  assert(DUPLICATE_TITLE_OVERLAP > 0 && DUPLICATE_TITLE_OVERLAP < 1);
});

// US-2211: the RN/CA cross-check.
//
// The rules under test are the ones that keep a public identity signal honest:
//   1. Parsing accepts what a label actually prints, and rejects what isn't one.
//   2. "no reference" is a distinct outcome from "contradicts" — it is the
//      NORMAL case (six brands carry a seeded number) and means nothing.
//   3. A shared registrant (URBN) is consistent, not a match and not a conflict.
//   4. Nothing here ever mints or rewrites a brand.
//
//   deno test --allow-env --allow-read src/tests/registered-numbers_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  assessRegisteredNumber,
  buildRegisteredNumberIndex,
  expandSeededNumber,
  MAX_RANGE_EXPANSION,
  parseRegisteredNumber,
  registeredNumberKey,
} = await import("../lib/registered-numbers.ts");

const { buildPersistedTagRead, acceptedTagFields, tagDiscrepancies } =
  await import("../lib/tag-ground-truth.ts");

// Mirrors the six real seeded rows, including URBN's shared number (00466).
const ROWS = [
  { brand_key: "aloyoga", canonical_brand: "Alo Yoga", registered_numbers: ["RN 87370"] },
  { brand_key: "zara", canonical_brand: "Zara", registered_numbers: ["RN 77302"] },
  {
    brand_key: "urbanoutfitters",
    canonical_brand: "Urban Outfitters",
    registered_numbers: ["RN 66170", "CA 32054"],
  },
  {
    brand_key: "anthropologie",
    canonical_brand: "Anthropologie",
    registered_numbers: ["RN 66170"],
  },
  {
    brand_key: "freepeople",
    canonical_brand: "Free People",
    registered_numbers: ["RN 66170"],
  },
  { brand_key: "luckybrand", canonical_brand: "Lucky Brand", registered_numbers: ["RN 80318"] },
];
const INDEX = buildRegisteredNumberIndex(ROWS);

// ── 1. Parsing ──────────────────────────────────────────────────────────────

Deno.test("parseRegisteredNumber accepts the forms a label and an OCR produce", () => {
  for (const raw of ["RN 106259", "RN106259", "rn# 106259", " 106259 ", "RN  106259"]) {
    const p = parseRegisteredNumber(raw);
    assert(p, `expected ${JSON.stringify(raw)} to parse`);
    assertEquals(p.kind, "RN");
    assertEquals(p.digits, "106259");
  }
  const ca = parseRegisteredNumber("CA 32054");
  assertEquals(ca?.kind, "CA");
  assertEquals(ca?.digits, "32054");
});

Deno.test("parseRegisteredNumber strips leading zeros so padding is not a mismatch", () => {
  assertEquals(
    registeredNumberKey(parseRegisteredNumber("RN 087370")!),
    registeredNumberKey(parseRegisteredNumber("RN 87370")!),
  );
});

Deno.test("parseRegisteredNumber rejects things that are not registry numbers", () => {
  // Too short, too long, empty, non-numeric, and a style code with letters —
  // the last is what keeps a style number from being cross-checked as an RN.
  for (const raw of ["", "  ", "7", "12345678", "abc", "LW1234", "RN", "RN abc"]) {
    assertEquals(
      parseRegisteredNumber(raw),
      null,
      `expected ${JSON.stringify(raw)} to be rejected`,
    );
  }
  assertEquals(parseRegisteredNumber(null), null);
  assertEquals(parseRegisteredNumber(undefined), null);
});

// ── Range expansion ─────────────────────────────────────────────────────────

Deno.test("expandSeededNumber handles singletons and small ranges", () => {
  assertEquals(expandSeededNumber("RN 87370"), ["RN:87370"]);
  assertEquals(expandSeededNumber("RN 100-102"), ["RN:100", "RN:101", "RN:102"]);
  assertEquals(expandSeededNumber("CA 10-11"), ["CA:10", "CA:11"]);
});

Deno.test("expandSeededNumber refuses a range too wide to be evidence", () => {
  const wide = `RN 1000-${1000 + MAX_RANGE_EXPANSION}`;
  assertEquals(expandSeededNumber(wide), []);
  // ...and an inverted or malformed one.
  assertEquals(expandSeededNumber("RN 500-100"), []);
  assertEquals(expandSeededNumber("not a number"), []);
});

// ── 2. Index ────────────────────────────────────────────────────────────────

Deno.test("the index maps a shared number to every brand that claims it", () => {
  const owners = INDEX.get("RN:66170") ?? [];
  assertEquals(owners.map((o) => o.brandKey).sort(), [
    "anthropologie",
    "freepeople",
    "urbanoutfitters",
  ]);
});

Deno.test("a brand listing the same number twice appears once", () => {
  const idx = buildRegisteredNumberIndex([
    { brand_key: "x", canonical_brand: "X", registered_numbers: ["RN 5555", "RN 05555"] },
  ]);
  assertEquals(idx.get("RN:5555")?.length, 1);
});

Deno.test("a null registered_numbers column does not break the index", () => {
  const idx = buildRegisteredNumberIndex([
    { brand_key: "x", canonical_brand: "X", registered_numbers: null },
  ]);
  assertEquals(idx.size, 0);
});

// ── 3. Outcomes ─────────────────────────────────────────────────────────────

Deno.test("a matching number CORROBORATES and says so without claiming proof", () => {
  const a = assessRegisteredNumber("RN 87370", "Alo Yoga", INDEX);
  assertEquals(a.outcome, "corroborates");
  assertEquals(a.owners.map((o) => o.brandKey), ["aloyoga"]);
  assert(a.note.includes("never proof"), "must not read as proof of authenticity");
});

Deno.test("a shared registrant is AMBIGUOUS — consistent but cannot disambiguate", () => {
  // The URBN case: RN 66170 covers three sibling brands (00466).
  for (const brand of ["Urban Outfitters", "Anthropologie", "Free People"]) {
    const a = assessRegisteredNumber("RN 66170", brand, INDEX);
    assertEquals(a.outcome, "ambiguous", `${brand} should be ambiguous, not a clean match`);
    assertEquals(a.owners.length, 3);
  }
});

Deno.test("a number registered elsewhere CONTRADICTS, and still asks for review not a verdict", () => {
  const a = assessRegisteredNumber("RN 87370", "Lululemon", INDEX);
  assertEquals(a.outcome, "contradicts");
  assertEquals(a.owners.map((o) => o.canonicalBrand), ["Alo Yoga"]);
  assert(a.note.includes("Review rather than conclude"));
});

Deno.test("an unknown number is NO_REFERENCE, never a contradiction", () => {
  const a = assessRegisteredNumber("RN 999999", "Levi's", INDEX);
  assertEquals(a.outcome, "no_reference");
  assertEquals(a.owners, []);
  // The distinction this whole story rests on: absence of a reference is not
  // evidence against the item. Six brands carry a number; the rest carry none.
  assert(a.outcome !== "contradicts");
  assert(a.note.includes("no information"));
});

Deno.test("an empty index (DB failure) degrades every lookup to no_reference", () => {
  const a = assessRegisteredNumber("RN 87370", "Lululemon", new Map());
  assertEquals(a.outcome, "no_reference");
});

Deno.test("an unparseable read is UNPARSED, distinct from having no reference", () => {
  assertEquals(assessRegisteredNumber("LW1234", "Alo Yoga", INDEX).outcome, "unparsed");
  assertEquals(assessRegisteredNumber(null, "Alo Yoga", INDEX).outcome, "unparsed");
});

Deno.test("with no declared brand the number resolves but cannot corroborate anything", () => {
  const single = assessRegisteredNumber("RN 87370", null, INDEX);
  assertEquals(single.outcome, "corroborates");
  assert(single.note.includes("No brand was declared"));
  const shared = assessRegisteredNumber("RN 66170", "", INDEX);
  assertEquals(shared.outcome, "ambiguous");
});

Deno.test("brand comparison is alias- and formatting-tolerant", () => {
  // brandKey() normalization: punctuation and case must not fake a conflict.
  for (const brand of ["alo yoga", "ALO YOGA", "Alo  Yoga"]) {
    assertEquals(
      assessRegisteredNumber("RN 87370", brand, INDEX).outcome,
      "corroborates",
      `${brand} should match`,
    );
  }
});

// ── 4. Never rewrites a brand ───────────────────────────────────────────────

Deno.test("the assessment exposes evidence, never a brand to write", () => {
  const a = assessRegisteredNumber("RN 87370", "Lululemon", INDEX);
  // There is deliberately no `correctedBrand` / `resolvedBrand` field: the
  // decoder bar's fourth question (which ENTITY does the identifier name?) is
  // answered "the registrant", which is frequently not the brand on the tag.
  assertEquals(Object.keys(a).sort(), ["normalized", "note", "outcome", "owners"]);
});

// ── Persistence ─────────────────────────────────────────────────────────────

Deno.test("the assessment rides along on the persisted tag read", () => {
  const accepted = acceptedTagFields({
    brand: { value: "Alo Yoga", confidence: 0.9 },
    rn_number: { value: "RN 87370", confidence: 0.8 },
  });
  const row = buildPersistedTagRead(
    accepted,
    tagDiscrepancies(accepted, { brand: "Alo Yoga" }),
    "m",
    "2026-07-28T00:00:00.000Z",
    undefined,
    assessRegisteredNumber("RN 87370", "Alo Yoga", INDEX),
  );
  assertEquals(row.registered_number?.outcome, "corroborates");
});

Deno.test("an unparsed cross-check is omitted rather than persisted as noise", () => {
  const row = buildPersistedTagRead(
    [],
    [],
    "m",
    "2026-07-28T00:00:00.000Z",
    undefined,
    assessRegisteredNumber("nonsense", "Alo Yoga", INDEX),
  );
  assertEquals(row.registered_number, undefined);
  assertEquals("registered_number" in row, false);
});

Deno.test("no cross-check at all leaves the persisted shape unchanged", () => {
  const row = buildPersistedTagRead([], [], "m", "2026-07-28T00:00:00.000Z");
  assertEquals("registered_number" in row, false);
});

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
  mergeRegistryRows,
  parseRegisteredNumber,
  recordRegisteredNumberSighting,
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
  // US-2244 added `registrant` — the company NAME, which is evidence for exactly
  // the same reason it is not a brand to write.
  assertEquals(
    Object.keys(a).sort(),
    ["normalized", "note", "outcome", "owners", "registrant"],
  );
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

// ── US-2243: sightings — recording the numbers we cannot resolve ─────────────

type Sighting = {
  registryKey: string;
  kind: "RN" | "CA";
  digits: string;
  declaredBrand: string | null;
};

Deno.test("a no_reference read is recorded, with its key split into kind + digits", async () => {
  const writes: Sighting[] = [];
  await recordRegisteredNumberSighting(
    assessRegisteredNumber("RN 999999", "Levi's", INDEX),
    "Levi's",
    (a) => {
      writes.push(a);
      return Promise.resolve();
    },
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0]!.registryKey, "RN:999999");
  assertEquals(writes[0]!.kind, "RN");
  assertEquals(writes[0]!.digits, "999999");
  assertEquals(writes[0]!.declaredBrand, "Levi's");
});

Deno.test("a CA number keeps its registry, so it can never collide with an RN", async () => {
  const writes: Sighting[] = [];
  await recordRegisteredNumberSighting(
    assessRegisteredNumber("CA 12345", null, INDEX),
    null,
    (a) => {
      writes.push(a);
      return Promise.resolve();
    },
  );
  assertEquals(writes[0]!.registryKey, "CA:12345");
  assertEquals(writes[0]!.kind, "CA");
  assertEquals(writes[0]!.declaredBrand, null);
});

Deno.test("only no_reference is recorded — a resolved or unparsed read teaches nothing", async () => {
  const cases = [
    assessRegisteredNumber("RN 87370", "Alo Yoga", INDEX), // corroborates
    assessRegisteredNumber("RN 66170", "Free People", INDEX), // ambiguous
    assessRegisteredNumber("RN 87370", "Lululemon", INDEX), // contradicts
    assessRegisteredNumber("nonsense", "Lululemon", INDEX), // unparsed
  ];
  for (const a of cases) {
    let wrote = false;
    await recordRegisteredNumberSighting(a, "Whoever", () => {
      wrote = true;
      return Promise.resolve();
    });
    assertEquals(wrote, false, `${a.outcome} must not be recorded`);
  }
});

Deno.test("a blank declared brand is passed as null, not as an empty string", async () => {
  for (const brand of ["", "   ", null, undefined]) {
    const writes: Sighting[] = [];
    await recordRegisteredNumberSighting(
      assessRegisteredNumber("RN 424242", brand, INDEX),
      brand,
      (a) => {
        writes.push(a);
        return Promise.resolve();
      },
    );
    assertEquals(writes[0]!.declaredBrand, null);
  }
});

Deno.test("a failed sighting write is swallowed — bookkeeping never fails a grade", async () => {
  await recordRegisteredNumberSighting(
    assessRegisteredNumber("RN 999999", "Levi's", INDEX),
    "Levi's",
    () => Promise.reject(new Error("pg down")),
  );
  // Reaching this line without throwing IS the assertion.
  assert(true);
});

// ── US-2244: merging the operator-resolved registry ─────────────────────────

const KNOWN_BRANDS = new Map(ROWS.map((r) => [r.brand_key, r.canonical_brand]));

Deno.test("a resolved row with a known brand_key becomes a full owner", () => {
  const { index, registrants } = mergeRegistryRows(
    buildRegisteredNumberIndex(ROWS),
    [{
      registry_key: "RN:123456",
      company_name: "Lucky Brand Apparel Inc.",
      brand_keys: ["luckybrand"],
    }],
    KNOWN_BRANDS,
  );
  const a = assessRegisteredNumber("RN 123456", "Lucky Brand", index, registrants);
  assertEquals(a.outcome, "corroborates");
  assertEquals(a.owners.map((o) => o.canonicalBrand), ["Lucky Brand"]);
  assertEquals(a.registrant, "Lucky Brand Apparel Inc.");
});

Deno.test("a company-only row surfaces the registrant but NEVER mints a brand", () => {
  const { index, registrants } = mergeRegistryRows(
    buildRegisteredNumberIndex(ROWS),
    [{
      registry_key: "RN:555555",
      company_name: "Delta Apparel Inc.",
      brand_keys: [],
    }],
    KNOWN_BRANDS,
  );
  assertEquals(index.get("RN:555555"), undefined);
  const a = assessRegisteredNumber("RN 555555", "Soffe", index, registrants);
  assertEquals(a.outcome, "no_reference");
  assertEquals(a.owners, []);
  assertEquals(a.registrant, "Delta Apparel Inc.");
  assert(a.note.includes("Delta Apparel Inc."));
  // The company is context, so it must not read as a conflict with the tag.
  assert(!a.note.toLowerCase().includes("not to the brand"));
});

Deno.test("a brand_key nobody has heard of is ignored rather than invented", () => {
  const { index } = mergeRegistryRows(
    buildRegisteredNumberIndex(ROWS),
    [{
      registry_key: "RN:777777",
      company_name: "Some Holdings LLC",
      brand_keys: ["notarealbrandkey"],
    }],
    KNOWN_BRANDS,
  );
  assertEquals(index.get("RN:777777"), undefined);
});

Deno.test("a resolved row ADDS to a seeded number instead of replacing it", () => {
  const { index, registrants } = mergeRegistryRows(
    buildRegisteredNumberIndex(ROWS),
    [{
      registry_key: "RN:87370",
      company_name: "Alo, LLC",
      // Already an owner via brand_knowledge — must not be duplicated.
      brand_keys: ["aloyoga", "zara"],
    }],
    KNOWN_BRANDS,
  );
  const owners = index.get("RN:87370") ?? [];
  assertEquals(owners.length, 2);
  assertEquals(new Set(owners.map((o) => o.brandKey)).size, 2);
  const a = assessRegisteredNumber("RN 87370", "Alo Yoga", index, registrants);
  assertEquals(a.outcome, "ambiguous");
  assertEquals(a.registrant, "Alo, LLC");
});

Deno.test("without a registrants map every pre-2244 caller behaves exactly as before", () => {
  const a = assessRegisteredNumber("RN 999999", "Levi's", INDEX);
  assertEquals(a.outcome, "no_reference");
  assertEquals(a.registrant, null);
  assert(a.note.includes("not in the brand knowledge base"));
});

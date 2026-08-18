// US-2215: size systems, conversions and extended size classes.
//
// The rules under test:
//   1. The system is READ off the labels, never guessed. Bare numbers stay null.
//   2. The conversion table is DERIVED FROM THE CORPUS and a test re-derives it,
//      so it cannot rot away from its own evidence.
//   3. Everything unproven is REFUSED. A wrong size is worse than no size.
//   4. Extended classes are representable; nothing is fabricated for brands that
//      have no extended chart.
//
//   deno test --allow-env --allow-read src/tests/size-systems_test.ts

import { assert, assertEquals } from "@std/assert";

const { SIZING_CHARTS } = await import("../lib/sizing-charts.ts");
const {
  detectSizeClass,
  detectSizeSystem,
  labelNumber,
  SIZE_CONVERSIONS,
  toUsSize,
  usEquivalentForRow,
} = await import("../lib/size-systems.ts");

const chart = (department: string, sizes: string[], garment = "Tops") => ({
  brand: "Test",
  brandMatch: ["test"],
  department,
  garment,
  categoryMatch: ["top"],
  rows: sizes.map((size) => ({ size, measurements: {} })),
});

// ── 1. Detection reads, it does not guess ───────────────────────────────────

Deno.test("a stated system is read off the labels", () => {
  assertEquals(detectSizeSystem(chart("Women", ["UK 6", "UK 8", "UK 10"])), "UK");
  assertEquals(
    detectSizeSystem(chart("Men", ["IT 46 (US 36)", "IT 48 (US 38)"])),
    "IT",
  );
  assertEquals(detectSizeSystem(chart("Women", ["FR 34 (US 2)"])), "FR");
  assertEquals(detectSizeSystem(chart("Women", ["US 0", "US 2"])), "US");
});

Deno.test("bare numbers stay NULL — a '6' does not say which system it is", () => {
  // The whole reason the column exists. Inferring US here would be exactly the
  // confident wrong answer the story is about.
  assertEquals(detectSizeSystem(chart("Women", ["2", "4", "6"])), null);
});

Deno.test("a pure alpha chart is alpha, not a national system", () => {
  assertEquals(detectSizeSystem(chart("Women", ["XS", "S", "M", "L", "XL"])), "alpha");
  assertEquals(detectSizeSystem(chart("Men", ["S", "M", "XXL"])), "alpha");
});

Deno.test("a chart mixing systems resolves to NULL rather than picking one", () => {
  assertEquals(detectSizeSystem(chart("Women", ["UK 6", "US 2"])), null);
});

Deno.test("DE folds to EU — the corpus writes German sizing as European", () => {
  assertEquals(detectSizeSystem(chart("Women", ["DE 36", "DE 38"])), "EU");
});

Deno.test("an empty chart has no system", () => {
  assertEquals(detectSizeSystem(chart("Women", [])), null);
});

// ── 2. The conversion table matches the corpus that produced it ─────────────

Deno.test("US-2215: every seeded conversion is re-derivable from the charts", () => {
  // THE GUARD: SIZE_CONVERSIONS was extracted from labels stating both sides.
  // If the corpus is edited so an offset no longer holds, this fails rather
  // than letting the table drift away from its own evidence.
  const pat = /^(UK|EU|IT|FR|JP|AU|DE)\s*(\d+(?:\.\d+)?)\s*\(\s*US\s*(\d+(?:\.\d+)?)\s*\)/i;
  const observed = new Map<string, Set<number>>();
  for (const c of SIZING_CHARTS) {
    for (const r of c.rows) {
      const m = r.size.match(pat);
      if (!m) continue;
      const key = `${m[1].toUpperCase()}|${c.department}`;
      if (!observed.has(key)) observed.set(key, new Set());
      observed.get(key)!.add(Number(m[2]) - Number(m[3]));
    }
  }
  for (const conv of SIZE_CONVERSIONS) {
    const key = `${conv.system}|${conv.department}`;
    const offsets = observed.get(key);
    assert(offsets, `no corpus evidence remains for ${key}`);
    assertEquals(
      [...offsets],
      [conv.offset],
      `${key}: the corpus no longer agrees on a single offset`,
    );
  }
});

Deno.test("US-2215: no conversion is seeded without corpus evidence", () => {
  // The other direction: a hand-added row with no paired data must fail here.
  const pat = /^(UK|EU|IT|FR|JP|AU|DE)\s*\d+(?:\.\d+)?\s*\(\s*US\s*\d/i;
  const evidenced = new Set<string>();
  for (const c of SIZING_CHARTS) {
    for (const r of c.rows) {
      const m = r.size.match(pat);
      if (m) evidenced.add(`${m[1].toUpperCase()}|${c.department}`);
    }
  }
  for (const conv of SIZE_CONVERSIONS) {
    assert(
      evidenced.has(`${conv.system}|${conv.department}`),
      `${conv.system}|${conv.department} has no paired data — remove it or seed the evidence`,
    );
  }
});

Deno.test("the four corpus-derived conversions produce the right US size", () => {
  assertEquals(toUsSize("UK", "Women", 10), 6);
  assertEquals(toUsSize("FR", "Women", 36), 4);
  assertEquals(toUsSize("IT", "Men", 48), 38);
  assertEquals(toUsSize("IT", "Women", 40), 4);
});

// ── 3. Refusals ─────────────────────────────────────────────────────────────

Deno.test("EU is REFUSED — no paired data, and EU numbering differs by country", () => {
  assertEquals(toUsSize("EU", "Women", 38), null);
  assertEquals(toUsSize("EU", "Men", 50), null);
});

Deno.test("JP is REFUSED — the corpus's only mapping is BAPE's, a brand fact", () => {
  // 00456 records that BAPE runs small, so "JP L = US M" is about BAPE, not
  // about Japan. Generalising it would mis-size every other Japanese label.
  assertEquals(toUsSize("JP", "Men", 3), null);
  assertEquals(toUsSize("JP", "Women", 9), null);
});

Deno.test("an unevidenced system/department pair is REFUSED", () => {
  // UK men's tailoring often equals US — "often" is not a rule, and the corpus
  // does not vouch for it.
  assertEquals(toUsSize("UK", "Men", 40), null);
  assertEquals(toUsSize("FR", "Men", 48), null);
  assertEquals(toUsSize("AU", "Women", 12), null);
  assertEquals(toUsSize("IT", "Kids", 10), null);
});

Deno.test("alpha and US convert to nothing — neither is a foreign numbering", () => {
  assertEquals(toUsSize("alpha", "Women", 2), null);
  assertEquals(toUsSize("US", "Women", 6), null);
  assertEquals(toUsSize(null, "Women", 6), null);
});

Deno.test("a conversion that would produce a non-positive size is REFUSED", () => {
  // IT 36 - 36 = 0. The offset does not apply at that end of the range, and
  // emitting "US 0" from it would be inventing a size.
  assertEquals(toUsSize("IT", "Women", 36), null);
  assertEquals(toUsSize("IT", "Women", 20), null);
});

Deno.test("non-numeric input is REFUSED rather than coerced", () => {
  assertEquals(toUsSize("UK", "Women", NaN), null);
  assertEquals(toUsSize("UK", "Women", Infinity), null);
});

// ── Label parsing ───────────────────────────────────────────────────────────

Deno.test("labelNumber reads a system ordinal, with or without a prefix", () => {
  assertEquals(labelNumber("IT 48 (US 38)"), 48);
  assertEquals(labelNumber("UK 10"), 10);
  assertEquals(labelNumber("6"), 6);
  assertEquals(labelNumber("M"), null);
  assertEquals(labelNumber(""), null);
});

Deno.test("a waist-inches label is NOT read as a system ordinal", () => {
  // "W30 L32" is a MEASUREMENT in inches, not a place in a national size
  // sequence. Returning 30 here would let it be handed to an offset and come
  // back as a "US 26" that means nothing. Refusing at the parse is the fix.
  assertEquals(labelNumber("W30 L32"), null);
  assertEquals(labelNumber("32x34"), 32); // a bare leading number IS an ordinal
  assertEquals(
    usEquivalentForRow(chart("Men", ["W30 L32", "W32 L32"], "Jeans"), "W30 L32"),
    null,
  );
});

Deno.test("usEquivalentForRow converts a real corpus row and refuses the rest", () => {
  const burberry = chart("Women", ["UK 6 (US 2)", "UK 8 (US 4)"]);
  assertEquals(usEquivalentForRow(burberry, "UK 8 (US 4)"), 4);
  const alpha = chart("Women", ["XS", "S", "M"]);
  assertEquals(usEquivalentForRow(alpha, "S"), null);
});

// ── 4. Extended classes ─────────────────────────────────────────────────────

Deno.test("an ordinary chart is standard", () => {
  assertEquals(detectSizeClass(chart("Women", ["S"], "Tops")), "standard");
});

Deno.test("a declared extended class is read from the garment scope", () => {
  assertEquals(detectSizeClass(chart("Women", ["1X"], "Plus tops")), "plus");
  assertEquals(detectSizeClass(chart("Women", ["0P"], "Petite pants")), "petite");
  assertEquals(detectSizeClass(chart("Men", ["LT"], "Tall tops")), "tall");
  assertEquals(detectSizeClass(chart("Men", ["2XLT"], "Big & Tall tops")), "big_and_tall");
  assertEquals(detectSizeClass(chart("Women", ["M"], "Maternity tops")), "maternity");
});

Deno.test("big-and-tall is not double-counted as tall", () => {
  // /tall/ matches inside "Big & Tall", so a naive implementation reads two
  // classes and refuses a chart that is perfectly unambiguous.
  assertEquals(detectSizeClass(chart("Men", ["LT"], "Big and Tall")), "big_and_tall");
});

Deno.test("a scope naming SEVERAL classes resolves to NULL, not to one of them", () => {
  // The Talbots case, and the reason this dimension exists: collapsing it to
  // one class would assert something false about two thirds of its rows.
  assertEquals(
    detectSizeClass(chart("Women", ["0P"], "Misses (US 2-18) / Petite (0P-16P) / Plus (14W-26W)")),
    null,
  );
});

Deno.test("note prose never sets a class — only the garment scope does", () => {
  // A note reading "tall inseams run 34-36" is a remark about a standard chart.
  const c = { ...chart("Men", ["32"], "Jeans (waist x inseam)"), note: "Tall inseams run 34-36." };
  assertEquals(detectSizeClass(c), "standard");
});

// ── The corpus, as it actually is ───────────────────────────────────────────

Deno.test("US-2215: the corpus has exactly one extended chart, and it is folded", () => {
  // Recorded as a fact, not fabricated into a fix: extended sizing is a
  // SOURCING gap. The dimension now exists; seeding real plus/petite/tall
  // charts needs data we do not have.
  const nonStandard = SIZING_CHARTS.filter((c) => detectSizeClass(c) !== "standard");
  assertEquals(nonStandard.length, 1, "expected only the Talbots chart");
  assertEquals(detectSizeClass(nonStandard[0]), null, "and it names several classes");
});

Deno.test("US-2215: detection never invents a system for a bare-number chart", () => {
  for (const c of SIZING_CHARTS) {
    const sys = detectSizeSystem(c);
    if (sys === null) continue;
    if (sys === "alpha") continue;
    // Every non-alpha system must be stated by at least one label.
    assert(
      c.rows.some((r) => new RegExp(`^\\s*(${sys}|DE)\\b`, "i").test(r.size)),
      `${c.brand}|${c.department} claims ${sys} with no label saying so`,
    );
  }
});

// ── US-2215 reading half: label → US equivalent ─────────────────────────────
//
// Until this, nothing in production imported this module. These functions are
// what carry a corpus-backed conversion onto the certificate line, and every one
// of them is written to refuse rather than to guess — so most of what is pinned
// here is the refusals.

const {
  normalizeDepartment,
  systemFromLabel,
  usEquivalentForLabel,
} = await import("../lib/size-systems.ts");

Deno.test("US-2215: a department is normalized to the two the corpus has offsets for", () => {
  for (const g of ["Women", "women", "Womens", "women's", "female"]) {
    assertEquals(normalizeDepartment(g), "Women", g);
  }
  for (const g of ["Men", "mens", "Male", "men's"]) {
    assertEquals(normalizeDepartment(g), "Men", g);
  }
  // Unisex, Kids and Baby have no corpus-backed offset. Refusing is the whole
  // discipline: a conversion we cannot evidence must not be invented.
  for (const g of ["Unisex", "Kids", "Baby", "", null, undefined, "??"]) {
    assertEquals(normalizeDepartment(g as string | null), null, String(g));
  }
});

Deno.test("US-2215: only an EXPLICIT system prefix counts", () => {
  assertEquals(systemFromLabel("IT 48"), "IT");
  assertEquals(systemFromLabel("fr 38"), "FR");
  assertEquals(systemFromLabel("UK10"), "UK");
  // A bare number is a size whose system nobody recorded. Guessing one turns an
  // unlabelled size into a confidently wrong one.
  assertEquals(systemFromLabel("48"), null);
  assertEquals(systemFromLabel("M"), null);
  // W30 L32 is a waist measurement in inches, not a place in a national size
  // sequence — the same refusal labelNumber's own test pins.
  assertEquals(systemFromLabel("W30 L32"), null);
  // A two-letter token that is not a system we know.
  assertEquals(systemFromLabel("XS 4"), null);
});

Deno.test("US-2215: the four corpus-backed conversions answer", () => {
  assertEquals(usEquivalentForLabel("IT 48", "Men"), 38);
  assertEquals(usEquivalentForLabel("IT 40", "Women"), 4);
  assertEquals(usEquivalentForLabel("FR 36", "Women"), 4);
  assertEquals(usEquivalentForLabel("UK 8", "Women"), 4);
});

Deno.test("US-2215: everything outside the corpus REFUSES", () => {
  // No offset for this system/department pair.
  assertEquals(usEquivalentForLabel("IT 48", "Women"), 12, "IT Women has its own offset");
  assertEquals(usEquivalentForLabel("JP 5", "Women"), null, "no JP offset in the corpus");
  assertEquals(usEquivalentForLabel("UK 8", "Men"), null, "no UK Men offset");
  assertEquals(usEquivalentForLabel("EU 42", "Men"), null, "no EU offset — IT is not EU");
  // Already US, or no system at all.
  assertEquals(usEquivalentForLabel("US 8", "Women"), null);
  assertEquals(usEquivalentForLabel("8", "Women"), null);
  // Department we cannot key on.
  assertEquals(usEquivalentForLabel("IT 48", "Unisex"), null);
  assertEquals(usEquivalentForLabel("IT 48", null), null);
  // Below the offset, which means the rule does not reach that end of the range.
  assertEquals(usEquivalentForLabel("IT 8", "Men"), null);
});

Deno.test("US-2215: a label that ALREADY states its US equivalent is left alone", () => {
  // The exact shape US-2215 was filed over: 00456 wrote "JP L (approx US M)"
  // inside the size label because there was nowhere structured to put it.
  // Appending our own "US 38" to a label that already says so is noise, and
  // noise on a certificate is indistinguishable from a bug.
  assertEquals(usEquivalentForLabel("IT 48 (US 38)", "Men"), null);
  assertEquals(usEquivalentForLabel("IT 48 approx us 38", "Men"), null);
  // But the leading system token itself must not be mistaken for that claim.
  assertEquals(usEquivalentForLabel("IT 48", "Men"), 38);
});

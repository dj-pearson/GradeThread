// US-2747/US-2748: what the public style-code lookup answers.
//
// The two rules worth guarding are that provenance travels with the name, and
// that `indexable` is false without one. The second is not a UI preference:
// thousands of empty pages is thin content, and thin content costs the whole
// domain rather than just this section.
import { assert, assertEquals } from "@std/assert";
import {
  PUBLIC_LOOKUP_BRAND,
  publicStyleCode,
  sourceLabel,
} from "../lib/public-style-code.ts";

const RESOLVED = {
  name: "Scuba Oversized Half Zip Hoodie",
  source: "seller" as const,
  supporting: 3,
  confidence: 0.8,
  evidenceUrl: "https://www.ebay.com/itm/1",
};

const DECODE = {
  brand: "Lululemon",
  decoderKind: "style_number_2017",
  raw: "W6AMYS",
  gender: "Women",
  styleCode: "6AMY",
  colorInitial: "S",
  canonicalCode: "W6AMYS",
  confidence: 0.85,
};

Deno.test("US-2747: a resolved code answers with its provenance, not just a name", () => {
  const out = publicStyleCode({
    requested: "W6AMYS",
    canonicalCode: "W6AMYS",
    resolved: RESOLVED,
    decode: DECODE,
  });
  assertEquals(out.name, "Scuba Oversized Half Zip Hoodie");
  // The provenance IS the product. A bare name is worth less and is not ours.
  assertEquals(out.source, "seller");
  assertEquals(out.supporting, 3);
  assertEquals(out.evidenceUrl, "https://www.ebay.com/itm/1");
  assertEquals(out.brand, PUBLIC_LOOKUP_BRAND);
  assert(out.indexable);
});

Deno.test("US-2748: no name means NOT indexable, however much else we know", () => {
  const out = publicStyleCode({
    requested: "W6AMYS",
    canonicalCode: "W6AMYS",
    resolved: null,
    decode: DECODE,
  });
  assertEquals(out.name, null);
  assertEquals(out.source, null);
  assertEquals(out.supporting, null);
  assertEquals(out.evidenceUrl, null);
  assertEquals(out.indexable, false);
  // Still worth a page for a HUMAN: the code itself grounds the gender.
  assertEquals(out.decoded?.gender, "Women");
});

Deno.test("US-2748: a blank name is not a name", () => {
  // A whitespace name would otherwise flip indexable and put an empty page in
  // the sitemap — the exact failure the flag exists to prevent.
  const out = publicStyleCode({
    requested: "W6AMYS",
    canonicalCode: "W6AMYS",
    resolved: { ...RESOLVED, name: "   " },
    decode: DECODE,
  });
  assertEquals(out.name, null);
  assertEquals(out.indexable, false);
});

Deno.test("US-2747: a non-canonical spelling is flagged so the route can redirect", () => {
  // Serving the same answer at four URLs is competing with ourselves.
  const out = publicStyleCode({
    requested: "LW6AMYSP60417",
    canonicalCode: "W6AMYS",
    resolved: RESOLVED,
    decode: DECODE,
  });
  assertEquals(out.canonical, false);
  assertEquals(out.code, "W6AMYS");
  assertEquals(out.requested, "LW6AMYSP60417");

  // Punctuation and case alone are not a different URL.
  const punctuated = publicStyleCode({
    requested: "w6amys",
    canonicalCode: "W6AMYS",
    resolved: RESOLVED,
    decode: DECODE,
  });
  assertEquals(punctuated.canonical, true);
});

Deno.test("US-2747: a code with no decoder still answers, with no decode block", () => {
  const out = publicStyleCode({
    requested: "ABCDEFG",
    canonicalCode: "ABCDEFG",
    resolved: null,
    decode: null,
  });
  assertEquals(out.decoded, null);
  assertEquals(out.indexable, false);
});

// ── US-2749: what a stranger may submit, and when the crowd has an answer ───

Deno.test("US-2749: a real product name is accepted", async () => {
  const { submissionRefusal } = await import("../lib/public-style-code.ts");
  assertEquals(submissionRefusal("Scuba Oversized Half Zip Hoodie"), null);
  assertEquals(submissionRefusal("Align High Rise Pant 25"), null);
});

Deno.test("US-2749: an unauthenticated box only defends on SHAPE", async () => {
  const { submissionRefusal } = await import("../lib/public-style-code.ts");
  // One word is a category, not a product — the same bar the seller-correction
  // trigger applies.
  assert(submissionRefusal("Hoodie"));
  assert(submissionRefusal("  "));
  assert(submissionRefusal("x".repeat(200)));
  // A link is never a product name, and a box that takes one is a link-spam
  // target the moment it is found.
  assert(submissionRefusal("Buy now at https://example.com"));
  assert(submissionRefusal("Scuba Hoodie www.example.com"));
  assert(submissionRefusal("cheap hoodies example.com"));
});

Deno.test("US-2749: two spellings of one answer are one answer", async () => {
  const { normalizeSubmittedName } = await import("../lib/public-style-code.ts");
  // Counting these apart would mean nobody ever reaches the corroboration bar.
  assertEquals(
    normalizeSubmittedName("Scuba Oversized Half-Zip"),
    normalizeSubmittedName("scuba oversized half zip"),
  );
  assertEquals(
    normalizeSubmittedName("Align  High Rise Pant!"),
    "align high rise pant",
  );
});

Deno.test("US-2749: the crowd has an answer only when it agrees", async () => {
  const { pickSubmittedName } = await import("../lib/public-style-code.ts");
  const rows = [
    { name: "Scuba Hoodie", name_norm: "scuba hoodie", submissions: 3 },
    { name: "Something Else", name_norm: "something else", submissions: 1 },
  ];
  assertEquals(pickSubmittedName(rows, 2)!.name, "Scuba Hoodie");

  // Nobody corroborated: no answer, however many distinct guesses there are.
  assertEquals(
    pickSubmittedName(
      [
        { name: "A Guess", name_norm: "a guess", submissions: 1 },
        { name: "B Guess", name_norm: "b guess", submissions: 1 },
      ],
      2,
    ),
    null,
  );

  // A TIE at the bar is not an answer either — two equally-attested names for
  // one garment means we do not know which it is.
  assertEquals(
    pickSubmittedName(
      [
        { name: "A Guess", name_norm: "a guess", submissions: 4 },
        { name: "B Guess", name_norm: "b guess", submissions: 4 },
      ],
      2,
    ),
    null,
  );

  assertEquals(pickSubmittedName([], 2), null);
});

// ── US-2748: the sitemap and the page must agree about which URLs exist ─────
//
// This is the one failure that quietly undoes the whole surface. A URL listed
// in a sitemap whose page renders noindex is a direct contradiction, and Google
// responds by trusting the section less — not by picking a side. Neither half
// can catch it alone, so both are driven from ONE fixture set.

const FIXTURES = [
  // Named, live: belongs in the sitemap AND indexable.
  { style_code_norm: "W6AMYS", name: "Scuba Oversized Half Zip Hoodie", updated_at: "2026-08-19T00:00:00Z", rejected_at: null },
  // Same garment, second source. One URL, not two.
  { style_code_norm: "W6AMYS", name: "Scuba Oversized Half Zip Hoodie", updated_at: "2026-08-20T00:00:00Z", rejected_at: null },
  // Rejected: in neither.
  { style_code_norm: "W7DVCS", name: "Wrong Name", updated_at: "2026-08-18T00:00:00Z", rejected_at: "2026-08-19T00:00:00Z" },
  // Blank name: in neither. A whitespace name would otherwise sitemap an
  // empty page.
  { style_code_norm: "WA1234B", name: "   ", updated_at: "2026-08-17T00:00:00Z", rejected_at: null },
];

Deno.test("US-2748: everything the sitemap lists renders indexable", async () => {
  const { indexableCodes } = await import("../lib/public-style-code.ts");
  const listed = indexableCodes(FIXTURES);
  for (const entry of listed) {
    const resolved = FIXTURES.find(
      (f) => f.style_code_norm === entry.code && !f.rejected_at && f.name.trim(),
    )!;
    const page = publicStyleCode({
      requested: entry.code,
      canonicalCode: entry.code,
      resolved: {
        name: resolved.name,
        source: "consensus",
        supporting: 4,
        confidence: 0.7,
        evidenceUrl: null,
      },
      decode: null,
    });
    assert(page.indexable, `${entry.code} is sitemapped but renders noindex`);
  }
});

Deno.test("US-2748: nothing the sitemap omits would have rendered indexable", () => {
  // The other direction. A code the page WOULD index but the sitemap drops is
  // a page nobody discovers — less damaging than the reverse, and still wrong.
  const omitted = ["W7DVCS", "WA1234B"];
  for (const code of omitted) {
    const row = FIXTURES.find((f) => f.style_code_norm === code)!;
    const page = publicStyleCode({
      requested: code,
      canonicalCode: code,
      // What the page's own read returns for these: pickStyleCodeName drops
      // rejected rows and blank names, so it resolves to nothing.
      resolved: null,
      decode: null,
    });
    assertEquals(page.indexable, false, `${code} (${row.name}) should not index`);
  }
});

Deno.test("US-2748: one URL per code, newest answer sets the lastmod", async () => {
  const { indexableCodes } = await import("../lib/public-style-code.ts");
  const listed = indexableCodes(FIXTURES);
  assertEquals(listed.length, 1);
  assertEquals(listed[0]!.code, "W6AMYS");
  assertEquals(listed[0]!.updated_at, "2026-08-20T00:00:00Z");
});

Deno.test("US-2748: an empty index lists nothing rather than everything", async () => {
  // The state on the day this ships. A bug that inverted the filter would put
  // every code we have ever SEEN in front of a crawler, which is the failure
  // this whole design exists to avoid.
  const { indexableCodes } = await import("../lib/public-style-code.ts");
  assertEquals(indexableCodes([]), []);
  assertEquals(
    indexableCodes([
      { style_code_norm: "W6AMYS", name: null, updated_at: null, rejected_at: null },
    ]),
    [],
  );
});

Deno.test("US-2747: every source reads as something a reseller understands", () => {
  assertEquals(sourceLabel("official"), "Lululemon's own product name");
  assertEquals(sourceLabel("seller"), "Corrected by a seller holding the garment");
  assertEquals(sourceLabel("consensus"), "Agreed across marketplace listings");
  assertEquals(sourceLabel("admin"), "Confirmed by GradeThread");
  // No name, no label — nothing to explain the provenance OF.
  assertEquals(sourceLabel(null), null);
});

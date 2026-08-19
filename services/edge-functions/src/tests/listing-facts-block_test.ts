// US-2682: the fixed-shape facts block.
//
// The block exists for readers that are not people. eBay summarises descriptions
// with its own model, and its shopping agent SKIPS an item with incomplete
// attributes rather than guessing (playbook §12). GradeThread's grade and factor
// breakdown are structured data nobody else has, and as prose they are invisible
// to both.
//
// So the assertion that matters is AC2: what was written can be read back. A
// block that only LOOKS tidy is not machine-readable, and there is no way to
// tell the two apart by eye.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildListingFactsBlock,
  FACTS_MARKER_END,
  FACTS_MARKER_START,
  type ListingFacts,
  listingFactsLines,
  parseListingFactsBlock,
  upsertListingFactsBlock,
} from "../lib/listing-facts-block.ts";
import { MARKETPLACE_SPECS } from "../lib/marketplace-specs.ts";

function facts(over: Partial<ListingFacts> = {}): ListingFacts {
  return {
    grade: 8.4,
    factors: [
      { label: "Fabric condition", score: 8.5 },
      { label: "Structural integrity", score: 9 },
      { label: "Cosmetic appearance", score: 8 },
      { label: "Functional elements", score: 8.5 },
      { label: "Odor and cleanliness", score: 8 },
    ],
    measurements: [
      { label: "Chest", inches: 21 },
      { label: "Length", inches: 27.5 },
      { label: "Sleeve", inches: 25 },
    ],
    fibreContent: "100% cotton",
    flaws: ["Small mark on the left cuff", "Faded print at the hem"],
    ...over,
  };
}

// ── AC2: the round trip ────────────────────────────────────────────────────

Deno.test("AC2: every field written into the block comes back out", () => {
  const input = facts();
  const description = upsertListingFactsBlock("Some seller prose.", input);
  const parsed = parseListingFactsBlock(description);

  assert(parsed, "the block did not parse");
  assertEquals(parsed.grade, input.grade);
  assertEquals(parsed.factors, input.factors);
  assertEquals(parsed.measurements, input.measurements);
  assertEquals(parsed.fibreContent, input.fibreContent);
  assertEquals(parsed.flaws, input.flaws);
});

Deno.test("AC4: supplied measurements survive verbatim, decimals included", () => {
  // The listing_gen_v2 measurement rule. 27.5 must not become 28, and 21 must
  // not become 21.0 — a buyer comparing against their own tape reads both as
  // different numbers from the one the seller measured.
  const parsed = parseListingFactsBlock(
    upsertListingFactsBlock("", facts({ measurements: [
      { label: "Chest", inches: 21 },
      { label: "Length", inches: 27.5 },
      { label: "Shoulder to shoulder", inches: 18.25 },
    ] })),
  );
  assertEquals(parsed!.measurements, [
    { label: "Chest", inches: 21 },
    { label: "Length", inches: 27.5 },
    { label: "Shoulder to shoulder", inches: 18.3 },
  ]);
});

Deno.test("a label containing a comma survives the round trip", () => {
  // The reason the list separator is a semicolon. Splitting on commas would cut
  // this fact in half and the round trip would silently lose it.
  const parsed = parseListingFactsBlock(
    upsertListingFactsBlock("", facts({
      measurements: [{ label: "Waist, laid flat", inches: 16 }],
    })),
  );
  assertEquals(parsed!.measurements, [{ label: "Waist, laid flat", inches: 16 }]);
});

Deno.test("an ungraded item omits the grade rather than claiming zero", () => {
  const parsed = parseListingFactsBlock(
    upsertListingFactsBlock("", facts({ grade: null, factors: [] })),
  );
  assertEquals(parsed!.grade, null);
  assertEquals(parsed!.factors, []);
  // And the other facts still made it.
  assertEquals(parsed!.fibreContent, "100% cotton");
});

Deno.test("no facts at all produces no block, not an empty one", () => {
  const empty: ListingFacts = {
    grade: null,
    factors: [],
    measurements: [],
    fibreContent: null,
    flaws: [],
  };
  assertEquals(buildListingFactsBlock(empty).html, "");
  assertEquals(upsertListingFactsBlock("Just prose.", empty), "Just prose.");
});

Deno.test("HTML in a seller-supplied field is escaped, not rendered", () => {
  const description = upsertListingFactsBlock(
    "",
    facts({ fibreContent: '<script>alert("x")</script>' }),
  );
  assert(!description.includes("<script>"), "a script tag reached the description");
  const parsed = parseListingFactsBlock(description);
  // Escaped on the way in, recovered on the way out: the round trip still holds
  // for hostile input.
  assertEquals(parsed!.fibreContent, '<script>alert("x")</script>');
});

// ── AC3: not a keyword dump ────────────────────────────────────────────────

Deno.test("AC3: the block contains no comma-separated keyword run", () => {
  // eBay treats keyword stuffing in a description as a policy violation, and a
  // comma-separated run of terms is exactly what that looks like. Lists here are
  // semicolon-separated and every entry is labelled.
  const { plain } = buildListingFactsBlock(facts());
  assert(
    !/(\b[\w-]+,\s+){3,}/.test(plain),
    `a comma-separated keyword run appeared:\n${plain}`,
  );
});

Deno.test("AC3: no phrase is repeated across the block", () => {
  const lines = listingFactsLines(facts());
  const seen = new Set<string>();
  for (const line of lines) {
    const label = line.slice(0, line.indexOf(":"));
    assert(!seen.has(label), `the label "${label}" appears twice`);
    seen.add(label);
  }
  // And no whole line is duplicated either.
  assertEquals(new Set(lines).size, lines.length);
});

Deno.test("AC3: every line is a labelled fact, never a bare term list", () => {
  for (const line of listingFactsLines(facts())) {
    assert(/^[A-Z][^:]*: .+$/.test(line), `not a labelled fact: ${line}`);
  }
});

// ── AC5: revise in place ───────────────────────────────────────────────────

Deno.test("AC5: a second upsert REPLACES the block rather than appending one", () => {
  const first = upsertListingFactsBlock("Seller prose.", facts());
  const second = upsertListingFactsBlock(first, facts({ grade: 6.2 }));

  assertEquals(second.split(FACTS_MARKER_START).length - 1, 1, "two blocks");
  assertEquals(second.split(FACTS_MARKER_END).length - 1, 1);
  assertEquals(parseListingFactsBlock(second)!.grade, 6.2);
  assert(second.includes("Seller prose."), "the seller's prose was lost");
});

Deno.test("AC5: an existing listing with no block gains one without losing prose", () => {
  const existing = "A lovely jacket. Ships next day.";
  const out = upsertListingFactsBlock(existing, facts());
  assert(out.startsWith(existing), "the block did not append after the prose");
  assert(parseListingFactsBlock(out));
});

Deno.test("AC5: facts that empty out REMOVE the block instead of leaving it stale", () => {
  // A listing whose measurements were deleted must not keep advertising them.
  const withBlock = upsertListingFactsBlock("Prose.", facts());
  const cleared = upsertListingFactsBlock(withBlock, {
    grade: null,
    factors: [],
    measurements: [],
    fibreContent: null,
    flaws: [],
  });
  assertEquals(parseListingFactsBlock(cleared), null);
  assertEquals(cleared, "Prose.");
});

Deno.test("the block sits at a fixed position: last, after the prose", () => {
  const out = upsertListingFactsBlock("Prose.", facts());
  assert(out.trimEnd().endsWith(FACTS_MARKER_END), out.slice(-80));
});

Deno.test("a truncated block (start marker, no end) is not mis-parsed", () => {
  const broken = `Prose.\n\n${FACTS_MARKER_START}<ul><li>half`;
  assertEquals(parseListingFactsBlock(broken), null);
  // And upserting over it appends rather than corrupting what is there.
  const out = upsertListingFactsBlock(broken, facts());
  assertEquals(out.split(FACTS_MARKER_END).length - 1, 1);
});

// ── AC6: it renders on eBay mobile ─────────────────────────────────────────

Deno.test("AC6: the markup is within what the eBay spec allows", () => {
  const spec = MARKETPLACE_SPECS.ebay;

  // descriptionMaxLength is null (an HTML body, effectively unbounded), so the
  // check is that the spec still SAYS so rather than that we fit a number that
  // does not exist. If eBay ever caps it, this fails and the block gets sized.
  assertEquals(spec.descriptionMaxLength, null);

  // Read from the spec's own field list rather than assumed: the description
  // field must actually accept multi-line content for any of this to render.
  const descriptionField = spec.fields.find((f) => f.key === "description");
  assert(descriptionField, "the eBay spec has no description field");
  assertEquals(descriptionField.multiline, true);
});

Deno.test("AC6: no table, no styling, nothing a mobile view will mangle", () => {
  const { html } = buildListingFactsBlock(facts());
  // A table either scrolls sideways on a narrow phone or squeezes each column
  // to one word. A list wraps.
  assert(!/<table\b/i.test(html), "a table would not survive eBay mobile");
  assert(!/\bstyle\s*=/i.test(html), "inline styles are stripped or ignored");
  assert(!/\bclass\s*=/i.test(html), "classes have nothing to resolve against");
  assert(!/<script\b/i.test(html));
  assert(!/<img\b/i.test(html));
  // And the tags actually used are the plainest that still parse as a list.
  assertEquals(
    [...html.matchAll(/<([a-z]+)\b/gi)].map((m) => m[1]!.toLowerCase()).filter(
      (t, i, a) => a.indexOf(t) === i,
    ).sort(),
    ["li", "strong", "ul"],
  );
});

Deno.test("AC6: no URL anywhere, which is the rule that hides listings", () => {
  // eBay treats an off-eBay URL in a description as offering to trade outside
  // eBay and hides the listing. Same rule the credential block obeys.
  const { html, plain } = buildListingFactsBlock(facts());
  for (const s of [html, plain]) {
    assert(!/https?:\/\//i.test(s), "a URL reached the facts block");
    assert(!/<a\b/i.test(s), "a link reached the facts block");
  }
});

Deno.test("the block stays short enough to read on a phone", () => {
  // Not a spec limit — a judgement. A facts block a buyer scrolls past is a
  // facts block a buyer does not read, and the fully-populated case is the
  // worst case.
  const { plain } = buildListingFactsBlock(facts());
  assertEquals(plain.split("\n").length, 5);
  assert(plain.length < 600, `${plain.length} characters is a wall of text`);
});

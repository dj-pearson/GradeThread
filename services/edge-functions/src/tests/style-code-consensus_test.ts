// US-2691: the product name a code's listings agree on.
//
// Fixture titles are real-shaped: a Lululemon style code's eBay results carry
// the product name plus each seller's colourway, inseam, size and condition
// abbreviation, in whatever order that seller likes.
import { assert, assertEquals } from "@std/assert";

// style-code-consensus.ts transitively imports the service-role supabase client
// at load (through style-code-observations.ts) — dummy env BEFORE the import.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  cleanTitleForNaming,
  consensusConfidence,
  consensusStyleName,
  consensusThreshold,
  CONSENSUS_CONFIDENCE_CAP,
  CONSENSUS_MIN_TITLES,
} = await import("../lib/style-code-consensus.ts");
const { LEARNED_CONFIDENCE_CAP } = await import(
  "../lib/style-code-observations.ts"
);
const { DEFAULT_DECODER_SPECS } = await import("../lib/brand-decoders.ts");

// What eBay actually returns for a Lululemon men's short style code. Five
// sellers, one product, five different ideas of a title.
const COMMISSION_SHORT_TITLES = [
  'Lululemon Commission Short Relaxed Warpstreme 11" Black Mens 32 EUC',
  "Lululemon Mens Commission Short Relaxed Warpstreme 11 Dark Olive Size 34",
  'LULULEMON Commission Short Relaxed *Warpstreme 11" True Navy 33 NWT',
  "Lululemon Commission Short Relaxed Warpstreme Obsidian 36 Free Shipping",
  "Lululemon Commission Short 9 Warpstreme Tofino Sand 30 Gently Used",
];

Deno.test("US-2691: cleaning strips the brand, the code, colour, size and chatter", () => {
  const { tokens } = cleanTitleForNaming(
    'Lululemon Commission Short Relaxed Warpstreme 11" Black Mens 32 EUC LM7A83S',
    "Lululemon",
    "LM7A83S",
  );
  assertEquals(tokens, ["commission", "short", "relaxed", "warpstreme"]);
});

Deno.test("US-2691: model numbers survive cleaning — 501 IS the product", () => {
  const { tokens } = cleanTitleForNaming(
    "Levi's 501 Original Fit Jeans Black W32 L30 EUC",
    "Levi's",
    null,
  );
  assert(tokens.includes("501"), `${tokens} dropped the model number`);
  assert(!tokens.includes("w32"), "waist size survived");
});

Deno.test("US-2691: the market's shared run is the name, not one seller's title", () => {
  const consensus = consensusStyleName({
    titles: COMMISSION_SHORT_TITLES,
    brand: "Lululemon",
    styleCode: "LM7A83S",
  });
  assert(consensus !== null, "five agreeing titles produced no consensus");
  assertEquals(consensus!.name, "Commission Short Relaxed Warpstreme");
  assertEquals(consensus!.considered, 5);
  assertEquals(consensus!.supporting, 4);
});

Deno.test("US-2691: the display spelling comes from a seller, not from title-casing", () => {
  const consensus = consensusStyleName({
    titles: COMMISSION_SHORT_TITLES,
    brand: "Lululemon",
    styleCode: "LM7A83S",
  });
  // The third title shouts the brand and stars the fabric; neither leaks in.
  assert(!consensus!.name.includes("*"), "punctuation leaked into the name");
  assert(!/LULULEMON/.test(consensus!.name), "brand leaked into the name");
});

Deno.test("US-2691: too few titles yields NOTHING rather than a guess", () => {
  const consensus = consensusStyleName({
    titles: COMMISSION_SHORT_TITLES.slice(0, CONSENSUS_MIN_TITLES - 1),
    brand: "Lululemon",
  });
  assertEquals(consensus, null);
});

Deno.test("US-2691: identical titles are ONE piece of evidence", () => {
  const one = 'Lululemon Commission Short Relaxed Warpstreme 11" Black 32';
  // Three verbatim copies is one seller's opinion repeated.
  assertEquals(
    consensusStyleName({ titles: [one, one, one, one], brand: "Lululemon" }),
    null,
  );
  // Case and surrounding whitespace do not make a copy independent either.
  assertEquals(
    consensusStyleName({
      titles: [one, one.toUpperCase(), `  ${one}  `],
      brand: "Lululemon",
    }),
    null,
  );
});

Deno.test("US-2691: titles that share nothing yield NOTHING", () => {
  const consensus = consensusStyleName({
    titles: [
      "Lululemon Align Legging 25 Nulu Black 6",
      "Lululemon Scuba Hoodie Oversized Heathered 8",
      "Lululemon Metal Vent Tech Long Sleeve 2.0 Medium",
      "Lululemon Define Jacket Luxtreme Slim 4",
    ],
    brand: "Lululemon",
  });
  assertEquals(consensus, null);
});

Deno.test("US-2691: the LONGEST agreed run wins, not the most-repeated short one", () => {
  // "Wunder Train" is in all four titles and is NOT the answer: three of the
  // four carry the full name plus the fabric, and that longer run is the one
  // that identifies the product. The differing inseams (25, 28) drop out as
  // two-digit numbers, which is what lets the run stay contiguous across
  // sellers who wrote them in different places.
  const consensus = consensusStyleName({
    titles: [
      "Lululemon Wunder Train High Rise Tight 25 Everlux Black 6 EUC",
      "Lululemon Wunder Train High Rise Tight 28 Everlux True Navy 8",
      "Lululemon Wunder Train High Rise Tight Everlux Womens 4 NWT",
      "Lululemon Wunder Train Everlux Pink 10",
    ],
    brand: "Lululemon",
  });
  assertEquals(consensus!.name, "Wunder Train High Rise Tight Everlux");
  assertEquals(consensus!.supporting, 3);
});

Deno.test("US-2691: the threshold is a majority and never below two", () => {
  assertEquals(consensusThreshold(3), 2);
  assertEquals(consensusThreshold(5), 3);
  assertEquals(consensusThreshold(10), 6);
  // Even a single title cannot pass on its own say-so.
  assertEquals(consensusThreshold(1), 2);
});

Deno.test("US-2691: confidence rises with supporters and stops at the cap", () => {
  const base = consensusConfidence(CONSENSUS_MIN_TITLES);
  assert(base < consensusConfidence(CONSENSUS_MIN_TITLES + 2));
  assertEquals(consensusConfidence(100), CONSENSUS_CONFIDENCE_CAP);
  // A consensus beats a single trimmed title...
  assert(
    CONSENSUS_CONFIDENCE_CAP > LEARNED_CONFIDENCE_CAP,
    "a market consensus should outrank one trimmed title",
  );
});

Deno.test("US-2691: no consensus ever reaches a decoder read off the tag", () => {
  // The ordering, not the numbers: a decoder read the code off the garment.
  // No amount of market agreement outranks the garment itself.
  const decoderFloor = Math.min(
    ...DEFAULT_DECODER_SPECS.filter((s) => s.brandKey === "lululemon").map(
      (s) => s.confidence,
    ),
  );
  assert(
    CONSENSUS_CONFIDENCE_CAP < decoderFloor,
    `consensus cap ${CONSENSUS_CONFIDENCE_CAP} must stay under the weakest decoder ${decoderFloor}`,
  );
});

Deno.test("US-2691: the same titles in any order produce the same name", () => {
  const forward = consensusStyleName({
    titles: COMMISSION_SHORT_TITLES,
    brand: "Lululemon",
  });
  const reversed = consensusStyleName({
    titles: [...COMMISSION_SHORT_TITLES].reverse(),
    brand: "Lululemon",
  });
  assertEquals(forward!.name.toLowerCase(), reversed!.name.toLowerCase());
  assertEquals(forward!.supporting, reversed!.supporting);
});

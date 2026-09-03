// US-2764: the category eBay itself puts a listing in, which we used to discard.
//
// WHY THIS IS THE INTERESTING SIGNAL. Category is resolved today by asking the
// Taxonomy service to keyword-match a phrase our own model wrote, and taking
// hit number one. Every step of that is a guess about a guess. A visual match
// returns real listings that real people filed somewhere, and where five of
// them agree that is evidence of a different kind, not more of the same.
//
// The tie case is the one worth reading. Two categories on two votes each is a
// question the evidence did not settle, and the tally is required to SAY so
// rather than let array order pick a winner - because a caller taking [0] from
// a sorted list cannot tell a 5-0 consensus from a 1-1 coin flip.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  type BrowseComp,
  tallyCategoryVotes,
  tallyLeafCategoryVotes,
} from "../lib/ebay-client.ts";

/** A comp carrying only the fields these tallies read. */
function comp(
  itemId: string,
  cats: Array<[string, string]>,
  leafIds: string[] = [],
): BrowseComp {
  return {
    itemId,
    title: `item ${itemId}`,
    price: 40,
    currency: "USD",
    imageUrl: null,
    itemWebUrl: null,
    condition: "Pre-owned",
    buyingOptions: [],
    // US-3098: fixtures state it explicitly; null means 'this source
    // cannot say', which is not the same fact as free shipping.
    shippingCents: null,
    categories: cats.map(([categoryId, categoryName]) => ({
      categoryId,
      categoryName,
    })),
    leafCategoryIds: leafIds,
  };
}

const TOPS: [string, string] = ["53159", "Women's Tops"];
const ACTIVEWEAR: [string, string] = ["185099", "Activewear Tops"];
const SWEATERS: [string, string] = ["63866", "Women's Sweaters"];

Deno.test("a clear consensus comes back first, with its count", () => {
  const votes = tallyCategoryVotes([
    comp("1", [TOPS, ACTIVEWEAR]),
    comp("2", [TOPS, ACTIVEWEAR]),
    comp("3", [TOPS, ACTIVEWEAR]),
    comp("4", [TOPS, ACTIVEWEAR]),
    comp("5", [TOPS, SWEATERS]),
  ]);

  assertEquals(votes[0]?.categoryId, TOPS[0]);
  assertEquals(votes[0]?.count, 5);
  assertEquals(votes[0]?.categoryName, "Women's Tops");

  // The ancestor winning does not erase the split underneath it. Four listings
  // say Activewear and one says Sweaters, and a caller resolving a LEAF needs
  // to see that rather than only the parent everyone agreed on.
  const byId = new Map(votes.map((v) => [v.categoryId, v.count]));
  assertEquals(byId.get(ACTIVEWEAR[0]), 4);
  assertEquals(byId.get(SWEATERS[0]), 1);
});

Deno.test("a tie is REPORTED as a tie, not broken by array order", () => {
  const votes = tallyCategoryVotes([
    comp("1", [ACTIVEWEAR]),
    comp("2", [SWEATERS]),
    comp("3", [ACTIVEWEAR]),
    comp("4", [SWEATERS]),
  ]);

  assertEquals(votes.length, 2);
  // Both survive at the top with equal support. A caller that takes [0] here is
  // choosing, and the shape makes that visible instead of hiding it.
  assertEquals(votes[0]?.count, 2);
  assertEquals(votes[1]?.count, 2);
});

Deno.test("one listing votes ONCE per category, however often eBay repeats it", () => {
  // eBay can name the same category more than once on a summary. Counting each
  // mention would let a single listing out-vote four others.
  const votes = tallyCategoryVotes([
    comp("1", [ACTIVEWEAR, ACTIVEWEAR, ACTIVEWEAR]),
    comp("2", [SWEATERS]),
  ]);

  const byId = new Map(votes.map((v) => [v.categoryId, v.count]));
  assertEquals(byId.get(ACTIVEWEAR[0]), 1);
  assertEquals(byId.get(SWEATERS[0]), 1);
});

Deno.test("listings with no category contribute nothing rather than a blank vote", () => {
  const votes = tallyCategoryVotes([
    comp("1", []),
    comp("2", [ACTIVEWEAR]),
    comp("3", []),
  ]);

  assertEquals(votes.length, 1);
  assertEquals(votes[0]?.categoryId, ACTIVEWEAR[0]);
  assertEquals(votes[0]?.count, 1);
});

Deno.test("an empty result set is an empty tally, not a throw", () => {
  assertEquals(tallyCategoryVotes([]), []);
});

Deno.test("a category id eBay omitted is dropped, name or not", () => {
  // Defensive: BrowseComp.categories is built by the mapper, which filters
  // these out. This asserts the tally does not depend on that having happened,
  // because a second caller could build the array itself.
  const dodgy: BrowseComp = {
    ...comp("1", [ACTIVEWEAR]),
    categories: [
      { categoryId: "", categoryName: "Nameless" },
      { categoryId: ACTIVEWEAR[0], categoryName: ACTIVEWEAR[1] },
    ],
  };
  const votes = tallyCategoryVotes([dodgy]);
  assertEquals(votes.length, 1);
  assertEquals(votes[0]?.categoryId, ACTIVEWEAR[0]);
});

// ── Leaf votes ──────────────────────────────────────────────────────────────
//
// The fixture below is a REAL production response, trimmed. Probing eBay for
// "lululemon half zip pullover" on 2026-08-21 returned five summaries whose
// ancestors agreed completely and whose leaves did not, which is the exact
// situation the two tallies exist to tell apart.

const CSA: [string, string] = ["11450", "Clothing, Shoes & Accessories"];
const WOMENS: [string, string] = ["15724", "Women's Clothing"];
const HOODIES: [string, string] = ["155226", "Hoodies & Sweatshirts"];
const ACTIVE_TOPS: [string, string] = ["185082", "Activewear Tops"];
const SWEATERS_REAL: [string, string] = ["63866", "Sweaters"];

const REAL_PROBE: BrowseComp[] = [
  comp("1", [HOODIES, CSA, WOMENS], ["155226"]),
  comp("2", [HOODIES, CSA, WOMENS], ["155226"]),
  comp("3", [ACTIVE_TOPS, CSA, WOMENS], ["185082"]),
  comp("4", [SWEATERS_REAL, CSA, WOMENS], ["63866"]),
  comp("5", [HOODIES, CSA, WOMENS], ["155226"]),
];

Deno.test("leaf votes separate the real winner from the ancestor everyone shares", () => {
  const leaves = tallyLeafCategoryVotes(REAL_PROBE);
  assertEquals(leaves[0]?.categoryId, "155226");
  assertEquals(leaves[0]?.categoryName, "Hoodies & Sweatshirts");
  assertEquals(leaves[0]?.count, 3);
  assertEquals(leaves.length, 3);

  // The ancestors are unanimous and useless for listing into. If the two
  // tallies were one array, "Clothing, Shoes & Accessories" at 5 votes would
  // outrank the leaf that is actually the answer.
  const all = tallyCategoryVotes(REAL_PROBE);
  assertEquals(all[0]?.count, 5);
  assertEquals(all[0]?.categoryId, CSA[0]);
});

Deno.test("a leaf name missing on one listing is recovered from another", () => {
  const votes = tallyLeafCategoryVotes([
    // eBay named no category chain here, so the leaf id arrives nameless.
    comp("1", [], ["155226"]),
    comp("2", [HOODIES, CSA], ["155226"]),
  ]);
  assertEquals(votes.length, 1);
  assertEquals(votes[0]?.count, 2);
  assertEquals(votes[0]?.categoryName, "Hoodies & Sweatshirts");
});

Deno.test("a leaf that is never named still counts", () => {
  // An unnamed winner beats a dropped one: the id is what can be listed into.
  const votes = tallyLeafCategoryVotes([comp("1", [], ["999999"])]);
  assertEquals(votes[0]?.categoryId, "999999");
  assertEquals(votes[0]?.categoryName, "");
  assertEquals(votes[0]?.count, 1);
});

Deno.test("sold comps carry no leaf, so they vote on nothing", () => {
  // Marketplace Insights reports no category at all. Empty must mean "this
  // source cannot say", never "the listings disagreed".
  assertEquals(tallyLeafCategoryVotes([comp("1", []), comp("2", [])]), []);
});

Deno.test("an ancestor chain with no leaf votes on NOTHING, not on the chain", () => {
  // The sabotage this exists to catch: falling back to `categories` when
  // `leafCategoryIds` is empty. It looks generous - some answer beats none -
  // and it is the one wrong answer that cannot be recovered from, because
  // "Women's Clothing" is an ANCESTOR. Nothing can be listed into it.
  //
  // The pre-existing empty-leaf case passed [] for both fields, so the fallback
  // produced [] either way and the test could not tell the two apart. Found by
  // sabotage, not by reading.
  const WOMENS: [string, string] = ["15724", "Women's Clothing"];
  const votes = tallyLeafCategoryVotes([
    comp("1", [WOMENS, TOPS, ACTIVEWEAR]),
    comp("2", [WOMENS, TOPS, ACTIVEWEAR]),
  ]);
  assertEquals(
    votes,
    [],
    "a listing whose leaf eBay did not send voted its ancestor chain instead - " +
      "the winner of a leaf vote must always be listable",
  );
});

Deno.test("a leaf vote never elects a category no listing named as its leaf", () => {
  // The same rule stated as an invariant rather than as one fixture: whatever
  // comes back must be a leaf SOMEBODY sent, so a future fallback that mixes
  // ancestors in fails here even if it keeps the empty case empty.
  const items = [
    comp("1", [["15724", "Women's Clothing"], TOPS], [TOPS[0]]),
    comp("2", [["15724", "Women's Clothing"], ACTIVEWEAR], [ACTIVEWEAR[0]]),
    comp("3", [["15724", "Women's Clothing"], TOPS], []),
  ];
  const declared = new Set(items.flatMap((i) => i.leafCategoryIds));
  for (const v of tallyLeafCategoryVotes(items)) {
    assertEquals(
      declared.has(v.categoryId),
      true,
      `${v.categoryId} (${v.categoryName}) won leaf votes but no listing sent ` +
        `it as a leaf`,
    );
  }
});

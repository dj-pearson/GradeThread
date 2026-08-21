// US-2765: the category decision, which used to be "take hit number one".
//
// The cases worth reading are the ones where the vote LOSES. A feature that
// only ever gets tested on its happy path is a feature whose fallbacks are
// decoration, and every fallback here exists because the alternative is a
// confidently wrong category that the seller then has to notice and fix.

import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  decideCategory,
  MIN_VOTE_SUPPORT,
  pickLeafVote,
} from "../lib/category-decision.ts";

const vote = (categoryId: string, categoryName: string, count: number) => ({
  categoryId,
  categoryName,
  count,
});

/** Leaf check that answers the same way for everything. */
const always = (answer: "leaf" | "non_leaf" | "not_found" | "unverified") => () =>
  Promise.resolve(answer);

const KEYWORD_HIT = [{ categoryId: "63866", categoryName: "Sweaters" }];
const keywords = () => Promise.resolve(KEYWORD_HIT);
const noKeywords = () => Promise.resolve([]);

// ── pickLeafVote ────────────────────────────────────────────────────────────

Deno.test("a clear majority wins", () => {
  const { winner, rejection } = pickLeafVote([
    vote("155226", "Hoodies & Sweatshirts", 3),
    vote("185082", "Activewear Tops", 1),
  ]);
  assertEquals(winner?.categoryId, "155226");
  assertEquals(rejection, null);
});

Deno.test("a TIE is not a decision", () => {
  // Two leaves on two votes each. Taking [0] would be the same "first hit
  // wins" reflex this story exists to remove, just with a nicer source.
  const { winner, rejection } = pickLeafVote([
    vote("155226", "Hoodies", 2),
    vote("185082", "Activewear Tops", 2),
  ]);
  assertEquals(winner, null);
  assertEquals(rejection, "tied");
});

Deno.test("one listing agreeing with itself is not a consensus", () => {
  const { winner, rejection } = pickLeafVote([vote("155226", "Hoodies", 1)]);
  assertEquals(winner, null);
  assertEquals(rejection, "below_min_support");
  assertEquals(MIN_VOTE_SUPPORT, 2);
});

Deno.test("no votes is distinct from a rejected vote", () => {
  const { winner, rejection } = pickLeafVote([]);
  assertEquals(winner, null);
  assertEquals(rejection, "no_votes");
});

Deno.test("a tie BELOW the bar reports the bar, not the tie", () => {
  // Both fail; the reason reported is the one that would still be true if the
  // other were fixed, so raising support is the actionable read.
  const { rejection } = pickLeafVote([
    vote("a", "A", 1),
    vote("b", "B", 1),
  ]);
  assertEquals(rejection, "below_min_support");
});

// ── decideCategory ──────────────────────────────────────────────────────────

Deno.test("a category the seller already set is never overridden by a vote", async () => {
  const d = await decideCategory({
    savedCategoryId: "11111",
    leafVotes: [vote("155226", "Hoodies", 5)],
    leafStatus: always("leaf"),
    keywordSuggest: keywords,
  });
  assertEquals(d.categoryId, "11111");
  assertEquals(d.method, "saved");
});

Deno.test("a proven-leaf consensus beats the keyword search", async () => {
  const d = await decideCategory({
    leafVotes: [vote("155226", "Hoodies & Sweatshirts", 3)],
    leafStatus: always("leaf"),
    keywordSuggest: keywords,
  });
  assertEquals(d.categoryId, "155226");
  assertEquals(d.categoryName, "Hoodies & Sweatshirts");
  assertEquals(d.method, "visual_consensus");
  assertEquals(d.support, 3);
  assertEquals(d.rejectedReason, null);
});

Deno.test("a winner that is NOT a leaf falls through to keywords", async () => {
  // "Women's Clothing" can win a vote outright and cannot be listed into.
  const d = await decideCategory({
    leafVotes: [vote("15724", "Women's Clothing", 5)],
    leafStatus: always("non_leaf"),
    keywordSuggest: keywords,
  });
  assertEquals(d.method, "keyword");
  assertEquals(d.categoryId, "63866");
  assertEquals(d.rejectedReason, "not_a_leaf");
});

Deno.test("an id eBay does not recognise falls through", async () => {
  const d = await decideCategory({
    leafVotes: [vote("999999", "Ghost", 4)],
    leafStatus: always("not_found"),
    keywordSuggest: keywords,
  });
  assertEquals(d.method, "keyword");
  assertEquals(d.rejectedReason, "not_a_leaf");
});

Deno.test("the leaf check FAILS OPEN, so an eBay blip does not quietly downgrade us", async () => {
  // The alternative is that during an incident every listing silently reverts
  // to the weaker path, which is both worse and invisible.
  const d = await decideCategory({
    leafVotes: [vote("155226", "Hoodies", 3)],
    leafStatus: always("unverified"),
    keywordSuggest: keywords,
  });
  assertEquals(d.method, "visual_consensus");
  assertEquals(d.categoryId, "155226");
});

Deno.test("no votes at all behaves exactly as today", async () => {
  const d = await decideCategory({
    leafStatus: always("leaf"),
    keywordSuggest: keywords,
  });
  assertEquals(d.method, "keyword");
  assertEquals(d.categoryId, "63866");
  assertEquals(d.rejectedReason, "no_votes");
});

Deno.test("a rejected vote is RECORDED even when keywords succeed", async () => {
  // A silently ignored vote and an absent vote look identical in the data, and
  // only one of them means the visual pass is not earning its latency.
  const d = await decideCategory({
    leafVotes: [vote("a", "A", 2), vote("b", "B", 2)],
    leafStatus: always("leaf"),
    keywordSuggest: keywords,
  });
  assertEquals(d.method, "keyword");
  assertEquals(d.rejectedReason, "tied");
});

Deno.test("nothing resolvable returns none rather than a wrong id", async () => {
  const d = await decideCategory({
    leafStatus: always("leaf"),
    keywordSuggest: noKeywords,
  });
  assertEquals(d.categoryId, null);
  assertEquals(d.method, "none");
});

Deno.test("the leaf check is not called when there is no winner to check", async () => {
  let calls = 0;
  await decideCategory({
    leafVotes: [vote("a", "A", 1)], // below support
    leafStatus: () => {
      calls++;
      return Promise.resolve("leaf" as const);
    },
    keywordSuggest: keywords,
  });
  assertEquals(calls, 0);
});

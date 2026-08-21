// US-2765: how a listing's eBay category is chosen.
//
// WHAT IT USED TO BE. `suggestCategories(query)[0]`, where `query` is a phrase
// our own model wrote ("men's flannel shirt"), matched by keyword against the
// Taxonomy service, first hit wins. Three guesses stacked on each other, and no
// step could tell a confident answer from a desperate one. It is the single
// most-corrected field in the product.
//
// WHAT REPLACES IT, AND WHY IT IS A DIFFERENT KIND OF EVIDENCE. A visual search
// returns live listings that real people filed into real categories. Where
// three of five agree on a leaf, that is not a better guess, it is a different
// question answered: not "what words describe this" but "where do garments that
// look like this actually get listed".
//
// The keyword path STAYS. It is the floor under the experiment and the only
// path that works when there is no photo, no match, or the flag is off.
//
// ── The one thing to keep straight ───────────────────────────────────────────
// A category vote is not a confidence score. Five listings agreeing that a
// garment belongs in "Women's Clothing" tells you almost nothing, because
// almost everything does, and you cannot list into it anyway. Only leaves are
// listable, so only leaf votes decide. See tallyLeafCategoryVotes.

import type { BrowseCompCategoryVote } from "./ebay-client.ts";

/**
 * How a category was arrived at. Recorded on the item so a wrong category can
 * be traced to the METHOD that picked it, not just to the id (AC4).
 *
 * Without this, "the category was wrong" is unactionable: it could be a bad
 * vote, a bad keyword phrase, or a leaf check that failed open, and those are
 * three different fixes.
 */
export type CategoryDecisionMethod =
  | "saved" // the seller (or a previous run) already set it; never overridden
  | "visual_consensus" // leaf votes from visually similar listings
  | "keyword" // Taxonomy keyword search on the AI's phrase
  | "none"; // nothing could be resolved

export interface CategoryDecision {
  categoryId: string | null;
  categoryName: string | null;
  method: CategoryDecisionMethod;
  /** Supporting listings when method is visual_consensus; 0 otherwise. */
  support: number;
  /**
   * Why the visual vote was NOT used, when it was present and lost. Recorded
   * because a silently ignored vote and an absent vote look identical in the
   * data, and only one of them means the feature is broken.
   */
  rejectedReason: VoteRejection | null;
}

export type VoteRejection =
  | "no_votes"
  | "tied"
  | "below_min_support"
  | "not_a_leaf";

/**
 * A single listing agreeing with itself is not a consensus.
 *
 * Two is deliberately low. The measured behaviour is that visual search returns
 * either a coherent neighbourhood or obvious junk, and the junk case is already
 * excluded upstream by the photo-role gate — a ruler shot never reaches here.
 * So this bar is guarding against the thin-result case (one or two matches on
 * an unusual garment), not against a bad neighbourhood.
 */
export const MIN_VOTE_SUPPORT = 2;

/**
 * Is the top leaf vote a decision, or did the evidence fail to settle?
 *
 * TIES LOSE. Two leaves on two votes each is not a 50% chance of being right,
 * it is a question the listings did not answer, and answering it from array
 * order would reintroduce exactly the "take hit number one" habit this whole
 * story exists to remove. A tie falls through to keywords, which at least
 * knows what it is doing.
 */
export function pickLeafVote(
  votes: readonly BrowseCompCategoryVote[],
  minSupport: number = MIN_VOTE_SUPPORT,
): { winner: BrowseCompCategoryVote | null; rejection: VoteRejection | null } {
  if (votes.length === 0) return { winner: null, rejection: "no_votes" };
  const top = votes[0]!;
  if (top.count < minSupport) {
    return { winner: null, rejection: "below_min_support" };
  }
  if (votes.length > 1 && votes[1]!.count === top.count) {
    return { winner: null, rejection: "tied" };
  }
  return { winner: top, rejection: null };
}

export interface DecideCategoryArgs {
  /** Already set on the item. Wins outright — a seller's choice is not a vote. */
  savedCategoryId?: string | null;
  /** Leaf votes from the visual matches, most-supported first. */
  leafVotes?: readonly BrowseCompCategoryVote[];
  /** Resolves whether a category id is a listable leaf. */
  leafStatus: (
    categoryId: string,
  ) => Promise<"leaf" | "non_leaf" | "not_found" | "unverified">;
  /** The keyword fallback: Taxonomy suggestions for the AI's phrase. */
  keywordSuggest: () => Promise<
    Array<{ categoryId: string; categoryName: string }>
  >;
  minSupport?: number;
}

/**
 * Decide the category, in strict precedence.
 *
 * A NOTE ON THE LEAF CHECK FAILING OPEN. `fetchCategoryLeafStatus` answers
 * "unverified" on a transient error, and that is treated as good enough to
 * proceed. The alternative is that an eBay blip silently demotes every listing
 * to the keyword path, which is worse and invisible: the category would quietly
 * get less accurate during exactly the incidents nobody is watching for it.
 * "not_found" and "non_leaf" are real answers and do reject the vote.
 */
export async function decideCategory(
  args: DecideCategoryArgs,
): Promise<CategoryDecision> {
  const saved = args.savedCategoryId?.trim();
  if (saved) {
    return {
      categoryId: saved,
      categoryName: null,
      method: "saved",
      support: 0,
      rejectedReason: null,
    };
  }

  let rejectedReason: VoteRejection | null = null;
  const { winner, rejection } = pickLeafVote(
    args.leafVotes ?? [],
    args.minSupport,
  );
  rejectedReason = rejection;

  if (winner) {
    const status = await args.leafStatus(winner.categoryId);
    if (status === "leaf" || status === "unverified") {
      return {
        categoryId: winner.categoryId,
        categoryName: winner.categoryName || null,
        method: "visual_consensus",
        support: winner.count,
        rejectedReason: null,
      };
    }
    rejectedReason = "not_a_leaf";
  }

  const suggestions = await args.keywordSuggest();
  const first = suggestions[0];
  if (!first) {
    return {
      categoryId: null,
      categoryName: null,
      method: "none",
      support: 0,
      rejectedReason,
    };
  }
  return {
    categoryId: first.categoryId,
    categoryName: first.categoryName || null,
    method: "keyword",
    support: 0,
    rejectedReason,
  };
}

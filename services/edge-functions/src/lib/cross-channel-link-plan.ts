// US-3197 AC3/AC4: turning pairwise link DECISIONS into a plan for a whole
// closet.
//
// cross-channel-link.ts answers "are these two rows the same garment?" and is
// unit-tested to the case. This answers the harder question it leaves open:
// given every listing a seller has across every channel, WHICH JOINS ACTUALLY
// HAPPEN. That is where a closet-sized import goes wrong, and the failure is
// not recoverable -- a wrong link merges two garments and there is no unmerge
// button.
//
// FOUR RULES, each one a way the naive version merges the wrong things:
//
//   1. MUTUAL BEST ONLY. A links B only when B's best match is also A. Without
//      it one attractive row (a generic "black tee") wins the top score
//      against five different garments and swallows all of them. A one-sided
//      "link" is demoted to review rather than dropped, because it is still
//      the best evidence anyone has.
//   2. ONE JOIN PER ROW PER RUN. No transitive closure. If A-B and B-C both
//      score as links, joining all three is a THREE-garment merge resting on
//      two pairwise decisions, and neither decision was asked that question.
//      The second pair becomes a review.
//   3. ONE LISTING PER PLATFORM IN A GROUP. decideLink already refuses two
//      rows from the same platform; this enforces the same thing at group
//      level, where the pairwise rule cannot see it.
//   4. ALREADY JOINED IS SKIPPED, NOT RE-JOINED. Two rows already sharing a
//      draft_id, or already on one inventory item, are the idempotency case
//      (AC5) and produce no plan entry at all.
//
// PURE, and deliberately so. The writer that applies a plan is the dangerous
// half; keeping the decision out of it means the decision can be driven with
// plain objects and sabotaged in a test, which is how cross-channel-link.ts
// was built and is the only reason its rules are trustworthy.

import {
  bestMatch,
  decideLink,
  type LinkCandidate,
  type LinkDecision,
} from "./cross-channel-link.ts";

/** One live listing, as the planner needs it. */
export interface LinkableRow {
  listingId: string;
  /** The inventory item this listing currently hangs off. */
  inventoryItemId: string;
  /** The cross-listing group anchor, when this row already has one. */
  draftId: string | null;
  /** When the row was created. The older item anchors a join -- see below. */
  createdAt: string;
  candidate: LinkCandidate;
}

export interface PlannedLink {
  /**
   * The inventory item the joined rows end up on.
   *
   * THE OLDER ITEM WINS. It is the one the seller has had longer and is more
   * likely to have edited, measured or photographed, and field ownership in
   * sync-source-of-truth.md is written from the item's own history. Ties break
   * on listing id so a plan is reproducible rather than dependent on row order.
   */
  keepItemId: string;
  /** The item whose rows move onto `keepItemId`. Never equal to it. */
  mergeItemId: string;
  /** Both listings, keeper first. */
  listingIds: [string, string];
  score: number;
  reasons: string[];
}

export interface PlannedReview {
  /** Keeper-first, same ordering rule as a link, so the two are comparable. */
  listingIds: [string, string];
  itemIds: [string, string];
  score: number;
  reasons: string[];
}

export interface LinkPlan {
  links: PlannedLink[];
  reviews: PlannedReview[];
  /** Rows already in one group. Counted so a summary can say "nothing to do". */
  alreadyLinked: number;
  /** Rows that matched nothing at all. */
  unmatched: number;
}

/** Older first; listing id breaks a tie so the plan is deterministic. */
function anchorFirst(a: LinkableRow, b: LinkableRow): [LinkableRow, LinkableRow] {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  const aFirst = Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb
    ? ta < tb
    : a.listingId < b.listingId;
  return aFirst ? [a, b] : [b, a];
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Already one garment: same item, or already sharing a cross-listing group. */
export function alreadyJoined(a: LinkableRow, b: LinkableRow): boolean {
  if (a.inventoryItemId === b.inventoryItemId) return true;
  if (a.draftId && b.draftId && a.draftId === b.draftId) return true;
  // A row whose draft_id IS the other's item is the shape the eBay writeback
  // leaves behind: the group anchor carries a null draft_id of its own.
  if (a.draftId && a.draftId === b.inventoryItemId) return true;
  if (b.draftId && b.draftId === a.inventoryItemId) return true;
  return false;
}

/**
 * Plan the joins for one seller's rows.
 *
 * Returns pairs, never groups. A plan entry is two listings and two items, so
 * applying it is one join; a three-way merge can only happen across two runs
 * with a human between them.
 */
export function planCrossChannelLinks(rows: readonly LinkableRow[]): LinkPlan {
  const plan: LinkPlan = { links: [], reviews: [], alreadyLinked: 0, unmatched: 0 };
  if (rows.length < 2) {
    plan.unmatched = rows.length;
    return plan;
  }

  // Best match for every row, computed once. `bestMatch` already demotes an
  // ambiguous winner to review, so anything still reading "link" survived that.
  const best = new Map<string, { other: LinkableRow; decision: LinkDecision } | null>();
  for (const row of rows) {
    const others = rows.filter((r) => r.listingId !== row.listingId);
    const match = bestMatch(row.candidate, others.map((o) => o.candidate));
    best.set(row.listingId, match ? { other: others[match.index], decision: match } : null);
  }

  const seenPair = new Set<string>();
  const joined = new Set<string>();
  const joinedItems = new Set<string>();
  const matched = new Set<string>();

  for (const row of rows) {
    const mine = best.get(row.listingId);
    if (!mine) continue;
    const other = mine.other;
    matched.add(row.listingId);

    const key = pairKey(row.listingId, other.listingId);
    if (seenPair.has(key)) continue;
    seenPair.add(key);

    if (alreadyJoined(row, other)) {
      plan.alreadyLinked++;
      continue;
    }

    const [keeper, merged] = anchorFirst(row, other);
    const theirs = best.get(other.listingId);
    const mutual = theirs?.other.listingId === row.listingId;

    // ORIENTED ON THE ANCHOR, not on whichever row the loop reached first.
    // decideLink's score is symmetric but its REASONS are not: the same pair
    // reads "Priced 45 and 48" or "Priced 48 and 45" depending on argument
    // order, so a plan built from the same rows in a different order stored
    // different words. Caught by the reproducibility case. Re-deriving here
    // also makes the reasons read in the same order as `listingIds`, which is
    // what a human reviewing the pair sees.
    const oriented = decideLink(keeper.candidate, merged.candidate);
    // Anything bestMatch added on top of the pairwise decision -- today the
    // ambiguity note -- is kept, because it is about the FIELD and cannot be
    // re-derived from the pair alone.
    //
    // EXCLUDING BOTH ORIENTATIONS, not just the one being kept. Filtering on
    // `oriented` alone let the FLIPPED wording back in as though it were a
    // ranking reason: the reverse plan carried "Priced 45 and 48." and
    // "Priced 48 and 45." together, which is the same reproducibility bug one
    // layer along. A reason either side of the pair can produce is a pairwise
    // reason, whichever way round it was computed.
    const flipped = decideLink(merged.candidate, keeper.candidate);
    const pairwise = new Set([...oriented.reasons, ...flipped.reasons]);
    const fromRanking = mine.decision.reasons.filter((r) => !pairwise.has(r));

    const record = (verdict: "link" | "review", extra: string[] = []) => {
      const entry = {
        listingIds: [keeper.listingId, merged.listingId] as [string, string],
        score: oriented.score,
        reasons: [...oriented.reasons, ...fromRanking, ...extra],
      };
      if (verdict === "link") {
        plan.links.push({
          keepItemId: keeper.inventoryItemId,
          mergeItemId: merged.inventoryItemId,
          ...entry,
        });
        joined.add(keeper.listingId);
        joined.add(merged.listingId);
        joinedItems.add(keeper.inventoryItemId);
        joinedItems.add(merged.inventoryItemId);
        return;
      }
      plan.reviews.push({
        itemIds: [keeper.inventoryItemId, merged.inventoryItemId],
        ...entry,
      });
    };

    if (mine.decision.verdict === "review") {
      record("review");
      continue;
    }
    if (mine.decision.verdict !== "link") continue;

    if (!mutual) {
      // One-sided. The other row thinks something else is a better fit, and
      // picking this one anyway is how a generic title swallows a closet.
      record("review", [
        "The other listing's closest match is a different item, so this one needs a look.",
      ]);
      continue;
    }
    // The ITEM check is the one that fires. The LISTING check is unreachable
    // while rule 1 holds -- mutual best matching is a matching, so its pairs
    // are disjoint by construction and no listing can appear twice. Measured
    // by sabotage: removing the listing half breaks nothing, removing the item
    // half breaks a case. Kept anyway, because it costs a set lookup and the
    // thing it guards is a merge with no undo, and named here so the next
    // reader does not spend an afternoon writing a case for it.
    if (
      joined.has(keeper.listingId) || joined.has(merged.listingId) ||
      joinedItems.has(keeper.inventoryItemId) || joinedItems.has(merged.inventoryItemId)
    ) {
      // Rule 2 and rule 3. A second join in one run would extend a group this
      // decision was never asked about.
      record("review", [
        "One of these is already being joined to something else in this run.",
      ]);
      continue;
    }
    record("link");
  }

  plan.unmatched = rows.filter((r) => !matched.has(r.listingId)).length;

  // DETERMINISTIC OUTPUT ORDER, not just deterministic content. The review
  // queue is a screen a seller works through, and a list that reshuffles
  // because the rows arrived in a different order is a list they lose their
  // place in. Caught by the reproducibility case, which compared two plans
  // built from the same rows reversed and found the same pairs in a different
  // order.
  const byPair = (a: { listingIds: [string, string] }, b: { listingIds: [string, string] }) =>
    pairKey(...a.listingIds).localeCompare(pairKey(...b.listingIds));
  plan.links.sort(byPair);
  plan.reviews.sort(byPair);
  return plan;
}

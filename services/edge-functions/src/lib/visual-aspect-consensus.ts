// US-2766: what the visually similar listings DECLARE, as opposed to what they
// are called.
//
// THE MISTAKE THIS AVOIDS, WHICH WE ALREADY MADE ONCE. The style-code index
// originally learned product names from the run of words most listing titles
// shared, and the owner rejected it for two reasons that apply here word for
// word (vault/20-domain/style-code-index-evidence.md):
//
//   1. A title is marketing text. A seller who bought the garment with no tag
//      beyond a size dot writes their best guess, and a consensus over guesses
//      is a confident guess.
//   2. We were reading ourselves. Our own sellers publish to eBay with titles
//      our AI wrote, so those titles came back as independent corroboration -
//      three copies of one guess, agreeing because they share an author.
//
// A visual search returns titles by the armful and it is tempting to mine them.
// This module refuses to. A listing contributes to a field only by filling in
// the STRUCTURED item specific for it. One such listing is worth more than
// three agreeing titles, because it is evidence of a different kind rather than
// more of the same.
//
// ── Cost ─────────────────────────────────────────────────────────────────────
// item_summary does NOT carry localizedAspects, so every listing read costs a
// second call. That is the price of not building on marketing text, and it is
// why MAX_ASPECT_READS exists.

import {
  getBrowseItemAspects,
  type BrowseComp,
} from "./ebay-client.ts";
import type { ListingAspects } from "./style-code-aspects.ts";

/**
 * How many of the visual matches get an aspect read.
 *
 * Five, matching what a visual search returns as its coherent top. Each read is
 * a network round trip on a path a seller is waiting on, so this is a latency
 * budget rather than a sampling choice: doubling it would double the cost to
 * sharpen a vote that is already decided by the first few.
 */
export const MAX_ASPECT_READS = 5;

/**
 * Aspects worth harvesting, and what each is trusted for.
 *
 * Deliberately NOT every aspect eBay returns. A listing's "Size" is the size of
 * THAT garment, not of ours, and copying it across would be actively wrong -
 * the whole point of a visual match is that it is a different physical item
 * that happens to be the same product. Only product-identity aspects belong
 * here.
 */
export const IDENTITY_ASPECTS = [
  "Brand",
  "Department",
  "Type",
  "Style",
  "Model",
  "Product Line",
  "Material",
  "Pattern",
  "Fit",
  "Sleeve Length",
  "Neckline",
  "Closure",
] as const;

export type IdentityAspect = (typeof IDENTITY_ASPECTS)[number];

export interface AspectConsensus {
  /** The agreed value, or null when the listings disagree. */
  value: string | null;
  /** How many listings declared the winning value. */
  support: number;
  /** How many listings declared this aspect at all. */
  declared: number;
  /** Distinct values seen, most-supported first. Present even when value is null. */
  candidates: Array<{ value: string; count: number }>;
  /**
   * The listings that declared the winning value (US-2780).
   *
   * Empty when the listings disagreed, because there is no winner to attribute.
   * The caller maps these back to the PHOTOS that surfaced them, which is how
   * "five listings agreed, but only one angle found them" becomes sayable.
   * Computed by the gatherer, not by tallyAspect - the tally counts strings and
   * has no idea which listing each came from.
   */
  winningListingIds?: string[];
}

export interface VisualAspectEvidence {
  /** Per-aspect consensus. An aspect nobody declared is absent, not null. */
  aspects: Partial<Record<IdentityAspect, AspectConsensus>>;
  /** Listings whose specifics were actually read. */
  listingsRead: number;
  /** Listings skipped because they are ours. */
  ownListingsExcluded: number;
  /** Reads that failed. Degrades the vote; never fails the identification. */
  readFailures: number;
}

/** Case-insensitive aspect read: sellers and categories vary the casing. */
function readAspect(
  aspects: Record<string, string>,
  want: string,
): string | null {
  const wanted = want.toLowerCase();
  for (const [name, value] of Object.entries(aspects)) {
    if (name.trim().toLowerCase() === wanted) {
      const v = value.trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

/**
 * Tally one aspect across the listings that declared it.
 *
 * A MAJORITY IS REQUIRED, and a tie is not one. Two listings saying "Nike" and
 * two saying "Adidas" is not a 50/50 brand, it is a signal that the visual
 * match pulled in more than one product - which is exactly the case where
 * asserting either would be worst. Same rule aspectEvidence already applies to
 * product names: "two people who both read the tag and disagree is a question
 * for a human".
 */
export function tallyAspect(values: readonly string[]): AspectConsensus {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    // Case-insensitive grouping, first spelling kept: "lululemon" and
    // "Lululemon" are one brand, and the seller's capitalisation is not a vote.
    const key = v.toLowerCase();
    const existing = [...counts.keys()].find((k) => k.toLowerCase() === key);
    const useKey = existing ?? v;
    counts.set(useKey, (counts.get(useKey) ?? 0) + 1);
  }
  const candidates = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);

  const declared = candidates.reduce((n, c) => n + c.count, 0);
  const top = candidates[0];
  const tied = candidates.length > 1 && candidates[1]!.count === top?.count;
  return {
    value: top && !tied ? top.value : null,
    support: top && !tied ? top.count : 0,
    declared,
    candidates,
  };
}

export interface GatherArgs {
  /** The visual matches, in eBay's order. */
  comps: readonly BrowseComp[];
  /** Our own eBay listing ids, so we cannot corroborate ourselves. */
  ownItemIds: ReadonlySet<string>;
  /** Injected for tests; defaults to the real Browse call. */
  fetchAspects?: (itemId: string) => Promise<ListingAspects | null>;
  maxReads?: number;
}

/**
 * Read the item specifics of the top visual matches and agree on what they say.
 *
 * NEVER THROWS. A failed read costs one listing's vote, an outage costs all of
 * them, and both come back as thinner evidence rather than as an error. The
 * caller is on a path a seller is waiting on and an identification that works
 * slightly less well beats one that 500s.
 */
export async function gatherVisualAspectEvidence(
  args: GatherArgs,
): Promise<VisualAspectEvidence> {
  const fetchAspects = args.fetchAspects ?? getBrowseItemAspects;
  const maxReads = args.maxReads ?? MAX_ASPECT_READS;

  let ownListingsExcluded = 0;
  const targets: string[] = [];
  for (const comp of args.comps) {
    if (targets.length >= maxReads) break;
    if (!comp.itemId) continue;
    if (args.ownItemIds.has(comp.itemId)) {
      ownListingsExcluded++;
      continue;
    }
    targets.push(comp.itemId);
  }

  // Concurrent: these are independent reads and the seller is waiting. Bounded
  // by maxReads, so this cannot fan out.
  const settled = await Promise.all(
    targets.map(async (itemId) => {
      try {
        return await fetchAspects(itemId);
      } catch {
        return null;
      }
    }),
  );

  const listings = settled.filter((l): l is ListingAspects => l != null);
  const readFailures = settled.length - listings.length;

  const aspects: Partial<Record<IdentityAspect, AspectConsensus>> = {};
  for (const name of IDENTITY_ASPECTS) {
    const values = listings
      .map((l) => readAspect(l.aspects, name))
      .filter((v): v is string => v != null);
    // An aspect nobody declared is ABSENT rather than a null consensus. The
    // difference matters downstream: absent means "no evidence", null means
    // "evidence that disagreed", and only the second is a reason for a human
    // to look.
    if (values.length === 0) continue;
    const consensus = tallyAspect(values);
    // US-2780: attribute the winner back to the listings that carried it, so
    // the caller can ask which PHOTOS surfaced them. A null value has no
    // winner and therefore nothing to attribute.
    if (consensus.value) {
      const want = consensus.value.toLowerCase();
      consensus.winningListingIds = listings
        .filter((l) => (readAspect(l.aspects, name) ?? "").toLowerCase() === want)
        .map((l) => l.itemId);
    }
    aspects[name] = consensus;
  }

  return {
    aspects,
    listingsRead: listings.length,
    ownListingsExcluded,
    readFailures,
  };
}

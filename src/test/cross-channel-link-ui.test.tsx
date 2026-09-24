import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanSummarySentence } from "@/hooks/use-cross-channel-link";

// US-3197 AC1/AC8: the seller-facing half.
//
// THE SENTENCE IS THE DELIVERABLE HERE. A scan that joins nothing and leaves
// eleven questions must not read like a scan that found nothing to do —
// those are opposite outcomes and the second one needs the seller. Most of
// this feature's value sits in the queue, because the decision layers refuse
// far more than they accept.

const ROOT = resolve(__dirname, "../..");
const CARD = readFileSync(
  resolve(ROOT, "src/components/flipdesk/link-duplicates-card.tsx"),
  "utf8",
);
const PAGE = readFileSync(resolve(ROOT, "src/pages/flipdesk/marketplaces.tsx"), "utf8");
const HOOK = readFileSync(resolve(ROOT, "src/hooks/use-cross-channel-link.ts"), "utf8");

const base = { linked: 0, needsReview: 0, alreadyLinked: 0, unmatched: 0, scanned: 0, failed: 0 };

describe("what a finished scan says (US-3197 AC8)", () => {
  it("a scan that joined nothing but left questions says so", () => {
    // The case that matters: silence here is a closet left half-joined.
    const s = scanSummarySentence({ ...base, scanned: 40, needsReview: 11 });
    expect(s).toContain("11 matches need your call");
    expect(s).not.toMatch(/nothing new to join/i);
  });

  it("a genuinely quiet scan reads as quiet, and says what it checked", () => {
    const s = scanSummarySentence({ ...base, scanned: 40 });
    expect(s).toMatch(/nothing new to join/i);
    expect(s).toContain("40");
  });

  it("nothing to compare is different from nothing to do", () => {
    // A seller with no live listings has not been told their closet is tidy.
    expect(scanSummarySentence(base)).toMatch(/no live listings/i);
  });

  it("singular and plural are both written", () => {
    expect(scanSummarySentence({ ...base, scanned: 2, linked: 1 })).toContain("1 pair");
    expect(scanSummarySentence({ ...base, scanned: 4, linked: 2 })).toContain("2 pairs");
    expect(scanSummarySentence({ ...base, scanned: 2, needsReview: 1 }))
      .toContain("1 match needs");
  });

  it("a pair that could not be joined is reported, not swallowed", () => {
    const s = scanSummarySentence({ ...base, scanned: 9, linked: 1, failed: 2 });
    expect(s).toContain("2 could not be joined");
    expect(s).toMatch(/left alone/i);
  });

  it("every count the summary needs comes back from the scan", () => {
    // AC8 asks for a per-outcome summary. If the route stops returning one of
    // these the sentence quietly loses a clause.
    for (const key of ["linked", "needsReview", "alreadyLinked", "unmatched", "scanned", "failed"]) {
      expect(HOOK, `LinkScanSummary lost ${key}`).toContain(`${key}:`);
    }
  });
});

describe("the queue is rendered, not just the button (US-3197 AC1/AC4)", () => {
  it("the card is on the Marketplaces page", () => {
    expect(PAGE).toContain("<LinkDuplicatesCard />");
    expect(PAGE).toContain('from "@/components/flipdesk/link-duplicates-card"');
  });

  it("the review list renders whether or not a scan just ran", () => {
    // Bound to the query, not to the mutation's result. A queue that only
    // appears after a scan is a queue a seller forgets.
    expect(CARD).toContain("useLinkReviews()");
    expect(CARD).toMatch(/pending\.length > 0 &&/);
  });

  it("both answers are offered, and the words are about garments", () => {
    // "Same item" / "Different items" rather than "confirm" / "reject": the
    // seller is answering a question about two photographs, not operating a
    // queue.
    expect(CARD).toContain("Same item");
    expect(CARD).toContain("Different items");
    expect(CARD).toContain('answer(r.id, "confirm")');
    expect(CARD).toContain('answer(r.id, "split")');
  });

  it("the reasons the server gave are shown as written", () => {
    // They name the fields that agreed, which is what a person checks. A card
    // that shows only a score asks the seller to trust a number.
    expect(CARD).toMatch(/r\.reasons\.map/);
  });

  it("an empty queue says so rather than rendering blank", () => {
    // Empty and never-built look identical on screen and mean opposite things.
    // MP-08: only on a SUCCESSFUL read. A failed one is not an empty queue.
    expect(CARD).toMatch(/pending\.length === 0 && reviews\.isSuccess/);
    expect(CARD).toMatch(/Nothing waiting on you/);
  });

  it("each row's buttons are told apart by a screen reader", () => {
    // US-2450, and it fired on this card: two buttons per row, both reading
    // the same two words all the way down the list. The review row carries no
    // title, so the identity a person can tell apart is the score plus the
    // strongest reason the server gave.
    expect(CARD).toContain('aria-label={`Same item: ${rowName(r)}`}');
    expect(CARD).toContain('aria-label={`Different items: ${rowName(r)}`}');
    expect(CARD).toMatch(/function rowName\(/);
  });

  it("a scan invalidates the surfaces it moved rows on", () => {
    // It moves listings between items and archives the emptied ones, so the
    // item lists are stale the moment it finishes.
    // SCOPED TO useLinkScan. Checking the whole file passed while the scan's
    // invalidations were deleted, because useResolveLinkReview names the same
    // keys — measured. A string present somewhere is not the same as a string
    // present where it does something.
    const scanBlock = HOOK.slice(
      HOOK.indexOf("export function useLinkScan"),
      HOOK.indexOf("export function useResolveLinkReview"),
    );
    expect(scanBlock.length).toBeGreaterThan(200);
    for (const key of ["cross_channel_link_reviews", "items_full", "item_listings"]) {
      expect(scanBlock, `a scan does not invalidate ${key}`).toContain(key);
    }
  });
});

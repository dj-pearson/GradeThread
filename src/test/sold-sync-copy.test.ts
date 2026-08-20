// US-2699: the sentences sold-sync shows a seller.
//
// Copy is tested here because the distinctions in it are load-bearing, not
// cosmetic. "We have never read this channel" and "we read it and it looked
// empty" have different fixes, and a UI that collapses them sends the seller
// after the wrong one.

import { describe, expect, it } from "vitest";
import {
  reviewGroupCopy,
  syncStateCopy,
  type SyncChannel,
} from "@/hooks/use-sold-sync";

function channel(over: Partial<SyncChannel> = {}): SyncChannel {
  return {
    platform: "poshmark",
    status: "ok",
    failure_reason: null,
    listings_seen: 118,
    last_ok_at: "2026-08-20T00:00:00.000Z",
    last_read_at: "2026-08-20T00:00:00.000Z",
    open_reviews: 0,
    live_listings: 118,
    ...over,
  };
}

describe("syncStateCopy", () => {
  it("never-synced does not read as healthy", () => {
    const copy = syncStateCopy(channel({ status: "never", listings_seen: null }));
    expect(copy.label).toBe("Not synced yet");
    expect(copy.tone).toBe("idle");
    expect(copy.label.toLowerCase()).not.toContain("syncing");
  });

  it("never-synced with live listings tells the seller how to start", () => {
    const copy = syncStateCopy(
      channel({ status: "never", listings_seen: null, live_listings: 42 }),
    );
    expect(copy.detail).toContain("42 listings");
    expect(copy.detail).toContain("sold page");
  });

  it("never-synced with nothing live does not invent a chore", () => {
    const copy = syncStateCopy(
      channel({ status: "never", listings_seen: null, live_listings: 0 }),
    );
    expect(copy.detail).toBe("Nothing to sync here yet.");
  });

  it("a failing channel says nothing was recorded", () => {
    // The seller's real question on seeing a failure is "did it do something
    // wrong to my listings?" The answer is no, and it has to be on screen.
    const copy = syncStateCopy(
      channel({ status: "failing", failure_reason: "The closet read returned no listings." }),
    );
    expect(copy.tone).toBe("warn");
    expect(copy.detail).toBe("The closet read returned no listings.");
  });

  it("a failing channel with no reason still says nothing was recorded", () => {
    const copy = syncStateCopy(channel({ status: "failing", failure_reason: null }));
    expect(copy.detail).toContain("Nothing was recorded");
  });

  it("not-signed-in is a different fix from failing", () => {
    const signedOut = syncStateCopy(channel({ status: "not_signed_in" }));
    const failing = syncStateCopy(channel({ status: "failing" }));
    expect(signedOut.label).not.toBe(failing.label);
    expect(signedOut.detail).toContain("sign in");
    expect(signedOut.detail).toContain("Nothing was recorded");
  });

  it("a healthy channel reports what the last read actually saw", () => {
    const copy = syncStateCopy(channel({ status: "ok", listings_seen: 118 }));
    expect(copy.tone).toBe("ok");
    expect(copy.detail).toContain("118 listings seen");
  });

  it("singular and plural both read correctly", () => {
    expect(syncStateCopy(channel({ listings_seen: 1 })).detail).toContain("1 listing seen");
    expect(syncStateCopy(channel({ listings_seen: 2 })).detail).toContain("2 listings seen");
    expect(
      syncStateCopy(channel({ status: "never", listings_seen: null, live_listings: 1 })).detail,
    ).toContain("1 listing");
  });

  it("a healthy channel with no closet read shows no invented count", () => {
    // A sold-page-only read saw no closet. Printing "0 listings seen" would
    // read as an empty closet, which is the exact false alarm the server's
    // failing state exists to distinguish.
    const copy = syncStateCopy(channel({ status: "ok", listings_seen: null }));
    expect(copy.detail).toBeNull();
  });
});

describe("reviewGroupCopy", () => {
  it("every reason has a title and a blurb", () => {
    for (
      const reason of [
        "probable_match",
        "unexplained_absence",
        "count_gap",
        "circuit_breaker",
      ] as const
    ) {
      const copy = reviewGroupCopy(reason);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.blurb.length).toBeGreaterThan(0);
    }
  });

  it("confirming a match promises it gets automatic", () => {
    // The reason a seller works this queue at all: it shrinks as they use it.
    expect(reviewGroupCopy("probable_match").blurb).toContain("next time");
  });

  it("the breaker explains itself as a redesign, not a good day", () => {
    const copy = reviewGroupCopy("circuit_breaker");
    expect(copy.blurb).toContain("recorded none of it");
    expect(copy.blurb).toContain("redesign");
  });

  it("an unexplained absence does not assert the item sold", () => {
    // It is exactly the case where we do not know, and saying "sold" would be
    // the system claiming a certainty it refused to act on.
    const copy = reviewGroupCopy("unexplained_absence");
    expect(copy.title.toLowerCase()).toContain("unknown");
    expect(copy.blurb).toContain("may have");
  });
});

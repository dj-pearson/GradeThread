import { describe, expect, it } from "vitest";
import {
  ALL_CLEAR,
  ATTENTION_HREF,
  buildAttentionChips,
  oldestUpdatedAt,
} from "@/lib/attention-rail";

// US-3079 AC4: the rail's ordering, its zero-count rule and the all-clear case,
// tested as data.
//
// The ordering is the part worth guarding. It is FIXED by consequence, not
// sorted by count: a seller with 40 aging items and one return due in two hours
// has one urgent problem and 40 slow ones, and a count-sorted rail buries the
// return under the inventory. That is exactly the kind of rule someone
// "improves" later by adding a sort.

const FLIPDESK_ALL = {
  needsYouCount: 3,
  needsYouDeadlineLabel: "Due in 2 hours",
  draftsToReview: 4,
  syncConflicts: 1,
  extensionJobsPending: 6,
  agingCount: 40,
  staleCount: 7,
};

const FLIPDESK_NONE = {
  needsYouCount: 0,
  needsYouDeadlineLabel: null,
  draftsToReview: 0,
  syncConflicts: 0,
  extensionJobsPending: 0,
  agingCount: 0,
  staleCount: 0,
};

describe("buildAttentionChips: order", () => {
  it("is by consequence, not by count", () => {
    const chips = buildAttentionChips({
      surface: "flipdesk",
      flipdesk: FLIPDESK_ALL,
    });
    expect(chips.map((c) => c.id)).toEqual([
      "needs-you",
      "drafts",
      "conflicts",
      "extension",
      "aging",
      "stale",
    ]);
    // The biggest count is next to last. If a sort ever creeps in, this is the
    // assertion that catches it.
    expect(chips[chips.length - 2]!.count).toBe(40);
    expect(chips[0]!.count).toBe(3);
  });

  it("keeps the same order when the middle chips are empty", () => {
    const chips = buildAttentionChips({
      surface: "flipdesk",
      flipdesk: {
        ...FLIPDESK_NONE,
        needsYouCount: 1,
        needsYouDeadlineLabel: "Overdue",
        staleCount: 2,
      },
    });
    expect(chips.map((c) => c.id)).toEqual(["needs-you", "stale"]);
  });

  it("orders the grading surface in review, failed, disputed", () => {
    const chips = buildAttentionChips({
      surface: "grading",
      grading: { inReview: 2, failed: 1, disputed: 5 },
    });
    expect(chips.map((c) => c.id)).toEqual(["in-review", "failed", "disputed"]);
  });
});

describe("buildAttentionChips: zero counts", () => {
  it("omits every chip whose count is zero", () => {
    const chips = buildAttentionChips({
      surface: "flipdesk",
      flipdesk: { ...FLIPDESK_ALL, syncConflicts: 0, agingCount: 0 },
    });
    expect(chips.map((c) => c.id)).not.toContain("conflicts");
    expect(chips.map((c) => c.id)).not.toContain("aging");
    expect(chips.every((c) => c.count > 0)).toBe(true);
  });

  it("treats a negative count as nothing rather than rendering it", () => {
    // Nothing should produce one, but a chip reading "-1 stale listings" is a
    // worse outcome than a missing chip.
    const chips = buildAttentionChips({
      surface: "flipdesk",
      flipdesk: { ...FLIPDESK_NONE, staleCount: -1 },
    });
    expect(chips).toEqual([]);
  });
});

describe("buildAttentionChips: all clear", () => {
  it("returns nothing when every flipdesk count is zero", () => {
    expect(
      buildAttentionChips({ surface: "flipdesk", flipdesk: FLIPDESK_NONE }),
    ).toEqual([]);
  });

  it("returns nothing when every grading count is zero", () => {
    expect(
      buildAttentionChips({
        surface: "grading",
        grading: { inReview: 0, failed: 0, disputed: 0 },
      }),
    ).toEqual([]);
  });

  it("returns nothing when the surface has no input at all", () => {
    expect(buildAttentionChips({ surface: "flipdesk" })).toEqual([]);
    expect(buildAttentionChips({ surface: "grading", grading: null })).toEqual([]);
  });

  it("has a phrase for the empty case so the rail is never a blank strip", () => {
    expect(ALL_CLEAR.length).toBeGreaterThan(0);
  });
});

describe("buildAttentionChips: surfaces do not leak into each other", () => {
  it("shows no flipdesk chips on the grading surface", () => {
    const chips = buildAttentionChips({
      surface: "grading",
      flipdesk: FLIPDESK_ALL,
      grading: { inReview: 1, failed: 0, disputed: 0 },
    });
    expect(chips.map((c) => c.id)).toEqual(["in-review"]);
  });

  it("shows no grading chips on the flipdesk surface", () => {
    const chips = buildAttentionChips({
      surface: "flipdesk",
      flipdesk: { ...FLIPDESK_NONE, staleCount: 1 },
      grading: { inReview: 9, failed: 9, disputed: 9 },
    });
    expect(chips.map((c) => c.id)).toEqual(["stale"]);
  });
});

describe("buildAttentionChips: the hint", () => {
  it("carries the soonest deadline wording on the needs-you chip only", () => {
    const chips = buildAttentionChips({
      surface: "flipdesk",
      flipdesk: FLIPDESK_ALL,
    });
    expect(chips.find((c) => c.id === "needs-you")!.hint).toBe("Due in 2 hours");
    for (const c of chips.filter((c) => c.id !== "needs-you")) {
      expect(c.hint).toBeNull();
    }
  });

  it("is null rather than a placeholder when nothing has a deadline", () => {
    const chips = buildAttentionChips({
      surface: "flipdesk",
      flipdesk: { ...FLIPDESK_NONE, needsYouCount: 2, needsYouDeadlineLabel: null },
    });
    expect(chips[0]!.hint).toBeNull();
  });
});

describe("buildAttentionChips: every chip links somewhere real", () => {
  it("uses a declared href for each chip", () => {
    const known = new Set<string>(Object.values(ATTENTION_HREF));
    const all = [
      ...buildAttentionChips({ surface: "flipdesk", flipdesk: FLIPDESK_ALL }),
      ...buildAttentionChips({
        surface: "grading",
        grading: { inReview: 1, failed: 1, disputed: 1 },
      }),
    ];
    expect(all.length).toBe(9);
    for (const c of all) {
      expect(known.has(c.href), `${c.id} -> ${c.href}`).toBe(true);
      expect(c.href.startsWith("/dashboard/")).toBe(true);
    }
  });
});

describe("oldestUpdatedAt", () => {
  it("takes the STALEST stamp, so the rail is never fresher than its worst number", () => {
    expect(oldestUpdatedAt([300, 100, 200])).toBe(100);
  });

  it("ignores 0, which TanStack Query uses for a query that never resolved", () => {
    // Treating 0 as a timestamp pins the whole rail to 1970 and reads as
    // "updated 56 years ago" next to perfectly fresh data.
    expect(oldestUpdatedAt([0, 500, 900])).toBe(500);
  });

  it("returns null when nothing has resolved, rather than a fake time", () => {
    expect(oldestUpdatedAt([])).toBeNull();
    expect(oldestUpdatedAt([0, 0])).toBeNull();
    expect(oldestUpdatedAt([Number.NaN])).toBeNull();
  });
});

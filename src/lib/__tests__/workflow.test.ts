import { describe, it, expect } from "vitest";
import { nextAction, resolveStatus, factsOf } from "@/lib/workflow";
import type { ItemFullRow, ItemStatus } from "@/types/database";

// Minimal ItemFullRow factory — only the fields nextAction/resolveStatus read
// matter; the rest are filled with inert defaults and cast.
function makeItem(overrides: Partial<ItemFullRow> = {}): ItemFullRow {
  return {
    status: "cataloged",
    measurements: null,
    has_required_photos: false,
    target_price: null,
    listing_id: null,
    grade_value: null,
    ...overrides,
  } as ItemFullRow;
}

// A fully prepped (measured + photographed) item with no price yet.
function photographed(overrides: Partial<ItemFullRow> = {}): ItemFullRow {
  return makeItem({
    status: "photographed",
    measurements: { chest: 20 },
    has_required_photos: true,
    ...overrides,
  });
}

describe("nextAction — grading bridge (US-736)", () => {
  it("nudges grading once an item is photographed but not yet graded/priced", () => {
    const action = nextAction(photographed());
    expect(action.kind).toBe("grade");
    expect(action.tone).toBe("todo");
  });

  it("shows an in-flight state while the item is being graded", () => {
    const action = nextAction(photographed({ status: "grading" }));
    expect(action.kind).toBe("grading");
    expect(action.tone).toBe("muted"); // nothing to do but wait
  });

  it("surfaces a 'grade ready' nudge when the grade lands", () => {
    const action = nextAction(
      photographed({ status: "graded", grade_value: 8.5 }),
    );
    expect(action.kind).toBe("review_grade");
    expect(action.tone).toBe("ready");
  });

  it("skips the grading nudge for an already-graded item and goes to comp", () => {
    // Grade present but status moved on (e.g. user dismissed it back to prep).
    const action = nextAction(
      photographed({ status: "photographed", grade_value: 9 }),
    );
    expect(action.kind).toBe("comp");
  });

  it("does not regress earlier prep steps for a grading item missing photos", () => {
    const action = nextAction(
      makeItem({ status: "grading", measurements: null }),
    );
    // Status-driven grading state wins over the (incomplete) prep facts.
    expect(action.kind).toBe("grading");
  });
});

describe("resolveStatus — grading stays optional (US-736)", () => {
  it("never forces grading: a photographed item's earned status ignores grade", () => {
    const facts = factsOf(photographed());
    // earnedStatus tops out at "photographed" from completed work — grading
    // is opt-in, so a selected forward pick still resolves without grading.
    const resolved = resolveStatus(
      "photographed" as ItemStatus,
      "comped" as ItemStatus,
      facts,
    );
    expect(resolved).toBe("comped");
  });

  it("is forward-only: grading (rank 5) is not regressed by earned photographed", () => {
    const facts = factsOf(photographed({ status: "grading" }));
    const resolved = resolveStatus(
      "grading" as ItemStatus,
      "cataloged" as ItemStatus,
      facts,
    );
    expect(resolved).toBe("grading");
  });
});

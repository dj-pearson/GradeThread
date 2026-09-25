import { describe, it, expect } from "vitest";
import {
  binOf,
  candidateFor,
  candidatesFor,
  candidatesWithGates,
  MAX_HANDLING_DAYS,
  shipDeadlineOf,
  type CandidateContext,
} from "@/lib/work-candidates";
import type { ItemListRow } from "@/lib/item-list-columns";

// Worth My Time, R1 03/12 (US-3168).
//
// The fixtures are deliberately MINIMAL rows widened by cast rather than full
// ItemListRow literals. A full literal would be sixty columns of noise around
// the four that decide each case, and the next column added to the projection
// would break every fixture here for no reason.

function item(over: Partial<ItemListRow>): ItemListRow {
  return {
    id: "item-1",
    item_title: "Carhartt Detroit jacket",
    status: "cataloged",
    measurements: null,
    has_required_photos: false,
    target_price: null,
    listing_id: null,
    grade_value: null,
    location_bin: null,
    container: null,
    listing_platform: "ebay",
    sale_status: null,
    sale_cancelled_at: null,
    sale_date: null,
    ...over,
  } as unknown as ItemListRow;
}

const HOME: CandidateContext = {
  workContext: "home",
  availableTools: ["camera", "measuring_tape", "steamer", "packing_supplies"],
};
const PHONE: CandidateContext = { workContext: "phone_only", availableTools: [] };
// A seller on a bus WITH a tape measure in their bag. This fixture exists
// because a sabotage that removed the context check entirely left every test
// green: the plain PHONE context has no tools, so the TOOL rule was catching
// the physical tasks and the context rule was never the thing under test.
const PHONE_EQUIPPED: CandidateContext = {
  workContext: "phone_only",
  availableTools: ["camera", "measuring_tape", "steamer", "packing_supplies"],
};

describe("the prep ladder (AC3)", () => {
  it("offers each step in turn as the facts land", () => {
    expect(candidateFor(item({}), HOME)?.action).toBe("measure");
    expect(
      candidateFor(item({ measurements: { chest: 22 } }), HOME)?.action,
    ).toBe("photograph");
    expect(
      candidateFor(
        item({ measurements: { chest: 22 }, has_required_photos: true }),
        HOME,
      )?.action,
    ).toBe("price_research");
    expect(
      candidateFor(
        item({
          measurements: { chest: 22 },
          has_required_photos: true,
          target_price: 68,
        }),
        HOME,
      )?.action,
    ).toBe("draft_review");
    expect(
      candidateFor(
        item({
          measurements: { chest: 22 },
          has_required_photos: true,
          target_price: 68,
          listing_id: "listing-1",
        }),
        HOME,
      )?.action,
    ).toBe("publish");
  });

  it("offers packing on a sold item", () => {
    expect(candidateFor(item({ status: "sold" }), HOME)?.action).toBe("pack_ship");
  });

  it("offers a grade REVIEW without ever requiring a grade (AC1)", () => {
    // An item the seller chose to grade has a review waiting.
    expect(candidateFor(item({ status: "graded" }), HOME)?.action).toBe(
      "review_grade",
    );
    // But an ungraded item with photos and no price gets PRICING, not "grade
    // it". nextAction nudges toward grading there; treating that nudge as a
    // task is how optional grading becomes mandatory.
    const ungraded = candidateFor(
      item({ measurements: { chest: 22 }, has_required_photos: true }),
      HOME,
    );
    expect(ungraded?.action).toBe("price_research");
  });
});

describe("prerequisites come from the FACTS, not the status (AC2)", () => {
  it("names every step the item still owes", () => {
    // A seller dragged this to `drafted` by hand with nothing done.
    const c = candidateFor(item({ status: "drafted" }), HOME);
    expect(c?.action).toBe("measure");
    expect(c?.prerequisiteKeys).toEqual([]);
  });

  it("lists only the UNFINISHED steps above the action", () => {
    const c = candidateFor(
      item({
        measurements: { chest: 22 },
        has_required_photos: true,
        target_price: 68,
        listing_id: "listing-1",
      }),
      HOME,
    );
    expect(c?.action).toBe("publish");
    // Everything above it is done, so nothing is owed.
    expect(c?.prerequisiteKeys).toEqual([]);
  });

  it("a completed prerequisite drops out of the chain", () => {
    // Photos are in but measurements are not, and nextAction sends us to
    // measuring -- which owes nothing above it.
    const c = candidateFor(item({ has_required_photos: true }), HOME);
    expect(c?.action).toBe("measure");
    expect(c?.prerequisiteKeys).toEqual([]);
  });

  it("never lists grading as a prerequisite of anything (AC1)", () => {
    const rows = [
      item({ id: "a" }),
      item({ id: "b", status: "graded" }),
      item({ id: "c", measurements: { chest: 1 }, has_required_photos: true }),
    ];
    for (const c of candidatesFor(rows, HOME)) {
      expect(c.prerequisiteKeys.some((k) => k.endsWith(":review_grade"))).toBe(false);
    }
  });
});

describe("keys are stable (AC2)", () => {
  it("the same item and action produce the same key every run", () => {
    const a = candidateFor(item({ id: "item-9" }), HOME);
    const b = candidateFor(item({ id: "item-9" }), HOME);
    expect(a?.key).toBe("item-9:measure");
    expect(a?.key).toBe(b?.key);
  });
});

describe("exclusions (AC4)", () => {
  it("skips stock the seller took out of the pipeline", () => {
    for (const status of ["archived", "keeping", "wearing", "completed"] as const) {
      expect(candidateFor(item({ status }), HOME)).toBeNull();
    }
  });

  it("skips a job already running", () => {
    // Offering "grade it" mid-grade would have the seller queue a second one.
    expect(candidateFor(item({ status: "grading" }), HOME)).toBeNull();
  });

  it("skips an item awaiting a buyer", () => {
    // The listing is live; the next event comes from somebody else.
    expect(candidateFor(item({ status: "listed" }), HOME)).toBeNull();
  });

  it("skips a cancelled or refunded sale even while the item reads sold", () => {
    for (const sale_status of ["cancelled", "refunded"] as const) {
      expect(candidateFor(item({ status: "sold", sale_status }), HOME)).toBeNull();
    }
    expect(
      candidateFor(
        item({ status: "sold", sale_cancelled_at: "2026-09-01T00:00:00Z" }),
        HOME,
      ),
    ).toBeNull();
  });

  it("does NOT treat every returned item as ready to relist (AC4)", () => {
    // With a supported channel and without one, a returned item is still not a
    // task in R1: "relist or write off" is a decision, and mapping it to
    // publish would relist at the old price with no review.
    expect(candidateFor(item({ status: "returned" }), HOME)).toBeNull();
    expect(
      candidateFor(item({ status: "returned", listing_platform: "offerup" }), HOME),
    ).toBeNull();
  });

  it("skips publishing to a channel with no supported flow (AC3)", () => {
    const ready = {
      measurements: { chest: 22 },
      has_required_photos: true,
      target_price: 68,
      listing_id: "listing-1",
    };
    // whatnot is mechanism `none`: every adapter method is notImplemented.
    expect(
      candidateFor(item({ ...ready, listing_platform: "whatnot" }), HOME),
    ).toBeNull();
    // ...and an extension channel IS a supported flow, so it stays.
    expect(
      candidateFor(item({ ...ready, listing_platform: "poshmark" }), HOME)?.action,
    ).toBe("publish");
  });
});

describe("context and tools (AC4)", () => {
  it("drops physical work on a phone", () => {
    expect(candidateFor(item({}), PHONE)).toBeNull();
  });

  it("WMT-06: a paid parcel is never dropped, whatever the setup", () => {
    // It goes through to the ranker, which flags it (wrong_context or
    // tools_missing) so the seller SEES the parcel they cannot ship tonight.
    expect(candidateFor(item({ status: "sold" }), PHONE)?.action).toBe("pack_ship");
    expect(
      candidateFor(item({ status: "sold" }), { workContext: "home", availableTools: [] })
        ?.action,
    ).toBe("pack_ship");
  });

  it("drops physical work on a phone EVEN WITH every tool in the bag", () => {
    // The context rule on its own. A tape measure on a bus does not help with
    // a garment that is at home, and this is the case that proves the rule is
    // the context rather than the tools.
    expect(candidateFor(item({}), PHONE_EQUIPPED)).toBeNull();
    expect(
      candidateFor(item({ measurements: { chest: 22 } }), PHONE_EQUIPPED),
    ).toBeNull();
    // ...and screen work is still offered to that same seller.
    expect(candidateFor(item({ status: "graded" }), PHONE_EQUIPPED)?.action)
      .toBe("review_grade");
  });

  it("keeps screen work on a phone", () => {
    expect(candidateFor(item({ status: "graded" }), PHONE)?.action).toBe(
      "review_grade",
    );
    expect(
      candidateFor(
        item({ measurements: { chest: 22 }, has_required_photos: true }),
        PHONE,
      )?.action,
    ).toBe("price_research");
  });

  it("drops a task whose tool the seller does not have", () => {
    const noTape: CandidateContext = {
      workContext: "home",
      availableTools: ["camera", "packing_supplies"],
    };
    expect(candidateFor(item({}), noTape)).toBeNull();
    // ...and the next task down the ladder is still offered to them.
    expect(
      candidateFor(item({ measurements: { chest: 22 } }), noTape)?.action,
    ).toBe("photograph");
  });

  it("a missing tool is not partial possibility", () => {
    const nothing: CandidateContext = { workContext: "home", availableTools: [] };
    expect(candidateFor(item({}), nothing)).toBeNull();
    expect(candidateFor(item({ measurements: { chest: 22 } }), nothing)).toBeNull();
  });

  it("WMT-06: work held back by the setup is COUNTED, with the tool it needs", () => {
    const cameraOnly: CandidateContext = { workContext: "home", availableTools: ["camera"] };
    const r = candidatesWithGates(
      [
        item({ id: "a" }),
        item({ id: "b" }),
        item({ id: "c", measurements: { chest: 22 } }),
        item({ id: "d", status: "sold" }),
      ],
      cameraOnly,
    );
    expect(r.candidates.map((c) => c.key)).toEqual(["c:photograph", "d:pack_ship"]);
    expect(r.gated).toEqual([
      { itemId: "a", action: "measure", reason: "tools", missing: ["measuring_tape"] },
      { itemId: "b", action: "measure", reason: "tools", missing: ["measuring_tape"] },
    ]);
    // Away from the table the physical work is gated on context, not tools.
    const away = candidatesWithGates([item({ id: "a" })], PHONE_EQUIPPED);
    expect(away.gated).toEqual([
      { itemId: "a", action: "measure", reason: "context", missing: [] },
    ]);
  });
});

describe("the bin (AC2)", () => {
  it("prefers location_bin, falls back to container, and admits unknown", () => {
    expect(binOf({ location_bin: "A-14", container: "Tote 3" } as ItemListRow))
      .toEqual({ value: "A-14", source: "location_bin" });
    expect(binOf({ location_bin: null, container: "Tote 3" } as ItemListRow))
      .toEqual({ value: "Tote 3", source: "container" });
    expect(binOf({ location_bin: null, container: null } as ItemListRow))
      .toEqual({ value: null, source: "unknown" });
  });

  it("whitespace is not a location", () => {
    // A seller sent to the wrong shelf loses more time than one told to look.
    expect(binOf({ location_bin: "   ", container: "  " } as ItemListRow))
      .toEqual({ value: null, source: "unknown" });
  });
});

describe("the shipping deadline (AC5)", () => {
  it("the marketplace's own date is CONFIRMED", () => {
    expect(
      shipDeadlineOf({ shipByDate: "2026-09-24T17:00:00Z", soldAt: "2026-09-21T00:00:00Z", handlingDays: 1 }),
    ).toEqual({ at: "2026-09-24T17:00:00.000Z", confidence: "confirmed" });
  });

  it("a derived date is labelled ESTIMATED, never confirmed", () => {
    const d = shipDeadlineOf({ soldAt: "2026-09-21T10:00:00Z", handlingDays: 2 });
    expect(d.confidence).toBe("estimated");
    expect(d.at).toBe("2026-09-23T10:00:00.000Z");
  });

  it("zero handling days is a real answer: ships the same day", () => {
    const d = shipDeadlineOf({ soldAt: "2026-09-21T10:00:00Z", handlingDays: 0 });
    expect(d.confidence).toBe("estimated");
    expect(d.at).toBe("2026-09-21T10:00:00.000Z");
  });

  it("no inputs is UNKNOWN, and no three-day window is invented (AC5)", () => {
    // The temptation is a default of "three days from sale", which puts a
    // countdown and eventually a red badge on orders nobody is late on.
    expect(shipDeadlineOf({})).toEqual({ at: null, confidence: "unknown" });
    expect(shipDeadlineOf({ soldAt: "2026-09-21T10:00:00Z" }))
      .toEqual({ at: null, confidence: "unknown" });
  });

  it("an absurd handling time is refused rather than sorted to the bottom", () => {
    expect(shipDeadlineOf({ soldAt: "2026-09-21T10:00:00Z", handlingDays: MAX_HANDLING_DAYS + 1 }).confidence)
      .toBe("unknown");
    expect(shipDeadlineOf({ soldAt: "2026-09-21T10:00:00Z", handlingDays: -1 }).confidence)
      .toBe("unknown");
  });

  it("crosses a timezone boundary without shifting the day (AC6)", () => {
    // A sale at 23:30 UTC on the 21st with one handling day is the 22nd at
    // 23:30 UTC. Date-only arithmetic would land on the 22nd at midnight and
    // be half a day early, or on the 23rd and be a day late.
    const d = shipDeadlineOf({ soldAt: "2026-09-21T23:30:00Z", handlingDays: 1 });
    expect(d.at).toBe("2026-09-22T23:30:00.000Z");
    // ...and an offset-carrying input is normalized rather than truncated.
    const offset = shipDeadlineOf({ soldAt: "2026-09-21T20:30:00-05:00", handlingDays: 1 });
    expect(offset.at).toBe("2026-09-23T01:30:00.000Z");
  });

  it("a shipping task reads the SALE's facts, not the item's date", () => {
    const sold = item({ id: "item-7", status: "sold", sale_date: "2026-09-21T10:00:00Z" });
    // With no sale facts injected, there is no handling time, so unknown.
    expect(candidateFor(sold, HOME)?.shipBy).toEqual({ at: null, confidence: "unknown" });
    // With eBay's own answer, confirmed.
    const withFacts: CandidateContext = {
      ...HOME,
      saleFacts: { "item-7": { shipByDate: "2026-09-23T17:00:00Z" } },
    };
    expect(candidateFor(sold, withFacts)?.shipBy).toEqual({
      at: "2026-09-23T17:00:00.000Z",
      confidence: "confirmed",
    });
  });

  it("a non-shipping task carries no deadline at all", () => {
    // A deadline belongs to a sale. One on a measuring task would sort unsold
    // stock into a queue that is about orders.
    expect(candidateFor(item({}), HOME)?.shipBy)
      .toEqual({ at: null, confidence: "unknown" });
  });
});

describe("partial item data (AC6)", () => {
  it("survives a row with almost nothing on it", () => {
    const bare = { id: "x", status: "cataloged" } as unknown as ItemListRow;
    const c = candidateFor(bare, HOME);
    expect(c?.action).toBe("measure");
    expect(c?.itemTitle).toBeNull();
    expect(c?.bin).toEqual({ value: null, source: "unknown" });
  });

  it("an unrecognised status falls through to the prep ladder, as the GRID does", () => {
    // Written expecting null, and that was the wrong expectation. nextAction
    // has no allowlist: anything it does not recognise drops into the prep
    // ladder and reads as "add measurements", which is what the item card
    // shows too.
    //
    // KEPT RATHER THAN FIXED, and the reason is AC1. Adding a known-status
    // allowlist here would be a second source of truth about statuses, and the
    // planner would then disagree with the badge on the card about the same
    // garment. `status` is a Postgres enum, so an unrecognised value cannot
    // reach this from the database at all -- only from a hand-built row like
    // this one. The agreement is worth more than the guard.
    expect(candidateFor(item({ status: "teleporting" as ItemListRow["status"] }), HOME)?.action).toBe(
      "measure",
    );
  });
});

describe("candidatesFor", () => {
  it("keeps item order and drops what is not work", () => {
    const rows = [
      item({ id: "a" }),
      item({ id: "b", status: "archived" }),
      item({ id: "c", status: "sold" }),
      item({ id: "d", status: "listed" }),
    ];
    expect(candidatesFor(rows, HOME).map((c) => c.key)).toEqual([
      "a:measure",
      "c:pack_ship",
    ]);
  });
});

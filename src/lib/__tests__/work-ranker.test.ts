import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  chainMinutesFor,
  RANKER_VERSION,
  rankWork,
  URGENT_WINDOW_HOURS,
  type RankInput,
  type RankTaskInput,
} from "@/lib/work-ranker";
import {
  candidateFor,
  remainingStepsFrom,
  type CandidateAction,
  type WorkCandidate,
} from "@/lib/work-candidates";
import type { ItemListRow } from "@/lib/item-list-columns";
import { estimateWorkValue, type ValueResult } from "@/lib/work-value";

// Worth My Time, R1 06/12 (US-3171).
//
// Table-driven, because the failures this ranker exists to prevent are all
// about ORDER between two specific tasks, and a table is the shape that says
// which two and why.

const NOW = "2026-09-21T12:00:00Z";
const hoursFromNow = (h: number) =>
  new Date(Date.parse(NOW) + h * 3_600_000).toISOString();

function candidate(over: Partial<WorkCandidate> & { itemId: string; action: CandidateAction }): WorkCandidate {
  return {
    key: `${over.itemId}:${over.action}`,
    itemTitle: null,
    prerequisiteKeys: [],
    requiredContext: over.action === "pack_ship" || over.action === "measure" ||
        over.action === "photograph"
      ? ["home"]
      : ["home", "phone_only"],
    requiredTools: over.action === "pack_ship"
      ? ["packing_supplies"]
      : over.action === "measure"
      ? ["measuring_tape"]
      : over.action === "photograph"
      ? ["camera"]
      : [],
    completionEvidence: "",
    bin: { value: null, source: "unknown" },
    shipBy: { at: null, confidence: "unknown" },
    ...over,
  } as WorkCandidate;
}

function valueOf(amountCents: number): ValueResult {
  return estimateWorkValue({
    marketplace: "ebay",
    evidence: { amountCents, source: "sold_comp", observedAt: "2026-09-01T00:00:00Z" },
    purchaseCents: 1000,
    shippingCents: 900,
    suppliesCents: 100,
  });
}

const NO_EVIDENCE: ValueResult = estimateWorkValue({
  marketplace: "ebay",
  evidence: null,
});
const UNSUPPORTED: ValueResult = estimateWorkValue({
  marketplace: "poshmark",
  evidence: { amountCents: 8000, source: "sold_comp", observedAt: null },
});

function plan(tasks: RankTaskInput[], over: Partial<RankInput> = {}) {
  return rankWork({
    now: NOW,
    budgetMinutes: 60,
    workContext: "home",
    availableTools: ["camera", "measuring_tape", "steamer", "packing_supplies"],
    hourlyTargetCents: null,
    tasks,
    ...over,
  });
}

describe("urgent shipping goes first, even when it earns least (AC2, AC5)", () => {
  it("a $2 parcel due in two hours beats a $200 prep item", () => {
    // The headline failure this file exists to prevent. Missing a ship-by
    // costs a defect on the seller's account, not a margin.
    const order = plan([
      {
        candidate: candidate({ itemId: "rich", action: "photograph" }),
        value: valueOf(20000),
        remainingActions: ["photograph", "price_research", "draft_review", "publish"],
      },
      {
        candidate: candidate({
          itemId: "parcel",
          action: "pack_ship",
          shipBy: { at: hoursFromNow(2), confidence: "confirmed" },
        }),
        value: valueOf(1200),
        remainingActions: ["pack_ship"],
      },
    ]).map((t) => t.key);
    expect(order).toEqual(["parcel:pack_ship", "rich:photograph"]);
  });

  it("an estimated deadline does not jump a CONFIRMED one inside the window", () => {
    // WMT-13: every unshipped sale is in the urgent tier now. What an
    // estimated date still may not do is outrank a date eBay named: it counts
    // calendar days rather than business days and can be a day early.
    const order = plan([
      {
        candidate: candidate({
          itemId: "guess",
          action: "pack_ship",
          shipBy: { at: hoursFromNow(2), confidence: "estimated" },
        }),
        value: valueOf(1200),
        remainingActions: ["pack_ship"],
      },
      {
        candidate: candidate({
          itemId: "named",
          action: "pack_ship",
          shipBy: { at: hoursFromNow(6), confidence: "confirmed" },
        }),
        value: valueOf(1200),
        remainingActions: ["pack_ship"],
      },
    ]);
    expect(order.map((t) => t.tier)).toEqual(["urgent_shipping", "urgent_shipping"]);
    expect(order.map((t) => t.key)).toEqual(["named:pack_ship", "guess:pack_ship"]);
  });

  it("a sale due beyond the window still goes above valued prep work (WMT-13)", () => {
    const order = plan([
      {
        candidate: candidate({ itemId: "rich", action: "photograph" }),
        value: valueOf(20000),
        remainingActions: ["photograph"],
      },
      {
        candidate: candidate({
          itemId: "later",
          action: "pack_ship",
          shipBy: { at: hoursFromNow(URGENT_WINDOW_HOURS + 1), confidence: "confirmed" },
        }),
        value: valueOf(5000),
        remainingActions: ["pack_ship"],
      },
    ]);
    expect(order.map((t) => t.key)).toEqual(["later:pack_ship", "rich:photograph"]);
    expect(order[0]!.tier).toBe("urgent_shipping");
  });

  it("an unshipped sale with NO deadline at all is still first (WMT-13)", () => {
    const order = plan([
      {
        candidate: candidate({ itemId: "rich", action: "photograph" }),
        value: valueOf(20000),
        remainingActions: ["photograph"],
      },
      {
        candidate: candidate({ itemId: "sold", action: "pack_ship" }),
        value: valueOf(1200),
        remainingActions: ["pack_ship"],
      },
    ]);
    expect(order[0]!.key).toBe("sold:pack_ship");
  });

  it("a confirmed ship-by tomorrow sorts ahead of an undated parcel (WMT-13)", () => {
    const order = plan([
      {
        candidate: candidate({ itemId: "undated", action: "pack_ship" }),
        value: valueOf(1200),
        remainingActions: ["pack_ship"],
      },
      {
        candidate: candidate({
          itemId: "tomorrow",
          action: "pack_ship",
          shipBy: { at: hoursFromNow(20), confidence: "confirmed" },
        }),
        value: valueOf(1200),
        remainingActions: ["pack_ship"],
      },
    ]).map((t) => t.key);
    expect(order).toEqual(["tomorrow:pack_ship", "undated:pack_ship"]);
  });

  it("an OVERDUE parcel is urgent and sorts before a merely soon one", () => {
    const order = plan([
      {
        candidate: candidate({
          itemId: "soon",
          action: "pack_ship",
          shipBy: { at: hoursFromNow(6), confidence: "confirmed" },
        }),
        value: valueOf(5000),
        remainingActions: ["pack_ship"],
      },
      {
        candidate: candidate({
          itemId: "late",
          action: "pack_ship",
          shipBy: { at: hoursFromNow(-30), confidence: "confirmed" },
        }),
        value: valueOf(1200),
        remainingActions: ["pack_ship"],
      },
    ]).map((t) => t.key);
    expect(order).toEqual(["late:pack_ship", "soon:pack_ship"]);
  });
});

describe("a conflict is SHOWN, never dropped (AC2)", () => {
  it("an urgent parcel with no packing supplies stays at the top, flagged", () => {
    // The seller most needs to see the parcel they cannot ship. Hiding it
    // would let them find out from the marketplace instead.
    const ranked = plan(
      [
        {
          candidate: candidate({
            itemId: "parcel",
            action: "pack_ship",
            shipBy: { at: hoursFromNow(3), confidence: "confirmed" },
          }),
          value: valueOf(4000),
          remainingActions: ["pack_ship"],
        },
      ],
      { availableTools: ["camera"] },
    );
    expect(ranked[0]!.tier).toBe("urgent_shipping");
    expect(ranked[0]!.conflict?.kind).toBe("tools_missing");
    expect(ranked[0]!.conflict?.message).toContain("packing supplies");
  });

  it("a task that cannot fit the budget is flagged rather than removed", () => {
    const ranked = plan(
      [
        {
          candidate: candidate({ itemId: "long", action: "photograph" }),
          value: valueOf(8000),
          remainingActions: ["photograph"],
        },
      ],
      { budgetMinutes: 5 },
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.conflict?.kind).toBe("cannot_fit");
  });

  it("the wrong context is a conflict, not a disappearance", () => {
    const ranked = plan(
      [
        {
          candidate: candidate({
            itemId: "parcel",
            action: "pack_ship",
            shipBy: { at: hoursFromNow(3), confidence: "confirmed" },
          }),
          value: valueOf(4000),
          remainingActions: ["pack_ship"],
        },
      ],
      { workContext: "phone_only" },
    );
    expect(ranked[0]!.conflict?.kind).toBe("wrong_context");
  });
});

describe("one item is one sale (AC3)", () => {
  it("every step of an item scores the same rate", () => {
    // Scoring each step against the item's value would make a $50 jacket look
    // like $200 of opportunity and beat four garments really worth $50 each.
    const chain: CandidateAction[] = ["measure", "photograph", "price_research", "draft_review"];
    const scores = plan(
      chain.map((action) => ({
        candidate: candidate({ itemId: "one", action }),
        value: valueOf(8000),
        remainingActions: chain,
      })),
    ).map((t) => t.score);
    expect(new Set(scores).size).toBe(1);
  });

  it("four steps of one item do not outweigh four separate items", () => {
    const chain: CandidateAction[] = ["measure", "photograph", "price_research", "draft_review"];
    const oneItem = plan(
      chain.map((action) => ({
        candidate: candidate({ itemId: "one", action }),
        value: valueOf(8000),
        remainingActions: chain,
      })),
    );
    const fourItems = plan(
      ["a", "b", "c", "d"].map((id) => ({
        candidate: candidate({ itemId: id, action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
      })),
    );
    // Four nearly-finished items each rank far above any step of the one that
    // still needs the whole ladder.
    expect(fourItems[0]!.score!).toBeGreaterThan(oneItem[0]!.score!);
  });
});

describe("the chain, not the next step (AC3)", () => {
  it("a two-minute step on a long chain loses to a longer step near the end", () => {
    // The misleading short next step. `publish` takes 2 minutes and `measure`
    // takes 5, but an item that only needs publishing is minutes from money
    // and one that needs the whole ladder is not.
    const order = plan([
      {
        candidate: candidate({ itemId: "far", action: "publish" }),
        value: valueOf(8000),
        // A hand-set status can leave an item owing everything and still
        // pointing at publish.
        remainingActions: ["measure", "photograph", "price_research", "draft_review", "publish"],
      },
      {
        candidate: candidate({ itemId: "near", action: "measure" }),
        value: valueOf(8000),
        remainingActions: ["measure"],
      },
    ]).map((t) => t.key);
    expect(order).toEqual(["near:measure", "far:publish"]);
  });

  it("chainMinutesFor sums the whole ladder and refuses an unknown step", () => {
    expect(chainMinutesFor(["measure"])).toBe(5);
    expect(chainMinutesFor(["measure", "photograph"])).toBe(13);
    // An unestimated step makes the whole chain unestimated rather than being
    // skipped, because skipping would understate the chain and inflate the
    // rate -- the direction that wastes an evening.
    expect(chainMinutesFor(["measure", "fly_to_mars" as CandidateAction])).toBeNull();
    expect(chainMinutesFor([])).toBe(0);
  });
});

describe("missing and negative value (AC6)", () => {
  it("an item with no price evidence gets exactly one research slot", () => {
    // Unknown-value stock must not be ignored forever, and must not flood a
    // plan either: a seller whose whole evening became price research would
    // have been better off without us.
    const ranked = plan(
      ["a", "b", "c"].map((id) => ({
        candidate: candidate({ itemId: id, action: "price_research" }),
        value: NO_EVIDENCE,
        remainingActions: ["price_research"],
        unfinishedSince: `2026-09-0${id === "a" ? 1 : id === "b" ? 2 : 3}T00:00:00Z`,
      })),
    );
    expect(ranked.filter((t) => t.tier === "research")).toHaveLength(1);
    expect(ranked.filter((t) => t.tier === "unvalued")).toHaveLength(2);
    // The oldest unfinished one gets the slot, not whichever was first in.
    expect(ranked.find((t) => t.tier === "research")!.key).toBe("a:price_research");
  });

  it("research sits below urgent work and above unrankable work", () => {
    const tiers = plan([
      {
        candidate: candidate({ itemId: "unknown", action: "price_research" }),
        value: NO_EVIDENCE,
        remainingActions: ["price_research"],
      },
      {
        candidate: candidate({
          itemId: "parcel",
          action: "pack_ship",
          shipBy: { at: hoursFromNow(2), confidence: "confirmed" },
        }),
        value: valueOf(3000),
        remainingActions: ["pack_ship"],
      },
      {
        candidate: candidate({ itemId: "posh", action: "draft_review" }),
        value: UNSUPPORTED,
        remainingActions: ["draft_review"],
      },
    ]).map((t) => t.tier);
    expect(tiers).toEqual(["urgent_shipping", "research", "unvalued"]);
  });

  it("an item nobody can value is kept at the bottom, not hidden", () => {
    // A seller who cannot see it cannot fix it.
    const ranked = plan([
      {
        candidate: candidate({ itemId: "posh", action: "draft_review" }),
        value: UNSUPPORTED,
        remainingActions: ["draft_review"],
      },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.tier).toBe("unvalued");
    expect(ranked[0]!.score).toBeNull();
  });

  it("a negative contribution ranks last among valued work but stays visible", () => {
    const order = plan([
      {
        candidate: candidate({ itemId: "loss", action: "draft_review" }),
        value: valueOf(400),
        remainingActions: ["draft_review"],
      },
      {
        candidate: candidate({ itemId: "gain", action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
      },
    ]);
    expect(order.map((t) => t.key)).toEqual(["gain:draft_review", "loss:draft_review"]);
    expect(order[1]!.score!).toBeLessThan(0);
  });
});

describe("the hourly target is advisory (AC4)", () => {
  it("no target still produces a full plan, with null rather than false", () => {
    // A seller with no target has not FAILED to meet it.
    const ranked = plan([
      {
        candidate: candidate({ itemId: "a", action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
      },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.meetsHourlyTarget).toBeNull();
  });

  it("a target flags tasks without reordering them", () => {
    const tasks: RankTaskInput[] = [
      {
        candidate: candidate({ itemId: "low", action: "draft_review" }),
        value: valueOf(2000),
        remainingActions: ["draft_review"],
      },
      {
        candidate: candidate({ itemId: "high", action: "draft_review" }),
        value: valueOf(9000),
        remainingActions: ["draft_review"],
      },
    ];
    // $200/hour. The high item runs at about $727/hour of remaining work and
    // the low one at about $74, so the target lands between them -- which is
    // the only placement that tests anything. A target above both, or below
    // both, would pass against a function that always answered the same way.
    const without = plan(tasks).map((t) => t.key);
    const withTarget = plan(tasks, { hourlyTargetCents: 20000 });
    expect(withTarget.map((t) => t.key)).toEqual(without);
    expect(withTarget.find((t) => t.key === "high:draft_review")!.meetsHourlyTarget).toBe(true);
    expect(withTarget.find((t) => t.key === "low:draft_review")!.meetsHourlyTarget).toBe(false);
  });
});

describe("deterministic ties (AC1)", () => {
  it("the comparator never READS the target, and a behavioural test cannot show it", () => {
    // Found by a sabotage that did not fire. Making meetsHourlyTarget reorder
    // the valued tier left every case green, and the reason is arithmetic:
    // the flag is a threshold ON the score, so grouping by it can never
    // invert score order within that tier. Sorting by it is behaviourally
    // identical TODAY.
    //
    // It is still wrong, and it is a trap with a fuse on it. The moment the
    // target stops being a pure threshold -- a per-family target, a
    // minimum-session-value rule, anything in R2 -- a comparator that reads
    // the field starts silently filtering work the seller never asked it to
    // filter. So this is a structural guard, which is the only kind that can
    // see the difference.
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-ranker.ts"), "utf8");
    const from = src.indexOf("function compareRanked");
    expect(from).toBeGreaterThan(-1);
    const body = src.slice(from, src.indexOf("function sinceOf"));
    expect(body).not.toMatch(/meetsHourlyTarget|hourlyTarget/);
  });


  it("equal scores break on due time, then age, then key", () => {
    const tasks: RankTaskInput[] = [
      {
        candidate: candidate({ itemId: "zzz", action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
        unfinishedSince: "2026-09-05T00:00:00Z",
      },
      {
        candidate: candidate({ itemId: "aaa", action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
        unfinishedSince: "2026-09-01T00:00:00Z",
      },
      {
        candidate: candidate({ itemId: "mmm", action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
        unfinishedSince: "2026-09-01T00:00:00Z",
      },
    ];
    // Same score and no due date, so: oldest first, then the key.
    expect(plan(tasks).map((t) => t.key)).toEqual([
      "aaa:draft_review",
      "mmm:draft_review",
      "zzz:draft_review",
    ]);
  });

  it("work whose age nobody recorded sorts last among ties, not first", () => {
    const tasks: RankTaskInput[] = [
      {
        candidate: candidate({ itemId: "aaa", action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
      },
      {
        candidate: candidate({ itemId: "zzz", action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
        unfinishedSince: "2026-09-01T00:00:00Z",
      },
    ];
    expect(plan(tasks).map((t) => t.key)).toEqual([
      "zzz:draft_review",
      "aaa:draft_review",
    ]);
  });

  it("the same input ranks the same way, input order notwithstanding", () => {
    const build = (ids: string[]): RankTaskInput[] =>
      ids.map((id) => ({
        candidate: candidate({ itemId: id, action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
        unfinishedSince: "2026-09-01T00:00:00Z",
      }));
    expect(plan(build(["a", "b", "c"])).map((t) => t.key))
      .toEqual(plan(build(["c", "a", "b"])).map((t) => t.key));
  });

  it("stamps the ranker version on every task", () => {
    const ranked = plan([
      {
        candidate: candidate({ itemId: "a", action: "draft_review" }),
        value: valueOf(8000),
        remainingActions: ["draft_review"],
      },
    ]);
    expect(ranked[0]!.version).toBe(RANKER_VERSION);
  });
});

describe("a score is a priority, not a payday (AC5)", () => {
  it("invents no sale probability", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-ranker.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    for (const banned of ["probability", "sellThrough", "likelihood", "expectedProfit"]) {
      expect(code.includes(banned), `work-ranker.ts uses ${banned}`).toBe(false);
    }
  });

  it("reads no clock: `now` is an argument", () => {
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-ranker.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    for (const banned of ["Date.now", "new Date(", "Math.random", "fetch("]) {
      expect(code.includes(banned), `work-ranker.ts uses ${banned}`).toBe(false);
    }
  });
});

describe("the whole chain to sale-ready (WMT-05)", () => {
  function row(over: Record<string, unknown>): ItemListRow {
    return {
      id: "x",
      item_title: "Jacket",
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
  const HOME = {
    workContext: "home" as const,
    availableTools: ["camera", "measuring_tape", "steamer", "packing_supplies"] as never,
  };

  it("counts every later step the item still owes, not just this one", () => {
    expect(remainingStepsFrom(row({}), "measure")).toEqual([
      "measure", "photograph", "price_research", "draft_review", "publish",
    ]);
    // Priced and drafted already: only the photos and the publish are left.
    expect(
      remainingStepsFrom(
        row({ measurements: { chest: 22 }, target_price: 40, listing_id: "l1" }),
        "photograph",
      ),
    ).toEqual(["photograph", "publish"]);
    // Off the chain: just itself.
    expect(remainingStepsFrom(row({}), "pack_ship")).toEqual(["pack_ship"]);
  });

  it("an item two steps from listing outranks one five steps away, at equal value", () => {
    // The near item's NEXT step (photograph, 8 min) is longer than the far
    // item's (measure, 5 min). Scored on the next step alone the far item
    // won; divided by the whole chain, the near one does.
    const near = candidateFor(
      row({ id: "near", measurements: { chest: 22 }, target_price: 40, listing_id: "l1" }),
      HOME,
    )!;
    const far = candidateFor(row({ id: "far" }), HOME)!;
    expect(near.action).toBe("photograph");
    expect(far.action).toBe("measure");
    const order = plan([
      { candidate: far, value: valueOf(8000), remainingActions: far.remainingActions },
      { candidate: near, value: valueOf(8000), remainingActions: near.remainingActions },
    ]).map((t) => t.key);
    expect(order).toEqual(["near:photograph", "far:measure"]);
  });

  it("keeps the value snapshot and its source on the ranked task", () => {
    const [r] = plan([{
      candidate: candidate({ itemId: "a", action: "measure" }),
      value: valueOf(8000),
      remainingActions: ["measure"],
    }]);
    expect(r!.valueSource).toBe("sold_comp");
    expect(r!.value.complete).toBe(true);
    expect(r!.valueFromOverride).toBe(false);
  });
});

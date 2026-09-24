import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BATCHING_VERSION,
  batchWork,
  UNKNOWN_BIN_LABEL,
  type BatchInput,
} from "@/lib/work-batching";
import { schedulePlan } from "@/lib/work-scheduler";
import { rankedDurationOf, type RankedTask } from "@/lib/work-ranker";
import { estimateDuration } from "@/lib/work-duration";
import type { CandidateAction } from "@/lib/work-candidates";

// Worth My Time, R1 08/12 (US-3173).

/**
 * Source with every comment removed.
 *
 * BLOCK COMMENTS ARE STRIPPED AS BLOCKS, not line by line. A filter that only
 * drops lines starting with `//` or `*` leaves the opening `/**` line of a
 * JSDoc in place, so a scan for a banned word finds it inside the very comment
 * that explains why the word is banned. That happened on the first run of the
 * route test below, and it is the third time this session a guard has failed
 * on its own reasoning.
 */
function codeOf(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

function ranked(over: Partial<RankedTask> & { key: string; action: CandidateAction }): RankedTask {
  return {
    itemId: over.key.split(":")[0]!,
    tier: "valued_work",
    score: 100,
    chainMinutes: 10,
    conservativeCents: 1000,
    dueAt: null,
    prerequisiteKeys: [],
    conflict: null,
    meetsHourlyTarget: null,
    version: 1,
    // WMT-04: the scheduler reads the ranker's resolved duration.
    duration: rankedDurationOf(estimateDuration({ action: over.action })),
    ...over,
  } as RankedTask;
}

function batch(tasks: RankedTask[], binOf: BatchInput["binOf"] = {}) {
  return batchWork({ ranked: tasks, binOf });
}

describe("items in one bin travel together (AC1)", () => {
  it("pulls the same-bin photography into one contiguous run", () => {
    // Interleaved on arrival: A-14, B-02, A-14. The seller should not walk to
    // A-14, then B-02, then back.
    const out = batch(
      [
        ranked({ key: "x:photograph", action: "photograph" }),
        ranked({ key: "y:photograph", action: "photograph" }),
        ranked({ key: "z:photograph", action: "photograph" }),
      ],
      { x: "A-14", y: "B-02", z: "A-14" },
    );
    expect(out.ordered.map((t) => t.key)).toEqual([
      "x:photograph",
      "z:photograph",
      "y:photograph",
    ]);
    expect(out.groups.map((g) => g.taskKeys)).toEqual([
      ["x:photograph", "z:photograph"],
      ["y:photograph"],
    ]);
  });

  it("groups are ordered by their BEST member, so the top work still leads", () => {
    // B-02 holds the best-ranked item, so its group leads even though A-14 has
    // two items in it. Convenience does not outrank the ranker.
    const out = batch(
      [
        ranked({ key: "best:photograph", action: "photograph" }),
        ranked({ key: "x:photograph", action: "photograph" }),
        ranked({ key: "z:photograph", action: "photograph" }),
      ],
      { best: "B-02", x: "A-14", z: "A-14" },
    );
    expect(out.groups[0]!.bin).toBe("B-02");
  });

  it("different families never merge, even in one bin", () => {
    const out = batch(
      [
        ranked({ key: "x:photograph", action: "photograph" }),
        ranked({ key: "x2:measure", action: "measure" }),
      ],
      { x: "A-14", x2: "A-14" },
    );
    expect(out.groups).toHaveLength(2);
    expect(out.groups.map((g) => g.family)).toEqual(["photo", "measure"]);
  });
});

describe("a bin is a label, not a coordinate (AC3)", () => {
  it("computes no route and claims no distance", () => {
    // Two bins called A-14 and A-15 may be in different rooms. A planner that
    // invented a walking order would send sellers the wrong way round their
    // own garage, confidently.
    const code = codeOf("src/lib/work-batching.ts");
    for (const banned of ["distance", "route", "nearest", "walkOrder", "proximity"]) {
      expect(code.includes(banned), `work-batching.ts mentions ${banned}`).toBe(false);
    }
  });

  it("an unrecorded bin says so rather than guessing", () => {
    const out = batch([ranked({ key: "x:photograph", action: "photograph" })], {});
    expect(out.pullList[0]!.bin).toBeNull();
    expect(out.pullList[0]!.label).toBe(UNKNOWN_BIN_LABEL);
  });

  it("blank and whitespace bins are not locations", () => {
    const out = batch(
      [
        ranked({ key: "x:photograph", action: "photograph" }),
        ranked({ key: "y:photograph", action: "photograph" }),
      ],
      { x: "  ", y: "" },
    );
    // Both unrecorded, so they share the one unknown group rather than
    // becoming two bins called "  " and "".
    expect(out.groups).toHaveLength(1);
    expect(out.pullList).toHaveLength(1);
    expect(out.pullList[0]!.label).toBe(UNKNOWN_BIN_LABEL);
  });

  it("items with no bin still batch by family", () => {
    const out = batch(
      [
        ranked({ key: "x:photograph", action: "photograph" }),
        ranked({ key: "y:measure", action: "measure" }),
        ranked({ key: "z:photograph", action: "photograph" }),
      ],
      {},
    );
    expect(out.ordered.map((t) => t.key)).toEqual([
      "x:photograph",
      "z:photograph",
      "y:measure",
    ]);
  });
});

describe("urgency outranks convenience (AC2)", () => {
  it("an urgent shipment in a far bin still goes first", () => {
    const out = batch(
      [
        ranked({ key: "x:photograph", action: "photograph" }),
        ranked({ key: "z:photograph", action: "photograph" }),
        ranked({
          key: "urgent:pack_ship",
          action: "pack_ship",
          tier: "urgent_shipping",
          dueAt: "2026-09-21T14:00:00Z",
        }),
      ],
      { x: "A-14", z: "A-14", urgent: "Z-99" },
    );
    expect(out.ordered[0]!.key).toBe("urgent:pack_ship");
  });

  it("two urgent shipments keep the ranker's exact order", () => {
    // They are already sorted by deadline. Regrouping them by bin would put a
    // later parcel first because it happens to sit near another one.
    const out = batch(
      [
        ranked({ key: "soon:pack_ship", action: "pack_ship", tier: "urgent_shipping" }),
        ranked({ key: "later:pack_ship", action: "pack_ship", tier: "urgent_shipping" }),
      ],
      { soon: "Z-99", later: "A-01" },
    );
    expect(out.ordered.map((t) => t.key)).toEqual([
      "soon:pack_ship",
      "later:pack_ship",
    ]);
  });
});

describe("dependencies survive the grouping (AC2)", () => {
  it("photos are never moved after the draft that needs them", () => {
    // The case this exists for. Photography groups by bin; draft review groups
    // with all screen work, and the screen group can easily hold a
    // better-ranked member. A naive sort puts the draft first, which is
    // photographing a listing that has already gone out.
    const out = batch(
      [
        ranked({ key: "other:draft_review", action: "draft_review" }),
        ranked({ key: "x:photograph", action: "photograph" }),
        ranked({
          key: "x:draft_review",
          action: "draft_review",
          prerequisiteKeys: ["x:photograph"],
        }),
      ],
      { x: "A-14", other: "A-14" },
    );
    const order = out.ordered.map((t) => t.key);
    expect(order.indexOf("x:photograph")).toBeLessThan(order.indexOf("x:draft_review"));
  });

  it("a chain inside one item keeps its order", () => {
    const out = batch(
      [
        ranked({
          key: "x:photograph",
          action: "photograph",
          prerequisiteKeys: ["x:measure"],
        }),
        ranked({ key: "x:measure", action: "measure" }),
      ],
      { x: "A-14" },
    );
    const order = out.ordered.map((t) => t.key);
    expect(order.indexOf("x:measure")).toBeLessThan(order.indexOf("x:photograph"));
  });
});

describe("screen work groups by family alone", () => {
  it("does not split pricing and drafting across bins", () => {
    // They happen at a laptop and it does not matter which tote the garment is
    // in. Splitting by bin would make several one-task groups that each cost
    // nothing to set up: noise on screen, no benefit.
    const out = batch(
      [
        ranked({ key: "x:draft_review", action: "draft_review" }),
        ranked({ key: "y:price_research", action: "price_research" }),
        ranked({ key: "z:draft_review", action: "draft_review" }),
      ],
      { x: "A-14", y: "B-02", z: "C-07" },
    );
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.family).toBe("screen");
  });

  it("puts nothing on the pull list for screen work", () => {
    // The garment stays where it is; there is nothing to fetch.
    const out = batch(
      [ranked({ key: "x:draft_review", action: "draft_review" })],
      { x: "A-14" },
    );
    expect(out.pullList).toHaveLength(0);
  });
});

describe("the pull list (AC1)", () => {
  it("lists each bin once, with its items, in group order", () => {
    const out = batch(
      [
        ranked({ key: "x:photograph", action: "photograph" }),
        ranked({ key: "y:photograph", action: "photograph" }),
        ranked({ key: "z:photograph", action: "photograph" }),
        ranked({ key: "x2:measure", action: "measure" }),
      ],
      { x: "A-14", y: "B-02", z: "A-14", x2: "A-14" },
    );
    expect(out.pullList.map((p) => p.bin)).toEqual(["A-14", "B-02"]);
    expect(out.pullList[0]!.itemIds).toEqual(["x", "z", "x2"]);
    expect(out.pullList[1]!.itemIds).toEqual(["y"]);
  });

  it("names an item once even when it has two jobs in the same bin", () => {
    const out = batch(
      [
        ranked({ key: "x:photograph", action: "photograph" }),
        ranked({ key: "x:measure", action: "measure" }),
      ],
      { x: "A-14" },
    );
    expect(out.pullList).toHaveLength(1);
    expect(out.pullList[0]!.itemIds).toEqual(["x"]);
  });
});

describe("no claimed saving (AC4)", () => {
  it("reports no minutes saved anywhere", () => {
    // The setup a batch avoids is avoided against a hypothetical plan nobody
    // ran. Presenting that as time the seller saved is the same overclaim the
    // duration estimator refuses. The plan is simply shorter.
    const out = batch([ranked({ key: "x:photograph", action: "photograph" })], {});
    expect(Object.keys(out)).not.toContain("minutesSaved");
    expect(Object.keys(out)).not.toContain("savedMinutes");
    expect(codeOf("src/lib/work-batching.ts")).not.toMatch(/saved|saving/i);
  });
});

describe("the plan stays inside the budget after grouping (AC4)", () => {
  it("a batched plan is re-costed by the scheduler, not assumed", () => {
    const tasks = [
      ranked({ key: "x:photograph", action: "photograph" }),
      ranked({ key: "y:measure", action: "measure" }),
      ranked({ key: "z:photograph", action: "photograph" }),
    ];
    const grouped = batch(tasks, { x: "A-14", y: "A-14", z: "A-14" });
    const plan = schedulePlan({
      now: "2026-09-21T12:00:00Z",
      budgetMinutes: 60,
      ranked: grouped.ordered,
    });
    expect(plan.plannedMinutes).toBeLessThanOrEqual(60);
    // Two photos run together, so the second pays no setup.
    expect(plan.tasks.map((t) => t.overheadMinutes)).toEqual([6, 0, 4]);
  });

  it("batching makes the same work cost less than the interleaved order", () => {
    // Stated as a comparison of two real plans rather than as a saving the
    // seller is told about.
    const tasks = [
      ranked({ key: "x:photograph", action: "photograph" }),
      ranked({ key: "y:measure", action: "measure" }),
      ranked({ key: "z:photograph", action: "photograph" }),
    ];
    const now = "2026-09-21T12:00:00Z";
    const interleaved = schedulePlan({ now, budgetMinutes: 240, ranked: tasks });
    const grouped = schedulePlan({
      now,
      budgetMinutes: 240,
      ranked: batch(tasks, {}).ordered,
    });
    expect(grouped.plannedMinutes).toBeLessThan(interleaved.plannedMinutes);
  });

  it("an urgent shipment that still does not fit reports the SAME conflict", () => {
    const grouped = batch(
      [
        ranked({ key: "u:pack_ship", action: "pack_ship", tier: "urgent_shipping" }),
        ranked({ key: "x:photograph", action: "photograph" }),
      ],
      { u: "Z-99", x: "A-14" },
    );
    const plan = schedulePlan({
      now: "2026-09-21T12:00:00Z",
      budgetMinutes: 10,
      ranked: grouped.ordered,
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.key).toBe("u:pack_ship");
  });
});

describe("determinism (AC5)", () => {
  it("the same input batches the same way twice", () => {
    const tasks = [
      ranked({ key: "x:photograph", action: "photograph" }),
      ranked({ key: "y:measure", action: "measure" }),
    ];
    expect(batch(tasks, { x: "A", y: "B" })).toEqual(batch(tasks, { x: "A", y: "B" }));
  });

  it("groups with the same best rank break on a stable key", () => {
    // Cannot happen from a real ranker, which produces distinct positions, but
    // a total order is what makes two runs provably identical.
    const src = readFileSync(resolve(process.cwd(), "src/lib/work-batching.ts"), "utf8");
    expect(src).toMatch(/a\.key < b\.key/);
  });

  it("never loses a task, whatever the grouping", () => {
    const tasks = [
      ranked({ key: "a:photograph", action: "photograph" }),
      ranked({ key: "b:measure", action: "measure" }),
      ranked({ key: "c:draft_review", action: "draft_review" }),
      ranked({ key: "d:pack_ship", action: "pack_ship", tier: "urgent_shipping" }),
      ranked({ key: "e:reupholster", action: "reupholster" as CandidateAction }),
    ];
    const out = batch(tasks, { a: "A-14", b: "A-14" });
    expect(out.ordered.map((t) => t.key).sort()).toEqual(
      tasks.map((t) => t.key).sort(),
    );
  });

  it("a task nobody can classify keeps its place at the end, not dropped", () => {
    const out = batch(
      [
        ranked({ key: "weird:reupholster", action: "reupholster" as CandidateAction }),
        ranked({ key: "x:photograph", action: "photograph" }),
      ],
      {},
    );
    expect(out.ordered.map((t) => t.key)).toEqual([
      "x:photograph",
      "weird:reupholster",
    ]);
    expect(out.groups.every((g) => !g.taskKeys.includes("weird:reupholster"))).toBe(true);
  });

  it("stamps the batching version", () => {
    expect(batch([], {}).version).toBe(BATCHING_VERSION);
  });
});

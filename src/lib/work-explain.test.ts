// US-3181: why was this task chosen, and what must the explanation refuse?
//
// AC6 asks for every reason family plus incomplete evidence. The two rules
// worth stating up front, because they are what a plausible implementation
// gets wrong: there is NO confidence percentage anywhere, and the explanation
// describes the SNAPSHOT rather than today.

import { describe, it, expect } from "vitest";
import {
  EXPLAIN_FACTS,
  STALE_SNAPSHOT_HOURS,
  explainOmission,
  explainTask,
  whatWouldChangeIt,
  type ExplainInput,
} from "@/lib/work-explain";
import { EXPLAIN_FACT_COPY, OMISSION_COPY, WOULD_CHANGE_COPY } from "@/lib/work-explain-copy";
import type { RankedTask } from "@/lib/work-ranker";
import type { DurationResult } from "@/lib/work-duration";
import type { ValueResult } from "@/lib/work-value";

const NOW = "2026-09-21T12:00:00.000Z";

function hoursAgo(n: number): string {
  return new Date(Date.parse(NOW) - n * 3_600_000).toISOString();
}

function task(over: Partial<RankedTask> = {}): RankedTask {
  return {
    key: "item-1:photograph",
    itemId: "item-1",
    action: "photograph",
    tier: "valued_work",
    score: 140,
    chainMinutes: 20,
    conservativeCents: 3300,
    dueAt: null,
    prerequisiteKeys: [],
    conflict: null,
    meetsHourlyTarget: null,
    version: 1,
    ...over,
  } as RankedTask;
}

const DEFAULT_DURATION: DurationResult = {
  low: 4, typical: 8, high: 15, family: "photo",
  setupMinutes: 6, unattendedMinutes: 0, source: "default", version: 1,
};

const LEARNED_DURATION: DurationResult = {
  low: 3, typical: 4, high: 7, family: "photo",
  setupMinutes: 6, unattendedMinutes: 0, source: "learned",
  learnedFrom: {
    sampleCount: 5,
    observedLowMinutes: 3,
    observedHighMinutes: 7,
    allocation: "per_item",
  },
  version: 1,
};

const SOLD_COMP: ValueResult = {
  complete: true,
  wholeItemProfitCents: 2000,
  remainingContributionCents: 4200,
  lowCents: 3600,
  highCents: 4800,
  evidence: "sold_comp",
  observedAt: "2026-09-01T00:00:00.000Z",
  missing: [],
  horizonDays: 30,
};

function explain(over: Partial<ExplainInput> = {}) {
  return explainTask({
    task: task(),
    duration: DEFAULT_DURATION,
    value: SOLD_COMP,
    takenAt: hoursAgo(1),
    now: NOW,
    hourlyTargetSet: false,
    ...over,
  });
}

describe("no confidence percentage, anywhere (AC3)", () => {
  it("nothing in the model emits one", () => {
    const src = codeOf("src/lib/work-explain.ts");
    for (const banned of ["confidence%", "probability", "percentConfident", "confidencePct"]) {
      expect(src, `work-explain.ts mentions "${banned}"`).not.toContain(banned);
    }
    expect(src).toContain("export function explainTask");
  });

  it("and no sentence carries a percent sign", () => {
    // `score` is cents per minute and is ordering only. Turning it into "87%
    // confident" would be inventing a statistic out of a sort key.
    for (const [code, line] of Object.entries(EXPLAIN_FACT_COPY)) {
      expect(line, `"${code}" contains a percentage`).not.toMatch(/\d\s*%/);
    }
    for (const [code, line] of Object.entries(OMISSION_COPY)) {
      expect(line, `"${code}" contains a percentage`).not.toMatch(/\d\s*%/);
    }
  });

  it("uncertainty is stated as the FACT that causes it", () => {
    const asking: ValueResult = { ...SOLD_COMP, evidence: "active_asking" };
    const e = explain({ value: asking });
    expect(e.facts).toContain("value_from_asking_price");
    // The copy says what the evidence IS, not how sure we are.
    expect(EXPLAIN_FACT_COPY.value_from_asking_price).toContain("Nobody has paid it");
  });
});

describe("every reason family (AC2, AC6)", () => {
  it("an urgent deadline says so, and says whether it was confirmed", () => {
    const confirmed = explain({
      task: task({ tier: "urgent_shipping", dueAt: "2026-09-22T00:00:00.000Z" }),
      shipBy: { at: "2026-09-22T00:00:00.000Z", confidence: "confirmed" },
    });
    expect(confirmed.facts).toContain("urgent_deadline");
    expect(confirmed.facts).not.toContain("deadline_unknown");
    expect(confirmed.deadline.confidence).toBe("confirmed");

    const guessed = explain({ task: task({ tier: "urgent_shipping" }) });
    expect(guessed.facts).toContain("deadline_unknown");
  });

  it("the valued tier reports the rate, the research tier reports the gap", () => {
    expect(explain().facts).toContain("best_rate");
    expect(explain({ task: task({ tier: "research" }) }).facts)
      .toContain("needs_price_research");
    expect(explain({ task: task({ tier: "unvalued" }) }).facts)
      .toContain("cannot_estimate_value");
  });

  it("says where the minutes came from, and never dresses a guess as a measurement", () => {
    expect(explain().facts).toContain("timing_is_default");
    expect(EXPLAIN_FACT_COPY.timing_is_default).toContain("starting guess");

    const learned = explain({ duration: LEARNED_DURATION });
    expect(learned.facts).toContain("timing_is_learned");
    expect(learned.timing.sampleCount).toBe(5);
    expect(learned.timing.observedLowMinutes).toBe(3);
    expect(learned.timing.observedHighMinutes).toBe(7);

    const override: DurationResult = { ...DEFAULT_DURATION, source: "seller" };
    expect(explain({ duration: override }).facts).toContain("timing_is_override");
  });

  it("reports the chain, the active minutes and the setup separately", () => {
    const e = explain();
    expect(e.timing.activeMinutes).toBe(8);
    expect(e.timing.setupMinutes).toBe(6);
    expect(e.timing.chainMinutes).toBe(20);
  });

  it("says where the value came from and when it was observed", () => {
    const e = explain();
    expect(e.facts).toContain("value_from_sold_comp");
    expect(e.value.observedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(e.value.lowCents).toBe(3600);
    expect(e.value.highCents).toBe(4800);

    const typed: ValueResult = { ...SOLD_COMP, evidence: "seller_estimate" };
    expect(explain({ value: typed }).facts).toContain("value_from_seller_estimate");
  });

  it("reports the hourly target honestly in all three states", () => {
    expect(explain({ hourlyTargetSet: false }).facts).toContain("no_hourly_target_set");
    expect(explain({
      hourlyTargetSet: true,
      task: task({ meetsHourlyTarget: true }),
    }).facts).toContain("clears_hourly_target");
    expect(explain({
      hourlyTargetSet: true,
      task: task({ meetsHourlyTarget: false }),
    }).facts).toContain("below_hourly_target");
  });

  it("names a prerequisite rather than leaving the order unexplained", () => {
    const e = explain({ task: task({ prerequisiteKeys: ["item-1:measure"] }) });
    expect(e.facts).toContain("blocked_by_prerequisite");
    expect(e.prerequisiteKeys).toEqual(["item-1:measure"]);
  });

  it("carries the ranker's own conflict message rather than restating it", () => {
    const e = explain({
      task: task({ conflict: { kind: "cannot_fit", message: "Needs 40 minutes." } }),
    });
    expect(e.conflict).toEqual({ kind: "cannot_fit", message: "Needs 40 minutes." });
  });
});

describe("incomplete evidence (AC2, AC6)", () => {
  it("an incomplete estimate still explains, with what is missing", () => {
    const incomplete: ValueResult = {
      complete: false,
      reason: "no_price_evidence",
      missing: ["price_evidence"],
      researchable: true,
      horizonDays: 30,
    };
    const e = explain({ task: task({ tier: "research" }), value: incomplete });
    expect(e.facts).toContain("needs_price_research");
    expect(e.facts).toContain("value_inputs_missing");
    expect(e.value.missing).toEqual(["price_evidence"]);
    // And no range is invented from nothing.
    expect(e.value.lowCents).toBeNull();
    expect(e.value.highCents).toBeNull();
  });

  it("a guessed cost is reported as guessed", () => {
    const guessed: ValueResult = { ...SOLD_COMP, missing: ["shipping_cost"] };
    const e = explain({ value: guessed });
    expect(e.facts).toContain("value_inputs_missing");
    expect(EXPLAIN_FACT_COPY.value_inputs_missing).toContain("estimated rather than recorded");
  });

  it("an unestimated task says the timing is unknown rather than zero", () => {
    const e = explain({
      duration: { unestimated: true, reason: "No duration model." },
    });
    expect(e.timing.activeMinutes).toBeNull();
    expect(e.timing.setupMinutes).toBeNull();
    expect(e.timing.source).toBe("unknown");
  });
});

describe("it explains the snapshot, not today (AC5)", () => {
  it("a fresh snapshot says nothing about staleness", () => {
    const e = explain({ takenAt: hoursAgo(1) });
    expect(e.stale).toBe(false);
    expect(e.facts).not.toContain("snapshot_may_be_stale");
  });

  it("an old one says so rather than showing today's numbers under it", () => {
    const e = explain({ takenAt: hoursAgo(STALE_SNAPSHOT_HOURS + 1) });
    expect(e.stale).toBe(true);
    expect(e.facts).toContain("snapshot_may_be_stale");
    expect(EXPLAIN_FACT_COPY.snapshot_may_be_stale).toContain("Build a new one");
  });

  it("an unknown snapshot time is not treated as stale", () => {
    // Absent is not old. Warning on a missing timestamp would fire on every
    // plan from before this field existed.
    expect(explain({ takenAt: null }).stale).toBe(false);
  });

  it("it reads nothing and is fully deterministic", () => {
    const src = codeOf("src/lib/work-explain.ts");
    for (const banned of ["fetch(", "supabase", "Date.now()", "Math.random"]) {
      expect(src, `work-explain.ts contains "${banned}"`).not.toContain(banned);
    }
    expect(JSON.stringify(explain())).toBe(JSON.stringify(explain()));
  });
});

describe("omissions (AC4)", () => {
  it("every omission reason has words, and they are the scheduler's reason", () => {
    const reasons = [
      "no_time_left", "prerequisite_not_ready", "conflict",
      "unestimated", "beyond_candidate_cap",
    ] as const;
    for (const reason of reasons) {
      const e = explainOmission({ key: "k", reason, minutes: 9 });
      expect(e.reason).toBe(reason);
      expect(OMISSION_COPY[reason], `${reason} has no copy`).toBeTruthy();
    }
  });

  it("carries the minutes it would have cost, when known", () => {
    expect(explainOmission({ key: "k", reason: "no_time_left", minutes: 12 }).minutes)
      .toBe(12);
    expect(explainOmission({ key: "k", reason: "unestimated", minutes: null }).minutes)
      .toBeNull();
  });
});

describe("what would change it (AC4)", () => {
  it("returns ONE thing, not a list", () => {
    const e = explain({ task: task({ tier: "unvalued" }) });
    const change = whatWouldChangeIt(e);
    expect(typeof change === "string" || change === null).toBe(true);
    expect(WOULD_CHANGE_COPY[change!]).toBeTruthy();
  });

  it("picks the fact that would move the answer most", () => {
    const asking: ValueResult = { ...SOLD_COMP, evidence: "active_asking", missing: ["shipping_cost"] };
    // Both value_from_asking_price and value_inputs_missing are present; the
    // weak evidence outranks the guessed cost.
    expect(whatWouldChangeIt(explain({ value: asking })))
      .toBe("value_from_asking_price");
  });

  it("returns null when nothing obvious would help", () => {
    const e = explain({
      duration: LEARNED_DURATION,
      task: task({ tier: "valued_work", meetsHourlyTarget: true }),
      hourlyTargetSet: true,
    });
    expect(whatWouldChangeIt(e)).toBeNull();
  });
});

describe("the code and the copy cannot drift", () => {
  it("every declared fact has a sentence", () => {
    for (const fact of EXPLAIN_FACTS) {
      expect(EXPLAIN_FACT_COPY[fact], `"${fact}" has no copy`).toBeTruthy();
    }
    expect(EXPLAIN_FACTS.length).toBeGreaterThan(10);
  });

  it("every fact the model can emit is declared", () => {
    const seen = new Set<string>();
    const inputs: Partial<ExplainInput>[] = [
      {},
      { task: task({ tier: "urgent_shipping" }) },
      { task: task({ tier: "research" }) },
      { task: task({ tier: "unvalued" }) },
      { task: task({ prerequisiteKeys: ["a"] }) },
      { duration: LEARNED_DURATION },
      { duration: { ...DEFAULT_DURATION, source: "seller" } },
      { value: { ...SOLD_COMP, evidence: "active_asking" } },
      { value: { ...SOLD_COMP, evidence: "seller_estimate", missing: ["shipping_cost"] } },
      { hourlyTargetSet: true, task: task({ meetsHourlyTarget: true }) },
      { hourlyTargetSet: true, task: task({ meetsHourlyTarget: false }) },
      { takenAt: hoursAgo(48) },
    ];
    for (const i of inputs) for (const f of explain(i).facts) seen.add(f);
    for (const f of seen) {
      expect((EXPLAIN_FACTS as readonly string[]).includes(f), `"${f}" is undeclared`)
        .toBe(true);
    }
    // Guards the guard: an empty set would pass the loop above.
    expect(seen.size).toBeGreaterThan(10);
  });
});

function codeOf(rel: string): string {
  // Comments stripped as BLOCKS: the header explains what this file must not
  // do, so a naive scan finds the banned word inside the sentence forbidding
  // it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

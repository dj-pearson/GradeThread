import { describe, it, expect } from "vitest";
import {
  issueCopy,
  impactLabel,
  impactExplanation,
  totalImpact,
  type ReviewIssue,
  type IssueKind,
} from "./books-review";

// US-2992. The queue itself is checked against Postgres by
// scripts/check-books-review.mjs; this covers what the seller is told.

const KINDS: IssueKind[] = [
  "no_cost_basis",
  "uncategorised",
  "sale_without_fees",
  "unmatched_payout",
  "missing_receipt",
  "no_inventory_snapshot",
];

function issue(over: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    kind: "uncategorised",
    subject_id: "x",
    title: "Something",
    happened_on: "2025-06-01",
    impact_cents: 5500,
    estimated_impact_cents: null,
    severity: 2,
    fix_kind: "expense",
    ...over,
  };
}

describe("every issue says what it COSTS, not what it is", () => {
  it("has copy for all six kinds", () => {
    for (const k of KINDS) {
      const c = issueCopy(k);
      expect(c.heading, k).toBeTruthy();
      expect(c.consequence, k).toBeTruthy();
      expect(c.action, k).toBeTruthy();
    }
  });

  it("states a consequence in money or tax, never a restatement of the title", () => {
    // AC3. "This expense has no category" is a description. "This is a
    // deduction you are entitled to and are not taking" is a reason to click.
    for (const k of KINDS) {
      const c = issueCopy(k);
      expect(c.consequence.length, k).toBeGreaterThan(60);
      expect(c.consequence.toLowerCase(), k).not.toBe(c.heading.toLowerCase());
    }
  });

  it("says the missing cost basis is taxed, because that is the part that stings", () => {
    expect(issueCopy("no_cost_basis").consequence).toMatch(/taxed on that/i);
  });

  it("says the snapshot one gets WORSE with time", () => {
    // The only issue on the list that becomes unfixable, which is why it is
    // worth saying rather than leaving to be discovered.
    expect(issueCopy("no_inventory_snapshot").consequence).toMatch(
      /gone for good|worse with time/i,
    );
  });

  it("gives every action as an instruction, not a noun", () => {
    for (const k of KINDS) {
      expect(issueCopy(k).action, k).toMatch(/^[A-Z][a-z]+ /);
    }
  });
});

describe("impactLabel", () => {
  it("shows an exact figure plainly", () => {
    expect(impactLabel(issue({ impact_cents: 5500 }))).toBe("$55.00");
  });

  it("hedges an estimate in the label itself, not only in a footnote", () => {
    // A number that looks measured but is not is the failure mode here.
    expect(
      impactLabel(
        issue({ impact_cents: null, estimated_impact_cents: 8000 }),
      ),
    ).toBe("about $80.00");
  });

  it("says unknown rather than showing zero", () => {
    // Zero is a claim. Unknown is the truth, and they are not the same thing.
    expect(
      impactLabel(issue({ impact_cents: null, estimated_impact_cents: null })),
    ).toBe("unknown");
  });

  it("prefers the exact figure when both are somehow present", () => {
    expect(
      impactLabel(issue({ impact_cents: 100, estimated_impact_cents: 999 })),
    ).toBe("$1.00");
  });
});

describe("impactExplanation", () => {
  it("says nothing when the figure is exact", () => {
    expect(impactExplanation(issue({ impact_cents: 5500 }))).toBeNull();
  });

  it("says WHERE an estimate came from, and that it could be well out", () => {
    const e = impactExplanation(
      issue({ impact_cents: null, estimated_impact_cents: 8000 }),
    );
    expect(e).toMatch(/your other items/i);
    expect(e).toMatch(/could be very different/i);
  });

  it("admits when there is no number at all", () => {
    expect(
      impactExplanation(
        issue({ impact_cents: null, estimated_impact_cents: null }),
      ),
    ).toMatch(/cannot put a number/i);
  });
});

describe("totalImpact", () => {
  it("keeps exact and estimated APART", () => {
    // Adding a guess to a set of exact figures and printing one total makes the
    // whole thing look measured. They are reported separately for that reason.
    const t = totalImpact([
      issue({ impact_cents: 5500 }),
      issue({ impact_cents: 12000 }),
      issue({ impact_cents: null, estimated_impact_cents: 8000 }),
      issue({ impact_cents: null, estimated_impact_cents: null }),
    ]);
    expect(t.exactCents).toBe(17500);
    expect(t.estimatedCents).toBe(8000);
    expect(t.unknownCount).toBe(1);
  });

  it("is all zeroes on an empty queue", () => {
    expect(totalImpact([])).toEqual({
      exactCents: 0,
      estimatedCents: 0,
      unknownCount: 0,
    });
  });

  it("counts an issue once, in exactly one bucket", () => {
    const issues = [
      issue({ impact_cents: 100 }),
      issue({ impact_cents: null, estimated_impact_cents: 200 }),
      issue({ impact_cents: null, estimated_impact_cents: null }),
    ];
    const t = totalImpact(issues);
    const counted =
      (t.exactCents > 0 ? 1 : 0) +
      (t.estimatedCents > 0 ? 1 : 0) +
      t.unknownCount;
    expect(counted).toBe(issues.length);
  });

  it("matches the fixture's own figures", () => {
    // The six issues scripts/check-books-review.mjs produced on Postgres:
    // $55 unsorted + $245 orphan payout + $120 receipt gap exact, an $80
    // estimate, and two with no number.
    const t = totalImpact([
      issue({ kind: "uncategorised", impact_cents: 5500 }),
      issue({ kind: "unmatched_payout", impact_cents: 24500 }),
      issue({ kind: "missing_receipt", impact_cents: 12000 }),
      issue({
        kind: "no_cost_basis",
        impact_cents: null,
        estimated_impact_cents: 8000,
      }),
      issue({ kind: "sale_without_fees", impact_cents: null, estimated_impact_cents: null }),
      issue({
        kind: "no_inventory_snapshot",
        impact_cents: null,
        estimated_impact_cents: null,
      }),
    ]);
    expect(t.exactCents).toBe(42000);
    expect(t.estimatedCents).toBe(8000);
    expect(t.unknownCount).toBe(2);
  });
});

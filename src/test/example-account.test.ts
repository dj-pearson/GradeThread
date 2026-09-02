import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GRADE_FACTORS, GRADE_TIERS, IMAGE_TYPES } from "@/lib/constants";
import {
  EXAMPLE_BADGE,
  EXAMPLE_COMP,
  EXAMPLE_DISCLAIMER,
  EXAMPLE_FACTORS,
  EXAMPLE_GRADE,
  EXAMPLE_ITEM,
  EXAMPLE_PHOTOS,
  EXAMPLE_SALE,
  exampleNetCents,
  exampleProfitCents,
  exampleWeightedScore,
} from "@/lib/example-account";

// US-2865. The worked example a new account reads instead of seven zeros.
//
// The assertions that earn their place are the ARITHMETIC ones. An example
// exists so a seller can follow the sum; one whose numbers do not add up
// teaches the wrong thing more convincingly than no example at all. That is
// not hypothetical here: the landing page's certificate has shown five factors
// weighting to 9.05 under a headline reading 9.0 since US-604, which is what
// this guard caught first.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Strip comments before scanning source. A prose mention is not a call site. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the example adds up (US-2865)", () => {
  it("the five factors weight to the headline score", () => {
    expect(
      exampleWeightedScore(),
      "the stated overall grade is not what the five factors produce. A " +
        "seller who does the sum gets a different number than the one on " +
        "screen, which is the one thing a worked example may not do.",
    ).toBe(EXAMPLE_GRADE.overallScore);
  });

  it("every factor is a real factor, scored on the real scale", () => {
    const keys = EXAMPLE_FACTORS.map((f) => f.key);
    expect(new Set(keys).size, "a factor is listed twice").toBe(keys.length);
    expect(
      keys.sort(),
      "the example must score every factor the grade uses, or the weights " +
        "silently do not sum to 1",
    ).toEqual(Object.keys(GRADE_FACTORS).sort());
    for (const f of EXAMPLE_FACTORS) {
      expect(f.score, `${f.key} is out of range`).toBeGreaterThanOrEqual(1);
      expect(f.score, `${f.key} is out of range`).toBeLessThanOrEqual(10);
      expect(
        (f.score * 2) % 1,
        `${f.key} is ${f.score}; factors move in 0.5 steps`,
      ).toBe(0);
    }
  });

  it("every factor says why it scored what it scored", () => {
    // A bar with a number and no sentence is the thing US-2871 is about. The
    // example is the one place that can never get away with it.
    for (const f of EXAMPLE_FACTORS) {
      expect(f.note.length, `${f.key} has no explanation`).toBeGreaterThan(20);
      expect(f.note.trim().endsWith("."), `${f.key} note is not a sentence`).toBe(
        true,
      );
    }
  });

  it("the tier is a real tier and the confidence clears human review", () => {
    expect(GRADE_TIERS).toContain(EXAMPLE_GRADE.tier);
    // Below 0.75 the pipeline routes to a person, so an example that graded
    // straight through must be above it or the story it tells is wrong.
    expect(EXAMPLE_GRADE.confidence).toBeGreaterThan(0.75);
    expect(EXAMPLE_GRADE.confidence).toBeLessThanOrEqual(1);
  });

  it("the money adds up, deduction by deduction", () => {
    const feeTotal = EXAMPLE_SALE.fees.reduce((s, f) => s + f.cents, 0);
    const expectedNet =
      EXAMPLE_SALE.soldPriceCents +
      EXAMPLE_SALE.shippingChargedCents -
      feeTotal -
      EXAMPLE_SALE.shippingCostCents;
    expect(exampleNetCents()).toBe(expectedNet);
    expect(exampleProfitCents()).toBe(
      expectedNet - EXAMPLE_ITEM.acquiredPriceCents,
    );
    // And the example has to be a WIN, or it teaches a new seller that the
    // product's own best case loses money.
    expect(exampleProfitCents()).toBeGreaterThan(0);
    // Every cent figure is an integer. A fractional cent is a rounding bug
    // waiting to be copied by whoever reads this as the reference.
    const cents = [
      EXAMPLE_ITEM.acquiredPriceCents,
      EXAMPLE_SALE.soldPriceCents,
      EXAMPLE_SALE.shippingChargedCents,
      EXAMPLE_SALE.shippingCostCents,
      EXAMPLE_COMP.lowCents,
      EXAMPLE_COMP.medianCents,
      EXAMPLE_COMP.highCents,
      ...EXAMPLE_SALE.fees.map((f) => f.cents),
    ];
    for (const c of cents) expect(Number.isInteger(c), `${c} is not whole`).toBe(true);
  });

  it("the sale price sits inside the comp range it was priced from", () => {
    // Otherwise the fourth screen contradicts the fifth.
    expect(EXAMPLE_SALE.soldPriceCents).toBeGreaterThanOrEqual(
      EXAMPLE_COMP.lowCents,
    );
    expect(EXAMPLE_SALE.soldPriceCents).toBeLessThanOrEqual(
      EXAMPLE_COMP.highCents,
    );
    expect(EXAMPLE_COMP.lowCents).toBeLessThan(EXAMPLE_COMP.medianCents);
    expect(EXAMPLE_COMP.medianCents).toBeLessThan(EXAMPLE_COMP.highCents);
  });

  it("the four photos are the four a grade requires", () => {
    expect(EXAMPLE_PHOTOS).toHaveLength(4);
    const types = EXAMPLE_PHOTOS.map((p) => p.type);
    expect(types).toEqual(["front", "back", "label", "detail"]);
    for (const t of types) expect(IMAGE_TYPES).toContain(t);
    for (const p of EXAMPLE_PHOTOS) {
      expect(
        p.teaches.length,
        `${p.type} does not say what the shot is for`,
      ).toBeGreaterThan(25);
    }
  });
});

describe("there is only ONE example in the product (US-2865)", () => {
  it("the landing page reads the fixture instead of restating it", () => {
    const src = read("src/pages/landing.tsx");
    expect(src).toContain('from "@/lib/example-account"');
    expect(src).toContain("title: EXAMPLE_ITEM.title");
    expect(src).toContain("factors: EXAMPLE_FACTORS");
    // The literal that used to live here. If it comes back, the marketing
    // certificate and the in-app one can disagree again, which they did.
    const body = stripComments(src);
    expect(
      /score:\s*9\.5/.test(body),
      "landing.tsx has a hardcoded factor score again; the example is defined " +
        "in src/lib/example-account.ts and nowhere else",
    ).toBe(false);
  });

  it("the garment is named, so support can talk about it", () => {
    expect(EXAMPLE_ITEM.title.length).toBeGreaterThan(10);
    expect(EXAMPLE_ITEM.brand.length).toBeGreaterThan(2);
  });
});

describe("the example page is read-only by construction (US-2865)", () => {
  const PAGE = "src/pages/example.tsx";

  it("it cannot write, because it never talks to anything", () => {
    const src = stripComments(read(PAGE));
    for (const forbidden of [
      "@/lib/supabase",
      "useQuery",
      "useMutation",
      "edgeFetch",
      "fetch(",
    ]) {
      expect(
        src.includes(forbidden),
        `${PAGE} uses ${forbidden}. The example is a constant: give it a data ` +
          "source and it becomes something that can write to the user's rows, " +
          "count against their plan, or fail.",
      ).toBe(false);
    }
  });

  it("every block carries the Example badge", () => {
    const src = read(PAGE);
    // Five steps, each through the same card, and the card renders the tag.
    expect(src).toContain("<ExampleTag />");
    const steps = (src.match(/<StepCard\s/g) ?? []).length;
    expect(steps, "the example should walk all five stages").toBe(5);
    // Counting, not toContain: a single badge on one card would satisfy a
    // toContain and leave four blocks unlabelled.
    expect(src).toContain("{EXAMPLE_BADGE}");
    expect(EXAMPLE_BADGE).toBe("Example");
  });

  it("it says out loud that this is not the user's data", () => {
    expect(read(PAGE)).toContain("EXAMPLE_DISCLAIMER");
    expect(EXAMPLE_DISCLAIMER).toMatch(/not your data/i);
    expect(EXAMPLE_DISCLAIMER).toMatch(/does not count against/i);
  });

  it("one click closes it", () => {
    const src = read(PAGE);
    expect(src).toContain("Close example");
    expect(src).toContain('to="/dashboard"');
  });

  it("the route is registered", () => {
    const routes = read("src/routes/index.tsx");
    expect(routes).toContain('path: "/dashboard/example"');
    expect(routes).toContain('import("@/pages/example")');
  });
});

describe("the way in is offered where an account is empty (US-2865)", () => {
  // AC1 named these three. Each is the ZERO-DATA branch, never the filtered
  // one: somebody whose filter hid their rows does not need an example.
  const ENTRY_POINTS = [
    // US-3075: the dashboard's empty state belongs to the recent-submissions
    // widget now. Same branch, same offer, different file.
    "src/components/dashboard/widgets/grading-recent-submissions.tsx",
    "src/pages/submissions.tsx",
    "src/pages/flipdesk/listings.tsx",
  ];

  for (const rel of ENTRY_POINTS) {
    it(`${rel} offers the example on its empty state`, () => {
      const src = stripComments(read(rel));
      expect(
        src.includes("secondaryAction={showExampleAction}") ||
          src.includes("showExampleAction : undefined"),
        `${rel} does not offer the worked example anywhere`,
      ).toBe(true);
      expect(src).toContain("@/lib/show-example");
    });
  }

  it("there is one spelling of the button, not three", () => {
    // The US-2860 failure mode: the same action called three things because
    // three call sites each wrote their own label.
    const helper = read("src/lib/show-example.ts");
    expect(helper).toContain('SHOW_EXAMPLE_LABEL = "Show me an example"');
    for (const rel of ENTRY_POINTS) {
      expect(
        stripComments(read(rel)).includes('"Show me an example"'),
        `${rel} writes the label itself instead of using showExampleAction`,
      ).toBe(false);
    }
  });

  it("it hangs off an empty state, so it disappears once there is data", () => {
    // AC4's "clears itself the moment the user's own first item exists" is
    // structural rather than a rule somebody has to remember: the offer lives
    // inside the branch that only renders when the list is empty.
    for (const rel of ENTRY_POINTS) {
      const src = stripComments(read(rel));
      // The USAGE, not the import line and not some other surface's
      // "Clear filters" secondaryAction, both of which match a naive
      // search and neither of which is what this asserts.
      const at = src.search(/secondaryAction=\{(?=[^}]*showExampleAction)/);
      expect(
        at,
        `${rel}: no secondaryAction hands the example link to an empty state`,
      ).toBeGreaterThan(-1);
      // Walk back to the nearest opening tag; it has to be an EmptyState.
      const before = src.slice(0, at);
      const tag = before.lastIndexOf("<");
      expect(
        before.slice(tag, tag + 12),
        `${rel}: the example link is not inside an <EmptyState>, so nothing ` +
          "makes it go away when the user has rows of their own",
      ).toContain("<EmptyState");
    }
  });
});

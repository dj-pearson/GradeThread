import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// US-3038: the disclosure has to stay TRUE, not just stay present.
//
// Measurement sharing is the only thing on the privacy page that is ON by
// default. The whole defence of that choice is that the copy tells the user
// exactly what the code does — five garments from three sellers before anything
// is published, and turning it off deletes what they already gave us.
//
// Those numbers live in measurement-aggregate.ts. Nothing stops somebody
// raising the floor to six and leaving three pages of copy saying five, and no
// test elsewhere would notice: the code would be correct, the pages would
// render, and the promise would quietly be false. US-2643 is the standing
// example of exactly this failure, on a retention row that promised a purge
// that did not happen.
//
// So this reads the constants out of the source and asserts the copy agrees.
//
// ⚠ THE FIRST THING IT CHECKS IS THAT IT CAN STILL READ THE CONSTANTS. A guard
// that greps for a value it can no longer find passes silently and forever,
// which is the failure mode that makes source-scanning tests worse than no test
// at all.

const AGGREGATE_SRC = "services/edge-functions/src/lib/measurement-aggregate.ts";
const SURFACES = [
  "src/pages/legal/privacy.tsx",
  "src/pages/legal/terms.tsx",
  "src/components/settings/measurement-sharing-card.tsx",
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function constantValue(src: string, name: string): number {
  const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
  if (!m) {
    throw new Error(
      `Could not read ${name} from ${AGGREGATE_SRC}. This guard compares the ` +
        `published copy against that constant, so if it cannot find it the ` +
        `guard is dead and every copy claim is unchecked. Fix the pattern ` +
        `rather than deleting the test.`,
    );
  }
  return Number(m[1]);
}

/** Digits and the English words for the small numbers this copy uses. */
function spellings(n: number): string[] {
  const words: Record<number, string> = {
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
  };
  const out = [String(n)];
  if (words[n]) out.push(words[n]);
  return out;
}

describe("US-3038: the measurement disclosure matches the code", () => {
  const aggregate = read(AGGREGATE_SRC);

  it("can still read both floors out of the source", () => {
    // The self-check. If this fails, every assertion below is meaningless.
    expect(() => constantValue(aggregate, "MIN_MEASUREMENT_SAMPLE")).not.toThrow();
    expect(() => constantValue(aggregate, "MIN_MEASUREMENT_CONTRIBUTORS")).not.toThrow();
  });

  it("every surface states the sample floor the code enforces", () => {
    const sample = constantValue(aggregate, "MIN_MEASUREMENT_SAMPLE");
    const ok = spellings(sample);
    for (const path of SURFACES) {
      const text = read(path);
      const stated = ok.some((s) => text.includes(s));
      expect(
        stated,
        `${path} does not state the sample floor of ${sample}. The code will ` +
          `not publish below ${sample} garments, so copy that says anything ` +
          `else — or says nothing — is a promise this product does not keep.`,
      ).toBe(true);
    }
  });

  it("every surface states the contributor floor the code enforces", () => {
    const contributors = constantValue(aggregate, "MIN_MEASUREMENT_CONTRIBUTORS");
    const ok = spellings(contributors);
    for (const path of SURFACES) {
      const text = read(path);
      const stated = ok.some((s) => text.includes(s));
      expect(
        stated,
        `${path} does not state the contributor floor of ${contributors}. This ` +
          `is the PRIVACY floor — the reason a published number is a fact ` +
          `about a garment rather than about one seller's inventory — so it is ` +
          `the number the copy least gets to be vague about.`,
      ).toBe(true);
    }
  });

  it("every surface promises that opting out DELETES what was contributed", () => {
    // Stopping future collection is the easy half and the half a reader
    // assumes. Deleting the past is the half the 00710 trigger actually does,
    // and copy that only promises the easy half undersells a real guarantee
    // while sounding like it covers it.
    for (const path of SURFACES) {
      const text = read(path).toLowerCase();
      expect(
        text.includes("delete"),
        `${path} does not say that turning measurement sharing off deletes ` +
          `the measurements already contributed. The 00710 trigger does ` +
          `exactly that, and a disclosure that omits it is not describing the ` +
          `product.`,
      ).toBe(true);
    }
  });

  it("the user-facing surfaces say the averages are recalculated, not frozen", () => {
    // The honest caveat: rows go immediately, published numbers catch up on the
    // next aggregate run. Verified live — after an opt-out the stats row still
    // read sufficient=true until the rebuild. Copy that implies instant removal
    // from the page would be wrong for up to a day.
    for (const path of ["src/pages/legal/privacy.tsx", SURFACES[2]!]) {
      const text = read(path).toLowerCase();
      expect(
        text.includes("recalculat"),
        `${path} must say the published averages are recalculated rather than ` +
          `frozen. Rows are deleted at once but a page can show the previous ` +
          `number until the next daily run.`,
      ).toBe(true);
    }
  });

  it("the opt-out is reachable from the privacy policy, not only from settings", () => {
    const privacy = read("src/pages/legal/privacy.tsx");
    expect(
      privacy.includes("Measurement sharing"),
      "The privacy policy must name where the switch is. An opt-out nobody " +
        "can find is not an opt-out.",
    ).toBe(true);
  });
});

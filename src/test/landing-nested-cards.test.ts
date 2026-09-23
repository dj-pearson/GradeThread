// web-growth action 3: the homepage carried two card-inside-card groups that
// US-2833 measured and left in place. The browser scan (check-ui-browser.mjs)
// cannot say WHERE a nested-cards finding is, so once they are fixed nothing
// stops them coming back one className at a time. This pins the two inner
// blocks as flat: a tinted panel, no border, no rounding of its own.
//
// Measured with `impeccable detect http://localhost:<preview>/` (one URL):
// nested-cards went 9 -> 5 on / when the plan tiles lost their border. The
// pipeline mock was not among the 9 (restoring its border alone left the count
// at 5, and /for-resellers read 1 either way), so it is pinned here as the same
// visual pattern rather than as a measured finding.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

/** className of the first element opened after `marker` in `src`. */
function classAfter(src: string, marker: string): string {
  const at = src.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0);
  const m = /className="([^"]*)"/.exec(src.slice(at));
  expect(m, `no className after ${marker}`).not.toBeNull();
  return m?.[1] ?? "";
}

const CARD_CHROME = /(^|\s)(border|rounded)(-|\s|$)/;

describe("homepage has no card inside a card (web-growth action 3)", () => {
  it("the Included-with-FlipDesk plan tiles are flat inside their card", () => {
    const landing = read("src/pages/landing.tsx");
    const fn = landing.slice(landing.indexOf("function IncludedGradesTable"));
    const tile = classAfter(fn, "key={key}");
    expect(tile).not.toMatch(CARD_CHROME);
  });

  for (const file of [
    "src/pages/landing.tsx",
    "src/components/marketing/flipdesk-pipeline-preview.tsx",
  ]) {
    it(`the pipeline stage mock is flat inside its panel (${file})`, () => {
      const mock = classAfter(read(file), "Stylized product mock");
      expect(mock).not.toMatch(CARD_CHROME);
    });
  }
});

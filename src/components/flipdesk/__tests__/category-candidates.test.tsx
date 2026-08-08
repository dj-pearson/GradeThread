// US-2426: AutoLister already scores several eBay leaves per draft (US-2424)
// and stores the ranked list on `listings.category_candidates`. Until this
// story the composer showed only the winner, so a seller who wanted the
// runner-up had to search the taxonomy by hand — for a decision the system had
// already made and explained.
//
// The list render and the selection rule are covered here directly; the
// "switching does not clear filled specifics" property is a structural fact
// about which handler the button calls, so it is asserted against the source
// the same way category-discard-confirm.test.ts does.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  alternateCategoryCandidates,
  CategoryCandidateList,
  MAX_ALTERNATE_CANDIDATES,
} from "@/components/flipdesk/ebay-category-picker";
import type { ListingCategoryCandidate } from "@/types/database";

const candidate = (
  categoryId: string,
  over: Partial<ListingCategoryCandidate> = {},
): ListingCategoryCandidate => ({
  categoryId,
  categoryPath: `Clothing > ${categoryId}`,
  rank: 0,
  requiredFilled: 3,
  requiredTotal: 4,
  requiredMissing: ["Size Type"],
  ...over,
});

describe("alternateCategoryCandidates (US-2426)", () => {
  it("offers every scored leaf except the one currently selected", () => {
    const all = [candidate("a"), candidate("b"), candidate("c")];
    expect(alternateCategoryCandidates(all, "a").map((c) => c.categoryId)).toEqual([
      "b",
      "c",
    ]);
    // After a switch the list must offer the way BACK, not the leaf the seller
    // is already sitting on — so it filters on the CURRENT selection, not on
    // "everything after element 0".
    expect(alternateCategoryCandidates(all, "b").map((c) => c.categoryId)).toEqual([
      "a",
      "c",
    ]);
  });

  it("caps the list so it stays a shortlist, not a taxonomy browser", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((id) => candidate(id));
    expect(alternateCategoryCandidates(many, "a")).toHaveLength(
      MAX_ALTERNATE_CANDIDATES,
    );
  });

  it("is empty for a draft that never went through the scorer", () => {
    expect(alternateCategoryCandidates(null, "a")).toEqual([]);
    expect(alternateCategoryCandidates(undefined, null)).toEqual([]);
    expect(alternateCategoryCandidates([], "a")).toEqual([]);
    // A single candidate means there was no choice to show.
    expect(alternateCategoryCandidates([candidate("a")], "a")).toEqual([]);
  });
});

describe("CategoryCandidateList (US-2426)", () => {
  it("names each leaf and the score that explains why it lost", () => {
    const html = renderToStaticMarkup(
      <CategoryCandidateList
        candidates={[
          candidate("57988", {
            categoryPath: "Clothing > Men > Casual Shirts",
            requiredFilled: 5,
            requiredTotal: 6,
            requiredMissing: ["Sleeve Length"],
          }),
        ]}
        onUse={() => {}}
      />,
    );
    expect(html).toContain("Also considered");
    expect(html).toContain("Clothing &gt; Men &gt; Casual Shirts");
    // The score is the whole point — a leaf without it is just another link.
    expect(html).toContain("5 of 6");
    expect(html).toContain("Sleeve Length");
    expect(html).toContain("Use this");
  });

  it("renders nothing at all when there is nothing to offer", () => {
    // Not an empty block, not a placeholder — a draft with no candidates must
    // look exactly as it did before this story.
    expect(renderToStaticMarkup(<CategoryCandidateList candidates={[]} onUse={() => {}} />))
      .toBe("");
  });

  it("says so plainly when a leaf has no required specifics at all", () => {
    const html = renderToStaticMarkup(
      <CategoryCandidateList
        candidates={[
          candidate("1", { requiredFilled: 0, requiredTotal: 0, requiredMissing: [] }),
        ]}
        onUse={() => {}}
      />,
    );
    expect(html).toContain("No required specifics");
    // …rather than the meaningless "fills 0 of 0".
    expect(html).not.toContain("0 of 0");
  });

  it("falls back to the raw id when eBay gave us no breadcrumb", () => {
    const html = renderToStaticMarkup(
      <CategoryCandidateList
        candidates={[candidate("11554", { categoryPath: null })]}
        onUse={() => {}}
      />,
    );
    expect(html).toContain("Category 11554");
  });

  it("shows only the first few missing names, so one row stays one row", () => {
    const html = renderToStaticMarkup(
      <CategoryCandidateList
        candidates={[
          candidate("1", {
            requiredFilled: 1,
            requiredTotal: 6,
            requiredMissing: ["A", "B", "C", "D", "E"],
          }),
        ]}
        onUse={() => {}}
      />,
    );
    expect(html).toContain("A, B, C");
    expect(html).not.toContain("A, B, C, D");
  });
});

// The property that matters most is what the switch does NOT do. `clearCategory`
// wipes aspectValues, sources, AI markers and prefill hints; `applyCategory`
// touches none of them and lets the picker prune against the new leaf's spec.
// Wiring the runner-up button to the wrong one would silently discard specifics
// the seller had already filled.
describe("switching to a runner-up preserves filled specifics", () => {
  const PICKER = "src/components/flipdesk/ebay-category-picker.tsx";
  const source = readFileSync(resolve(process.cwd(), PICKER), "utf8");

  it("routes the runner-up button through applyCategory, never clearCategory", () => {
    expect(source).toContain("onUse={applyCategory}");
    expect(source).not.toContain("onUse={clearCategory}");
  });

  it("applyCategory does not touch any aspect state", () => {
    const start = source.indexOf("function applyCategory(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("function pickCategory("));
    for (const wipe of [
      "setAspectValues",
      "setSources",
      "setAiFilled",
      "setAiMeta",
      "setPrefillHints",
    ]) {
      expect(body, `applyCategory must not call ${wipe}`).not.toContain(wipe);
    }
  });
});

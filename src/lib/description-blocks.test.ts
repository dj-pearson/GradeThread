// US-2960: the block list's array operations.
//
// The two the seller actually performs — toggle and reorder — are the two that
// can silently lose work, so they are tested here rather than inferred from a
// rendered card. The reorder case that matters is not "does arrayMove work": it
// is whether a drag that passes over a PINNED row leaves that row where it was.
// A facts block that slid up by one is US-2682's accumulate-a-second-copy bug
// coming back through the front door.
import { describe, expect, it } from "vitest";
import {
  anchorForBlock,
  appendTextBlock,
  applyWholeText,
  DEFAULT_DESCRIPTION_BLOCKS,
  describeBlock,
  isEditable,
  isPinned,
  isRegenerable,
  moveBlock,
  setBlockTextAt,
  stripRenderedBlocks,
  toggleBlockAt,
  type BlockRowContext,
} from "@/lib/description-blocks";
import type { DescriptionBlock } from "@/types/database";

const blocks = (): DescriptionBlock[] =>
  DEFAULT_DESCRIPTION_BLOCKS.map((b) => ({ ...b }));

const keys = (list: DescriptionBlock[]) => list.map((b) => b.key);

const ctx: BlockRowContext = {
  attributes: { brand: "Veronica Beard", size: "8", color: "", material: null },
  measurementCount: 6,
  unit: "in",
  gradeValue: 8.3,
  snippetNames: {},
};

describe("toggleBlockAt (US-2960)", () => {
  it("flips one row and leaves every other entry alone", () => {
    const before = blocks();
    const after = toggleBlockAt(before, 4);
    expect(after[4]?.on).toBe(false);
    expect(after[3]).toBe(before[3]);
    expect(after[5]).toBe(before[5]);
  });

  it("keeps the row's POSITION across off and back on", () => {
    // The acceptance criterion in full: switching measurements off and on again
    // must not send it to the bottom of the description.
    const before = blocks();
    const index = before.findIndex((b) => b.key === "measurements");
    const off = toggleBlockAt(before, index);
    const on = toggleBlockAt(off, index);
    expect(keys(off)).toEqual(keys(before));
    expect(keys(on)).toEqual(keys(before));
    expect(on[index]?.on).toBe(true);
  });

  it("ignores an index that is not a row", () => {
    const before = blocks();
    expect(toggleBlockAt(before, -1)).toBe(before);
    expect(toggleBlockAt(before, 99)).toBe(before);
  });
});

describe("setBlockTextAt (US-2960)", () => {
  it("writes one row's text and carries the rest by reference", () => {
    const before = blocks();
    const after = setBlockTextAt(before, 0, "Jogger-style pants.");
    expect(after[0]?.text).toBe("Jogger-style pants.");
    expect(after[1]).toBe(before[1]);
  });
});

describe("moveBlock (US-2960)", () => {
  it("reorders two movable rows", () => {
    const before = blocks(); // intro, features, attributes, condition, …
    const after = moveBlock(before, 0, 2);
    expect(keys(after).slice(0, 4)).toEqual([
      "features",
      "attributes",
      "intro",
      "condition",
    ]);
  });

  it("refuses a drag that starts on a pinned row", () => {
    const before = blocks();
    const facts = before.findIndex((b) => b.key === "facts");
    expect(moveBlock(before, facts, 0)).toBe(before);
  });

  it("refuses a drag that ends on a pinned row", () => {
    const before = blocks();
    const credentials = before.findIndex((b) => b.key === "credentials");
    expect(moveBlock(before, 0, credentials)).toBe(before);
  });

  it("leaves a pinned row at its index when a drag passes over it", () => {
    // A legacy parse can put credentials in the MIDDLE of the array, and a plain
    // arrayMove across it would slide it up by one. Both pinned rows have to
    // come back to the index they held.
    const before: DescriptionBlock[] = [
      { key: "intro", on: true, src: "ai", text: "a" },
      { key: "features", on: true, src: "ai", text: "b" },
      { key: "credentials", on: true, src: "seller" },
      { key: "condition", on: true, src: "ai", text: "c" },
      { key: "facts", on: true, src: "system" },
    ];
    const after = moveBlock(before, 0, 3);
    expect(keys(after)).toEqual([
      "features",
      "condition",
      "credentials",
      "intro",
      "facts",
    ]);
    expect(after[2]).toBe(before[2]);
    expect(after[4]).toBe(before[4]);
  });

  it("no-ops on a move to the same slot or off the ends", () => {
    const before = blocks();
    expect(moveBlock(before, 1, 1)).toBe(before);
    expect(moveBlock(before, -1, 2)).toBe(before);
    expect(moveBlock(before, 2, 99)).toBe(before);
  });
});

describe("row classification (US-2960)", () => {
  it("pins exactly the two rows the card renders without a handle", () => {
    expect(isPinned("facts")).toBe(true);
    expect(isPinned("credentials")).toBe(true);
    expect(isPinned("measurements")).toBe(false);
    expect(isPinned("intro")).toBe(false);
  });

  it("lets the seller type into their own prose and nothing else", () => {
    for (const key of ["intro", "features", "condition", "snippet", "text"] as const) {
      expect(isEditable(key), key).toBe(true);
    }
    for (const key of ["attributes", "measurements", "grade", "facts"] as const) {
      expect(isEditable(key), key).toBe(false);
    }
  });

  it("offers redo only on the three blocks the AI writes", () => {
    expect(isRegenerable("intro")).toBe(true);
    expect(isRegenerable("features")).toBe(true);
    expect(isRegenerable("condition")).toBe(true);
    expect(isRegenerable("text")).toBe(false);
    expect(isRegenerable("measurements")).toBe(false);
  });

  it("sends every derived row to a composer anchor and no editable one", () => {
    expect(anchorForBlock("attributes")).toBe("composer-category");
    expect(anchorForBlock("measurements")).toBe("composer-measurements");
    expect(anchorForBlock("grade")).toBe("composer-grading");
    expect(anchorForBlock("disclosure")).toBe("composer-grading");
    expect(anchorForBlock("intro")).toBeNull();
  });
});

describe("describeBlock (US-2960)", () => {
  it("names the attributes that are actually filled in", () => {
    const block: DescriptionBlock = {
      key: "attributes",
      on: true,
      src: "item",
      fields: ["brand", "size", "color", "material"],
    };
    expect(describeBlock(block, ctx)).toBe("Brand, Size");
  });

  it("counts measurements and names the unit", () => {
    expect(
      describeBlock({ key: "measurements", on: true, src: "item" }, ctx),
    ).toBe("6 values, inches");
    expect(
      describeBlock(
        { key: "measurements", on: true, src: "item", unit: "cm" },
        ctx,
      ),
    ).toBe("6 values, centimetres");
  });

  it("says so rather than lying when there is nothing to show", () => {
    const empty = { ...ctx, measurementCount: 0, gradeValue: null };
    expect(
      describeBlock({ key: "measurements", on: true, src: "item" }, empty),
    ).toBe("No measurements yet");
    expect(describeBlock({ key: "grade", on: true, src: "grade" }, empty)).toBe(
      "Not graded yet",
    );
    expect(
      describeBlock({ key: "intro", on: true, src: "ai", text: "  " }, ctx),
    ).toBe("Empty");
  });

  it("prefers a snippet's per-listing override over its account name", () => {
    const withNames = { ...ctx, snippetNames: { abc: "Policy note" } };
    expect(
      describeBlock({ key: "snippet", on: true, src: "account", ref: "abc" }, withNames),
    ).toBe("Policy note");
    expect(
      describeBlock(
        { key: "snippet", on: true, src: "account", ref: "abc", text: "Just this one." },
        withNames,
      ),
    ).toBe("Just this one.");
  });
});

describe("stripRenderedBlocks + applyWholeText (US-2960)", () => {
  const legacy = [
    "Veronica Beard jogger-style pants, new with tags.",
    "",
    "<!--gradethread-measurements-->",
    '- Waist (flat): 30 in',
    "<!--/gradethread-measurements-->",
    "",
    "<!--gradethread-facts--><ul><li>x</li></ul><!--/gradethread-facts-->",
    "<!--gradethread-seller-credentials--><div>23 items</div>",
  ].join("\n");

  it("keeps the prose and drops every rendered section", () => {
    const out = stripRenderedBlocks(legacy);
    expect(out).toBe("Veronica Beard jogger-style pants, new with tags.");
    expect(out).not.toContain("gradethread");
  });

  it("folds a whole-description string into intro and clears the other prose", () => {
    const before = setBlockTextAt(blocks(), 1, "Old features copy.");
    const after = applyWholeText(before, legacy);
    expect(after.find((b) => b.key === "intro")?.text).toBe(
      "Veronica Beard jogger-style pants, new with tags.",
    );
    // Otherwise the same sentence would print twice — once as the folded intro
    // and once as the features text the template it replaced had written.
    expect(after.find((b) => b.key === "features")?.text).toBe("");
    expect(after.find((b) => b.key === "condition")?.text).toBe("");
  });

  it("leaves the derived rows untouched", () => {
    const before = blocks();
    const after = applyWholeText(before, "New prose.");
    for (const key of ["attributes", "measurements", "grade", "facts"] as const) {
      const i = before.findIndex((b) => b.key === key);
      expect(after[i], key).toBe(before[i]);
    }
  });

  it("adds an intro when the array has none", () => {
    const after = applyWholeText(
      [{ key: "facts", on: true, src: "system" }],
      "Prose.",
    );
    expect(keys(after)).toEqual(["intro", "facts"]);
    expect(after[0]?.text).toBe("Prose.");
  });
});

// US-2967: a saved template's boilerplate is a FOOTER, so it gets its own block
// instead of being folded over the prose the way applyWholeText folds a whole
// description. Before this, applying a template in the composer deleted the AI
// copy the seller was reviewing.
describe("appendTextBlock (US-2967)", () => {
  const footer = "Ships in 1 business day. Smoke-free home.";

  it("leaves the three prose blocks exactly as they were", () => {
    const before = setBlockTextAt(
      setBlockTextAt(setBlockTextAt(blocks(), 0, "Intro copy."), 1, "Features copy."),
      3,
      "Condition copy.",
    );
    const after = appendTextBlock(before, footer);
    expect(after.find((b) => b.key === "intro")?.text).toBe("Intro copy.");
    expect(after.find((b) => b.key === "features")?.text).toBe("Features copy.");
    expect(after.find((b) => b.key === "condition")?.text).toBe("Condition copy.");
  });

  it("adds one editable text block the seller owns", () => {
    const after = appendTextBlock(blocks(), `  ${footer}  `);
    const added = after.find((b) => b.key === "text");
    expect(added).toEqual({ key: "text", on: true, src: "user", text: footer });
    expect(isEditable("text")).toBe(true);
  });

  it("sits in front of the pinned rows, never between them", () => {
    const k = keys(appendTextBlock(blocks(), footer));
    expect(k.indexOf("text")).toBeLessThan(k.indexOf("credentials"));
    expect(k.indexOf("text")).toBeLessThan(k.indexOf("facts"));
  });

  it("is a no-op for blank boilerplate", () => {
    const before = blocks();
    expect(appendTextBlock(before, "   ")).toBe(before);
  });
});

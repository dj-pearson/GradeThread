// US-2450: an item row names its own controls.
//
// The two halves are tested differently on purpose. itemRowLabel is a pure
// function, so it gets ordinary unit tests. Whether the LISTINGS TABLE actually
// uses it is a property of that file, so the second block reads the file as
// text — the same technique as src/test/control-labels.test.ts, and for the
// same reason: the thing that regresses is a call site, not a function.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { itemDisplayTitle, itemRowLabel, rowControlLabel } from "./item-row-label";

const TABLE_SRC = readFileSync(
  resolve(process.cwd(), "src/pages/flipdesk/listings-table.tsx"),
  "utf8",
);

describe("itemDisplayTitle (US-1569 rule, moved not changed)", () => {
  it("uses a real item title", () => {
    expect(itemDisplayTitle({ item_title: "Nike Windbreaker" })).toBe(
      "Nike Windbreaker",
    );
  });

  it("falls back to the draft's generated listing title for a placeholder", () => {
    for (const placeholder of ["Item 42", "item 7", "Untitled draft", "  ", ""]) {
      expect(
        itemDisplayTitle({
          item_title: placeholder,
          listing_title: "Vintage Levi's 501 W32",
        }),
        `"${placeholder}" should be treated as a placeholder`,
      ).toBe("Vintage Levi's 501 W32");
    }
  });

  it("does not treat a real title that merely starts with 'item' as a placeholder", () => {
    // "Item 42" is generated; "Italian wool coat" is not. The rule is anchored
    // and digit-bounded for exactly this reason.
    expect(
      itemDisplayTitle({ item_title: "Italian wool coat", listing_title: "x" }),
    ).toBe("Italian wool coat");
  });

  it("returns null when there is nothing at all to show", () => {
    expect(itemDisplayTitle({})).toBeNull();
  });

  it("still SHOWS a placeholder when no listing title has been generated yet", () => {
    // Faithful to the pre-US-2450 JSX: a draft with no generated title renders
    // "Item 3" rather than an empty cell. itemRowLabel diverges here and that
    // divergence is the point — see the placeholder case in its block below.
    expect(itemDisplayTitle({ item_title: "Item 3" })).toBe("Item 3");
  });

  it("returns the stored value untrimmed", () => {
    // This feeds rendered output. Trimming would be a silent visual change, and
    // the point of moving the rule out of the JSX was to change nothing visible.
    expect(itemDisplayTitle({ item_title: " Padded jacket " })).toBe(
      " Padded jacket ",
    );
  });
});

describe("itemRowLabel never gives two rows the same name", () => {
  it("prefers the display title", () => {
    expect(itemRowLabel({ item_title: "Nike Windbreaker" })).toBe(
      "Nike Windbreaker",
    );
  });

  it("trims, because a label is spoken and not rendered", () => {
    expect(itemRowLabel({ item_title: " Padded jacket " })).toBe("Padded jacket");
  });

  it("falls back to the item number when the only title is a placeholder", () => {
    expect(itemRowLabel({ item_title: "Item 9", item_number: "GT-1042" })).toBe(
      "item GT-1042",
    );
  });

  it("refuses a placeholder title even though the cell displays it", () => {
    // "Untitled draft" is what EVERY fresh draft is called. Speaking it would
    // name a whole screen of rows identically, which is the defect.
    expect(
      itemRowLabel({ item_title: "Untitled draft", item_number: "GT-7" }),
    ).toBe("item GT-7");
  });

  it("falls back to an id fragment when there is no number either", () => {
    expect(
      itemRowLabel({ id: "3f7a1c88-2b40-4f0e-9a11-77c2d0b5e123" }),
    ).toBe("item 3f7a1c88");
  });

  it("gives two untitled items DIFFERENT names", () => {
    // The assertion the whole module exists for. A shared constant here would
    // rebuild the defect — many controls, one name — for precisely the rows
    // most likely to be untitled, which are fresh drafts.
    const a = itemRowLabel({ id: "aaaaaaaa-1111-4111-8111-111111111111" });
    const b = itemRowLabel({ id: "bbbbbbbb-2222-4222-8222-222222222222" });
    expect(a).not.toBe(b);
  });

  it("is never empty", () => {
    for (const item of [
      {},
      { item_title: "" },
      { item_title: "   ", listing_title: "  " },
      { item_number: "  " },
    ]) {
      expect(itemRowLabel(item).trim().length).toBeGreaterThan(0);
    }
  });

  it("does not truncate a long marketplace title", () => {
    // An eBay title runs to 80 characters. Two listings often differ only in
    // their size or colourway at the END, so a truncated label would make them
    // announce identically — the defect, restored.
    const long =
      "Vintage Patagonia Synchilla Snap-T Fleece Pullover Mens Deep Sea Blue Size Large";
    expect(itemRowLabel({ item_title: long })).toBe(long);
  });
});

describe("rowControlLabel", () => {
  it("puts the action before the row", () => {
    expect(rowControlLabel("Cost", { item_title: "Nike Windbreaker" })).toBe(
      "Cost for Nike Windbreaker",
    );
  });
});

describe("the listings table names every per-row control (US-2450)", () => {
  /**
   * aria-labels in listings-table.tsx that are allowed to be a fixed string,
   * because they appear ONCE per table rather than once per row.
   *
   * Anything else fixed is the bug: a literal label in a row repeats for every
   * item on screen. Keep this list short and justified — adding an entry is
   * how this guard would be quietly switched off.
   */
  const TABLE_LEVEL_LABELS = ["Select all on page"];

  it("reads the table source", () => {
    // Guards the guard: a bad path makes every assertion below vacuous.
    expect(TABLE_SRC.length).toBeGreaterThan(10_000);
    expect(TABLE_SRC).toContain("<InlineCell");
  });

  it("has no fixed aria-label outside the table-level allowlist", () => {
    const fixed = [...TABLE_SRC.matchAll(/aria-label="([^"]*)"/g)]
      .map((m) => m[1] ?? "")
      .filter((v) => !TABLE_LEVEL_LABELS.includes(v));
    expect(
      fixed,
      `These labels are the same for every row, so a screen reader user hears ` +
        `them once per item with nothing saying which item. Interpolate ` +
        `rowLabel, or add the control to TABLE_LEVEL_LABELS if it genuinely ` +
        `renders once per table.`,
    ).toEqual([]);
  });

  it("every InlineCell and InlineStatusSelect is given the row", () => {
    // The compiler already refuses a missing prop, so this is not the primary
    // guard — it is here to catch the shortcut of passing a literal or a
    // different row's label to satisfy the type.
    const controls = TABLE_SRC.match(/<(InlineCell|InlineStatusSelect)\b/g) ?? [];
    const passes = TABLE_SRC.match(/rowLabel=\{rowLabel\}/g) ?? [];
    expect(controls.length).toBeGreaterThanOrEqual(8);
    expect(
      passes.length,
      `${controls.length} inline controls but ${passes.length} rowLabel={rowLabel} ` +
        `props. One of them is being handed something other than its own row.`,
    ).toBe(controls.length);
  });

  it("the row label is derived once per row, from the shared helper", () => {
    expect(TABLE_SRC).toContain('from "@/lib/item-row-label"');
    expect(TABLE_SRC).toContain("const rowLabel = itemRowLabel(it)");
    // Exactly one derivation. A second would be the door back to the title
    // disagreement this replaced, where the row's own activate label skipped
    // the placeholder fallback the title cell applied.
    expect((TABLE_SRC.match(/itemRowLabel\(/g) ?? []).length).toBe(1);
  });

  it("the row's own activate label uses it too", () => {
    // ClickableRow takes activateLabel, not aria-label, so the fixed-label scan
    // above cannot see it — and it was the one that had drifted, announcing
    // "Open Item 42" for a row displaying "Nike Windbreaker".
    expect(TABLE_SRC).toContain("activateLabel={`Open ${rowLabel}`}");
  });

  it("the visible title and the spoken label share one rule", () => {
    // The placeholder regexes moved into the helper. If they come back here,
    // the two derivations can drift again.
    expect(TABLE_SRC).toContain("itemDisplayTitle(it)");
    expect(TABLE_SRC).not.toMatch(/\/\^item\\s\+\\d\+\$\/i\.test/);
  });
});

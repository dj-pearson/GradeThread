// US-2960: the description card, rendered.
//
// renderToStaticMarkup is the repo's convention here (no @testing-library), so
// what this can assert is first paint: which rows exist, what they are called,
// which of them carry a drag handle, and which controls a row offers. That is
// exactly the set that rots silently — a pinned row that quietly grows a handle,
// a derived row that starts offering an Edit button for text it does not have.
//
// The array operations behind the interactions are covered directly in
// src/lib/description-blocks.test.ts, which is where the state actually lives.
import type React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DescriptionCard } from "@/components/flipdesk/composer/description-card";
import { DEFAULT_DESCRIPTION_BLOCKS } from "@/lib/description-blocks";
import type { DescriptionBlock } from "@/types/database";

const rowContext = {
  attributes: { brand: "Veronica Beard", size: "8" },
  measurementCount: 6,
  unit: "in" as const,
  gradeValue: 8.3,
  snippetNames: {},
};

const base: React.ComponentProps<typeof DescriptionCard> = {
  blocks: DEFAULT_DESCRIPTION_BLOCKS.map((b) => ({ ...b })) as DescriptionBlock[],
  onBlocksChange: () => {},
  preview: "Veronica Beard jogger-style pants, new with tags.",
  previewPending: false,
  previewAvailable: true,
  blocksLoading: false,
  unavailable: false,
  converted: false,
  rowContext,
  onRegenerate: () => {},
  regenerating: null,
  onGoToField: () => {},
  group: "pants",
  applyTemplate: () => {},
  photoCount: 3,
  aiRewrite: { isPending: false },
  rewriteAction: null,
  runRewrite: () => {},
  aiSnapshot: null,
  onRevertToAi: () => {},
  isEbayOrigin: false,
  ebayOwnedHint: undefined,
};

const markup = (over: Partial<React.ComponentProps<typeof DescriptionCard>> = {}) =>
  renderToStaticMarkup(<DescriptionCard {...base} {...over} />);

describe("DescriptionCard rows (US-2960)", () => {
  it("renders one row per block, with its source tag", () => {
    const html = markup();
    for (const label of [
      "Intro",
      "Features",
      "Attributes",
      "Condition",
      "Measurements",
      "Grade badge",
      "Grade disclosure",
      "Verified seller",
      "Item facts",
    ]) {
      expect(html, label).toContain(`>${label}<`);
    }
    expect(html).toContain(">AI<");
    expect(html).toContain(">Item<");
    expect(html).toContain(">System<");
  });

  it("gives every movable row a drag handle and the pinned two none", () => {
    const html = markup();
    for (const label of ["Intro", "Attributes", "Measurements", "Grade badge"]) {
      expect(html, label).toContain(`aria-label="Reorder ${label}"`);
    }
    // Pinned: facts is fixed last for US-2682's replace-in-place revise, and
    // credentials is server-owned. A handle that snapped back would be worse
    // than no handle at all.
    expect(html).not.toContain('aria-label="Reorder Item facts"');
    expect(html).not.toContain('aria-label="Reorder Verified seller"');
  });

  it("offers Edit and redo on prose rows, and go-to-field on derived ones", () => {
    const html = markup();
    expect(html).toContain('aria-label="Edit Intro"');
    expect(html).toContain('aria-label="Rewrite Intro with AI"');
    expect(html).toContain('aria-label="Go to the Measurements fields"');
    expect(html).toContain('aria-label="Go to the Attributes fields"');
    // A derived row has no text of its own, so there is nothing to open.
    expect(html).not.toContain('aria-label="Edit Measurements"');
    expect(html).not.toContain('aria-label="Rewrite Attributes with AI"');
  });

  it("dims a switched-off row and keeps it in the list", () => {
    const blocks = base.blocks.map((b) =>
      b.key === "measurements" ? { ...b, on: false } : b,
    );
    const html = markup({ blocks });
    expect(html).toContain(">Measurements<");
    expect(html).toContain("opacity-50");
  });

  it("summarises a row rather than repeating the preview", () => {
    const html = markup();
    expect(html).toContain("6 values, inches");
    expect(html).toContain("Brand, Size");
    expect(html).toContain("8.3 / 10");
  });

  it("shows a character count and keeps the preview closed by default", () => {
    const html = markup();
    expect(html).toContain("Preview what eBay receives");
    expect(html).toContain(`${base.preview.length} characters`);
    // Closed: the panel's textarea is not in the first paint.
    expect(html).not.toContain('aria-label="Rendered description preview"');
  });

  it("says the preview needs a saved row rather than showing an empty one", () => {
    const html = markup({ previewAvailable: false, preview: "" });
    expect(html).toContain("0 characters");
  });

  it("explains a legacy conversion without claiming anything was written", () => {
    const html = markup({ converted: true });
    expect(html).toContain("nothing changes until you save");
  });

  it("says so when the blocks never loaded", () => {
    const html = markup({ unavailable: true });
    expect(html).toContain("nothing here will");
    expect(html).toContain("the description is");
  });

  it("locks every row on an eBay-originated listing", () => {
    const html = markup({
      isEbayOrigin: true,
      ebayOwnedHint: "eBay owns this listing's description.",
    });
    expect(html).not.toContain('aria-label="Reorder Intro"');
    expect(html).toContain("disabled");
  });
});

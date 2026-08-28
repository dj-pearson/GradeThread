// US-2962 AC1: the bulk grid gets the toggle set and nothing else.
//
// The negative half is the one worth guarding. A textarea in this toolbar would
// look like a convenience and would be a way to paste the same paragraph onto
// forty listings — which is exactly what the block split exists to stop. So this
// asserts on the SOURCE that no text editor reached the bulk surface, as well as
// on the markup that the three-state control is there.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DescriptionBlocksBulk } from "@/pages/flipdesk/autolister/description-blocks-bulk";
import { BULK_TOGGLE_KEYS, BULK_TOGGLE_LABELS } from "@/lib/description-block-bulk";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PANEL = "src/pages/flipdesk/autolister/description-blocks-bulk.tsx";
const GRID = "src/pages/flipdesk/autolister-bulk-edit.tsx";

const markup = (ids: string[]) =>
  renderToStaticMarkup(
    <DescriptionBlocksBulk targetIds={ids} onApplied={() => {}} />,
  );

describe("the bulk surface offers toggles only (AC1)", () => {
  const panel = read(PANEL);

  it("has no text editor of any kind", () => {
    // The needles are ASSEMBLED rather than written out, because a literal
    // "<Textarea" in this file reads as real JSX to the source scanners that
    // walk src/ — control-labels.test.ts counted two of them here.
    for (const name of ["Textarea", "Input"]) {
      expect(panel, name).not.toContain(`<${name}`);
    }
    expect(panel).not.toContain("contentEditable");
    // And it never writes a block's text, only its `on` flag.
    expect(panel).not.toContain("setBlockTextAt");
    expect(read("src/lib/description-block-bulk.ts")).not.toContain("text:");
  });

  it("names every section on the list", () => {
    const html = markup(["a", "b"]);
    // The trigger is what renders on first paint; the popover body is portalled
    // and opens on click, so the labels are asserted against the set the panel
    // maps over rather than against closed markup.
    expect(html).toContain("Description sections");
    for (const key of BULK_TOGGLE_KEYS) {
      expect(panel).toContain("BULK_TOGGLE_LABELS[key]");
      expect(BULK_TOGGLE_LABELS[key], key).toBeTruthy();
    }
  });

  it("offers Leave, Show and Hide, with Leave the default", () => {
    // Two states would force a value onto every section the seller never
    // touched: unticking one box would also assert "and hide the grade badge".
    expect(panel).toContain('{ value: "keep", label: "Leave" }');
    expect(panel).toContain('{ value: "on", label: "Show" }');
    expect(panel).toContain('{ value: "off", label: "Hide" }');
    expect(panel).toContain('toggles[key] ?? "keep"');
    expect(panel).toContain("useState<BlockToggleSet>({})");
  });

  it("names each option button after the section it belongs to", () => {
    // Eight sections means eight buttons reading "Hide". US-2450's rule.
    expect(panel).toContain("aria-label={`${o.label} ${BULK_TOGGLE_LABELS[key]}`}");
  });

  it("says how many listings it will touch, and that drafts are the limit", () => {
    expect(markup(["a", "b", "c"])).toContain("Description sections");
    expect(panel).toContain("Only drafts are");
    expect(panel).toContain("Apply to {targetIds.length}");
  });
});

describe("the grid wires it without taking on the work (AC2)", () => {
  const grid = read(GRID);

  it("renders the panel with the current target set", () => {
    expect(grid).toContain("<DescriptionBlocksBulk");
    expect(grid).toContain("targetIds={[...targetIds]}");
    expect(grid).toContain('queryKey: ["autolister_batch_drafts", batchId]');
  });

  it("keeps the block work out of the page itself", () => {
    // The page is on a shrink-only ceiling (autolister-split.test.ts), and the
    // reason the panel is its own module is that the ceiling is the point.
    expect(grid).not.toContain("applyBlockToggles");
    expect(grid).not.toContain("BULK_TOGGLE_KEYS");
  });

  it("goes through the description save route, not a direct column write", () => {
    const lib = read("src/lib/description-block-bulk.ts");
    expect(lib).toContain("/api/flipdesk/description/${id}/save");
    expect(lib).toContain("/api/flipdesk/description/${id}/blocks");
    // A direct update of listing_description here would leave description_blocks
    // saying something else — the exact drift the single persist path prevents.
    expect(lib).not.toContain("listing_description");
    expect(lib).not.toContain(".update(");
  });
});

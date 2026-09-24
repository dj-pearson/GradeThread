// AL-14: the workbench has to work by touch. Hover never fires on a phone, so
// a control that only appears on hover is a control a phone cannot reach, and
// a drag handle without touch-action: none scrolls the page instead of
// dragging.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import { describe, expect, it } from "vitest";
import { GroupSuggestionChips } from "@/pages/flipdesk/autolister/suggestion-chips";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("AutoLister touch targets (AL-14)", () => {
  it("every hover-only tile control is also shown where there is no hover", () => {
    for (const rel of [
      "src/pages/flipdesk/autolister.tsx",
      "src/pages/flipdesk/autolister/photo-drag-tiles.tsx",
    ]) {
      const src = read(rel);
      const hoverOnly = src
        .split("\n")
        .filter((l) => /opacity-0/.test(l) && /group-hover:opacity-100/.test(l))
        .filter((l) => !l.includes("[@media(hover:none)]:opacity-100"));
      expect(hoverOnly, `${rel} has hover-only controls`).toEqual([]);
    }
  });

  it("the drag handle is touch-none, so a phone drags instead of scrolling", () => {
    const src = read("src/pages/flipdesk/autolister/photo-drag-tiles.tsx");
    expect(src).toMatch(/cursor-grab touch-none/);
  });

  it("a suggestion chip shows its reason and has a 24px dismiss target", () => {
    const html = renderToStaticMarkup(
      h(GroupSuggestionChips, {
        suggestions: [
          { id: "s1", text: "Merge?", label: "Merge", confidence: 0.8, reason: "Same logo" },
        ],
        onApply: () => {},
        onDismiss: () => {},
      }),
    );
    expect(html).toContain("(Same logo)");
    expect(html).toMatch(/h-6 w-6/);
  });
});

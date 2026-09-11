// US-3336: the pins on the outline, and the words a screen reader gets instead.
// renderToStaticMarkup is the repo's convention (no @testing-library/react).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FlawMap } from "@/components/certificate/flaw-map";
import type { AnnotatedPhotoGroup } from "@/components/certificate/annotated-defect-photo";

const bbox: [number, number, number, number] = [0.1, 0.1, 0.1, 0.1];
const groups: AnnotatedPhotoGroup[] = [
  {
    image_type: "front",
    annotations: [
      { n: 1, issue: "Hole", severity: "major", location: "collar", bbox },
    ],
  },
  {
    // A close-up whose words name no zone: nothing to place it by.
    image_type: "detail",
    annotations: [{ n: 2, issue: "Snag", severity: "minor", location: "unclear spot", bbox }],
  },
];

describe("FlawMap", () => {
  it("draws a numbered pin for each placed flaw, and hides the drawing from screen readers", () => {
    const html = renderToStaticMarkup(<FlawMap groups={groups} garmentCategory="shirt" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/<circle/g)).toHaveLength(1);
    expect(html).toMatch(/<text[^>]*>1<\/text>/);
  });

  it("says every flaw in words, including the one it could not place", () => {
    const html = renderToStaticMarkup(<FlawMap groups={groups} garmentCategory="shirt" />);
    expect(html).toContain("Flaw 1: ");
    expect(html).toContain("collar or neckline");
    expect(html).toContain("Flaw 2: ");
    expect(html).toContain("location not mapped");
  });

  it("renders nothing for a garment with no outline, or when no flaw can be placed", () => {
    expect(renderToStaticMarkup(<FlawMap groups={groups} garmentCategory="sneakers" />)).toBe("");
    const none: AnnotatedPhotoGroup[] = [
      { image_type: "detail", annotations: [{ n: 1, issue: "Snag", severity: "minor", location: "", bbox }] },
    ];
    expect(renderToStaticMarkup(<FlawMap groups={none} garmentCategory="shirt" />)).toBe("");
  });
});

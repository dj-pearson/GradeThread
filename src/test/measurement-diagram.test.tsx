import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BottomMeasurementDiagram,
  DIAGRAMMED_MEASUREMENTS,
  TopMeasurementDiagram,
  howtoMeasurementKeys,
} from "@/components/marketing/measurement-diagram";

// US-9007. The converter page describes nine measurements in prose, which is
// the part a search engine reads, and draws them, which is the part a
// first-time seller needs — "front rise" and "pit to pit" are not picturable
// from a sentence. The guard that matters is coverage: a measurement added to
// MEASUREMENT_HOWTO without a line drawn for it would leave the diagram quietly
// incomplete, and nothing else would notice.

describe("the measurement diagrams (US-9007)", () => {
  it("draws every measurement the page describes, and no others", () => {
    expect([...DIAGRAMMED_MEASUREMENTS].sort()).toEqual(
      [...howtoMeasurementKeys()].sort(),
    );
  });

  it("survives the prerender as static markup with selectable labels", () => {
    const html =
      renderToStaticMarkup(<TopMeasurementDiagram />) +
      renderToStaticMarkup(<BottomMeasurementDiagram />);
    for (const label of [
      "Pit to pit",
      "Shoulder",
      "Sleeve",
      "Length",
      "Waist",
      "Hip",
      "Front rise",
      "Inseam",
      "Leg opening",
    ]) {
      expect(html, `missing label: ${label}`).toContain(`>${label}</text>`);
    }
  });

  it("carries a described alternative for a screen reader", () => {
    const html = renderToStaticMarkup(<TopMeasurementDiagram />);
    expect(html).toContain('role="img"');
    expect(html).toContain("<title");
    expect(html).toContain("one inch below the armpit seams");
  });

  it("emphasises only the selected measurement", () => {
    const plain = renderToStaticMarkup(<TopMeasurementDiagram />);
    const picked = renderToStaticMarkup(<TopMeasurementDiagram highlight="chest" />);
    expect(plain).not.toContain("text-brand-red-text");
    expect(picked).toContain("text-brand-red-text");
    // Everything else dims rather than disappearing: the diagram still has to
    // read as a whole garment when one tape is picked out.
    expect(picked).toContain("Shoulder");
    expect(picked).toContain('opacity="0.45"');
  });

  it("inherits the theme instead of hardcoding a palette", () => {
    const html =
      renderToStaticMarkup(<TopMeasurementDiagram />) +
      renderToStaticMarkup(<BottomMeasurementDiagram />);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).toContain('stroke="currentColor"');
  });
});

// US-432's head-integrity guard counts <title> elements and fails the build on
// more than one, because a Helmet title leaking into the SSR body is a real
// bug it caught before. An inline SVG's <title> is a different thing entirely —
// it is the drawing's accessible name — and it tripped the same check. The
// guard now strips SVG before counting; this asserts the relaxation is exactly
// that narrow, because a guard that stops catching what it was built for is
// worse than no guard.
describe("the prerender head guard still catches leaks (US-432)", () => {
  const src = readFileSync(join(__dirname, "../../scripts/prerender.mjs"), "utf8");
  const withoutSvg = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/gi, "");

  it("strips SVG rather than loosening the title pattern", () => {
    expect(src).toContain("function withoutSvg(");
    // The count itself must still be an exact-one assertion.
    expect(src).toContain("expected exactly 1 <title>");
  });

  it("ignores a title inside an SVG", () => {
    expect(withoutSvg('<p>x</p><svg><title>Diagram</title></svg>')).toBe("<p>x</p>");
  });

  it("still sees a title that leaked into the body outside an SVG", () => {
    const leaked = '<div><title>Leaked</title></div><svg><title>Fine</title></svg>';
    expect(withoutSvg(leaked)).toContain("<title>Leaked</title>");
  });
});

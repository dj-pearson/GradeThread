// US-3307 AC2: the seller-visible path to record the real maker.
//
// Rendered with renderToStaticMarkup (the repo's convention here, no
// @testing-library), so these run headless and still catch the things that
// matter: the panel must appear exactly when the brand column holds something
// that is not a maker, it must not nag a seller whose brand is fine, and it must
// never treat a recorded "Unbranded" as a gap.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BrandFieldNotice } from "@/components/flipdesk/brand-field-notice";

const render = (brand: string | null) =>
  renderToStaticMarkup(
    <BrandFieldNotice brand={brand} onRecordMaker={() => {}} />,
  );

describe("BrandFieldNotice", () => {
  it("says nothing when a real maker is on file", () => {
    expect(render("Patagonia")).toBe("");
    expect(render("Gildan")).toBe("");
    // An ordinary word that is a real house must not trip it.
    expect(render("MOTHER")).toBe("");
  });

  it("names what a licensor actually is and offers the maker field", () => {
    const html = render("Norman Rockwell");
    expect(html).toContain("Norman Rockwell is not the maker");
    expect(html).toContain("licensed onto the shirt");
    expect(html).toContain("Maker on the neck or care tag");
    expect(html).toContain("Save maker");
    // And it keeps the value useful rather than telling the seller to delete it.
    expect(html).toContain("as a listing keyword");
  });

  it("names a fibre as a fibre", () => {
    const html = render("Cashmere");
    expect(html).toContain("Cashmere is not the maker");
    expect(html).toContain("what the garment is made of");
  });

  it("prompts on an empty brand without accusing the seller of anything", () => {
    const html = render(null);
    expect(html).toContain("No maker recorded for this item");
    expect(html).toContain("mark the item Unbranded if it genuinely carries no label");
    // Nothing to quote back, so the keep-it-as-a-keyword line stays away.
    expect(html).not.toContain("as a listing keyword");
  });

  it("treats Unknown as a gap and Unbranded as an answer", () => {
    const unknown = render("Unknown");
    expect(unknown).toContain("No maker recorded for this item");
    expect(unknown).toContain("Save maker");

    // AC4: the recorded answer gets an acknowledgement, not a form.
    const unbranded = render("Unbranded");
    expect(unbranded).toContain("carries no maker&#x27;s label");
    expect(unbranded).toContain("That is an answer, not a");
    expect(unbranded).not.toContain("Save maker");
    expect(unbranded).not.toContain("No label</button>");
  });

  it("always offers the explicit No label button on a gap", () => {
    // The whole AC4 point: a seller should never have to express "no label" by
    // typing "none" or by leaving the field blank and hoping.
    for (const value of [null, "", "Unknown", "Norman Rockwell", "Goodwill"]) {
      expect(render(value), String(value)).toContain("No label");
    }
  });
});

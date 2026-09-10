// US-3283: the size guide panel.
//
// Rendered with renderToStaticMarkup, this repo's convention. The body is
// asserted directly rather than through the trigger — a Radix dialog's content
// lives behind a portal, which the static renderer emits as nothing, so going
// through the button would only prove that a closed dialog is closed.
//
// What is worth asserting here is everything the old Google link could not do:
// the brand's own numbers on screen, the item's row marked, a column the band
// table cannot represent still printed, and honest wording about what the
// numbers mean.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SizeGuideBody } from "../size-guide-panel";
import { NO_SIZE_BANDS } from "@/lib/size-bands";
import type { SizeBandsResponse, SizeGuideChart } from "@/lib/size-check";

const LULU_MENS_TOPS: SizeGuideChart = {
  brand: "Lululemon",
  department: "Men",
  garment: "Tops",
  note: "Lululemon men's tops run slim through the chest.",
  sizeSystem: "alpha",
  sizeClass: "standard",
  measurementBasis: "body",
  sourceUrl: "https://shop.lululemon.com/help/size-guide",
  tier: "brand",
  columns: [
    { key: "chest", label: "Chest", bandKey: "chest" },
    { key: "waist", label: "Waist", bandKey: "waist" },
  ],
  rows: [
    { size: "S", index: 0, values: { chest: "35-37", waist: "29-31" }, footnote: null },
    { size: "M", index: 1, values: { chest: "38-40", waist: "32-34" }, footnote: null },
    { size: "L", index: 2, values: { chest: "41-43", waist: "35-37" }, footnote: null },
  ],
};

const LULU_WOMENS_TOPS: SizeGuideChart = {
  ...LULU_MENS_TOPS,
  department: "Women",
  note: null,
  rows: [
    { size: "4", index: 0, values: { chest: "33", waist: "26" }, footnote: null },
    { size: "6", index: 1, values: { chest: "34.5", waist: "27.5" }, footnote: null },
  ],
};

function bandsFor(over: Partial<SizeBandsResponse> = {}): SizeBandsResponse {
  return {
    ...NO_SIZE_BANDS,
    tier: "brand",
    brandLabel: "Lululemon",
    department: "Men",
    garment: "Tops",
    sourceUrl: "https://shop.lululemon.com/help/size-guide",
    rows: [
      { size: "S", index: 0, bands: { chest: [19, 23.5] } },
      { size: "M", index: 1, bands: { chest: [20.5, 25] } },
      { size: "L", index: 2, bands: { chest: [22, 26.5] } },
    ],
    chart: LULU_MENS_TOPS,
    alternates: [],
    ...over,
  };
}

function render(over: Partial<Parameters<typeof SizeGuideBody>[0]> = {}): string {
  return renderToStaticMarkup(
    <SizeGuideBody
      brand="Lululemon"
      group="top"
      bands={bandsFor()}
      size="M"
      values={{ chest: 21 }}
      {...over}
    />,
  );
}

describe("the chart itself", () => {
  it("prints the brand's own numbers rather than sending the seller away", () => {
    const html = render();
    expect(html).toContain("38-40");
    expect(html).toContain("41-43");
    expect(html).toContain("Chest");
    expect(html).toContain("Waist");
  });

  it("marks the row the item's size resolves to", () => {
    const html = render({ size: "Medium" });
    // "Medium" and "M" are the same row — the panel reuses the size check's
    // matcher rather than comparing strings.
    const marked = html.split("This item");
    expect(marked).toHaveLength(2);
    expect(marked[0]).toContain(">M");
  });

  it("marks nothing when the size matches no row", () => {
    expect(render({ size: "42R" })).not.toContain("This item");
  });

  it("prints a column the band table has no representation for", () => {
    const footwear: SizeGuideChart = {
      ...LULU_MENS_TOPS,
      garment: "Footwear (US/UK/EU)",
      columns: [
        { key: "us", label: "US", bandKey: null },
        { key: "uk", label: "UK", bandKey: null },
        { key: "eu", label: "EU", bandKey: null },
      ],
      rows: [{ size: "US 9", index: 0, values: { us: "9", uk: "8", eu: "42.5" }, footnote: null }],
    };
    const html = render({
      group: "shoes",
      bands: bandsFor({ chart: footwear, rows: [] }),
    });
    expect(html).toContain("42.5");
    expect(html).toContain(">UK<");
  });

  it("renders a row footnote under the table rather than inside a cell", () => {
    const withNote: SizeGuideChart = {
      ...LULU_MENS_TOPS,
      rows: [
        {
          size: "XL",
          index: 0,
          values: { chest: "44-46" },
          footnote: "The run skips 35 and 37.",
        },
      ],
    };
    const html = render({ bands: bandsFor({ chart: withNote }) });
    expect(html).toContain("The run skips 35 and 37.");
    expect(html).toContain("<li>");
  });
});

describe("saying what the numbers mean", () => {
  it("warns that a body chart is not a flat measurement", () => {
    expect(render()).toContain("BODY measurements");
  });

  it("says so plainly when the chart is already flat", () => {
    const html = render({
      bands: bandsFor({
        chart: { ...LULU_MENS_TOPS, measurementBasis: "flat" },
      }),
    });
    expect(html).toContain("taken flat");
    expect(html).not.toContain("BODY measurements");
  });

  it("names the tier so an estimate is never mistaken for the brand's guide", () => {
    // Apostrophes come back as &#x27; from the static renderer, so the
    // assertion takes the half of the sentence that carries the claim.
    expect(render()).toContain("published guide");
    const generic = render({
      bands: bandsFor({ chart: { ...LULU_MENS_TOPS, tier: "generic" } }),
    });
    expect(generic).toContain("we have no chart for this brand yet");
  });

  it("carries the chart's own note through", () => {
    expect(render()).toContain("run slim through the chest");
  });
});

describe("the outbound link", () => {
  it("points at the brand's own guide when the chart carries one", () => {
    const html = render();
    expect(html).toContain("https://shop.lululemon.com/help/size-guide");
    expect(html).not.toContain("google.com/search");
  });

  it("falls back to the search only when there is no source URL", () => {
    const html = render({
      bands: bandsFor({ chart: { ...LULU_MENS_TOPS, sourceUrl: null }, sourceUrl: null }),
    });
    expect(html).toContain("google.com/search");
  });
});

describe("more than one department", () => {
  it("offers the other chart instead of hiding it", () => {
    const html = render({
      size: null,
      bands: bandsFor({ alternates: [LULU_WOMENS_TOPS] }),
    });
    // Two picker buttons, one per department, and only one of them pressed.
    expect(html.match(/aria-pressed=/g)).toHaveLength(2);
    expect(html).toContain("Men");
    expect(html).toContain("Women");
  });

  it("shows no picker when the brand publishes one chart", () => {
    expect(render()).not.toContain("aria-pressed=");
  });
});

describe("with no chart at all", () => {
  it("still draws where to measure, and says why the run is missing", () => {
    const html = render({ bands: bandsFor({ chart: null, rows: [] }) });
    expect(html).toContain("We have no chart for this brand yet");
    expect(html).toContain("<svg");
    expect(html).toContain("Chest");
    expect(html).not.toContain("<table");
  });
});

describe("the diagram", () => {
  it("draws the lines this garment group's form asks for", () => {
    const html = render({ group: "bottom", bands: bandsFor({ chart: null }) });
    expect(html).toContain("Waist");
    expect(html).toContain("Inseam");
    expect(html).toContain("Leg opening");
    // A tops-only measurement must not appear on a bottoms diagram.
    expect(html).not.toContain("Sleeve");
  });

  it("names the measurements in its accessible label", () => {
    const html = render({ group: "shoes", bands: bandsFor({ chart: null }) });
    expect(html).toContain("Where to measure: Insole");
  });
});

describe("where the item's own numbers land", () => {
  it("agrees with the inline check rather than making a second claim", () => {
    // 21in flat chest sits inside the M band [20.5, 25] on the fixture.
    expect(render({ size: "M", values: { chest: 21 } })).toContain(
      "Your measurements agree with M.",
    );
    expect(render({ size: "L", values: { chest: 21 } })).toContain(
      "land closer to M than to L",
    );
  });

  it("says nothing when the item has no size", () => {
    expect(render({ size: null })).not.toContain("Your measurements");
  });
});

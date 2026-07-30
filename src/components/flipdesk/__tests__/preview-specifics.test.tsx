// US-2255: the composer preview used to render a hardcoded six-row specifics
// table (Brand/Style/Size/Category/Condition/Grade), so a seller who filled
// fifteen eBay item specifics saw four of them. The preview is the only place to
// check that work before publishing, and it was quietly disagreeing with what
// would actually go to eBay.
//
// Rendered markup is asserted via renderToStaticMarkup (the repo's convention —
// no @testing-library here). That means the collapsed state is what renders on
// first paint; the toggle itself is asserted as present with the right label and
// count, which is the part that can silently rot.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EbayViewItemPreview } from "@/components/flipdesk/ebay-view-item-preview";

const base = {
  title: "Nike Vintage Hoodie Large",
  price: 48,
  photos: [],
  primaryPhotoId: null,
  conditionLabel: "Pre-owned - Excellent",
  description: "A hoodie.",
  shippingCost: null,
  shippingPolicyName: null,
  returnPolicyName: null,
  showBadge: false,
  gradeValue: null,
};

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    label: `Aspect ${i + 1}`,
    value: `Value ${i + 1}`,
  }));

const markup = (specifics: { label: string; value: string }[]) =>
  renderToStaticMarkup(<EbayViewItemPreview {...base} specifics={specifics} />);

describe("EbayViewItemPreview item specifics", () => {
  it("renders specifics beyond the old hardcoded six", () => {
    const html = markup([
      { label: "Sleeve Length", value: "Long Sleeve" },
      { label: "Pattern", value: "Solid" },
      { label: "Closure", value: "Pullover" },
    ]);
    for (const text of [
      "Sleeve Length",
      "Long Sleeve",
      "Pattern",
      "Solid",
      "Closure",
      "Pullover",
    ]) {
      expect(html).toContain(text);
    }
  });

  it("shows an ordinary listing's specifics without collapsing", () => {
    const html = markup(rows(12));
    expect(html).toContain("Aspect 12");
    expect(html).not.toContain("Show all");
  });

  it("collapses a long list behind a labelled show-all toggle", () => {
    const html = markup(rows(18));
    expect(html).toContain("Aspect 12");
    expect(html).not.toContain("Aspect 13");
    expect(html).toContain("Show all 18 item specifics");
  });

  it("renders no specifics block at all when there are none", () => {
    expect(markup([])).not.toContain("Item specifics");
  });
});

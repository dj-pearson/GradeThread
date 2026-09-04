import { describe, it, expect } from "vitest";
import { queueRowTitle } from "@/pages/flipdesk/autolister/queue-row-title";

// The queue used to label every row with the inventory item's title, which for
// an AutoLister upload is the "Item 3" placeholder it was seeded with. The AI
// writes its title to the listing, so a finished batch read as six rows named
// Item 1..6 and the seller had to open each one to learn what it was.
describe("queueRowTitle", () => {
  it("prefers the generated listing title over the seeded item placeholder", () => {
    expect(
      queueRowTitle({
        generated: "Patagonia Better Sweater Fleece Jacket Men's L Navy",
        itemTitle: "Item 3",
        ordinal: 3,
      }),
    ).toBe("Patagonia Better Sweater Fleece Jacket Men's L Navy");
  });

  it("falls back to the item title while the draft has no title yet", () => {
    expect(queueRowTitle({ generated: null, itemTitle: "Item 3", ordinal: 3 })).toBe(
      "Item 3",
    );
    expect(queueRowTitle({ generated: "   ", itemTitle: "Item 3", ordinal: 3 })).toBe(
      "Item 3",
    );
  });

  it("names the batch position when neither title exists", () => {
    expect(queueRowTitle({ generated: undefined, itemTitle: "", ordinal: 4 })).toBe(
      "Generation 4",
    );
    expect(queueRowTitle({ generated: null, itemTitle: null, ordinal: undefined })).toBe(
      "Generation",
    );
  });

  it("trims whitespace the AI or the seller left on the title", () => {
    expect(queueRowTitle({ generated: "  Levi's 501 W32 L32  ", itemTitle: "x", ordinal: 1 }))
      .toBe("Levi's 501 W32 L32");
  });
});

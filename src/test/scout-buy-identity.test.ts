// US-2763 AC6: a visual-search outcome cannot silently populate a saved field.
//
// The edge is only half of this. It now sends `identityIsAuthoritative` beside
// `matchedTitle` — but scout-buy.tsx was reading the title and saving it, and a
// server that labels its guess correctly to a client that ignores the label has
// changed nothing.
//
// THE CONCRETE CASE, from the US-2758 spike: a teal athletic tank with no brand
// mark anywhere in the frame returned five Lululemon tanks. Before this, tapping
// Buy saved that item as "Lululemon Womens Tank Top Sleeveless Blue".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = "src/pages/flipdesk/scout-buy.tsx";

/**
 * The title expression as scout-buy actually computes it.
 *
 * Mirrored rather than imported because it lives inline in a JSX onClick and
 * there is no seam to import. The source assertion below is what keeps this
 * mirror honest — it fails if the real expression stops matching this shape.
 */
function titleFor(
  result: { matchedTitle: string | null; identityIsAuthoritative?: boolean },
  keyword: string,
): string {
  return (result.identityIsAuthoritative ? result.matchedTitle : null) ||
    keyword.trim() || "Scout item";
}

describe("US-2763 AC6: a guessed identity cannot name a saved item", () => {
  it("a visual match does NOT become the item title", () => {
    const title = titleFor(
      {
        matchedTitle: "Lululemon Womens Tank Top Sleeveless Blue",
        identityIsAuthoritative: false,
      },
      "blue tank",
    );
    expect(title).toBe("blue tank");
    expect(title).not.toContain("Lululemon");
  });

  it("what the seller typed beats a guess", () => {
    const title = titleFor(
      { matchedTitle: "Somebody Else's Listing Title", identityIsAuthoritative: false },
      "  carhartt jacket  ",
    );
    expect(title).toBe("carhartt jacket");
  });

  it("a barcode match DOES name the item", () => {
    // The other side. Without this the gate could refuse every title and the
    // tests above would still pass.
    const title = titleFor(
      { matchedTitle: "Faherty Reserve Movement Polo", identityIsAuthoritative: true },
      "polo",
    );
    expect(title).toBe("Faherty Reserve Movement Polo");
  });

  it("an unlabelled response is treated as a guess, not as permission", () => {
    // An older edge build, or any response that omits the flag. Absent must not
    // read as authoritative.
    const title = titleFor(
      { matchedTitle: "Some Listing Title" } as { matchedTitle: string | null },
      "tank",
    );
    expect(title).toBe("tank");
  });

  it("falls back to a placeholder only when there is nothing at all", () => {
    expect(titleFor({ matchedTitle: null, identityIsAuthoritative: false }, "  "))
      .toBe("Scout item");
  });

  it("the real component gates on identityIsAuthoritative", () => {
    // Keeps the mirror above honest. If scout-buy goes back to reading
    // matchedTitle directly, this fails even though every case above passes.
    const src = readFileSync(SRC, "utf8");
    expect(
      /identityIsAuthoritative\s*\?\s*result\.matchedTitle\s*:\s*null/.test(src),
      "scout-buy.tsx no longer gates the saved title on identityIsAuthoritative, " +
        "so a visual-search guess can become an inventory item's name again",
    ).toBe(true);
    expect(
      /title:\s*result\.matchedTitle\s*\|\|/.test(src),
      "scout-buy.tsx reads matchedTitle straight into the title again",
    ).toBe(false);
  });
});

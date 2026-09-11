// US-3042 AC8: eBay attribution on every web surface that shows eBay data.
//
// WHY THIS FILE EXISTS. The criterion says "every surface". Until now the web
// app had the notice on exactly two of them and nothing anywhere said which
// surfaces were supposed to have it, so a reader could not tell "this surface
// needs no notice" from "this surface was forgotten". That is the same hole
// US-3112 closed on the browser extension, and the extension's registry
// (extension-unified/test/ebay-attribution.test.cjs) is the model for this one.
//
// The output of US-3042 is a claim made to eBay. A compliance claim with no
// guard behind it is worth nothing, so the decision about each surface is
// written down here in one of two lists, and BOTH lists fail when they stop
// matching the tree:
//
//   REQUIRED  renders third-party eBay content and must mount the notice
//   EXEMPT    renders eBay-derived data and deliberately does not, with a
//             reason. An exempt file that STARTS rendering the notice fails
//             too, so the list can only shrink.
//
// Deliberately a source scan and not a render test. What is being asserted is
// WHERE a component is mounted, which is the one thing a scan is right for
// (see the repo's guards-that-do-not-guard notes): rendering scout.tsx would
// need the whole router, the query client and a fake eBay, and would still only
// prove the one branch the fixture happened to take.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const COMPONENT = "src/components/marketplace/ebay-attribution.tsx";

/**
 * Surfaces that render THIRD-PARTY eBay content - other sellers' listings, or
 * eBay's own catalog - and must carry the notice beside it.
 */
const REQUIRED: ReadonlyArray<{ file: string; shows: string }> = [
  {
    file: "src/components/flipdesk/ebay-comps-panel.tsx",
    shows: "other sellers' active listings, per row, deep linked to eBay",
  },
  {
    file: "src/components/flipdesk/sold-comp-recommendation.tsx",
    shows: "the comp-derived price recommendation and its sample",
  },
  {
    file: "src/pages/flipdesk/scout.tsx",
    shows: "other sellers' live listings: photo, title, asking price, item link",
  },
  {
    file: "src/pages/flipdesk/scout-buy.tsx",
    shows: "resale value and sell-through computed from active eBay listings",
  },
  {
    file: "src/components/flipdesk/ebay-catalog-match-card.tsx",
    shows: "eBay's catalog record for a product: title, brand, specifics",
  },
];

/**
 * Surfaces that touch eBay-derived data and carry no notice ON PURPOSE. Each
 * entry is a decision somebody made, not an oversight, and the reason is the
 * whole point of the entry.
 *
 * The dividing line: eBay's attribution requirement is about DISPLAYING eBay's
 * content. A seller's own listing, their own sale, their own payout and their
 * own account health are their records, which happen to have round-tripped
 * through eBay - there are roughly sixty such surfaces in this app and listing
 * every one of them would bury the ones below, which are the genuinely
 * arguable cases.
 */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: "src/components/flipdesk/ebay-category-picker.tsx",
    why:
      "eBay Taxonomy category names and aspect allowed-values used as form " +
      "input for the seller's OWN listing. Functional metadata for a listing " +
      "being published TO eBay rather than eBay content shown to a reader. " +
      "OWNER CALL: if eBay's reviewer disagrees, move this entry to REQUIRED.",
  },
  {
    file: "src/components/flipdesk/composer/price-card.tsx",
    why:
      "eBay condition ids and labels for the seller's own listing form. Same " +
      "reasoning as the category picker.",
  },
  {
    file: "src/components/flipdesk/ebay-keywords-card.tsx",
    why:
      "eBay's keyword suggestions for the seller's OWN Promoted Listings " +
      "campaign. Advertising tooling over their own ads, not a display of " +
      "eBay marketplace content.",
  },
  {
    file: "src/components/flipdesk/ebay-campaign-card.tsx",
    why:
      "eBay's Promoted Listings suggestions for the seller's own listings. " +
      "Same reasoning as the keywords card.",
  },
  {
    file: "src/pages/price-suggestions.tsx",
    why:
      "shows a comp COUNT and median for the seller's own items, not any " +
      "listing from eBay. value-basis-note.tsx already names active asking " +
      "prices as the basis. DERIVED-PRICE QUESTION, raised by US-3112 and " +
      "still open: whether a number computed from eBay comps needs the notice " +
      "when no eBay content is rendered is an owner call.",
  },
  {
    file: "src/pages/flipdesk/repricing.tsx",
    why: "same comp-derived suggestion feed as price-suggestions.tsx.",
  },
];

function read(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8").replace(/\r\n/g, "\n");
}

/** Every file under a directory, recursively. Absolute paths. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

/**
 * Strip comments BEFORE looking for the mount. A comment naming the component
 * is exactly what sits next to one - including the comments this change added -
 * and a scan that counts them passes against a surface with no notice at all.
 * Blocks first, as blocks: a JSX comment's continuation lines start with plain
 * prose, so a line-prefix filter leaves the interior behind.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/** Does this source MOUNT the component (not merely mention or import it)? */
function mountsNotice(src: string): boolean {
  return /<EbayAttribution[\s/>]/.test(codeOnly(src));
}

describe("EbayAttribution: the detector itself", () => {
  // A guard is only as good as what it can tell apart, and this one has to tell
  // a mount from the sentence explaining a mount. Proven on fixtures rather
  // than assumed, because every other assertion in this file rests on it.
  it("sees a real mount", () => {
    expect(mountsNotice("return <div><EbayAttribution /></div>;")).toBe(true);
    expect(mountsNotice('<EbayAttribution what="Listing data" />')).toBe(true);
  });

  it("does NOT see a mount that exists only in a comment", () => {
    expect(
      mountsNotice("{/* US-3042: <EbayAttribution /> belongs here */}\n<div />"),
    ).toBe(false);
    expect(
      mountsNotice("// TODO: mount <EbayAttribution /> on this card\nconst x = 1;"),
    ).toBe(false);
    expect(
      mountsNotice("/*\n  <EbayAttribution />\n  was removed on purpose\n*/"),
    ).toBe(false);
  });

  it("does NOT count the import line as coverage", () => {
    // A file can import the component and never render it, which reads as
    // compliant to a grep for the name.
    expect(
      mountsNotice(
        'import { EbayAttribution } from "@/components/marketplace/ebay-attribution";\nexport function X() { return <div />; }',
      ),
    ).toBe(false);
  });
});

describe("EbayAttribution: the notice itself", () => {
  it("carries the three things eBay asks for", () => {
    // Source, trademark acknowledgement, non-endorsement. Same three phrases
    // extension-unified/test/ebay-attribution.test.cjs pins from the other
    // side, so the web copy and the extension copy cannot drift apart.
    const src = read(COMPONENT);
    for (
      const phrase of [
        "from eBay, retrieved through the eBay API",
        "eBay is a trademark of eBay Inc",
        "uses the eBay API but is not endorsed or certified by eBay Inc",
      ]
    ) {
      // Collapse JSX line wrapping before matching: the component's prose is
      // broken across lines by the formatter, so the phrase is only contiguous
      // after whitespace normalisation.
      expect(src.replace(/\s+/g, " ")).toContain(phrase);
    }
  });
});

describe("EbayAttribution: surface coverage", () => {
  it("has a registry worth trusting", () => {
    // The floor. Every assertion below iterates a list, and an empty list
    // iterates zero times and reports a clean pass - which is what a guard
    // reads like right after somebody deletes its contents.
    expect(REQUIRED.length).toBeGreaterThanOrEqual(5);
    expect(EXEMPT.length).toBeGreaterThanOrEqual(4);
    for (const r of REQUIRED) expect(r.shows.length).toBeGreaterThan(20);
    for (const e of EXEMPT) expect(e.why.length).toBeGreaterThan(40);
  });

  it.each(REQUIRED)("$file shows $shows and mounts the notice", ({ file }) => {
    // read() throws on a missing file on purpose: a surface that was renamed or
    // deleted must fail loudly here rather than drop out of the coverage.
    expect(mountsNotice(read(file)), `${file} renders eBay data with no attribution`)
      .toBe(true);
  });

  it.each(EXEMPT)("$file is exempt on purpose and still is", ({ file }) => {
    // The direction that keeps the list shrinking. An exempt surface that
    // GAINED the notice is good news and a stale entry, and a stale exemption
    // is how a list nobody can retire gets started.
    expect(
      mountsNotice(read(file)),
      `${file} now mounts the notice - move it from EXEMPT to REQUIRED`,
    ).toBe(false);
  });

  it("REQUIRED is the complete set of surfaces mounting the notice", () => {
    // Without this the registry can only fall behind: somebody adds the notice
    // to a seventh surface, nobody adds the line here, and the list stops
    // describing the app while every assertion above stays green. Walking the
    // tree is what makes REQUIRED a census rather than a sample.
    const mounted = walk(join(REPO, "src"))
      .map((abs) => abs.slice(REPO.length + 1).split(sep).join("/"))
      // .tsx only, and never a test: THIS file quotes `<EbayAttribution />`
      // inside the detector's own fixtures, and a scanner that reads the
      // documentation written about it reports itself (guards-that-do-not-
      // guard, mode 7).
      .filter((rel) => rel.endsWith(".tsx") && !/[._]test\.tsx$/.test(rel))
      .filter((rel) => rel !== COMPONENT)
      .filter((rel) => mountsNotice(read(rel)))
      .sort();

    // Floor: the walk has to find the surfaces we already know about, or the
    // path arithmetic has rotted and an empty result reads as "all clear".
    expect(mounted.length).toBeGreaterThanOrEqual(REQUIRED.length);
    expect(mounted).toEqual([...REQUIRED.map((r) => r.file)].sort());
  });
});

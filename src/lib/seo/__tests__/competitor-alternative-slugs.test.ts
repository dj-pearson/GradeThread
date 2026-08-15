import { describe, expect, it } from "vitest";
import { COMPETITOR_ALTERNATIVE_SLUGS, alternativePath } from "../competitor-alternative-slugs";
import { COMPETITOR_ALTERNATIVES } from "../competitor-alternatives";
import { competitorAlternativeRoutes } from "../competitor-alternatives";

// US-2600. The router used to build these routes by mapping over the full
// competitor data set, which is what put 16 KB of editorial prose in the eager
// entry chunk that every landing-page visitor downloads.
//
// The slugs now live in their own module. That trades a shared array — where
// drift was impossible by construction — for two lists that must agree, so the
// agreement is what this file asserts. Both directions, because the two failures
// are different and only one of them is loud:
//
//   a slug here with no data  → the route renders a page with nothing to show
//   data with no slug here    → the page exists, is in the sitemap, and 404s
//
// The second is the quiet one. The dynamic /reselling/:slug route swallows the
// path and renders the guide page's not-found, so the page looks published
// everywhere except in a browser.

describe("the slug list and the data set agree", () => {
  it("every slug in the router has a data entry", () => {
    const known = new Set(COMPETITOR_ALTERNATIVES.map((a) => a.slug));
    const orphans = COMPETITOR_ALTERNATIVE_SLUGS.filter((s) => !known.has(s));
    expect(
      orphans,
      `these slugs are routed but have no entry in competitor-alternatives.ts: ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  it("every data entry has a routed slug", () => {
    const routed = new Set<string>(COMPETITOR_ALTERNATIVE_SLUGS);
    const unrouted = COMPETITOR_ALTERNATIVES.filter((a) => !routed.has(a.slug)).map((a) => a.slug);
    expect(
      unrouted,
      "these pages exist in the data set and in the sitemap but are not routed, so " +
        `/reselling/:slug will swallow them and 404: ${unrouted.join(", ")}. ` +
        "Add them to COMPETITOR_ALTERNATIVE_SLUGS.",
    ).toEqual([]);
  });

  it("the two lists are the same length", () => {
    // Catches a duplicate on either side, which the set comparisons above miss.
    expect(COMPETITOR_ALTERNATIVE_SLUGS.length).toBe(COMPETITOR_ALTERNATIVES.length);
  });

  it("the registered routes use the same path builder", () => {
    // public-routes.ts feeds the sitemap and the prerender from the data set.
    // If its paths and the router's ever diverge, one of the two is serving a
    // URL the other has never heard of.
    const fromData = competitorAlternativeRoutes().map((r) => r.path).sort();
    const fromSlugs = COMPETITOR_ALTERNATIVE_SLUGS.map(alternativePath).sort();
    expect(fromSlugs).toEqual(fromData);
  });
});

describe("alternativePath", () => {
  it("builds the public path", () => {
    expect(alternativePath("vendoo")).toBe("/reselling/vendoo-alternative");
  });

  it("is the same function the data module re-exports", async () => {
    // The re-export exists so six call sites did not have to move. If it ever
    // becomes a second copy, the paths can drift without anything failing.
    const dataModule = await import("../competitor-alternatives");
    expect(dataModule.alternativePath).toBe(alternativePath);
  });
});

// US-9031: what the /rn/:number page is allowed to say.
//
// Three of these guard claims that are legal and reputational rather than
// cosmetic: an RN names a company and not a brand, it is not proof of
// authenticity, and a number we cannot resolve is not a number that is wrong.

import { describe, expect, it } from "vitest";
import {
  numberLabel,
  pageDescription,
  pageTitle,
  type PublicRegisteredNumber,
  renderRnBody,
  rnLd,
  sightingText,
} from "../../functions/_shared/rn-render";

const resolved: PublicRegisteredNumber = {
  key: "RN:56323",
  kind: "RN",
  digits: "56323",
  requested: "56323",
  canonical: true,
  companyName: "NIKE, INC.",
  brands: ["Nike"],
  productLines: [],
  sourceUrl: "https://www.ftc.gov/rn-database/search?search=56323",
  searchUrl: "https://www.ftc.gov/rn-database/search?search=56323",
  sightings: 12,
  indexable: true,
};

const blank: PublicRegisteredNumber = {
  ...resolved,
  key: "RN:999999",
  digits: "999999",
  requested: "999999",
  companyName: null,
  brands: [],
  sourceUrl: null,
  // Always set, including here — that is the whole point of the field.
  searchUrl: "https://www.ftc.gov/rn-database/search?search=999999",
  sightings: null,
  indexable: false,
};

describe("rn-render", () => {
  it("leads with the company", () => {
    expect(pageTitle(resolved)).toContain("NIKE, INC.");
    expect(pageTitle(resolved)).toContain("RN 56323");
    expect(renderRnBody(resolved)).toContain("<h1>NIKE, INC.</h1>");
  });

  it("never names a company it does not have", () => {
    expect(pageTitle(blank)).not.toContain("NIKE");
    expect(pageDescription(blank)).not.toContain("NIKE");
    expect(pageDescription(blank)).toContain("no record");
  });

  it("says an RN names the company, not the brand", () => {
    const html = renderRnBody(resolved);
    expect(html).toContain("names the company");
    expect(pageDescription(resolved)).toContain("not the brand");
  });

  it("never claims the number proves anything", () => {
    const html = renderRnBody(resolved);
    expect(html).toMatch(/corroboration, never as proof/i);
    expect(html).not.toMatch(/\b(authentic|genuine|verified seller)\b/i);
  });

  it("an unresolved number reads as no reference, not as wrong", () => {
    const html = renderRnBody(blank);
    expect(html).toMatch(/no reference/i);
    expect(html).toMatch(/almost certainly real/i);
    expect(html).not.toMatch(/\b(invalid|fake|not a real|suspicious)\b/i);
  });

  it("a shared registrant names every brand and picks none", () => {
    const html = renderRnBody({
      ...resolved,
      companyName: "URBN",
      brands: ["Urban Outfitters", "Anthropologie", "Free People"],
    });
    expect(html).toContain("Free People");
    expect(html).toContain("Anthropologie");
    expect(html).toMatch(/cannot tell you which/i);
  });

  it("shows the sighting count only when it is worth a sentence", () => {
    expect(sightingText(resolved)).toContain("12");
    expect(sightingText({ ...resolved, sightings: 1 })).toBeNull();
    expect(sightingText({ ...resolved, sightings: 0 })).toBeNull();
    expect(sightingText({ ...resolved, sightings: null })).toBeNull();
    expect(renderRnBody({ ...resolved, sightings: 0 })).not.toMatch(/0 garment tags/);
  });

  it("links the FTC record when there is one", () => {
    expect(renderRnBody(resolved)).toContain("https://www.ftc.gov/rn-database/search?search=56323");
    expect(renderRnBody(resolved)).toContain("See the FTC record");
  });

  // US-9036 replaced the old rule here, which was "a blank page links no
  // ftc.gov at all". That rule was written to stop us dressing a query up as
  // evidence, and it was right about that. It also made the blank page a dead
  // end: it told somebody we could not help and gave them nowhere to go, and
  // after the first seed run that is nearly every visitor. The distinction the
  // page actually needs is between the two KINDS of link.
  it("offers the search on a blank page, and never calls it our record", () => {
    const html = renderRnBody(blank);
    expect(html).toContain("https://www.ftc.gov/rn-database/search?search=999999");
    expect(html).toContain("we have not indexed yet");
    // Provenance language belongs to a claim we made, and we made none here.
    expect(html).not.toContain("See the FTC record");
  });

  it("never prints a resolved number's stored source on an unresolved one", () => {
    // sourceUrl is gated on companyName in the payload; this holds the renderer
    // to it too, so a future edit cannot leak one row's evidence onto a blank.
    const leaky = { ...blank, sourceUrl: "https://www.ftc.gov/rn-database/search?search=56323" };
    expect(renderRnBody(leaky)).not.toContain("search=56323");
  });

  it("sends the reader to the tag reader with the number prefilled", () => {
    expect(renderRnBody(resolved)).toContain("/tools/rn-lookup?rn=56323");
    expect(renderRnBody(blank)).toContain("/tools/rn-lookup?rn=999999");
  });

  it("emits Organization markup only with a company", () => {
    const ld = rnLd(resolved, "https://gradethread.com/rn/56323") as Record<string, unknown>;
    expect(ld["@type"]).toBe("Organization");
    expect(ld.name).toBe("NIKE, INC.");
    // Markup never describes data we do not have (US-291..309).
    expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|offers|review/i);
    expect(rnLd(blank, "https://gradethread.com/rn/999999")).toBeNull();
  });

  it("labels a CA number as its own registry", () => {
    const ca: PublicRegisteredNumber = { ...resolved, kind: "CA", digits: "32054", key: "CA:32054" };
    expect(numberLabel(ca)).toBe("CA 32054");
    const ld = rnLd(ca, "https://gradethread.com/rn/32054") as Record<string, unknown>;
    expect(JSON.stringify(ld)).toContain("Canadian");
  });

  it("escapes what it renders", () => {
    const html = renderRnBody({ ...resolved, companyName: 'A & B <script>alert(1)</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });
});

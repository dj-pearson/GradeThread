import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MEASURE_CARD_V1 } from "@/lib/measure-card";

// US-2540. The mail form had no country field, called the region "State" and
// the postal code "ZIP", so a seller outside the US had to invent values to get
// past a required field for a card that would then be posted to an address
// nobody had asked them to confirm. The page also told them to frame "all four
// black squares" without ever showing the card, and a failed status read
// returned null — the same value as "you have never requested one", so someone
// with a request already in the queue was offered the form again.

const PAGE = "src/pages/flipdesk/measure-card.tsx";
const DIAGRAM = "src/components/flipdesk/measure-card-diagram.tsx";
const ROUTE = "services/edge-functions/src/routes/flipdesk-measure.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("the mail form is not US-only by accident (US-2540)", () => {
  it("asks for a country and sends it", () => {
    const src = read(PAGE);
    expect(src).toMatch(/country: "US"/);
    expect(src).toMatch(/<Label htmlFor="mc-country">Country<\/Label>/);
    // The whole form object is the request body, so the field travels.
    expect(src).toMatch(/json: form/);
  });

  it("labels the region and postal fields for the chosen country", () => {
    const src = read(PAGE);
    expect(src).toMatch(/isUs \? "State" : "State \/ Province \/ Region"/);
    expect(src).toMatch(/isUs \? "ZIP" : "Postal code"/);
  });

  it("the client and the server agree on where a card can go", () => {
    // Two copies across two builds, as this repo does for shared constants —
    // so they need a test, or the form offers a country the server rejects.
    const page = read(PAGE);
    const route = read(ROUTE);
    const pageCodes = [...page.matchAll(/\{ code: "([A-Z]{2})", name: "/g)].map(
      (m) => m[1],
    );
    const serverList = /export const MAIL_COUNTRIES = \[([^\]]+)\]/.exec(route);
    expect(serverList, "the server has no country list").toBeTruthy();
    const serverCodes = [...serverList![1]!.matchAll(/"([A-Z]{2})"/g)].map(
      (m) => m[1],
    );
    expect(pageCodes.length).toBeGreaterThan(1);
    expect(serverCodes).toEqual(pageCodes);
  });

  it("the server refuses a country it cannot post to", () => {
    const route = read(ROUTE);
    expect(route).toMatch(
      /if \(!\(MAIL_COUNTRIES as readonly string\[\]\)\.includes\(country\)\)/,
    );
    // And says what to do instead rather than just refusing.
    expect(route).toContain("print-at-home PDF");
  });

  it("says where the card posts from, and what to do on A4", () => {
    const src = read(PAGE);
    expect(src).toContain("post from the United");
    expect(src).toMatch(/On A4:/);
    expect(src).toContain("Actual size");
  });
});

describe("the page shows the card (US-2540)", () => {
  it("renders the diagram in the shooting instructions", () => {
    expect(read(PAGE)).toContain("<MeasureCardDiagram");
  });

  it("the drawing is derived from the generated geometry, not typed in", () => {
    const src = read(DIAGRAM);
    expect(src).toMatch(/from "@\/lib\/measure-card"/);
    expect(src).toMatch(/g\.markerCentersInches/);
    expect(src).toMatch(/g\.cardInches/);
    // A hardcoded square position would drift from the printed card the first
    // time the geometry changed.
    expect(src).not.toMatch(/x=\{0\.75\}/);
  });

  it("it says it is a diagram and not a usable card", () => {
    // A photo of a screen will not decode, and someone will try.
    expect(read(DIAGRAM)).toContain("not a usable card");
  });

  it("the caption states the real dimensions", () => {
    const { w, h } = MEASURE_CARD_V1.cardInches;
    expect(w).toBe(7.5);
    expect(h).toBe(5.5);
    // Which is what the A4 advice on the page is based on.
    expect(Math.round(w * 25.4)).toBe(191);
    expect(Math.round(h * 25.4)).toBe(140);
    expect(read(PAGE)).toContain("191mm × 140mm");
  });
});

describe("a failed status read is not an empty one (US-2540)", () => {
  it("the query throws instead of returning null", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/if \(!res\.ok\) return null;/);
    expect(src).toMatch(/throw new Error\(json\.error \?\? "Could not check/);
  });

  it("the form is hidden while the check is broken", () => {
    const src = read(PAGE);
    expect(src).toMatch(/\) : isError \? \(/);
    expect(src).toContain("<ErrorState");
    // Ordered before the branches that would render the form.
    const errAt = src.indexOf(") : isError ? (");
    const formAt = src.indexOf("<form onSubmit=");
    expect(errAt).toBeLessThan(formAt);
  });
});

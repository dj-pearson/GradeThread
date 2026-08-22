// US-2706 AC5/AC6/AC7: what the return-evidence surface promises.
//
// The interesting failure here is not a crash. It is a screen that reads as a
// guarantee, or one that shows a seller a pack built from a grade report alone
// as though it were the same argument as a pack backed by the listing text they
// actually published. Both produce a confident seller and a lost case.
//
// Source-scanning, because the property is the COPY and the ordering of the
// controls, and neither needs a DOM to check.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PANEL = "src/components/flipdesk/return-evidence-panel.tsx";
const PAGE = "src/pages/flipdesk/post-sale.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** Comments stripped: a paragraph about a promise is not a promise. */
function copy(rel: string): string {
  return read(rel)
    .replace(/\r\n/g, "\n")
    .replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("US-2706: the return-evidence surface", () => {
  const panel = copy(PANEL);

  it("reads the files it guards", () => {
    // A rename leaves every assertion below checking an empty string.
    expect(panel.length, `${PANEL} is missing or empty`).toBeGreaterThan(2000);
    expect(panel).toContain("ReturnEvidencePanel");
  });

  it("AC7: never claims the evidence wins the case", () => {
    // eBay decides. The claim is dated, specific evidence in one click - not an
    // outcome we do not control.
    const claims = [
      /\bwin\b/i,
      /\bwins\b/i,
      /\byou'?ll win\b/i,
      /guarantee/i,
      /prove(s|n)? (your|the) case/i,
      /ebay will (side|rule|find)/i,
    ];
    for (const claim of claims) {
      expect(
        claim.test(panel),
        `the panel asserts an outcome we do not control: ${claim}`,
      ).toBe(false);
    }
  });

  it("AC6: labels a pack with no published listing text as the weaker case", () => {
    // Without the snapshot the report can show the flaw was documented but not
    // that the listing disclosed it. Presenting the two as equivalent is the
    // failure this AC exists for.
    expect(panel).toMatch(/hasPublicationSnapshot === false/);
    expect(panel).toMatch(/weaker case/i);
  });

  it("AC5: nothing sends without a click, and nothing sends on a timer", () => {
    // The plan is a read; the send is a separate mutation behind its own
    // button. A useEffect that fired either would turn a review surface into an
    // auto-submit.
    expect(panel).toMatch(/useEbayReturnEvidencePlan/);
    expect(panel).toMatch(/useEbaySendReturnEvidence/);
    expect(
      /useEffect|setTimeout|setInterval/.test(panel),
      "the panel runs something on its own - a review surface must not",
    ).toBe(false);
  });

  it("AC5: the send is refused on the surface when the report agrees with the buyer", () => {
    // Not only server-side. A screen that offers Send and then 409s has already
    // told the seller they had a case.
    expect(panel).toMatch(/verdict === "supported"/);
    expect(panel).toMatch(/!refuses/);
  });

  it("shows what the pack contains before it is sent", () => {
    // "Send to eBay" over an unspecified bundle is the thing this replaces.
    expect(panel).toMatch(/includesConditionSheet/);
    expect(panel).toMatch(/certificate number and grade date/i);
  });

  it("reports a file eBay dropped after accepting it", () => {
    // The upload succeeded and activation removed it, so the pack on the case
    // is smaller than the one just reviewed. Saying "sent" over that is the
    // silent success this epic keeps running into.
    // `?? 0` because the dispute route reports no removed count of its own -
    // eBay's dispute API does not drop files at activation the way the return
    // API does. Absent must read as none, never as "do not mention it".
    expect(panel).toMatch(/res\.removed/);
    expect(panel).toMatch(/eBay dropped/);
  });

  it("is reachable from the returns list, and only on an open case", () => {
    const page = copy(PAGE);
    expect(page).toContain("ReturnEvidencePanel");
    expect(page).toMatch(/evidenceFor === r\.returnId && !showClosed/);
  });

  it("US-2707: the DISPUTE list offers the same panel, on open cases only", () => {
    // The rarer path is not the one where GradeThread hands the seller a file
    // picker and no verdict. One panel, so the refusal cannot be present on one
    // surface and missing on the other.
    const page = copy(PAGE);
    expect(page).toMatch(/packFor === d\.paymentDisputeId && !showClosed/);
    expect(page).toMatch(/kind="dispute"/);
    expect(page).toMatch(/kind="return"/);
    const mounts = page.match(/<ReturnEvidencePanel/g) ?? [];
    expect(
      mounts.length,
      "both surfaces must mount the SAME panel component",
    ).toBe(2);
  });
});

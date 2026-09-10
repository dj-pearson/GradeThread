import { describe, expect, it } from "vitest";
import {
  certificateIdFromUrl,
  packingSlipDocument,
  type PackingSlipRow,
} from "@/pages/flipdesk/packing-slip";

function row(over: Partial<PackingSlipRow> = {}): PackingSlipRow {
  return {
    id: "sale-1",
    orderRef: "12-34567-89012",
    soldAt: "2026-09-01T12:00:00.000Z",
    buyerUsername: "thrift_hunter",
    title: "Patagonia Better Sweater",
    sku: "FD-0001",
    size: "M",
    locationBin: "A3",
    quantity: 1,
    gradeValue: 8.5,
    gradeLabel: "Excellent",
    certificateUrl: "https://gradethread.com/verify/GT-ABC123",
    container: null,
    ...over,
  };
}

describe("packingSlipDocument", () => {
  it("renders one slip per selected sale", () => {
    const doc = packingSlipDocument([
      row({ id: "a" }),
      row({ id: "b" }),
      row({ id: "c" }),
    ]);
    expect(doc.match(/class="slip"/g)).toHaveLength(3);
    expect(doc).toContain('data-sale="a"');
    expect(doc).toContain('data-sale="c"');
  });

  it("breaks a page between slips so two orders never share a sheet", () => {
    expect(packingSlipDocument([row()])).toContain("page-break-after:always");
  });

  it("puts the bin on the slip — the field that saves a walk", () => {
    expect(packingSlipDocument([row({ locationBin: "Rack 4 / B" })])).toContain(
      "Rack 4 / B",
    );
  });

  it("carries the grade and the certificate id, not the raw URL", () => {
    const doc = packingSlipDocument([row()]);
    expect(doc).toContain("8.5");
    expect(doc).toContain("Excellent");
    expect(doc).toContain("GT-ABC123");
    expect(doc).not.toContain("https://gradethread.com/verify/GT-ABC123");
  });

  it("omits the grade rows entirely for an ungraded item", () => {
    const doc = packingSlipDocument([
      row({ gradeValue: null, gradeLabel: null, certificateUrl: null }),
    ]);
    expect(doc).not.toContain("Condition grade");
    expect(doc).not.toContain("Certificate");
  });

  it("never prints buyer contact details, only the username", () => {
    // The slip is handled by a courier and sometimes a returns desk. Whatever
    // else changes here, an address, an email or a phone number must not appear
    // on it. Asserted against the slip bodies rather than the whole document,
    // because the stylesheet legitimately contains "@media print".
    const doc = packingSlipDocument([row()]);
    const bodies = doc.split("<body>")[1] ?? "";
    expect(bodies).toContain("thrift_hunter");
    for (const forbidden of [/address/i, /\bphone\b/i, /\bpostcode\b/i, /\bzip\b/i]) {
      expect(bodies).not.toMatch(forbidden);
    }
    // Nothing shaped like an email address.
    expect(bodies).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it("escapes a title that contains markup", () => {
    const doc = packingSlipDocument([
      row({ title: '<script>alert("x")</script> Jacket' }),
    ]);
    expect(doc).not.toContain("<script>alert");
    expect(doc).toContain("&lt;script&gt;");
  });

  it("says manual sale rather than 'Order null' when there is no order ref", () => {
    const doc = packingSlipDocument([row({ orderRef: null })]);
    expect(doc).toContain("Manual sale");
    expect(doc).not.toContain("Order null");
  });

  it("defaults a missing quantity to one rather than printing nothing", () => {
    expect(packingSlipDocument([row({ quantity: null })])).toContain("Qty 1");
  });

  // ── The sheet is PAPER. These four are about what comes out of the printer. ──

  it("sets its own page margin instead of inheriting the browser's", () => {
    // Without an @page rule the margin is whatever the browser picked that
    // release (Chrome and Firefox do not agree), so the same slip sits in a
    // different place on the sheet depending on where it was printed from.
    const doc = packingSlipDocument([row()]);
    expect(doc).toMatch(/@page\s*\{[^}]*margin:\s*14mm/);
  });

  it("never lets one slip split across two sheets", () => {
    // page-break-after only guarantees the NEXT slip starts fresh. A long title
    // plus a long bin can still push the certificate line onto a second sheet,
    // which is the one line the buyer is meant to act on.
    expect(packingSlipDocument([row()])).toMatch(/break-inside:\s*avoid/);
  });

  it("leads with the garment and the shelf, not a flat list of fields", () => {
    // The seller reads this while walking to a rack. The title and the bin are
    // the two things that have to survive a glance.
    const doc = packingSlipDocument([row({ locationBin: "A3" })]);
    expect(doc).toMatch(/<h1[^>]*>Patagonia Better Sweater<\/h1>/);
    expect(doc).toMatch(/class="pick"[\s\S]*?A3/);
  });

  it("prints the tote as well as the shelf when the item has one", () => {
    const doc = packingSlipDocument([
      row({ locationBin: "A3", container: "Haul-12" }),
    ]);
    expect(doc).toContain("Haul-12");
    expect(doc).toContain("A3");
  });

  it("drops the pick line entirely when the item has no shelf and no tote", () => {
    const doc = packingSlipDocument([
      row({ locationBin: null, container: null }),
    ]);
    expect(doc).not.toContain('class="pick"');
  });

  it("writes the month in words, because 9/1/2026 is two dates", () => {
    // The slip goes in a box that may cross a border. A numeric date read in
    // the wrong order is a returns-window argument.
    const doc = packingSlipDocument([row({ soldAt: "2026-09-01T12:00:00.000Z" })]);
    const cell = /<th>Sold<\/th><td>([^<]*)<\/td>/.exec(doc)?.[1] ?? "";
    // Asserted on the shape, not on "Sep", so the test does not depend on the
    // locale the runner happens to boot with.
    expect(cell).not.toMatch(/^\s*\d+[-/.]\d+[-/.]\d+\s*$/);
    expect(cell).toMatch(/\p{L}{3}/u);
    expect(cell).toContain("2026");
  });

  it("omits the sold row rather than printing a dash for a sale with no date", () => {
    const doc = packingSlipDocument([
      row({
        soldAt: null,
        buyerUsername: null,
        gradeValue: null,
        gradeLabel: null,
        certificateUrl: null,
      }),
    ]);
    expect(doc).not.toContain("Sold");
    // And with every table row gone, no empty table is left behind.
    expect(doc).not.toContain("<table>");
  });

  it("prints no money at all, so cost basis and net cannot ride along", () => {
    // The queue row this is built from carries cost_basis and net. The slip
    // takes named fields only, and this asserts that stays true: a buyer must
    // never learn what the seller paid.
    const wide = {
      ...row(),
      salePrice: 89.99,
      costBasis: 12.34,
      net: 45.67,
      sourcingNote: "Goodwill bins, half-price Tuesday",
    } as PackingSlipRow;
    const doc = packingSlipDocument([wide]);
    const bodies = doc.split("<body>")[1] ?? "";
    expect(bodies).not.toContain("12.34");
    expect(bodies).not.toContain("45.67");
    expect(bodies).not.toContain("89.99");
    expect(bodies).not.toContain("Goodwill");
    expect(bodies).not.toContain("$");
  });
});

describe("certificateIdFromUrl", () => {
  it("takes the last path segment", () => {
    expect(certificateIdFromUrl("https://gradethread.com/verify/GT-1")).toBe("GT-1");
  });

  it("ignores a trailing slash and a query string", () => {
    expect(certificateIdFromUrl("https://gradethread.com/verify/GT-2/")).toBe("GT-2");
    expect(certificateIdFromUrl("https://gradethread.com/verify/GT-3?src=email")).toBe(
      "GT-3",
    );
  });

  it("is null for a missing or empty url", () => {
    expect(certificateIdFromUrl(null)).toBeNull();
    expect(certificateIdFromUrl("")).toBeNull();
    expect(certificateIdFromUrl("   ")).toBeNull();
  });
});

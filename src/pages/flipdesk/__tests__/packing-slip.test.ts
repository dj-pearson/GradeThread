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
    expect(packingSlipDocument([row({ quantity: null })])).toContain("Quantity");
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

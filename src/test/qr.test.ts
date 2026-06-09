// US-762: server-side QR generator (functions/_shared/qr.ts).
//
// We can't decode the QR in a unit test without a reader, but the QR spec
// mandates a fixed 7x7 *finder pattern* in three corners of every symbol —
// asserting those proves a structurally valid QR was generated (not just some
// SVG), and the deterministic/encoding checks guard the SVG plumbing the slab
// (US-763) depends on.

import { describe, it, expect } from "vitest";
import { qrMatrix, qrSvg, qrSvgDataUri } from "../../functions/_shared/qr";

const CERT_URL = "https://gradethread.com/cert/abcdef01-2345-6789?s=qr";

describe("qr", () => {
  it("produces a square matrix with valid finder patterns in three corners", () => {
    const { size, modules } = qrMatrix(CERT_URL);
    expect(size).toBeGreaterThanOrEqual(21); // version 1 is 21x21
    expect(modules).toHaveLength(size);
    expect(modules.every((row) => row.length === size)).toBe(true);

    // A finder pattern: solid dark 7x7 border, a one-module light ring, and a
    // 3x3 dark centre.
    const finderOk = (r0: number, c0: number) => {
      for (let i = 0; i < 7; i++) {
        expect(modules[r0]?.[c0 + i]).toBe(true); // top edge
        expect(modules[r0 + 6]?.[c0 + i]).toBe(true); // bottom edge
        expect(modules[r0 + i]?.[c0]).toBe(true); // left edge
        expect(modules[r0 + i]?.[c0 + 6]).toBe(true); // right edge
      }
      expect(modules[r0 + 1]?.[c0 + 1]).toBe(false); // light ring
      expect(modules[r0 + 3]?.[c0 + 3]).toBe(true); // dark centre
    };

    finderOk(0, 0); // top-left
    finderOk(0, size - 7); // top-right
    finderOk(size - 7, 0); // bottom-left
  });

  it("is deterministic for the same input + options", () => {
    expect(qrSvg(CERT_URL)).toBe(qrSvg(CERT_URL));
  });

  it("renders one path over a quiet-zone background sized for the margin", () => {
    const { size } = qrMatrix(CERT_URL);
    const svg = qrSvg(CERT_URL, { margin: 4 });
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
    expect(svg).toContain(`viewBox="0 0 ${size + 8} ${size + 8}"`);
  });

  it("varies with the error-correction level", () => {
    expect(qrSvg(CERT_URL, { ecl: "H" })).not.toBe(qrSvg(CERT_URL, { ecl: "L" }));
  });

  it("emits a decodable base64 svg data URI", () => {
    const uri = qrSvgDataUri(CERT_URL);
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = atob(uri.slice("data:image/svg+xml;base64,".length));
    expect(decoded).toContain("<svg");
    expect(decoded).toContain("<path");
  });

  it("throws on empty input", () => {
    expect(() => qrMatrix("")).toThrow();
  });
});

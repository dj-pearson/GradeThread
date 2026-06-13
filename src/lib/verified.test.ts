import { describe, it, expect } from "vitest";
import { parseCertificateRef, validateHandle } from "./verified";

const UUID = "0f3a1b2c-4d5e-6f70-8a9b-0c1d2e3f4a5b";

describe("parseCertificateRef (US-593 buyer verify lookup)", () => {
  it("accepts a bare certificate id", () => {
    expect(parseCertificateRef(UUID)).toBe(UUID);
  });

  it("uppercases are normalized to lowercase", () => {
    expect(parseCertificateRef(UUID.toUpperCase())).toBe(UUID);
  });

  it("extracts the id from a full certificate URL", () => {
    expect(parseCertificateRef(`https://gradethread.com/cert/${UUID}`)).toBe(UUID);
  });

  it("ignores the QR source query param and hash", () => {
    expect(parseCertificateRef(`https://gradethread.com/cert/${UUID}?s=qr`)).toBe(UUID);
    expect(parseCertificateRef(`https://gradethread.com/cert/${UUID}#grade`)).toBe(UUID);
  });

  it("works for any origin (preview/localhost) and a bare /cert/ path", () => {
    expect(parseCertificateRef(`http://localhost:5173/cert/${UUID}`)).toBe(UUID);
    expect(parseCertificateRef(`/cert/${UUID}`)).toBe(UUID);
  });

  it("trims surrounding whitespace from a paste", () => {
    expect(parseCertificateRef(`   ${UUID}  `)).toBe(UUID);
  });

  it("rejects empty / non-id input rather than navigating to a 404", () => {
    expect(parseCertificateRef("")).toBeNull();
    expect(parseCertificateRef("   ")).toBeNull();
    expect(parseCertificateRef("not-a-certificate")).toBeNull();
    expect(parseCertificateRef("https://gradethread.com/pricing")).toBeNull();
    // A truncated / malformed UUID is rejected.
    expect(parseCertificateRef("0f3a1b2c-4d5e")).toBeNull();
  });
});

describe("validateHandle", () => {
  it("accepts a valid handle and rejects bad shapes", () => {
    expect(validateHandle("jane-doe").ok).toBe(true);
    expect(validateHandle("ab").ok).toBe(false);
    expect(validateHandle("-leading").ok).toBe(false);
  });
});

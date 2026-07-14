import { describe, it, expect } from "vitest";
import * as certNumberLib from "@/lib/cert-number";
import { normalizeCertNumber } from "@/lib/cert-number";

// US-1945: there is a SINGLE certificate-number scheme — the stored, verifiable
// `certificate_number` resolved by /verify. The old UUID-derived
// `certificateDisplayNumber` (a look-alike "GT-XXXX-XXXX" that was never stored
// and always failed the by-number lookup) is intentionally gone, so a cert page
// can never advertise a code a buyer can't verify.
describe("cert-number scheme (US-1945 reconciliation)", () => {
  it("exposes no UUID-derived display-number helper", () => {
    expect(
      (certNumberLib as Record<string, unknown>).certificateDisplayNumber,
    ).toBeUndefined();
  });
});

describe("normalizeCertNumber", () => {
  it("uppercases, strips spaces, and ensures the GT- prefix", () => {
    expect(normalizeCertNumber("gt-7k2m9")).toBe("GT-7K2M9");
    expect(normalizeCertNumber("7k2m9")).toBe("GT-7K2M9");
    expect(normalizeCertNumber("  GT-7K2M9 ")).toBe("GT-7K2M9");
    expect(normalizeCertNumber("gt 7k2m9")).toBe("GT-7K2M9");
  });

  // The displayed certificate_number round-trips through the buyer-typed
  // normalizer, so a code read off the cert resolves via /verify.
  it("round-trips a stored GT- cert number a buyer types back in", () => {
    expect(normalizeCertNumber("GT-7K2M9")).toBe("GT-7K2M9");
    expect(normalizeCertNumber(" gt-7k2m9 ")).toBe("GT-7K2M9");
  });
});

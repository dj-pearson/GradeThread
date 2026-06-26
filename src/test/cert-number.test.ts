import { describe, it, expect } from "vitest";
import { certificateDisplayNumber, normalizeCertNumber } from "@/lib/cert-number";

describe("certificateDisplayNumber", () => {
  it("derives a clean GT-XXXX-XXXX label from a UUID", () => {
    expect(certificateDisplayNumber("a1b2c3d4-e5f6-7890-abcd-ef1234567890"))
      .toBe("GT-A1B2-C3D4");
  });

  it("accepts a full /cert/<id> URL", () => {
    expect(
      certificateDisplayNumber("https://gradethread.com/cert/a1b2c3d4-e5f6-7890-abcd-ef1234567890?s=qr"),
    ).toBe("GT-A1B2-C3D4");
  });

  it("returns null for empty/short input", () => {
    expect(certificateDisplayNumber(null)).toBeNull();
    expect(certificateDisplayNumber("")).toBeNull();
    expect(certificateDisplayNumber("abc")).toBeNull();
  });
});

describe("normalizeCertNumber", () => {
  it("uppercases, strips spaces, and ensures the GT- prefix", () => {
    expect(normalizeCertNumber("gt-7k2m9")).toBe("GT-7K2M9");
    expect(normalizeCertNumber("7k2m9")).toBe("GT-7K2M9");
    expect(normalizeCertNumber("  GT-7K2M9 ")).toBe("GT-7K2M9");
    expect(normalizeCertNumber("gt 7k2m9")).toBe("GT-7K2M9");
  });
});

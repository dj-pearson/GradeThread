// US-1777: buyer body-profile domain — pure normalization + validation.
import { describe, expect, it } from "vitest";
import {
  BODY_MEASUREMENT_FIELDS,
  hasEnoughForFit,
  MIN_MEASUREMENTS_FOR_FIT,
  normalizeBodyMeasurements,
  validateProfileName,
} from "@/lib/body-profile";

describe("validateProfileName", () => {
  it("trims and caps; rejects empty / non-string", () => {
    expect(validateProfileName("  Me  ")).toBe("Me");
    expect(validateProfileName("")).toBeNull();
    expect(validateProfileName("   ")).toBeNull();
    expect(validateProfileName(42)).toBeNull();
    expect(validateProfileName("x".repeat(200))!.length).toBe(60);
  });
});

describe("normalizeBodyMeasurements", () => {
  it("keeps known keys with plausible inch values, rounded to 0.1", () => {
    const out = normalizeBodyMeasurements({ chest: 40.04, waist: "32", inseam: 30.5 });
    expect(out).toEqual({ chest: 40, waist: 32, inseam: 30.5 });
  });

  it("drops unknown keys, non-numbers, and out-of-range typos", () => {
    const out = normalizeBodyMeasurements({
      chest: 40,
      bogus: 10, // unknown key
      waist: "abc", // non-number
      hips: 500, // out of range (max 75)
      inseam: 5, // out of range (min 22)
    });
    expect(out).toEqual({ chest: 40 });
  });

  it("non-object input → empty map", () => {
    expect(normalizeBodyMeasurements(null)).toEqual({});
    expect(normalizeBodyMeasurements("x")).toEqual({});
  });
});

describe("hasEnoughForFit", () => {
  it("requires at least MIN_MEASUREMENTS_FOR_FIT measures", () => {
    expect(hasEnoughForFit({ chest: 40 })).toBe(false);
    expect(hasEnoughForFit({ chest: 40, waist: 32 })).toBe(true);
    expect(MIN_MEASUREMENTS_FOR_FIT).toBe(2);
  });
});

describe("BODY_MEASUREMENT_FIELDS", () => {
  it("every field has guidance and a sane range", () => {
    for (const f of BODY_MEASUREMENT_FIELDS) {
      expect(f.guidance.length).toBeGreaterThan(10);
      expect(f.min).toBeLessThan(f.max);
    }
  });
});

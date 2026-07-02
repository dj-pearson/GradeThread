import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isGpcEnabled,
  regimeForGeo,
  showsPrivacyChoices,
  UNKNOWN_GEO,
  type GeoSignal,
} from "./consent-regime";

const geo = (country: string | null, isEU = false, regionCode: string | null = null): GeoSignal => ({
  country,
  regionCode,
  isEU,
});

describe("consent regime mapping", () => {
  it("treats the US as opt-out (CCPA notice)", () => {
    expect(regimeForGeo(geo("US"))).toBe("opt-out");
    expect(regimeForGeo(geo("US", false, "CA"))).toBe("opt-out");
  });

  it("treats EU countries as opt-in (GDPR)", () => {
    expect(regimeForGeo(geo("DE", true))).toBe("opt-in");
    expect(regimeForGeo(geo("FR", true))).toBe("opt-in");
  });

  it("treats the UK and Switzerland as opt-in", () => {
    expect(regimeForGeo(geo("GB"))).toBe("opt-in");
    expect(regimeForGeo(geo("CH"))).toBe("opt-in");
  });

  it("treats rest-of-world (e.g. Brazil, Australia) as opt-in by default", () => {
    expect(regimeForGeo(geo("BR"))).toBe("opt-in");
    expect(regimeForGeo(geo("AU"))).toBe("opt-in");
  });

  it("fails safe to opt-in when geo is unknown", () => {
    expect(regimeForGeo(null)).toBe("opt-in");
    expect(regimeForGeo(UNKNOWN_GEO)).toBe("opt-in");
    expect(regimeForGeo(geo(null))).toBe("opt-in");
  });

  it("surfaces Your Privacy Choices only for the US opt-out regime", () => {
    expect(showsPrivacyChoices(geo("US"))).toBe(true);
    expect(showsPrivacyChoices(geo("DE", true))).toBe(false);
    expect(showsPrivacyChoices(null)).toBe(false);
  });
});

describe("Global Privacy Control detection", () => {
  afterEach(() => {
    delete (navigator as unknown as { globalPrivacyControl?: boolean })
      .globalPrivacyControl;
    vi.restoreAllMocks();
  });

  it("is false when the browser sends no GPC signal", () => {
    expect(isGpcEnabled()).toBe(false);
  });

  it("is true when navigator.globalPrivacyControl is set", () => {
    Object.defineProperty(navigator, "globalPrivacyControl", {
      value: true,
      configurable: true,
    });
    expect(isGpcEnabled()).toBe(true);
  });
});

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  isGpcEnabled,
  regimeForGeo,
  showsPrivacyChoices,
  UNKNOWN_GEO,
  __resetGeoCacheForTests,
  fetchGeo,
  getCachedGeo,
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

// US-2440: the CACHED half of this module — getCachedGeo and fetchGeo — is live
// production code behind use-consent-regime.ts, and nothing exercised it. The
// tests above cover the pure mapping only.
//
// The point of these cases is the CACHE, not the happy path. A module-level
// `cached` variable cannot be exercised more than once per process without
// __resetGeoCacheForTests, which is exactly why that hatch was written — and
// why it looked like dead code until something used it.
describe("geo cache (US-2440)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetGeoCacheForTests();
    sessionStorage.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetGeoCacheForTests();
    sessionStorage.clear();
  });

  it("returns undefined before anything has been fetched", () => {
    // undefined and null mean different things here: never asked, versus asked
    // and the answer was unknown. Collapsing them would make a failed lookup
    // retry on every render, which is the thing the null is for.
    expect(getCachedGeo()).toBeUndefined();
  });

  it("fetches once and serves every later call from memory", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ country: "DE", regionCode: null, isEU: true }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const first = await fetchGeo();
    const second = await fetchGeo();

    expect(first).toEqual({ country: "DE", regionCode: null, isEU: true });
    expect(second).toEqual(first);
    // THE ASSERTION THAT MATTERS. A per-render refetch of a geo endpoint is a
    // request per component mount for every visitor, and it would pass a
    // happy-path test perfectly.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("persists across a reload through sessionStorage, not just memory", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ country: "FR", regionCode: null, isEU: true }),
    }) as unknown as typeof fetch;
    await fetchGeo();

    // Drop the in-memory cache only — the same shape as a page reload, where
    // the module is re-evaluated but sessionStorage survives.
    __resetGeoCacheForTests();
    expect(getCachedGeo()).toEqual({ country: "FR", regionCode: null, isEU: true });
  });

  it("remembers a FAILURE so it does not refetch on every render", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("offline"));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(await fetchGeo()).toEqual(UNKNOWN_GEO);
    expect(await fetchGeo()).toEqual(UNKNOWN_GEO);
    // Without the remembered null this is the worst case of the two: a user
    // with a blocked/failing geo endpoint would hammer it forever, and the
    // symptom is invisible to them.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a non-ok response as a failure, not as a geo signal", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ country: "US", regionCode: null, isEU: false }),
    }) as unknown as typeof fetch;
    // Parsing the body of a 502 would hand back whatever an error page happened
    // to contain, and the regime it decides gates a privacy notice.
    expect(await fetchGeo()).toEqual(UNKNOWN_GEO);
  });

  it("the reset hatch genuinely restores the uncached path", async () => {
    // AC2: a test that never trips the guard would not have needed the hatch.
    // This is the case that proves the hatch does what the other cases assume.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ country: "GB", regionCode: null, isEU: false }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await fetchGeo();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    __resetGeoCacheForTests();
    sessionStorage.clear();
    await fetchGeo();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

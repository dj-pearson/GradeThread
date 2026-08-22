import { describe, it, expect } from "vitest";
import {
  LISTER_LOCALE_DEFAULT,
  isMultiDomainPlatform,
  localeForPlatform,
  localeOptions,
  normalizeLocaleSelection,
} from "@/lib/lister-locales";

// US-2777. The pure half of the country-domain setting.
//
// The behaviour worth pinning is what happens when the seller has chosen
// NOTHING, because that is every account today and getting it wrong would start
// sending a locale where none was sent before.

describe("localeForPlatform", () => {
  it("is undefined when nothing is stored, which is today's behaviour", () => {
    expect(localeForPlatform(null, "vinted")).toBeUndefined();
    expect(localeForPlatform(undefined, "vinted")).toBeUndefined();
    expect(localeForPlatform({}, "vinted")).toBeUndefined();
  });

  it("is undefined for a platform that has no country domains", () => {
    // A stray key must not be handed to a single-domain platform: the extension
    // ignores it, but the payload would be describing something untrue.
    expect(localeForPlatform({ poshmark: "poshmark.ca" }, "poshmark")).toBeUndefined();
  });

  it("returns the stored key", () => {
    expect(localeForPlatform({ vinted: "vinted.fr" }, "vinted")).toBe("vinted.fr");
  });

  it("treats an empty string as no choice", () => {
    expect(localeForPlatform({ vinted: "" }, "vinted")).toBeUndefined();
  });

  it("passes an UNCOVERED key through rather than falling back", () => {
    // Deliberate, and the opposite of what looks safe. The extension refuses a
    // domain it does not cover and names it; silently swapping in the default
    // is the exact silent-wrong-country failure this story fixes.
    expect(localeForPlatform({ vinted: "vinted.xx" }, "vinted")).toBe("vinted.xx");
  });
});

describe("normalizeLocaleSelection", () => {
  it("stores a real choice", () => {
    expect(normalizeLocaleSelection(null, "vinted", "vinted.de")).toEqual({
      vinted: "vinted.de",
    });
  });

  it("drops the key when the seller picks the default", () => {
    // One spelling of "no preference". Storing the default and storing nothing
    // are the same navigation target, and keeping both would make every reader
    // compare instead of look up.
    const stored = { vinted: "vinted.de" };
    expect(
      normalizeLocaleSelection(stored, "vinted", LISTER_LOCALE_DEFAULT.vinted),
    ).toEqual({});
  });

  it("drops the key for a value that is not covered", () => {
    expect(normalizeLocaleSelection({ vinted: "vinted.de" }, "vinted", "nope")).toEqual({});
  });

  it("leaves other platforms alone", () => {
    const stored = { vinted: "vinted.de", future: "future.fr" };
    expect(normalizeLocaleSelection(stored, "vinted", "vinted.it")).toEqual({
      vinted: "vinted.it",
      future: "future.fr",
    });
  });
});

describe("localeOptions", () => {
  it("shows the default when nothing is stored", () => {
    const { value, strayValue } = localeOptions(null, "vinted");
    expect(value).toBe(LISTER_LOCALE_DEFAULT.vinted);
    expect(strayValue).toBeNull();
  });

  it("shows a stored choice", () => {
    expect(localeOptions({ vinted: "vinted.pl" }, "vinted").value).toBe("vinted.pl");
  });

  it("offers a stale stored key as itself so the UI and the wire agree", () => {
    const { value, options, strayValue } = localeOptions({ vinted: "vinted.xx" }, "vinted");
    expect(value).toBe("vinted.xx");
    expect(strayValue).toBe("vinted.xx");
    expect(options[0]).toBe("vinted.xx");
  });
});

describe("isMultiDomainPlatform", () => {
  it("knows vinted has country domains and poshmark does not", () => {
    expect(isMultiDomainPlatform("vinted")).toBe(true);
    expect(isMultiDomainPlatform("poshmark")).toBe(false);
  });
});

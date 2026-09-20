import { describe, expect, it } from "vitest";
import {
  asAiFieldSource,
  isAiWritten,
  readAcceptance,
} from "@/lib/ai-field-sources";

// US-3444. Two type lies were documented in src/types/database.ts and deferred:
// the entry can be a bare string (Android, US-3358), and `accepted` is a
// tri-state plus a missing key (US-3352). Both are closed here, and both had a
// live reader indexing the entry directly.

describe("asAiFieldSource", () => {
  it("returns the object form unchanged", () => {
    const entry = { source: "photo:tag", confidence: 0.82, accepted: null };
    expect(asAiFieldSource(entry)).toBe(entry);
  });

  it("returns null for Android's bare string, which carries no confidence", () => {
    // The string says an AI pass wrote the field and nothing else. A caller
    // that needs a number has to handle this, which is the whole point.
    expect(asAiFieldSource("photo:tag")).toBeNull();
  });

  it("returns null for an object missing source or confidence", () => {
    // measurement-photo-editor writes { source: "manual", measuredAt }, with no
    // confidence. Reading `.confidence` off it gave NaN in the badge tooltip.
    expect(asAiFieldSource({ source: "manual", measuredAt: "x" } as never))
      .toBeNull();
    expect(asAiFieldSource({ confidence: 0.5 } as never)).toBeNull();
  });

  it("returns null for null, undefined and a non-object", () => {
    expect(asAiFieldSource(null)).toBeNull();
    expect(asAiFieldSource(undefined)).toBeNull();
    expect(asAiFieldSource(7 as never)).toBeNull();
  });
});

describe("isAiWritten", () => {
  it("accepts both shapes, because both say an AI pass wrote the field", () => {
    expect(isAiWritten({ source: "text", confidence: 0.4 })).toBe(true);
    expect(isAiWritten("photo:front")).toBe(true);
  });

  it("refuses a manual measurement in either shape", () => {
    // The seller measured this off a photo. Badging it "AI" is a false claim
    // about who put the number there, and it was live.
    expect(isAiWritten({ source: "manual", measuredAt: "x" } as never)).toBe(false);
    expect(isAiWritten("manual")).toBe(false);
  });

  it("refuses the shapes no client has ever written", () => {
    expect(isAiWritten("")).toBe(false);
    expect(isAiWritten("   ")).toBe(false);
    expect(isAiWritten(0 as never)).toBe(false);
    expect(isAiWritten(true as never)).toBe(false);
    expect(isAiWritten(null)).toBe(false);
    expect(isAiWritten(undefined)).toBe(false);
  });
});

describe("readAcceptance", () => {
  it("keeps all four readings apart", () => {
    const base = { source: "text", confidence: 0.9 };
    expect(readAcceptance({ ...base, accepted: true })).toBe("accepted");
    expect(readAcceptance({ ...base, accepted: false })).toBe("rejected");
    expect(readAcceptance({ ...base, accepted: null })).toBe("not_shown");
    // No key at all predates the rule and is unknowable. Folding it into
    // "not_shown" is exactly what made the old constant invisible.
    expect(readAcceptance(base)).toBe("unknown");
  });

  it("reads a bare string as unknown, because Android records no acceptance", () => {
    expect(readAcceptance("photo:tag")).toBe("unknown");
  });

  it("reads nothing as unknown", () => {
    expect(readAcceptance(null)).toBe("unknown");
    expect(readAcceptance(undefined)).toBe("unknown");
  });
});

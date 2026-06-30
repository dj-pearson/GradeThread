import { describe, it, expect } from "vitest";
import { sanitizeReturnTo, RETURN_TO_KEY } from "@/lib/return-to";

describe("sanitizeReturnTo (US-1430 open-redirect guard)", () => {
  it("accepts a plain internal path", () => {
    expect(sanitizeReturnTo("/dashboard/flipdesk/items")).toBe(
      "/dashboard/flipdesk/items",
    );
  });

  it("accepts an internal path with query + hash", () => {
    expect(sanitizeReturnTo("/dashboard/inventory?tab=active#top")).toBe(
      "/dashboard/inventory?tab=active#top",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeReturnTo("  /settings  ")).toBe("/settings");
  });

  it("rejects null / undefined / empty", () => {
    expect(sanitizeReturnTo(null)).toBeNull();
    expect(sanitizeReturnTo(undefined)).toBeNull();
    expect(sanitizeReturnTo("")).toBeNull();
    expect(sanitizeReturnTo("   ")).toBeNull();
  });

  it("rejects absolute URLs (off-site bounce)", () => {
    expect(sanitizeReturnTo("https://evil.com")).toBeNull();
    expect(sanitizeReturnTo("http://evil.com/path")).toBeNull();
    expect(sanitizeReturnTo("javascript:alert(1)")).toBeNull();
  });

  it("rejects scheme-relative and backslash tricks", () => {
    expect(sanitizeReturnTo("//evil.com")).toBeNull();
    expect(sanitizeReturnTo("/\\evil.com")).toBeNull();
    expect(sanitizeReturnTo("/%2Fevil.com")).toBeNull();
    expect(sanitizeReturnTo("/%5Cevil.com")).toBeNull();
  });

  it("rejects relative paths that don't start with a slash", () => {
    expect(sanitizeReturnTo("dashboard")).toBeNull();
    expect(sanitizeReturnTo("../etc")).toBeNull();
  });

  it("rejects control characters", () => {
    expect(sanitizeReturnTo("/foo\nbar")).toBeNull();
    expect(sanitizeReturnTo("/foo\tbar")).toBeNull();
  });

  it("rejects auth surfaces to avoid loops / skipping the app", () => {
    expect(sanitizeReturnTo("/login")).toBeNull();
    expect(sanitizeReturnTo("/login?next=/x")).toBeNull();
    expect(sanitizeReturnTo("/signup")).toBeNull();
    expect(sanitizeReturnTo("/auth/callback")).toBeNull();
    expect(sanitizeReturnTo("/auth/reset-password")).toBeNull();
  });

  it("exposes a stable storage key", () => {
    expect(RETURN_TO_KEY).toBe("gt_return_to");
  });
});

import { describe, it, expect } from "vitest";
import { sanitizeReturnTo, safeEmbedUrl, RETURN_TO_KEY } from "@/lib/return-to";

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

describe("safeEmbedUrl (US-1925 embed phishing/XSS guard)", () => {
  it("accepts a benign absolute https URL (returns normalized href)", () => {
    expect(safeEmbedUrl("https://partner.example/support")).toBe(
      "https://partner.example/support",
    );
    expect(safeEmbedUrl("https://cdn.partner.example/logo.png")).toBe(
      "https://cdn.partner.example/logo.png",
    );
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(safeEmbedUrl("  https://partner.example/help  ")).toBe(
      "https://partner.example/help",
    );
  });

  it("rejects a javascript: support URL", () => {
    expect(safeEmbedUrl("javascript:alert(document.cookie)")).toBeNull();
  });

  it("rejects data: and vbscript: schemes", () => {
    expect(safeEmbedUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeEmbedUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects an http: (non-TLS) downgrade", () => {
    expect(safeEmbedUrl("http://phish.example")).toBeNull();
  });

  it("rejects protocol-relative and relative refs (not absolute URLs)", () => {
    expect(safeEmbedUrl("//phish.example")).toBeNull();
    expect(safeEmbedUrl("/dashboard")).toBeNull();
    expect(safeEmbedUrl("phish.example/support")).toBeNull();
  });

  it("returns null for empty / nullish input", () => {
    expect(safeEmbedUrl(null)).toBeNull();
    expect(safeEmbedUrl(undefined)).toBeNull();
    expect(safeEmbedUrl("")).toBeNull();
    expect(safeEmbedUrl("   ")).toBeNull();
  });
});

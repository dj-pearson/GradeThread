import { describe, it, expect } from "vitest";
import { redactSensitiveUrl, stripSensitiveParams } from "./redact-url";
import { escapeHtml } from "./escape-html";

// US-1635: single-use auth tokens must never reach analytics, and export cells
// must be HTML-escaped.

describe("redactSensitiveUrl", () => {
  it("redacts token_hash in the query but keeps non-secret params", () => {
    const out = redactSensitiveUrl(
      "https://gradethread.com/auth/confirm?token_hash=abc123&type=recovery&email=a@b.co",
    );
    expect(out).not.toContain("abc123");
    expect(out).toContain("token_hash=redacted");
    expect(out).toContain("type=recovery");
    expect(out).toContain("email=a%40b.co");
  });

  it("clears a token-bearing hash fragment", () => {
    const out = redactSensitiveUrl(
      "https://gradethread.com/reset-password#access_token=xyz&refresh_token=q",
    );
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("refresh_token");
  });

  it("leaves a clean URL untouched", () => {
    const clean = "https://gradethread.com/dashboard?tab=finances";
    expect(redactSensitiveUrl(clean)).toBe(clean);
  });

  it("preserves a relative URL shape", () => {
    const out = redactSensitiveUrl("/auth/confirm?token_hash=abc&type=signup");
    expect(out.startsWith("/auth/confirm")).toBe(true);
    expect(out).not.toContain("abc");
  });
});

describe("stripSensitiveParams", () => {
  it("removes the token param entirely and reports the change", () => {
    const { url, changed } = stripSensitiveParams(
      "https://gradethread.com/auth/confirm?token_hash=abc&type=recovery",
    );
    expect(changed).toBe(true);
    expect(url).not.toContain("token_hash");
    expect(url).toContain("type=recovery");
  });

  it("reports no change for a clean URL", () => {
    const { changed } = stripSensitiveParams("https://gradethread.com/dashboard");
    expect(changed).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("escapes the XSS-relevant characters", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("O'Brien")).toBe("O&#39;Brien");
  });

  it("coerces null/undefined to an empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

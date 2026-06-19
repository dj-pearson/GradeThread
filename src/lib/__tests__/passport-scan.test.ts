import { describe, it, expect } from "vitest";
import {
  isValidTagCode,
  normalizeTagCode,
  parseScanInput,
} from "@/lib/passport-scan";

const SLUG = "0123456789abcdef0123456789abcdef"; // 32 hex
const TAG = "ABCDEFGHJK"; // 10 Crockford base32

describe("normalizeTagCode", () => {
  it("uppercases and strips grouping hyphens / whitespace", () => {
    expect(normalizeTagCode("abcd-efgh-jk")).toBe("ABCDEFGHJK");
    expect(normalizeTagCode("ABCD EFGH JK")).toBe("ABCDEFGHJK");
  });
});

describe("isValidTagCode", () => {
  it("accepts a normalized 10-char code, rejects ambiguous/short", () => {
    expect(isValidTagCode(TAG)).toBe(true);
    expect(isValidTagCode("ABCDEFGHJ")).toBe(false); // 9 chars
    expect(isValidTagCode("ABCDEFGHIK")).toBe(false); // contains I (excluded)
  });
});

describe("parseScanInput", () => {
  it("resolves a passport link to /passport/:slug", () => {
    expect(parseScanInput(`https://gradethread.com/passport/${SLUG}`)).toEqual({
      kind: "passport",
      slug: SLUG,
      path: `/passport/${SLUG}`,
    });
  });

  it("resolves a bare 32-hex slug (case-insensitive)", () => {
    expect(parseScanInput(SLUG.toUpperCase())).toEqual({
      kind: "passport",
      slug: SLUG,
      path: `/passport/${SLUG}`,
    });
  });

  it("resolves a tag link to /t/:code (normalizing the code)", () => {
    expect(parseScanInput("https://gradethread.com/t/abcd-efgh-jk")).toEqual({
      kind: "tag",
      code: TAG,
      path: `/t/${TAG}`,
    });
  });

  it("resolves a bare grouped tag code", () => {
    expect(parseScanInput("ABCD-EFGH-JK")).toEqual({
      kind: "tag",
      code: TAG,
      path: `/t/${TAG}`,
    });
  });

  it("prefers the explicit passport path even with extra URL noise", () => {
    const out = parseScanInput(`http://x/passport/${SLUG}?s=verify#top`);
    expect(out).toEqual({ kind: "passport", slug: SLUG, path: `/passport/${SLUG}` });
  });

  it("returns null for empty / unrecognizable input", () => {
    expect(parseScanInput("")).toBeNull();
    expect(parseScanInput("   ")).toBeNull();
    expect(parseScanInput("hello world")).toBeNull();
    expect(parseScanInput("https://gradethread.com/cert/abc")).toBeNull();
  });
});

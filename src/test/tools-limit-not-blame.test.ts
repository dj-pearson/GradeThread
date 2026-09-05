import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AT_CAPACITY_CODE,
  isAtCapacity,
  isRateLimited,
  RATE_LIMITED_CODE,
} from "@/lib/tool-rate-limit";

// US-2526. The free tools rendered every non-OK response through one red line:
// "Couldn't grade that photo. Try a clearer, well-lit shot." So a visitor who
// had simply used the tool three times was told their photography was the
// problem, went and retook a photo that was fine, hit the limit again, and
// left — at the exact moment they were closest to signing up.

const GRADE = "src/pages/tools/grade-checker.tsx";
const AUTH = "src/pages/tools/authenticity-check.tsx";
const FIT = "src/pages/tools/fit-checker.tsx";
const ROUTE = "services/edge-functions/src/routes/public-grading.ts";
const GENERATOR = "src/pages/tools/listing-generator.tsx";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("a limit is told apart from a failure (US-2526)", () => {
  it("the client and the server agree on the code", () => {
    const route = read(ROUTE);
    expect(route).toContain(`export const RATE_LIMITED_CODE = "${RATE_LIMITED_CODE}"`);
  });

  it("every 429 in the public tools carries it", () => {
    const route = read(ROUTE);
    // Count the 429 responses and the codes attached to them. A new rate limit
    // added without a code puts a tool back to blaming the photo.
    const responses = route.match(/^\s*429,$/gm) ?? [];
    const codes = route.match(/code: RATE_LIMITED_CODE/g) ?? [];
    expect(responses.length).toBeGreaterThan(0);
    expect(codes.length).toBe(responses.length);
  });

  it("the status alone is enough, and the code is the backup", () => {
    expect(isRateLimited(429, null)).toBe(true);
    expect(isRateLimited(200, { code: RATE_LIMITED_CODE })).toBe(true);
    expect(isRateLimited(500, { error: "boom" })).toBe(false);
    expect(isRateLimited(400, null)).toBe(false);
  });

  it("both photo tools branch on it before the generic message", () => {
    for (const rel of [GRADE, AUTH]) {
      const src = read(rel);
      expect(src, `${rel} does not check`).toMatch(
        /if \(isRateLimited\(res\.status, body\)\)/,
      );
      // And the check comes BEFORE the "your photo" fallback, or it never runs.
      const checkAt = src.indexOf("isRateLimited(res.status");
      const blameAt = src.search(/Try (a clearer|clear,)/);
      expect(checkAt).toBeGreaterThan(-1);
      expect(checkAt).toBeLessThan(blameAt);
      expect(src).toContain("<ToolLimitNotice");
    }
  });

  it("the notice says the photo was fine and offers a way through", () => {
    const src = read("src/components/marketing/tool-limit-notice.tsx");
    expect(src).toContain("Nothing was wrong with your photo");
    expect(src).toMatch(/to="\/signup"/);
    expect(src).toMatch(/to="\/pricing"/);
  });
});

describe("a finished result converts (US-2526)", () => {
  it("all three tools carry the buyer conversion moment", () => {
    for (const rel of [GRADE, AUTH, FIT]) {
      expect(read(rel), `${rel} has no buyer CTAs`).toContain(
        "<BuyerConversionCtas",
      );
    }
  });

  it("the primary CTA goes to the flow, not to an explainer", () => {
    for (const rel of [GRADE, AUTH]) {
      const src = read(rel);
      // Someone who has just watched the tool work does not need /how-it-works.
      expect(src, `${rel} still sends the result CTA to the explainer`).not.toMatch(
        /to="\/how-it-works" onClick=\{\(\) => onCtaClick\("certify"\)\}/,
      );
      expect(src).toMatch(/to="\/dashboard\/submissions\/new"/);
    }
  });

  it("the fit checker is not expected to handle a limit it cannot hit", () => {
    // Recorded because the story asked for it: fit-checker runs entirely in the
    // browser (fit-model.ts), reaches no endpoint, and so has no rate limit to
    // report. Adding a limit branch there would be dead code pretending to be
    // a safeguard.
    const src = read(FIT);
    expect(src).not.toContain("isRateLimited");
    expect(src).not.toMatch(/fetch\(/);
  });
});

describe("at capacity is neither a limit nor a bad photo (US-3089)", () => {
  // The edge has answered 503 with at_capacity since US-1883 and NOTHING on
  // this side read it. Rendered through the rate-limit notice it tells a
  // first-time visitor they have used up a free allowance they never touched;
  // rendered through the generic error it sends them off to retake a photo
  // that was fine. Both are the US-2526 mistake wearing a different hat, and
  // this is the surface where a stranger meets us first.

  it("the client and the server agree on the code", () => {
    expect(read(ROUTE)).toContain(`export const AT_CAPACITY_CODE = "${AT_CAPACITY_CODE}"`);
  });

  it("a 503 is capacity, and a 429 is not", () => {
    expect(isAtCapacity(503, null)).toBe(true);
    expect(isAtCapacity(200, { code: AT_CAPACITY_CODE })).toBe(true);
    expect(isAtCapacity(429, { code: RATE_LIMITED_CODE })).toBe(false);
    expect(isAtCapacity(500, { error: "boom" })).toBe(false);
  });

  it("the two conditions never both claim the same response", () => {
    // A response that satisfied both would render whichever branch came first,
    // which makes the ORDER of two if-statements the thing deciding what a
    // visitor is told.
    for (const [status, body] of [
      [429, { code: RATE_LIMITED_CODE }],
      [503, { code: AT_CAPACITY_CODE }],
      [500, null],
      [400, { code: "bad_target" }],
    ] as const) {
      expect(
        isRateLimited(status, body) && isAtCapacity(status, body),
        `${status} matches both conditions`,
      ).toBe(false);
    }
  });

  it("the listing generator branches limit, then capacity, then the photo", () => {
    const src = read(GENERATOR);
    const limitAt = src.indexOf("isRateLimited(res.status");
    const capacityAt = src.indexOf("isAtCapacity(res.status");
    const blameAt = src.search(/Try clearer, well-lit shots/);
    expect(limitAt, "no rate-limit branch").toBeGreaterThan(-1);
    expect(capacityAt, "no capacity branch").toBeGreaterThan(-1);
    expect(blameAt, "no generic fallback to order against").toBeGreaterThan(-1);
    expect(limitAt).toBeLessThan(blameAt);
    expect(capacityAt).toBeLessThan(blameAt);
    expect(src).toContain("<ToolLimitNotice");
  });

  it("the capacity message blames us and does not mention the photo", () => {
    const src = read(GENERATOR);
    const start = src.indexOf("The generator is at capacity right now");
    expect(start, "no capacity copy").toBeGreaterThan(-1);
    const copy = src.slice(start, start + 400);
    expect(copy).toMatch(/That is us, not you/);
    // The two things it must never do: blame the photo, or imply the visitor
    // spent something. Neither is true, and both send them away.
    expect(copy).not.toMatch(/clearer|well-lit|better photo/i);
    expect(copy).not.toMatch(/used up|ran out|your limit/i);
  });
});

// US-2739: the two copies of the price unit boundary must not drift.
//
// src/lib/marketplace-price.ts (the browser payload + the Listing Kit row) and
// services/edge-functions/src/lib/marketplace-price.ts (everything queued from
// a phone, and every revise) both decide what units a marketplace's price input
// takes. The edge and the SPA share no module graph, so the rule exists twice.
//
// A drift here is a money bug that shows on exactly one of the two paths: the
// seller cross-posts from the desk and the price lands, queues the next one
// from their phone and it does not, and nothing anywhere reports a failure.
// This is the same arrangement aspect-normalize-mirror-parity.test.ts holds for
// the aspect tables, and it exists for the same reason: both headers can say
// "mirrored" forever while only one of them is patched.
//
// The headers DIFFER on purpose (the web copy carries the full reasoning), so
// the comparison starts at the first export and strips comments.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB = resolve("src/lib/marketplace-price.ts");
const EDGE = resolve("services/edge-functions/src/lib/marketplace-price.ts");

/** Everything from the first export down, comments and whitespace removed. */
function body(src: string): string {
  const start = src.indexOf("export const CENTS_PER_DOLLAR");
  if (start === -1) return "";
  return src
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("marketplace-price edge/web mirror (US-2739)", () => {
  const web = readFileSync(WEB, "utf8");
  const edge = readFileSync(EDGE, "utf8");

  it("the code is identical, token for token", () => {
    const a = body(web);
    const b = body(edge);
    // A pair of empty strings would compare equal and check nothing, which is
    // exactly how a mirror guard goes blind.
    expect(a.length, "the web copy's first export has been renamed").toBeGreaterThan(400);
    expect(b, "the two copies of the price unit boundary have drifted").toBe(a);
  });

  it("both copies export the whole boundary", () => {
    for (const decl of [
      "export const CENTS_PER_DOLLAR",
      "export function dollarsToCents",
      "export function centsToDollars",
      "export function stepPriceCents",
      "export function stepPrice",
      "export function marketplacePriceString",
    ]) {
      expect(web, `the web copy lost "${decl}"`).toContain(decl);
      expect(edge, `the edge copy lost "${decl}"`).toContain(decl);
    }
  });

  it("the edge copy pulls in no module graph", () => {
    // extension-queue.ts was written with zero imports so its four test files
    // run without a Supabase client. This module is the one import it has, and
    // that stays affordable only while this file imports nothing itself.
    expect(edge).not.toMatch(/^import /m);
  });
});

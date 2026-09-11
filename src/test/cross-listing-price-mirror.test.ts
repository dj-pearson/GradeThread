// US-3317: the two copies of the per-channel price rule must not drift.
//
// src/lib/cross-listing-price.ts (the Listing Kit's send-to-extension button)
// and services/edge-functions/src/lib/cross-listing-fields.ts (the cross-push
// fan-out and, through the queue route, every job a phone enqueues) both decide
// which of an item's three candidate prices this marketplace charges. The edge
// and the SPA share no module graph, so the rule exists twice.
//
// A drift here is exactly the bug US-3317 closes, re-opened: the seller sends an
// item to Poshmark from the desk and it goes at one price, queues the next one
// from their phone and it goes at another, and neither path reports anything.
// Same arrangement, and same reason, as marketplace-price-mirror.test.ts.
//
// The headers DIFFER on purpose (the web copy explains why the SPA needs it), so
// the comparison runs between two markers and strips comments.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB = resolve("src/lib/cross-listing-price.ts");
const EDGE = resolve("services/edge-functions/src/lib/cross-listing-fields.ts");

const START = "export type SiblingPriceSource";
/** The edge file carries on past the rule; the web copy ends with it. */
const EDGE_END = "export interface SourceDraftCopy";

/** The mirrored region, comments and whitespace removed. */
function body(src: string, end?: string): string {
  const start = src.indexOf(START);
  if (start === -1) return "";
  const stop = end ? src.indexOf(end) : -1;
  return src
    .slice(start, stop === -1 ? undefined : stop)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("cross-listing price edge/web mirror (US-3317)", () => {
  const web = readFileSync(WEB, "utf8");
  const edge = readFileSync(EDGE, "utf8");

  it("both files still carry the markers the comparison runs between", () => {
    expect(web, `the web copy lost "${START}"`).toContain(START);
    expect(edge, `the edge copy lost "${START}"`).toContain(START);
    expect(edge, `the edge copy lost "${EDGE_END}"`).toContain(EDGE_END);
  });

  it("the rule is identical, token for token", () => {
    const a = body(web);
    const b = body(edge, EDGE_END);
    // A pair of empty strings would compare equal and check nothing, which is
    // exactly how a mirror guard goes blind.
    expect(a.length, "the web copy's mirrored region has shrunk to nothing")
      .toBeGreaterThan(500);
    expect(b, "the two copies of the per-channel price rule have drifted").toBe(a);
  });

  it("both copies export the whole rule", () => {
    for (const decl of [
      "export type SiblingPriceSource",
      "export interface ResolvedSiblingPrice",
      "export function resolveSiblingPrice",
    ]) {
      expect(web, `the web copy lost "${decl}"`).toContain(decl);
      expect(edge, `the edge copy lost "${decl}"`).toContain(decl);
    }
  });

  it("the web copy adds no unit crossing of its own", () => {
    // US-2739 owns the dollars<->cents boundary and there is no fifth copy of
    // it. This file may only reach for it through marketplace-price.
    expect(web).toContain('from "@/lib/marketplace-price"');
    expect(web).not.toMatch(/\b100\b/);
  });
});

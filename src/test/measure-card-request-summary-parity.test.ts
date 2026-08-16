// US-2231: everything the card-request summary returns has to reach the seller.
//
// THE BUG THIS IS FOR, and it is a shape worth recognising rather than a typo.
// 00561 added `tracking_number` / `tracking_carrier` to `measure_card_requests`.
// The admin route writes them, `requestSummary()` returns them, and the route's
// own comment says "the page renders nothing rather than an empty link — see the
// migration comment for why a placeholder is worse". All true. And the page's
// `CardRequest` interface never declared either field, so it rendered nothing
// for EVERY request, tracked or not. The one person the number exists for was
// the only one who could not see it, and the comment asserting the page's
// behaviour was written next to a page that had none.
//
// A field-by-field check is the remedy because the failure is a DIVERGENCE
// between two files that are both readable statically. `requestSummary` exists
// only to feed this page — it is not a general API surface — so "the summary
// returns it" and "the page knows about it" should never come apart.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = readFileSync(
  join(process.cwd(), "services/edge-functions/src/routes/flipdesk-measure.ts"),
  "utf8",
);
const PAGE = readFileSync(
  join(process.cwd(), "src/pages/flipdesk/measure-card.tsx"),
  "utf8",
);

/** The keys of the object literal `requestSummary` returns. */
function summaryKeys(): string[] {
  const at = ROUTE.indexOf("function requestSummary");
  expect(at, "requestSummary was renamed — update this guard").toBeGreaterThan(-1);
  const open = ROUTE.indexOf("return {", at);
  const close = ROUTE.indexOf("\n  };", open);
  expect(close, "could not find the end of the returned literal").toBeGreaterThan(open);
  const body = ROUTE.slice(open, close)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return [...body.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1] ?? "");
}

/** The fields declared on the page's CardRequest interface. */
function pageFields(): string[] {
  const at = PAGE.indexOf("interface CardRequest {");
  expect(at, "CardRequest was renamed — update this guard").toBeGreaterThan(-1);
  const close = PAGE.indexOf("\n}", at);
  const body = PAGE.slice(at, close)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return [...body.matchAll(/^\s{2}([a-z_]+)[?]?:/gm)].map((m) => m[1] ?? "");
}

describe("US-2231: the card-request summary and the page agree", () => {
  it("the page declares every field the summary returns", () => {
    const missing = summaryKeys().filter((k) => !pageFields().includes(k));
    expect(
      missing,
      `requestSummary() returns ${missing.join(", ")} and ` +
        "src/pages/flipdesk/measure-card.tsx does not declare it. That is how " +
        "the tracking number reached the API and never reached the seller. " +
        "Add it to CardRequest AND render it, or stop returning it.",
    ).toEqual([]);
  });

  it("the summary is not a stub — it carries the fields this story added", () => {
    // Both assertions above pass if requestSummary returns nothing at all, so
    // this pins the fields rather than only the correspondence.
    const keys = summaryKeys();
    expect(keys).toContain("tracking_number");
    expect(keys).toContain("tracking_carrier");
    expect(keys.length).toBeGreaterThanOrEqual(6);
  });

  it("the page actually renders the tracking number, not just the type", () => {
    // Declaring the field satisfies the correspondence above while still
    // showing the seller nothing — which is the original bug wearing a type.
    expect(PAGE).toMatch(/\{request\.tracking_number\}/);
    expect(PAGE).toMatch(/request\.tracking_number \?/);
  });

  it("an untracked card renders no tracking row", () => {
    // Most cards go as untracked letters. The migration refuses to store a
    // placeholder because a seller clicks a tracking link; rendering an empty
    // one here would reintroduce that from the other end.
    expect(PAGE).not.toMatch(/tracking_number\s*\|\|\s*["']/);
    expect(PAGE).not.toMatch(/tracking_number\s*\?\?\s*["']/);
  });
});

// US-2631: the shorthand parser, which is the only hard part of this gate.
//
// A first pass of the scan reported 88 missing variables. About 70 of them were
// documented in a compact form it could not read — including every
// STRIPE_PRICE_*_YEARLY, which would have sent someone hunting for five price
// IDs that were already written down. That is the failure mode to guard: a gate
// that cries wolf gets muted, and then it is worse than nothing, because the
// green was doing work in someone's head.

import { describe, expect, it } from "vitest";
import { documentedNames, findGaps } from "./check-env-reference.mjs";

describe("US-2631: the env reference's shorthand is read the way a person reads it", () => {
  it("reads the slash form that REPLACES a segment", () => {
    // `GOOGLE_PHOTOS_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` — note the two
    // resolve differently: one drops a segment, the other drops two.
    const names = documentedNames(
      "| `GOOGLE_PHOTOS_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | edge | OAuth. |",
    );
    expect(names.has("GOOGLE_PHOTOS_CLIENT_ID")).toBe(true);
    expect(names.has("GOOGLE_PHOTOS_CLIENT_SECRET")).toBe(true);
    expect(names.has("GOOGLE_PHOTOS_REDIRECT_URI")).toBe(true);
  });

  it("reads the parenthesised form that APPENDS", () => {
    const names = documentedNames(
      "| `CONTENT_INTERNAL_JOB_SECRET` (+`_OLD`) | edge | Rotation overlap. |",
    );
    expect(names.has("CONTENT_INTERNAL_JOB_SECRET_OLD")).toBe(true);
  });

  it("reads a numeric suffix family", () => {
    const names = documentedNames(
      "| `STRIPE_PRICE_CREDITS_10` / `_25` / `_50` / `_100` | edge | Credit packs. |",
    );
    for (const suffix of ["_10", "_25", "_50", "_100"]) {
      expect(names.has(`STRIPE_PRICE_CREDITS${suffix}`), suffix).toBe(true);
    }
  });

  it("carries the base across a wrapped paragraph but not across a blank line", () => {
    // The Apple Search Ads entry puts the optional member on the next line.
    const wrapped = documentedNames(
      "`APPLE_SEARCH_ADS_ORG_ID`, `_KEY_ID`, `_PRIVATE_KEY`\nand optional `_TEAM_ID` (defaults to the client id).",
    );
    expect(wrapped.has("APPLE_SEARCH_ADS_TEAM_ID")).toBe(true);

    // A suffix in an unrelated section must NOT inherit a base from the one
    // above it — that is how an over-eager parser starts documenting names
    // nobody wrote.
    const separated = documentedNames("`SOME_OTHER_VAR`\n\n`_TEAM_ID`");
    expect(separated.has("SOME_OTHER_TEAM_ID")).toBe(false);
    expect(separated.has("SOME_OTHER_VAR_TEAM_ID")).toBe(false);
  });

  it("still reports a genuinely undocumented variable", () => {
    // The half that proves the generosity above did not swallow everything.
    const names = documentedNames("| `KNOWN_VAR` | edge | Something. |");
    const reads = new Map([
      ["KNOWN_VAR", new Set(["a.ts"])],
      ["SECRET_NOBODY_WROTE_DOWN", new Set(["b.ts"])],
    ]);
    const { missing } = findGaps(reads, names, []);
    expect(missing).toEqual(["SECRET_NOBODY_WROTE_DOWN"]);
  });

  it("an exemption naming a variable nothing reads is an error", () => {
    const { staleExemptions } = findGaps(new Map(), new Set(), [
      { name: "GONE", why: "used to be read" },
    ]);
    expect(staleExemptions).toHaveLength(1);
  });
});

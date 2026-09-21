// US-3211: the web's default block order must match the server's.
//
// src/lib/description-blocks.ts carries DEFAULT_DESCRIPTION_BLOCKS so the
// composer can draw rows before the first save, when there is no listing id
// to ask the server about. The server's defaultBlocks() is authoritative. Two
// hand-maintained copies of an ordered list drift, and the way this one drifts
// is invisible: a seller sees prose-first in the composer and facts-first in
// the published listing, or the other way round, and neither screen is wrong
// about itself.
//
// This reads the server file as TEXT rather than importing it, because the
// edge module is Deno and imports `.ts` extensions the web build will not
// resolve.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_DESCRIPTION_BLOCKS } from "@/lib/description-blocks";

const SERVER = readFileSync(
  resolve(process.cwd(), "services/edge-functions/src/lib/description-blocks.ts"),
  "utf8",
);

/** The keys defaultBlocks() returns, in order, for the UNGRADED default. */
function serverKeys(): string[] {
  const start = SERVER.indexOf("export function defaultBlocks(");
  expect(start, "defaultBlocks() not found in the server module").toBeGreaterThan(-1);
  const body = SERVER.slice(start, SERVER.indexOf("\n}", start));
  // The graded branch is a ternary on the same `condition` entry, so reading
  // `key: "..."` in order gives each block once, with condition in its place.
  const keys = [...body.matchAll(/\{\s*key:\s*"([a-z]+)"/g)].map((m) => m[1]!);
  // The ternary writes `key: "condition"` twice (graded and not); collapse it.
  return keys.filter((k, i) => !(k === "condition" && keys[i - 1] === "condition"));
}

describe("the two default block orders agree (US-3211)", () => {
  it("same keys, same order", () => {
    expect(DEFAULT_DESCRIPTION_BLOCKS.map((b) => b.key)).toEqual(serverKeys());
  });

  it("facts come before prose, on both sides", () => {
    for (const keys of [DEFAULT_DESCRIPTION_BLOCKS.map((b) => b.key), serverKeys()]) {
      const intro = keys.indexOf("intro");
      expect(intro).toBeGreaterThan(-1);
      for (const fact of ["attributes", "condition", "measurements", "disclosure"]) {
        expect(keys.indexOf(fact), `${fact} must precede intro`).toBeLessThan(intro);
      }
      expect(keys.indexOf("features")).toBeGreaterThan(intro - 1);
    }
  });

  it("the server derives the condition block when the item is graded", () => {
    // The whole of AC2's second half, asserted where the ternary lives.
    const start = SERVER.indexOf("export function defaultBlocks(");
    const body = SERVER.slice(start, SERVER.indexOf("\n}", start));
    expect(body).toMatch(/opts\.graded/);
    expect(body).toMatch(/key:\s*"condition",\s*on:\s*true,\s*src:\s*"grade"/);
  });
});

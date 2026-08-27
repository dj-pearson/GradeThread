// US-2936: the SNAD word list exists twice, and the two copies must agree.
//
// The edge is a separate Deno project and cannot import from `src/`, so
// `isNotAsDescribed` (web) and `isSnadReason` (edge) are two implementations of
// one rule. That is fine — what is not fine is them drifting, because the
// consequence is silent and asymmetric: the page would pre-load the grade pack
// on a reason the analytics does not count as a condition complaint, so a
// seller sees an argument offered for a return that their own return-rate
// report says was about something else.
//
// This is a SOURCE SCAN, which is a shape that fails quietly in six known ways.
// So it carries its own self-check: if either extraction stops finding a list,
// the test fails rather than passing on two empty sets.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB = resolve(process.cwd(), "src/pages/flipdesk/post-sale-state.ts");
const EDGE = resolve(
  process.cwd(),
  "services/edge-functions/src/lib/post-sale-analytics.ts",
);

/** Pull the quoted entries out of a named `const X = [ ... ] as const` array. */
function markersFrom(file: string, name: string): string[] {
  const src = readFileSync(file, "utf8");
  const block = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(src);
  if (!block) return [];
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("SNAD vocabulary parity (US-2936)", () => {
  const web = markersFrom(WEB, "SNAD_MARKERS");
  const edge = markersFrom(EDGE, "SNAD_MARKERS");

  it("the scan actually found both lists", () => {
    // The self-check. Two empty sets are equal, and a guard that compares them
    // reads exactly like a codebase in agreement.
    expect(web.length, `no SNAD_MARKERS found in ${WEB}`).toBeGreaterThan(3);
    expect(edge.length, `no SNAD_MARKERS found in ${EDGE}`).toBeGreaterThan(3);
  });

  it("the web and edge lists are identical", () => {
    expect([...edge].sort()).toEqual([...web].sort());
  });

  it("the extractor can tell a different list apart (self-check)", () => {
    // Proves the comparison above can fail. Without this, a bug in `markersFrom`
    // that returned the same thing for every input would pass silently.
    expect(markersFrom(WEB, "TERMINAL_MARKERS")).not.toEqual(web);
    expect(markersFrom(WEB, "TERMINAL_MARKERS").length).toBeGreaterThan(3);
  });
});

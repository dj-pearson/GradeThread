// US-2619: an og-template builder that nothing renders is invisible today.
//
// THE TRAP THIS CLOSED, and it is worth keeping the story now that the register
// is empty. og/cert, slab/cert and badge/cert became thin proxies to the Deno
// edge (the workers-og render inside a Pages Function exceeded the free-plan
// Worker CPU limit — six files carry that paragraph). Their layouts were
// RE-AUTHORED on the edge, which left buildCertOgHtml, buildCertSlabHtml and
// buildCertBadgeHtml with zero importers in functions/ outside their own tests.
// Editing one of them to change the certificate card would have done nothing at
// all: production renders the edge copy. They are now deleted (AC9) — see the
// register below for why that, and not a conversion, was the answer.
//
// WHY THE EXISTING GUARD CANNOT SEE IT, checked rather than assumed.
// scripts/check-unwired-modules.mjs flags whole EDGE modules that nothing
// imports. og-template.ts is not an edge module and it IS imported — only three
// of its exports are dead, which that guard has no way to express.
//
// This matters more the moment the remaining routes migrate: doing it the same
// way would leave SEVEN dead builders and a test suite pinning templates nobody
// renders. Each migration has to delete its Pages copy or say why it stays, and
// this is what asks the question.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS = join(process.cwd(), "functions");
const TEMPLATE = join(FUNCTIONS, "_shared", "og-template.ts");

/**
 * Builders with no Pages-side caller, and why each is still here.
 *
 * MAY ONLY SHRINK. An entry whose builder has regained an importer fails too —
 * so a migration that brings a card back has to delete its line rather than
 * leave the register describing something that is no longer true.
 */
// EMPTY, AND IT GOT THERE BY DELETION RATHER THAN BY BEING WRITTEN OFF
// (US-2619 AC9, 2026-08-17). It held buildCertOgHtml, buildCertSlabHtml and
// buildCertBadgeHtml, each on the condition "kept in case US-2619 adopts a shape
// where the Pages Function builds the markup and the edge only rasterises it".
//
// That shape DID arrive — `renderViaEdge` is exactly it, and og/social/card,
// og/blog, og/help and og/verified all use it. It still does not fit the three
// certificate routes, and the reason is structural rather than incidental: those
// routes are handed an id, and the certificate row is fetched ON THE EDGE. The
// Pages Function has no data to build markup from without a second round trip
// for every crawler hit on the most-shared card we have.
//
// So the condition resolved against them and they were deleted. They had also
// already DIVERGED from the live edge copies in lib/cert-og-template.ts — by
// 22, 286 and 225 characters — which is the register working: three functions
// that looked like the certificate card, tested green, and rendered nothing.
const KNOWN_DEAD: Record<string, string> = {};

function functionModules(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "_shared") continue;
      out.push(...functionModules(p));
    } else if (e.name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

function exportedBuilders(): string[] {
  const src = readFileSync(TEMPLATE, "utf8");
  return [...src.matchAll(/^export function (build[A-Za-z0-9]*Html)\b/gm)].map((m) => m[1]!);
}

function callersOf(name: string): number {
  let n = 0;
  for (const file of functionModules(FUNCTIONS)) {
    if (new RegExp(`\\b${name}\\b`).test(readFileSync(file, "utf8"))) n++;
  }
  return n;
}

describe("US-2619: every og-template builder is rendered by something", () => {
  it("finds the builders, so a rename cannot empty this guard", () => {
    // Guarding the guard: if the export shape changes and the scan returns
    // nothing, every assertion below passes for the wrong reason.
    // Was 8 until the three dead certificate builders were deleted (AC9). The
    // floor tracks what the file actually holds — a floor left above the real
    // count is a guard that fails for a reason unrelated to what it guards, and
    // a floor left far below it stops catching the empty scan it exists for.
    const builders = exportedBuilders();
    expect(builders.length).toBeGreaterThanOrEqual(5);
    expect(builders).toContain("buildSocialCardHtml");
  });

  it("a builder with no Pages caller is listed with a reason", () => {
    const orphans = exportedBuilders().filter(
      (b) => callersOf(b) === 0 && !(b in KNOWN_DEAD),
    );
    expect(
      orphans,
      "no Pages Function renders these, so editing one changes nothing a " +
        "visitor sees. Either wire it, delete it, or add it to KNOWN_DEAD with " +
        "the reason and the condition for removing the entry.",
    ).toEqual([]);
  });

  it("no entry outlives the deadness it describes", () => {
    // The half that makes the register shrink. When a card comes back to the
    // Pages side, this fails until its line is deleted — so the list cannot rot
    // into a record of a problem that no longer exists.
    const revived = Object.keys(KNOWN_DEAD).filter((b) => callersOf(b) > 0);
    expect(
      revived,
      "these are listed as dead and something now renders them. Delete their " +
        "KNOWN_DEAD entries.",
    ).toEqual([]);
  });

  it("every reason is a real one", () => {
    for (const [name, why] of Object.entries(KNOWN_DEAD)) {
      expect(why.length, `${name}: an exception needs a real reason`).toBeGreaterThan(80);
      // A reason that does not say when the entry goes away is a permanent
      // exception wearing a temporary one's clothes.
      expect(why, `${name}: say what would make this entry deletable`).toMatch(
        /Delete it|same condition/,
      );
    }
  });
});

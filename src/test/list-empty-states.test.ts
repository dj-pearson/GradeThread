import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// US-2866 + US-2867.
//
// THE STORIES BOTH OVERSTATED THE PROBLEM, and the correction is the useful
// part. A first survey said 158 list surfaces had no empty state; it was
// counting every `{x.map(` in every file, which swept in tab strips, select
// options, marketing feature grids and table headers. A second, scoped to
// customer surfaces that fetch the user's own rows, said 32; most of those
// branch on emptiness and render a perfectly reasonable sentence, just as a
// bare <p> rather than the shared component.
//
// What was actually wrong, once counted properly:
//
//   • a handful of PRIMARY lists said one short sentence with no way forward
//     ("No open offers.", "You don't have any support tickets yet.")
//   • four surfaces DID distinguish zero-data from no-matches -- which US-2867
//     assumed none did -- but the no-matches branch offered no way to clear the
//     filter that was hiding everything. A dead end on a filter the user set
//     two clicks ago is the most common way a working list reads as broken.
//
// This file guards the second one, because it is the one with a rule: if a
// branch already knows the list is non-empty, it must not send the user off to
// create something, and it must offer the way back.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "__tests__") continue;
      walk(p, out);
      continue;
    }
    if (/\.tsx$/.test(e) && !/\.test\.tsx$/.test(e)) {
      out.push(relative(ROOT, p).replace(/\\/g, "/"));
    }
  }
  return out;
}

const PAGES = walk(resolve(ROOT, "src/pages"));

/**
 * Surfaces that distinguish "you have none" from "none match your filter".
 * Every one of them must offer a way to clear the filter.
 *
 * This list only ever GROWS. A surface that starts distinguishing the two cases
 * belongs here; one that stops has regressed.
 */
const DISTINGUISHING: Array<[file: string, clearLabel: string]> = [
  ["src/pages/flipdesk/autolister-drafts.tsx", "Clear search"],
  ["src/pages/flipdesk/bulk-pricing.tsx", "Clear filters"],
];

/**
 * The same distinction, expressed through the shared component.
 *
 * These two went through <FilterEmpty> rather than a hand-written EmptyState,
 * because US-2520's shrink-only ratchet on the AutoLister files does not accept
 * "I added three lines for a good reason" -- and it was right not to. Extracting
 * the state paid for the fix exactly: both files came back to their ceiling.
 */
const VIA_COMPONENT: Array<[file: string, clearLabel: string]> = [
  ["src/pages/flipdesk/autolister.tsx", "Clear filter"],
  ["src/pages/flipdesk/autolister-queue.tsx", "Show all drafts"],
];

describe("a filtered-empty list offers the way back (US-2867)", () => {
  for (const [file, label] of DISTINGUISHING) {
    it(`${file} can clear what is hiding the rows`, () => {
      const src = read(file);
      expect(
        src.includes(`label: "${label}"`),
        `${file} tells the user nothing matches and gives them no way to undo ` +
          "the filter doing it.",
      ).toBe(true);
      expect(
        src.includes("secondaryAction"),
        "the clear-filter path is the SECONDARY action; the primary action on a " +
          "no-matches state would be 'go and create one', which is the wrong " +
          "answer for somebody who already has rows",
      ).toBe(true);
    });
  }

  for (const [file, label] of VIA_COMPONENT) {
    it(`${file} uses the shared filtered-empty component`, () => {
      const src = read(file);
      expect(src).toContain("<FilterEmpty");
      expect(src).toContain(`clearLabel="${label}"`);
      // The count is a REQUIRED prop, so "none match" can never render without
      // the number that stops it reading as "none exist".
      expect(src).toMatch(/total=\{/);
    });
  }

  it("FilterEmpty forces the caller to supply the count", () => {
    const src = read("src/components/flipdesk/filter-empty.tsx");
    expect(src).toContain("total: number;");
    expect(
      /total\?: number/.test(src),
      "making the count optional puts back the exact confusion this component " +
        "exists to remove",
    ).toBe(false);
    expect(
      /\baction=\{/.test(src),
      "a filtered-empty state has no primary action — the rows already exist",
    ).toBe(false);
  });

  it("a clear-filters handler resets every filter, not just one", () => {
    // Half a reset leaves the list empty and makes the button look broken,
    // which is worse than not offering it.
    const src = read("src/pages/flipdesk/bulk-pricing.tsx");
    const at = src.indexOf('label: "Clear filters"');
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, at + 500);
    for (const setter of ["setSearch", "setBrandFilter", "setMinPrice", "setMaxPrice"]) {
      expect(
        handler.includes(setter),
        `"Clear filters" on bulk pricing does not call ${setter}`,
      ).toBe(true);
    }
  });
});

describe("primary lists say what goes in them (US-2866)", () => {
  // The ones converted from a bare sentence to the shared component, with a
  // real action. Pinned so they cannot quietly go back.
  const CONVERTED: Array<[file: string, title: string]> = [
    ["src/pages/support-tickets.tsx", "No support tickets yet"],
    ["src/pages/flipdesk/offers.tsx", "No open offers"],
    ["src/pages/flipdesk/autolister-drafts.tsx", "No unpublished drafts yet"],
    ["src/pages/flipdesk/bulk-pricing.tsx", "No active eBay listings"],
  ];

  for (const [file, title] of CONVERTED) {
    it(`${file} uses the shared empty state`, () => {
      const src = read(file);
      expect(src).toContain("<EmptyState");
      expect(src).toContain(`title="${title}"`);
    });
  }

  it("every converted zero-data state offers a next step", () => {
    for (const [file] of CONVERTED) {
      const src = read(file);
      const at = src.indexOf("<EmptyState");
      const block = src.slice(at, at + 900);
      expect(
        /\baction=\{/.test(block),
        `${file}: the first EmptyState is the zero-data one and has no action. ` +
          '"You have none" with nothing to press is a dead end.',
      ).toBe(true);
    }
  });
});

describe("the shared component still supports both cases (US-2867)", () => {
  const src = read("src/components/ui/empty-state.tsx");

  it("takes a primary and a secondary action", () => {
    expect(src).toContain("action?: EmptyStateAction");
    expect(src).toContain("secondaryAction?: EmptyStateAction");
  });

  it("an action can be a handler, not only a route", () => {
    // "Clear filters" is a state reset, not a navigation. Without onClick the
    // whole no-matches pattern has to be hand-rolled at every call site.
    expect(src).toContain("onClick?: () => void");
  });
});

describe("the scan is looking at real files", () => {
  it("found the page tree", () => {
    expect(PAGES.length).toBeGreaterThan(150);
    for (const [file] of [...DISTINGUISHING, ...VIA_COMPONENT]) {
      expect(PAGES.includes(file), `${file} is not a page any more`).toBe(true);
    }
  });
});

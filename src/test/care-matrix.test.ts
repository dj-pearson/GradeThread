import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CARE_MATRIX,
  FIBER_LABELS,
  FIBER_SLUGS,
  MATRIX_PAGE_CAP,
  careMatrixRoutes,
  matrixPath,
  orphanedMatrixEntries,
  type FiberClass,
} from "@/lib/seo/care-matrix";
import { FLAW_ENTRIES, getFlawBySlug } from "@/lib/seo/flaw-library";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";

// US-9014. A programmatic family is only allowed to exist where the generated
// page says something its parent does not. Path 4's value pages failed that
// test; this one has to keep passing it.
//
// The assertions that matter are the ones that would let the family rot into
// 192 near-identical pages, which is what every programmatic family does if
// nobody is checking.

describe("the matrix only exists where the answer differs (US-9014 AC2)", () => {
  it("generates far fewer pages than the full cross product", () => {
    const possible = FLAW_ENTRIES.length * Object.keys(FIBER_SLUGS).length;
    expect(possible).toBe(192);
    expect(CARE_MATRIX.length).toBeLessThan(possible / 4);
  });

  it("makes every entry state what actually changes", () => {
    // If you cannot write this line, the combination does not get a page.
    for (const e of CARE_MATRIX) {
      expect(e.differs.length, matrixPath(e)).toBeGreaterThan(60);
      expect(e.neverDo.length, matrixPath(e)).toBeGreaterThan(50);
    }
  });

  it("never restates the parent's procedure", () => {
    // The actual AC. A generated page whose steps are the parent's steps is a
    // duplicate wearing a different URL.
    for (const e of CARE_MATRIX) {
      const parent = getFlawBySlug(e.flaw);
      expect(parent, e.flaw).toBeDefined();
      const parentSteps = new Set(parent!.removal.map((s) => s.trim().toLowerCase()));
      for (const step of e.steps) {
        expect(
          parentSteps.has(step.trim().toLowerCase()),
          `${matrixPath(e)} repeats a step verbatim from ${e.flaw}`,
        ).toBe(false);
      }
    }
  });

  it("differs from the parent by more than a rename", () => {
    // A weaker but broader check than exact-match: the step lists must not be
    // substantially the same text.
    for (const e of CARE_MATRIX) {
      const parent = getFlawBySlug(e.flaw)!;
      const parentText = parent.removal.join(" ").toLowerCase();
      const overlap = e.steps.filter((s) => parentText.includes(s.slice(0, 40).toLowerCase()));
      expect(overlap.length, `${matrixPath(e)} is mostly the parent's text`).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("does not generate a page for a combination that would only canonicalise", () => {
    // There is deliberately no thin page pointing at the parent. A page that
    // exists only to point elsewhere is still a page Google crawls and judges.
    const generated = new Set(CARE_MATRIX.map((e) => `${e.flaw}:${e.fiber}`));
    let unrepresented = 0;
    for (const f of FLAW_ENTRIES) {
      for (const fiber of Object.keys(FIBER_SLUGS) as FiberClass[]) {
        if (!generated.has(`${f.slug}:${fiber}`)) unrepresented++;
      }
    }
    expect(unrepresented).toBe(192 - CARE_MATRIX.length);
    // And none of them has a route.
    const matrixPaths = new Set(PUBLIC_ROUTES.map((r) => r.path));
    expect(matrixPaths.has("/care/pilling/linen")).toBe(false);
    expect(matrixPaths.has("/care/bleach-spots/silk")).toBe(false);
  });
});

describe("the matrix is wired and bounded", () => {
  it("has no entry whose parent flaw is missing", () => {
    expect(orphanedMatrixEntries().map((e) => e.flaw)).toEqual([]);
  });

  it("registers every entry in PUBLIC_ROUTES", () => {
    const registered = new Set(PUBLIC_ROUTES.map((r) => r.path));
    for (const e of CARE_MATRIX) {
      expect(registered.has(matrixPath(e)), matrixPath(e)).toBe(true);
    }
    expect(careMatrixRoutes()).toHaveLength(CARE_MATRIX.length);
  });

  it("is LINKED TO from the parent flaw page, not merely registered", () => {
    // MEASURED IN PRODUCTION 2026-08-22, before this existed: all 18 matrix
    // pages were orphaned. Every one of the 11 parent flaw pages linked zero of
    // its children — /care/rust-spots served 30283 bytes and not one
    // href="/care/rust-spots/silk". The pages were in the sitemap and reachable
    // by URL, and nothing pointed down at them.
    //
    // Registration is what the case above checks and it is not the same
    // question. interlink-rules.ts states the policy this enforces: "a pillar
    // links all its cluster children in a curated chapter block (enforced by
    // the pillar page components)". Nothing enforced it.
    //
    // The tell was sitting in the audit the whole time, filed under the wrong
    // heading: matrixEntriesForFlaw is documented "for the parent page to link
    // down to" and had no callers, so audit-file-local-exports reported it as a
    // DEAD EXPORT. It was a missing section.
    //
    // A SOURCE SCAN IS THE RIGHT SHAPE HERE and it is worth saying why, because
    // it usually is not: the question is pure wiring — does the parent component
    // render a link per child — and the rendering itself is a `.map` over the
    // helper's return, which has its own cases above. What a scan cannot check
    // is that the block is visible or well-placed, and nothing here claims it.
    const page = readFileSync(
      resolve(process.cwd(), "src/pages/marketing/flaw-library.tsx"),
      "utf8",
    );
    expect(page).toContain("matrixEntriesForFlaw(flaw.slug)");
    expect(page).toContain("to={matrixPath(entry)}");
    // Derived once per page, so a second flaw's children cannot be rendered
    // under the first.
    expect((page.match(/matrixEntriesForFlaw\(/g) ?? []).length).toBe(1);
  });

  it("gives every parent flaw with children something to link", () => {
    // The data half of the case above: if a flaw's children exist, the helper
    // must return them. Guards the guard — a helper that returned [] for
    // everything would leave the source scan passing over a page that renders
    // nothing.
    const parents = new Set(CARE_MATRIX.map((e) => e.flaw));
    expect(parents.size).toBeGreaterThan(0);
    for (const flaw of parents) {
      const kids = CARE_MATRIX.filter((e) => e.flaw === flaw);
      expect(kids.length, flaw).toBeGreaterThan(0);
      expect(getFlawBySlug(flaw), `${flaw} has children but no parent page`).toBeDefined();
    }
  });

  it("lives under /care, so the containment guards apply to it too", () => {
    for (const e of CARE_MATRIX) {
      expect(matrixPath(e).startsWith("/care/")).toBe(true);
      // Two segments below /care: /care/{flaw}/{fabric}.
      expect(matrixPath(e).split("/")).toHaveLength(4);
    }
  });

  it("stays under the cap, and logs the count at build time", () => {
    expect(CARE_MATRIX.length).toBeLessThan(MATRIX_PAGE_CAP);
    const viteConfig = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
    expect(viteConfig).toContain("MATRIX_PAGE_CAP");
    expect(viteConfig).toContain("[seo] care cluster");
  });

  it("keeps titles and descriptions inside the SERP budget", () => {
    for (const e of CARE_MATRIX) {
      expect(e.title.length, `${matrixPath(e)} title`).toBeLessThanOrEqual(46);
      expect(e.description.length, `${matrixPath(e)} description`).toBeGreaterThanOrEqual(70);
      expect(e.description.length, `${matrixPath(e)} description`).toBeLessThanOrEqual(160);
    }
  });

  it("has a unique path per entry", () => {
    const paths = CARE_MATRIX.map(matrixPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("names every fibre class it uses", () => {
    for (const e of CARE_MATRIX) {
      expect(FIBER_SLUGS[e.fiber], e.fiber).toBeDefined();
      expect(FIBER_LABELS[e.fiber], e.fiber).toBeDefined();
    }
  });
});

describe("the fibre taxonomy is mirrored, not invented (US-9014 AC1)", () => {
  it("matches FiberClass in the grading engine", () => {
    // The edge module is the source of truth; this file is the mirror. Same
    // treatment ebay-fees.ts gets, for the same reason: two lists that are
    // supposed to be one list will drift, silently, on the first edit.
    const edge = readFileSync(
      resolve(process.cwd(), "services/edge-functions/src/lib/fabric-criteria.ts"),
      "utf8",
    );
    const block = edge.slice(edge.indexOf("export type FiberClass ="));
    const declared = [...block.slice(0, block.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(FIBER_SLUGS).sort()).toEqual([...declared].sort());
  });
});

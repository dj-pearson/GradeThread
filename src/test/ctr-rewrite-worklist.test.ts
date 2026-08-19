import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCsv,
  blogRewrites,
  isUntouched,
  validate,
} from "../../scripts/apply-blog-ctr-rewrites.mjs";
import { PUBLIC_ROUTES } from "@/lib/seo/public-routes";
import { valueItemTitle } from "../../functions/_shared/condition-index-render";

// US-9017. The CTR pass splits across two surfaces: eleven registry routes
// whose titles ship with the build, and seven /blog/ posts whose SERP copy is a
// database column written by scripts/apply-blog-ctr-rewrites.mjs. The worklist
// CSV is the shared record of what was decided, so it is the thing worth
// guarding — a proposal that busts the SERP budget, or a registry row whose
// proposal never actually reached the code, both fail here rather than in
// Search Console sixty days later.
//
// Registry-route titles are separately length-checked by route-metadata.test.ts
// against the 60-char cap including the " | GradeThread" suffix. This file
// checks the DIFFERENT thing: that the shipped copy matches the reviewed copy.

const ROOT = join(__dirname, "../..");
const CSV = readFileSync(join(ROOT, "docs/seo/ctr-rewrite-worklist.csv"), "utf8");
const rows = parseCsv(CSV);

describe("CTR rewrite worklist (US-9017)", () => {
  it("every row carries a proposal", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.proposed_title.trim(), `no proposed_title for ${r.url}`).not.toBe("");
      expect(
        r.proposed_meta_description.trim(),
        `no proposed_meta_description for ${r.url}`,
      ).not.toBe("");
    }
  });

  it("every blog rewrite fits the SERP budget", () => {
    for (const r of blogRewrites(CSV)) {
      expect(validate(r), `${r.slug}: ${validate(r).join("; ")}`).toEqual([]);
    }
  });

  const registryRows = rows.filter(
    (r) => !r.url.startsWith("/blog/") && !r.url.startsWith("/value/"),
  );

  it.each(registryRows.map((r) => [r.url, r] as const))(
    "%s ships the reviewed title and description",
    (url, r) => {
      const route = PUBLIC_ROUTES.find((x) => x.path === url);
      expect(route, `${url} is not a registered public route`).toBeDefined();
      expect(route!.title).toBe(r.proposed_title);
      expect(route!.description).toBe(r.proposed_meta_description);
    },
  );
});

// The /value row is not a registry route — /value/{brand}/{item} is edge-SSR'd
// by functions/value/[[path]].ts, so its title is a template over a curve label
// and the only thing worth asserting is that the template stays inside the SERP
// cap for a label of any length.
describe("value item titles stay inside the SERP cap (US-9017)", () => {
  it("uses the click hook when it fits", () => {
    expect(valueItemTitle("Nike Tech Fleece")).toBe(
      "Nike Tech Fleece Resale Value: What Yours Is Worth",
    );
  });

  it("falls back rather than being truncated mid-promise", () => {
    const long = "Patagonia Better Sweater Full-Zip Fleece Jacket";
    expect(valueItemTitle(long)).toBe(`${long} Resale Value`);
    const middling = "Carhartt Detroit Jacket J97";
    expect(valueItemTitle(middling)).toBe(`${middling} Resale Value by Condition`);
  });

  it("keeps every real curve label inside 60 characters", () => {
    // The longest label the Value Index carries today is 46 characters, which
    // is exactly where the plain fallback still fits. A label past that cannot
    // be rescued by any suffix, so the helper stops adding to the problem
    // rather than pretending it fixed it.
    for (const label of [
      "Nike Tech Fleece",
      "Carhartt Detroit Jacket J97",
      "Patagonia Better Sweater Full-Zip Fleece Jacket",
    ]) {
      expect(valueItemTitle(label).length, label).toBeLessThanOrEqual(60);
    }
    expect(valueItemTitle("A".repeat(120))).toBe(`${"A".repeat(120)} Resale Value`);
  });
});

// US-9017. The clobber guard, extracted so it can be tested without a database.
//
// It was BROKEN when this test was written, and the break was invisible to
// every check that existed: the dry run never reads the database, so it
// exercises none of this. It was caught by running --apply against the
// throwaway local stack with a seeded fixture on 2026-08-18, which found the
// script silently overwriting an admin's edit while reporting "wrote" — the one
// thing the script's own header promises it never does.
describe("the CTR script never clobbers an admin edit (US-9017)", () => {
  const rewrite = {
    slug: "a-post",
    currentTitle: "The Title The Worklist Captured",
    title: "The Proposed New Title",
    description: "The proposed new description.",
  };

  it("treats a NULL seo_title as untouched: the SERP was showing `title`", () => {
    expect(isUntouched({ title: rewrite.currentTitle, seo_title: null }, rewrite)).toBe(true);
  });

  it("treats seo_title equal to the captured title as untouched", () => {
    expect(
      isUntouched({ title: "Something Else", seo_title: rewrite.currentTitle }, rewrite),
    ).toBe(true);
  });

  it("treats seo_title equal to the PROPOSED title as untouched, not edited", () => {
    // A part-written earlier run: title applied, description not. Resumable.
    expect(isUntouched({ title: "Something Else", seo_title: rewrite.title }, rewrite)).toBe(
      true,
    );
  });

  it("treats any other seo_title as an edit to be protected", () => {
    expect(
      isUntouched({ title: "Something Else", seo_title: "Admin wrote this" }, rewrite),
    ).toBe(false);
  });

  it("THE REGRESSION: a matching `title` must not excuse an edited seo_title", () => {
    // This is the exact shape that was being clobbered. seo_title was NULL when
    // the worklist was captured, so current_title == title; an admin then set
    // seo_title. The old guard had `|| post.title === currentTitle`, which
    // fired here and overwrote the admin.
    expect(
      isUntouched(
        { title: rewrite.currentTitle, seo_title: "Admin Edited This In The UI Last Week" },
        rewrite,
      ),
    ).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// US-2542. The house style names tracked uppercase as the most recognizable
// tell of a default-looking UI, and this app had 106 of them , seven of which
// were the entire outline of the Marketplaces page. Twenty-three pages also
// hand-rolled an <h1> instead of the shared header, so the heading rhythm
// changed as you moved between them.
//
// The two halves of the fix are different in kind, and this file holds both:
//   - Section HEADINGS are converted outright, and may not come back.
//   - The remaining small-caps LABELS ("SKU", "STATUS", 10-11px inside cards)
//     are a legible convention, kept deliberately and held under a ratchet so
//     the pattern cannot be reached for by default again.

const DIRS = ["src/pages", "src/components"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(process.cwd(), dir))) {
    const rel = join(dir, entry);
    const full = resolve(process.cwd(), rel);
    if (statSync(full).isDirectory()) out.push(...walk(rel));
    else if (entry.endsWith(".tsx")) out.push(rel.split("\\").join("/"));
  }
  return out;
}

function readAll(): { rel: string; src: string }[] {
  return DIRS.flatMap(walk).map((rel) => ({
    rel,
    src: readFileSync(resolve(process.cwd(), rel), "utf8"),
  }));
}

describe("tracked uppercase is not the house heading style (US-2542)", () => {
  it("no heading element uses it", () => {
    const offenders: string[] = [];
    for (const { rel, src } of readAll()) {
      for (const m of src.matchAll(/<h[1-6][^>]*uppercase tracking[^>]*>/g)) {
        offenders.push(`${rel}: ${m[0].slice(0, 70)}`);
      }
    }
    expect(
      offenders,
      "a section heading should carry weight and size, not letter-spacing:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the remaining small-caps labels only shrink", () => {
    // 80 at the time of the sweep. Lower it when a page loses one; never raise
    // it. A ceiling that moves up on demand is not a ceiling.
    const CEILING = 80;
    const count = readAll().reduce(
      (n, { src }) => n + (src.match(/uppercase tracking/g) ?? []).length,
      0,
    );
    expect(
      count,
      `${count} uses of tracked uppercase, ceiling ${CEILING}. These are meant ` +
        "to be small data labels inside cards , if this is a new section " +
        "heading, use weight and size instead.",
    ).toBeLessThanOrEqual(CEILING);
    // And if it has dropped well below, lower the ceiling in the same commit.
    expect(CEILING - count, "the ceiling has gone slack , lower it").toBeLessThan(15);
  });
});

describe("pages share one header (US-2542)", () => {
  // The pages the story named. Each rendered its own <h1> with its own size and
  // spacing, so the heading rhythm changed as you moved between them.
  //
  // Four detail pages are deliberately NOT here: flipdesk/intake.tsx,
  // admin/task-board.tsx, admin/user-detail.tsx and admin/ops-runbooks.tsx all
  // put a back button to the LEFT of the title. PageHeader has no back slot and
  // it lives under src/components/ui/, which is generated and not hand-edited,
  // so converting them would mean nesting a button inside the <h1>. Give
  // PageHeader a real `back` prop first, then move them over.
  const CONVERTED = [
    "src/pages/admin/ai-models.tsx",
    "src/pages/admin/analytics.tsx",
    "src/pages/admin/claims.tsx",
    "src/pages/admin/dashboard.tsx",
    "src/pages/admin/disputes.tsx",
    "src/pages/admin/grading.tsx",
    "src/pages/admin/submissions.tsx",
    "src/pages/admin/support.tsx",
    "src/pages/admin/support-tickets.tsx",
    "src/pages/admin/users.tsx",
    "src/pages/new-submission.tsx",
    "src/pages/bulk-submission.tsx",
    "src/pages/snap.tsx",
    "src/pages/flipdesk/search.tsx",
    "src/pages/flipdesk/measure-card.tsx",
    "src/pages/fit/body-profiles.tsx",
    "src/pages/flipdesk/marketplaces-google.tsx",
  ];

  for (const rel of CONVERTED) {
    it(`${rel} uses PageHeader`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src, "no PageHeader import").toMatch(
        /from "@\/components\/ui\/page-header"/,
      );
      expect(src, "still hand-rolls a page <h1>").not.toMatch(
        /<h1 className="[^"]*text-2xl font-bold/,
      );
    });
  }
});

describe("images reserve their space (US-2542)", () => {
  it("every logo carries its intrinsic size", () => {
    const offenders: string[] = [];
    for (const { rel, src } of [
      ...readAll(),
      // The auth layout lives outside both scanned trees.
      {
        rel: "src/layouts/auth-layout.tsx",
        src: readFileSync(resolve(process.cwd(), "src/layouts/auth-layout.tsx"), "utf8"),
      },
    ]) {
      for (const m of src.matchAll(/<img\s[^>]*\/>/g)) {
        if (!/src="\/logo/.test(m[0])) continue;
        if (!/\bwidth=/.test(m[0]) || !/\bheight=/.test(m[0])) {
          offenders.push(`${rel}: ${m[0].slice(0, 60).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(
      offenders,
      "an <img> with no intrinsic size reserves no box, so the header jumps " +
        "when it decodes:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });
});

describe("gradients stay rare (US-2542)", () => {
  it("the sweep introduced none", () => {
    // Two at the time of the sweep, both a barely-there tint on a card. The
    // point of this test is that a "make it look designed" pass does not turn
    // into a purple-gradient pass.
    const count = readAll().reduce(
      (n, { src }) => n + (src.match(/bg-gradient-to-/g) ?? []).length,
      0,
    );
    expect(count).toBeLessThanOrEqual(2);
  });

  it("no gradient text anywhere", () => {
    const offenders = readAll()
      .filter(({ src }) => src.includes("bg-clip-text"))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

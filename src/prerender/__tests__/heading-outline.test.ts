// Every prerendered page must have exactly one <h1> and no skipped heading
// level.
//
// Heading order is how screen-reader users navigate a page — most jump by
// heading rather than reading linearly. A skip (h1 -> h3, or h2 -> h4) tells
// assistive tech a level exists that does not, so a section appears nested
// under a parent that was never announced. It is invisible in review because
// the page LOOKS right: the skip is usually someone picking a heading tag for
// its font size rather than its position in the outline, which is exactly how
// both instances here happened (an h3 chosen for `text-sm`, an h4 for a card).
//
// This runs against the SHIPPED HTML rather than the components, so it also
// covers headings contributed by shared layouts — the level a component lands
// on depends on what wraps it, which no component-level test can see.
//
// Requires `npm run build` first; CI builds before running tests (US-2038).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const DIST = resolve(process.cwd(), "dist");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".html")) out.push(full);
  }
  return out;
}

function routeOf(file: string): string {
  return (
    "/" +
    relative(DIST, file).split(sep).join("/").replace(/\.html$/, "").replace(/^index$/, "")
  );
}

const hasDist = existsSync(DIST);
const files = hasDist ? walk(DIST) : [];

describe.skipIf(!hasDist)("prerendered heading outlines", () => {
  it("dist contains the full set of prerendered pages", () => {
    // Guards the guard: if dist is partial, everything below passes trivially.
    expect(files.length, "dist/ has too few pages — build first").toBeGreaterThan(200);
  });

  it("every page has exactly one h1", () => {
    const bad: string[] = [];
    for (const f of files) {
      const html = readFileSync(f, "utf8");
      const body = html.slice(html.indexOf("<body"));
      const count = (body.match(/<h1\b/gi) ?? []).length;
      if (count !== 1) bad.push(`${routeOf(f)} has ${count}`);
    }
    expect(
      bad,
      "Each page needs exactly one h1 — it is the page's accessible title and " +
        "the top of its outline:\n  " + bad.join("\n  "),
    ).toEqual([]);
  });

  it("no page skips a heading level", () => {
    const bad: string[] = [];
    for (const f of files) {
      const html = readFileSync(f, "utf8");
      const body = html.slice(html.indexOf("<body"));
      const levels = [...body.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));
      for (let i = 1; i < levels.length; i++) {
        if (levels[i]! - levels[i - 1]! > 1) {
          bad.push(`${routeOf(f)}: h${levels[i - 1]} -> h${levels[i]}`);
          break;
        }
      }
    }
    expect(
      bad,
      "These pages skip a heading level, which announces a nesting depth that " +
        "does not exist to anyone navigating by heading. Pick the tag for its " +
        "position in the outline, then style it — not the reverse:\n  " +
        bad.join("\n  "),
    ).toEqual([]);
  });
});

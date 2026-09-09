import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, sep } from "node:path";

// US-3243.
//
// autolister-bulk-edit.tsx tracked a per-row dirty flag, showed dirtyCount in
// the Save button, and saved each dirty row independently (US-557). What it
// never did was stop you leaving. A seller who had retitled, repriced and
// re-categorised forty listings and then clicked the sidebar lost all of it:
// the edits live only in component state, and nothing warned.
//
// useNavigationGuard has existed since US-2032 and already covered composer,
// intake, blog-editor, social-editor and customize-board. This page had the
// signal it needed and was simply never wired up.
//
// THE RULE KEYS ON AN EXPLICIT DIRTY SIGNAL, not on how much state a page
// holds. A scan by useState count returns 23 pages and most of them are right:
// a filter panel is not unsaved work, and blocking navigation where nothing is
// at stake trains people to click through the dialog -- which is how a guard
// stops working. The hook's own doc comment says exactly that.

const ROOTS = ["src/pages", "src/components/dashboard"];

/** A page that names a dirty count and can save it has work worth keeping. */
const DIRTY_SIGNAL = /\bdirtyCount\b|\bisDirty\b|\bhasUnsavedChanges\b/;
const GUARDED = /useNavigationGuard\b/;

/**
 * Pages that carry a dirty signal and deliberately do not block. Each needs a
 * reason, because "it seemed fine" is how the bulk grid went two years without
 * one.
 */
const ALLOWED: { file: string; why: string }[] = [];

function listPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) {
        out.push(p.split(sep).join("/"));
      }
    }
  };
  for (const r of ROOTS) walk(resolve(process.cwd(), r));
  return out.map((p) => p.slice(p.indexOf("src/")));
}

describe("a page that knows it has unsaved work says so on the way out (US-3243)", () => {
  const files = listPages();

  it("found pages, and the patterns match what they claim (self-check)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(DIRTY_SIGNAL.test("const dirtyCount = rows.filter(r => r.dirty).length;")).toBe(true);
    expect(DIRTY_SIGNAL.test("const [filter, setFilter] = useState('');")).toBe(false);
    expect(GUARDED.test("const guard = useNavigationGuard(dirty);")).toBe(true);
    // The known-good pages must actually be found by this scan, or the rule
    // below is asserting over the wrong set.
    expect(files).toContain("src/pages/flipdesk/composer.tsx");
    expect(files).toContain("src/pages/flipdesk/autolister-bulk-edit.tsx");
    const stale = ALLOWED.filter((a) => !files.includes(a.file)).map((a) => a.file);
    expect(stale, `allowlist entries with no file:\n  ${stale.join("\n  ")}`).toEqual([]);
  });

  it("every page with a dirty signal mounts the guard", () => {
    const allowed = new Set(ALLOWED.map((a) => a.file));
    const offenders = files
      .filter((rel) => {
        if (allowed.has(rel)) return false;
        const src = readFileSync(resolve(process.cwd(), rel), "utf8");
        return DIRTY_SIGNAL.test(src) && !GUARDED.test(src);
      })
      .sort();
    expect(
      offenders,
      "these track unsaved work and let you walk away from it. Wire " +
        "useNavigationGuard(<dirty> && !saving) and render the confirm " +
        "dialog, or add the file to ALLOWED with a reason:\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("the bulk grid names how many rows it is about to discard", () => {
    // "You have unsaved changes" is the copy people click through. The number
    // is the part that makes someone stop.
    const src = readFileSync(
      resolve(process.cwd(), "src/pages/flipdesk/autolister-bulk-edit.tsx"),
      "utf8",
    );
    expect(src).toMatch(/useNavigationGuard\(dirtyCount > 0 && !saving\)/);
    expect(src).toMatch(/<UnsavedChangesDialog[^>]*count=\{dirtyCount\}/);
  });
});

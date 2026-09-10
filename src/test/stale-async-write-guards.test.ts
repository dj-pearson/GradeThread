import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// US-3223. A REGRESSION guard over the sites that have been fixed, and NOT a
// detector for new ones.
//
// That distinction is the whole point, and AC3 is why. The scanner that found
// the first three sites flagged five and two of those were correct code. The
// widened scan run for this story (async work started outside a useEffect whose
// RESULT is written to state) produced 65 candidates, 41 of them on
// money-shaped surfaces, and hand-checking them turned up four real defects —
// roughly a 6% hit rate. A build-failing rule at that precision does not teach
// people to guard their async writes, it teaches them to add suppressions, and
// then the suppression list is the thing nobody reads.
//
// So this file makes no judgement about code it has never seen. It asserts two
// things that cannot be false positives, because both are statements about
// files that already carry a guard:
//
//   1. Each fixed site still has one. A revert, a refactor that inlines a
//      helper, or a merge that drops a line all show up here.
//   2. Nothing imports the RunOwner and then fails to read the flag. Keeping
//      `useLatestRun` while deleting `if (run.superseded)` is the exact shape
//      of a guard that no longer guards, and it looks fixed from a distance.
//
// The list only ever grows, one entry per site the audit closes.

const SRC = resolve(process.cwd(), "src");

interface Required {
  text: string;
  atLeast?: number;
}

interface FixedSite {
  rel: string;
  why: string;
  requires: Required[];
}

/**
 * Every site with a stale-response guard, and the interleaving each one closes.
 * Add to this when you fix another; never remove an entry to make it green.
 */
const FIXED_SITES: FixedSite[] = [
  {
    rel: "src/components/flipdesk/grade-this-item-card.tsx",
    why:
      "The tier effect and saveGarment both write the validation block beside " +
      "the button that charges for a grade. Fixed 2026-09-09 (effect) and " +
      "US-3223 (saveGarment); they share one owner so neither can outlive the " +
      "other.",
    requires: [
      { text: "validationRuns.begin()", atLeast: 2 },
      { text: "acceptValidation(run", atLeast: 2 },
      { text: "run.superseded = true" },
    ],
  },
  {
    rel: "src/components/flipdesk/bulk-reprice-dialog.tsx",
    why:
      "Apply sends the previewed rows verbatim. Reopening on a changed " +
      "selection mid-preview let the seller confirm prices they were never " +
      "shown. Fixed 2026-09-09.",
    requires: [
      { text: "let superseded = false" },
      { text: "if (superseded) return" },
      { text: "superseded = true" },
    ],
  },
  {
    rel: "src/components/flipdesk/command-palette.tsx",
    why:
      "Both searches are debounced, and a debounce cancels a PENDING query, " +
      "never one in flight. Fixed 2026-09-09.",
    requires: [
      { text: "let superseded = false", atLeast: 2 },
      { text: "superseded = true", atLeast: 2 },
    ],
  },
  {
    rel: "src/pages/admin/bulk.tsx",
    why:
      "Confirm fires credits/suspend at whatever is in `resolved`. Editing the " +
      "target box clears it, and the in-flight resolve used to put the old " +
      "list back. US-3223.",
    requires: [
      { text: "resolveRuns.supersede()" },
      { text: "resolveRuns.begin()" },
      { text: "acceptResolution(run" },
    ],
  },
  {
    rel: "src/components/flipdesk/ship-order-dialog.tsx",
    why:
      "Buy sends the quote id a rate-shop left in state. Two rate-shops at two " +
      "weights, or a reopen onto another order, could arm it with the wrong " +
      "parcel. US-3223.",
    requires: [
      { text: "quoteRuns.begin()" },
      { text: "quoteRuns.supersede()" },
      { text: "acceptRateQuote(run" },
    ],
  },
  {
    rel: "src/pages/flipdesk/intake.tsx",
    why:
      "An AI extract landing after 'Save & add another' repopulated the panel " +
      "for the blank form, and aiResult feeds the NEXT item's garment_type. " +
      "US-3223.",
    requires: [
      { text: "aiExtractRuns.begin()" },
      { text: "aiExtractRuns.supersede()", atLeast: 2 },
      { text: "if (run.superseded) return" },
    ],
  },
  {
    rel: "src/components/flipdesk/grading-validation-run.ts",
    why: "The accept helper IS the guard for the grading card.",
    requires: [{ text: "if (run.superseded) return null;" }],
  },
  {
    rel: "src/components/flipdesk/ship-rate-quote.ts",
    why: "The accept helper IS the guard for the label flow.",
    requires: [{ text: "if (run.superseded) return null;" }],
  },
  {
    rel: "src/pages/admin/bulk-resolve.ts",
    why: "The accept helper IS the guard for the bulk target list.",
    requires: [{ text: "if (run.superseded) return null;" }],
  },
];

/**
 * Files allowed to import the RunOwner without reading the flag themselves.
 * Only the primitive and the hook that hands it out.
 */
const OWNER_PLUMBING = ["src/hooks/use-latest-run.ts", "src/lib/latest-run.ts"];

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

function missing(src: string, requires: Required[]): string[] {
  return requires
    .filter((r) => occurrences(src, r.text) < (r.atLeast ?? 1))
    .map((r) => (r.atLeast ? `${r.text} (x${r.atLeast})` : r.text));
}

function listSources(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  })(SRC);
  return out.map((p) => "src" + p.slice(SRC.length).split(sep).join("/"));
}

/**
 * The predicate used for rule 2, isolated so the self-check below can prove it
 * still separates a guarded file from an unguarded one. A rule that has quietly
 * stopped firing reads exactly like a clean codebase.
 */
export function readsTheFlag(src: string): boolean {
  return (
    /\.superseded\b/.test(src) ||
    /\bacceptValidation\s*\(/.test(src) ||
    /\bacceptRateQuote\s*\(/.test(src) ||
    /\bacceptResolution\s*\(/.test(src)
  );
}

const GUARDED_SAMPLE = `
  const runs = useLatestRun();
  async function go() {
    const run = runs.begin();
    const res = await fetchIt();
    if (run.superseded) return;
    setThing(res);
  }
`;

const UNGUARDED_SAMPLE = `
  const runs = useLatestRun();
  async function go() {
    runs.begin();
    const res = await fetchIt();
    setThing(res);
  }
`;

describe("stale-async-write guards are still in place (US-3223)", () => {
  const files = listSources();

  it("found the tree to scan", () => {
    // Guard the guard: a broken walk must fail loudly, not silently pass.
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("src/lib/latest-run.ts");
    expect(files).toContain("src/pages/admin/bulk.tsx");
    // Test files are excluded, so a guard's own sample text can't satisfy it.
    expect(files.some((f) => f.includes(".test."))).toBe(false);
  });

  it("the flag-read predicate still tells guarded from unguarded", () => {
    expect(readsTheFlag(GUARDED_SAMPLE)).toBe(true);
    expect(readsTheFlag(UNGUARDED_SAMPLE)).toBe(false);
  });

  it("every listed site still exists", () => {
    const gone = FIXED_SITES.map((s) => s.rel).filter((rel) => !files.includes(rel));
    expect(
      gone,
      "listed as fixed but not found — a rename to notice, not a free pass: " +
        gone.join(", "),
    ).toEqual([]);
  });

  it("every fixed site still carries its guard", () => {
    const broken: string[] = [];
    for (const site of FIXED_SITES) {
      if (!files.includes(site.rel)) continue;
      const src = readFileSync(resolve(process.cwd(), site.rel), "utf8");
      const gaps = missing(src, site.requires);
      if (gaps.length > 0) {
        broken.push(`${site.rel} lost [${gaps.join(", ")}] — ${site.why}`);
      }
    }
    expect(
      broken,
      "a stale-response guard went missing. An async response can now " +
        "overwrite newer state here:\n  " + broken.join("\n  "),
    ).toEqual([]);
  });

  it("nothing imports the run owner without reading the flag", () => {
    const offenders = files
      .filter((rel) => !OWNER_PLUMBING.includes(rel))
      .filter((rel) => {
        const src = readFileSync(resolve(process.cwd(), rel), "utf8");
        return /use-latest-run|from "@\/lib\/latest-run"/.test(src) && !readsTheFlag(src);
      });
    expect(
      offenders,
      "these begin a run and never check whether it is still the current one, " +
        "which is the same as having no guard at all: " + offenders.join(", "),
    ).toEqual([]);
  });

  it("the plumbing exclusions are real files", () => {
    const stale = OWNER_PLUMBING.filter((rel) => !files.includes(rel));
    expect(stale, "excluded but missing: " + stale.join(", ")).toEqual([]);
  });
});

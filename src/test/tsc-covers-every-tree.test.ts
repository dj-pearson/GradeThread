// US-2629: every TypeScript file in this repo is in a `tsc -b` project, or is
// named here with the reason it is not.
//
// THE DEFECT THIS COMES FROM. `npx tsc -b` is the type check — CLAUDE.md says so
// in bold, and says `--noEmit` is weaker. It ran on three projects: the app, the
// build tooling, and functions/. Nothing owned `e2e/` or `playwright.config.ts`
// or `vitest.config.ts`. Proven rather than reasoned about: a
// `const x: number = "a string"` planted in e2e/smoke.spec.ts left `tsc -b` at
// exit 0, and so did the same line in playwright.config.ts and in
// vitest.config.ts.
//
// The cost is not hypothetical for e2e/: nine Playwright specs gate the release
// lane, and a type error in one of them surfaces as a failing browser run after
// a full build rather than as a compiler error in seconds.
//
// WHY A DIRECTORY SWEEP RATHER THAN "assert e2e is referenced". Pinning the one
// tree that was missed only stops that tree being missed again. The failure was
// that a new directory of TypeScript could appear and nothing noticed, and this
// catches the NEXT one.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();

/** Directories that never hold source we own. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-ext",
  "test-results",
  "coverage",
  "playwright-report",
  "build",
]);

/**
 * Trees deliberately outside the root build, each with the toolchain that DOES
 * check them. Shrink-only in spirit: an entry here is a claim that something
 * else does the job, and if that stops being true the entry is a lie.
 */
const CHECKED_ELSEWHERE: Array<{ prefix: string; by: string }> = [
  {
    prefix: "services/edge-functions",
    by: "Deno. `deno check src/main.ts src/tests/` in the edge lane, plus deno lint.",
  },
  {
    prefix: "sdk",
    by: "The published SDK is a standalone zero-dep package with its own build and tsconfig.",
  },
  {
    prefix: "remotion",
    by: "A self-contained subproject with its own package.json and tsconfig.json.",
  },
  {
    prefix: "scripts/sync-aspect-registry.deno.ts",
    by: "Deno, not Node — the root config would resolve its imports wrongly.",
  },
  {
    prefix: "scripts/fixtures/ui-antipatterns",
    by:
      "Nothing, and that is the point. These are deliberately-bad components " +
      "that exist ONLY to be read as text by `impeccable detect` in " +
      "check-ui-antipatterns.mjs selfCheck(), which proves each enforced rule " +
      "still fires. They are never imported, never rendered and never built. " +
      "Typechecking them would be checking a fixture whose whole job is to be " +
      "wrong.",
  },
  {
    prefix: "scripts/backfill-stripe-state.ts",
    by: "A one-shot operator script run with tsx; it imports no app module. If it ever does, move it into a project rather than widening this.",
  },
  {
    prefix: "scripts/lib/ci-env.ts",
    by: "Transitively, by tsconfig.app.json — src/test/ci-env-parity.test.ts imports it, and that test is the file's only consumer. Lose the import and it stops being checked, which is the honest limit of this entry.",
  },
];

/** Every .ts/.tsx we own, repo-relative with forward slashes. */
function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.(ts|mts|cts)$/.test(entry.name)) {
        out.push(relPath);
      }
    }
  })(REPO, "");
  return out;
}

/** `include` globs across every project the root tsconfig references. */
function includedPrefixes(): string[] {
  const root = JSON.parse(stripComments(readFileSync(join(REPO, "tsconfig.json"), "utf8")));
  const refs: string[] = (root.references ?? []).map((r: { path: string }) => r.path);
  expect(refs.length, "tsconfig.json has no project references").toBeGreaterThan(0);
  const prefixes: string[] = [];
  for (const ref of refs) {
    const file = join(REPO, ref.replace(/^\.\//, ""));
    expect(existsSync(file), `tsconfig.json references a missing project: ${ref}`).toBe(true);
    const cfg = JSON.parse(stripComments(readFileSync(file, "utf8")));
    for (const inc of cfg.include ?? []) prefixes.push(String(inc).replace(/^\.\//, ""));
  }
  return prefixes;
}

/** tsconfigs here carry `//` comments, which JSON.parse rejects. */
function stripComments(src: string): string {
  return src
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

/**
 * Does an `include` entry claim this file? Entries here are either a bare
 * directory ("src"), a single file ("vite.config.ts") or a glob
 * ("functions/**\/*.ts"), so all three have to resolve — a prefix-only match
 * reported every functions/ file as an orphan while tsc was compiling them.
 */
function claims(entry: string, file: string): boolean {
  if (!entry.includes("*")) return file === entry || file.startsWith(`${entry}/`);
  const rx = new RegExp(
    `^${entry
      .split("/")
      .map((seg) =>
        seg === "**"
          ? "(?:.*)"
          : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").split("*").join("[^/]*"),
      )
      .join("/")
      // `a/**/b` must also match `a/b`, which is what tsc does.
      .replace(/\/\(\?:\.\*\)\//g, "(?:/.*)?/")}$`,
  );
  return rx.test(file);
}

const covered = (file: string, entries: string[]) =>
  entries.some((entry) => claims(entry, file));

describe("US-2629: tsc -b covers every TypeScript tree", () => {
  it("no file is both unowned and unexplained", () => {
    const prefixes = includedPrefixes();
    const orphans = sourceFiles().filter(
      (f) =>
        !covered(f, prefixes) &&
        !CHECKED_ELSEWHERE.some((e) => f === e.prefix || f.startsWith(`${e.prefix}/`)),
    );
    expect(
      orphans,
      "these are typechecked by nothing. Add the tree to a tsconfig project and " +
        "reference it from tsconfig.json, or add it to CHECKED_ELSEWHERE naming " +
        "the toolchain that does check it.",
    ).toEqual([]);
  });

  it("the trees the fix added are genuinely in a project", () => {
    // The sweep above would pass if someone deleted e2e/ entirely, so name the
    // three that were actually missing and assert they are now claimed.
    const prefixes = includedPrefixes();
    for (const f of ["e2e/smoke.spec.ts", "playwright.config.ts", "vitest.config.ts"]) {
      expect(covered(f, prefixes), `${f} is back outside every project`).toBe(true);
    }
  });

  it("every CHECKED_ELSEWHERE entry still exists and still says who checks it", () => {
    // An entry pointing at a deleted tree is a stale exemption, and the next
    // directory to land under that prefix inherits it silently.
    for (const entry of CHECKED_ELSEWHERE) {
      expect(existsSync(join(REPO, entry.prefix)), `${entry.prefix} no longer exists`).toBe(true);
      expect(entry.by.length, `${entry.prefix} needs a real reason`).toBeGreaterThan(30);
    }
  });
});

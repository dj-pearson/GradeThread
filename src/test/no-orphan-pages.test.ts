import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// US-2882, and the story that filed it was WRONG.
//
// It claimed src/pages/flipdesk/prep.tsx was unreachable, on the strength of a
// grep for "pages/flipdesk/prep" that found nothing. It found nothing because
// the one importer uses a RELATIVE path: inventory.tsx lazy-loads `./prep` as
// the ?mode=prep view. The page is live and always was.
//
// That is the whole reason this file exists. "No importer" is a claim about a
// search, not about a codebase, and an alias-only search is blind to every
// sibling import in the repo. So the check is written once, resolves both
// forms, and runs on every commit — instead of being re-derived by hand each
// time somebody wonders whether a file is dead.

const ROOT = process.cwd();
const SRC = resolve(ROOT, "src");
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walk(p, out);
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const allFiles = walk(SRC);

/**
 * Every module specifier in a file, resolved to an absolute path where it
 * points inside src/.
 *
 * Handles BOTH forms, which is the correction this file encodes:
 *   • "@/pages/flipdesk/prep"  — the alias
 *   • "./prep", "../grid"      — relative, and invisible to an alias-only grep
 */
function importsFrom(file: string): Set<string> {
  const src = readFileSync(file, "utf8");
  const out = new Set<string>();
  const specifiers = [
    ...src.matchAll(/from\s+["']([^"']+)["']/g),
    ...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]!);

  for (const spec of specifiers) {
    let base: string | null = null;
    if (spec.startsWith("@/")) base = resolve(SRC, spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(file), spec);
    if (!base) continue;
    // A specifier carries no extension; try the ones the repo uses.
    for (const cand of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ]) {
      out.add(cand.replace(/\\/g, "/"));
    }
  }
  return out;
}

const imported = new Set<string>();
for (const f of allFiles) {
  for (const target of importsFrom(f)) imported.add(target);
}

/** Page modules: everything under src/pages, minus tests and helper modules. */
const pageFiles = allFiles.filter((f) => {
  const r = rel(f);
  if (!r.startsWith("src/pages/")) return false;
  if (r.includes("/__tests__/")) return false;
  if (/\.test\.tsx?$/.test(r)) return false;
  // Only files that export a page component; the directories also hold
  // column definitions, filter helpers and query modules.
  return /export function [A-Z]\w*Page\b/.test(readFileSync(f, "utf8"));
});

describe("no page module is unreachable (US-2882)", () => {
  it("the scan resolves relative imports, not only the @/ alias", () => {
    // The exact blind spot that produced the wrong story. inventory.tsx
    // lazy-imports "./prep"; an alias-only search reports it as dead.
    const inventory = resolve(SRC, "pages/flipdesk/inventory.tsx");
    const targets = importsFrom(inventory);
    expect(
      targets.has(resolve(SRC, "pages/flipdesk/prep.tsx").replace(/\\/g, "/")),
      "the resolver stopped following relative imports, which is precisely how " +
        "prep.tsx was mistaken for an orphan",
    ).toBe(true);
  });

  it("the scan found a real set of pages", () => {
    expect(pageFiles.length).toBeGreaterThan(50);
  });

  it("every page module is imported somewhere", () => {
    const orphans = pageFiles
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => !imported.has(f))
      .map(rel);
    expect(
      orphans,
      "these page files export a *Page component that nothing imports. Either " +
        "route them or delete them — a dead page in a directory of fifty is a " +
        "trap for the next person who greps while fixing a bug in the live one.",
    ).toEqual([]);
  });

  it("prep.tsx specifically is live, and this records why", () => {
    // Pinned by name because a future reader will find US-2882 in the archive
    // saying it was an orphan, and should be able to see the correction here
    // rather than re-deriving it.
    const prep = resolve(SRC, "pages/flipdesk/prep.tsx").replace(/\\/g, "/");
    expect(imported.has(prep)).toBe(true);
    expect(readFileSync(resolve(SRC, "pages/flipdesk/inventory.tsx"), "utf8")).toContain(
      'import("./prep")',
    );
  });
});

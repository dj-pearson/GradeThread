import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// US-2794: a comment stripper that silently does nothing on a Windows checkout.
//
// THE MECHANISM, because it is invisible in review. A stripper written as
//
//     src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n")
//
// cannot work on a CRLF line. `.` never matches `\r`, so `.*` stops one
// character short of the end and `$` — which needs the end of the string, or
// with `m` the position before `\n` — is never reached. The replace matches
// nothing. It looks correct, it throws nothing, and it removes no comments.
//
// The consequence is a source-scanning test that reads its own documentation:
// a name mentioned only in prose counts as a real reference, so the scan finds
// hits that are not there or misses drift that is.
//
// IT HAS BITTEN THREE TIMES. extension-unified/test/sync-poll.test.cjs
// (2026-08-21, recorded in CLAUDE.md), then scripts/check-ios-orphans.mjs and
// its Android twin (2026-08-22) — which were GREEN on Windows and RED in CI,
// with two real findings this machine could not see. Sixteen more files carried
// the same shape; fourteen were fixed in the same pass and none of their
// assertions changed, so the strip had been doing nothing and nothing depended
// on it.
//
// This tree has MIXED line endings — ios/ is entirely CRLF, and in src/
// consignment.tsx is CRLF while autolister.tsx is LF — so "all the files it
// reads are LF today" is not a property anyone can rely on.

const ROOT = process.cwd();
const ROOTS = ["src", "scripts", "services/edge-functions/src", "functions", "extension-unified"];
const SKIP = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e)) out.push(p);
  }
  return out;
}

/** A per-line `//`-comment strip — the only shape this is about. */
const STRIPPER = /replace\(\s*\/\\\/\\\/\.\*\$\/[gimsuy]*\s*,/;
/** Any of the ways the tree normalises CRLF before splitting. */
const NORMALISES = /\\r\\n\?|\\r\?\\n|replace\(\s*\/\\r\/g/;

describe("a comment stripper must survive CRLF (US-2794)", () => {
  const files = ROOTS.flatMap((r) => walk(resolve(ROOT, r)));

  it("scans a real corpus", () => {
    // Guards the guard: an empty walk makes the assertion below vacuous.
    expect(files.length).toBeGreaterThan(1000);
  });

  it("the rule matches the shape it is about, and not others", () => {
    // The crude version of this check keyed on `$` in a regex and reported 40
    // candidates, of which 7 were real — `/\.(ts|tsx)$/` and
    // `/^\d{4}-\d{2}-\d{2}$/` match that just as well. It has to key on the
    // COMMENT pattern.
    expect(STRIPPER.test(String.raw`.map((l) => l.replace(/\/\/.*$/, ""))`)).toBe(true);
    expect(STRIPPER.test(String.raw`.replace(/\/\/.*$/gm, "")`)).toBe(true);
    expect(STRIPPER.test(String.raw`f.replace(/\.(ts|tsx)$/, "")`)).toBe(false);
    expect(STRIPPER.test(String.raw`/^\d{4}-\d{2}-\d{2}$/.test(v)`)).toBe(false);
    expect(NORMALISES.test(String.raw`src.replace(/\r\n?/g, "\n")`)).toBe(true);
    expect(NORMALISES.test(String.raw`src.split(/\r?\n/)`)).toBe(true);
  });

  it("every file with one normalises CRLF first", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!STRIPPER.test(src)) continue;
      if (NORMALISES.test(src)) continue;
      offenders.push(f.split(`${sep}`).join("/").replace(`${ROOT.split(sep).join("/")}/`, ""));
    }
    expect(
      offenders,
      `These strip \`//\` comments per line without normalising CRLF first, so on ` +
        `a Windows checkout they remove NOTHING and every comment counts as code. ` +
        `Add \`.replace(/\\r\\n?/g, "\\n")\` before the split.`,
    ).toEqual([]);
  });
});

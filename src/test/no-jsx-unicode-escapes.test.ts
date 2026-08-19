// A `\u2014` inside a JSX TEXT node is not an escape. It is six characters, and
// they ship to the visitor exactly as written.
//
// This is easy to get wrong because the same file usually contains the working
// form: inside a TypeScript string literal (`prompt: "\u201c…"`) the engine
// decodes it, so a developer writing ASCII-safe source correctly in one place
// copies the habit into JSX and gets literal backslash-u on the page. That is
// what happened on /developers, where four sentences in the connector section
// rendered "refused outright \u2014 a confirmation…" to anyone reading it.
//
// The check strips quoted strings and template chunks first; whatever escapes
// survive are sitting in markup.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOTS = ["src", "functions"];
const ESCAPE = /\\u[0-9a-fA-F]{4}/;

/** Lines where a unicode escape survives outside any string literal. */
export function jsxEscapeHits(source: string): number[] {
  return source.split("\n").flatMap((line, i) => {
    if (!ESCAPE.test(line)) return [];
    const stripped = line
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    return ESCAPE.test(stripped) ? [i + 1] : [];
  });
}

function componentFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an optional root
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) componentFiles(path, out);
    else if (/\.(tsx|jsx)$/.test(path)) out.push(path);
  }
  return out;
}

describe("no unicode escapes render as literal text", () => {
  it("catches an escape in JSX text and ignores one in a string literal", () => {
    // The guard is asserted in BOTH directions before it is trusted. A
    // scanner that finds nothing is indistinguishable from a scanner that
    // cannot find anything, and this one is a negative assertion over a tree
    // that is currently clean.
    expect(jsxEscapeHits('  refused outright \\u2014 a confirmation\n')).toEqual([1]);
    expect(jsxEscapeHits('  prompt: "\\u201cWhat is unlisted?\\u201d",\n')).toEqual([]);
    expect(jsxEscapeHits("  const dash = '\\u2014';\n")).toEqual([]);
    expect(jsxEscapeHits("  const s = `a \\u2014 b`;\n")).toEqual([]);
  });

  it("no component ships one", () => {
    const files = ROOTS.flatMap((r) => componentFiles(resolve(process.cwd(), r)));
    expect(files.length, "found no components to scan").toBeGreaterThan(0);

    const offenders = files.flatMap((file) => {
      const hits = jsxEscapeHits(readFileSync(file, "utf8"));
      return hits.map((line) => `${file.replace(`${process.cwd()}/`, "")}:${line}`);
    });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

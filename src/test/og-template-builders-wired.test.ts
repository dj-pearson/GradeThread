import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// US-2619 AC10: an OG template builder cannot go dead unnoticed.
//
// THE HISTORY. Three builders — buildCertOgHtml, buildCertSlabHtml and
// buildCertBadgeHtml — were left in functions/_shared/og-template.ts with ZERO
// importers when /og/cert, /slab/cert and /badge/cert moved to the edge-proxy
// shape. Their layouts were re-authored on the edge; the Pages copies stayed,
// along with a test suite pinning templates nobody rendered. Repeating that on
// the four remaining in-Function renderers would have given seven dead builders
// and seven suites asserting the wrong thing with total confidence.
//
// WHY THE EXISTING GUARD DOES NOT COVER THIS, and it is a real gap rather than
// an oversight: scripts/check-unwired-modules.mjs flags whole MODULES nothing
// imports, and og-template.ts is imported — heavily. Only some of its EXPORTS
// were dead. A module-level check cannot see inside a file that is used.
//
// This is a wiring question, so a source scan is the right instrument: "is this
// export referenced anywhere outside its own file and its own tests" has no
// runtime state and no branches. It is not asking whether the template renders
// correctly, which a scan could not answer.

const ROOT = resolve(__dirname, "../..");
const TEMPLATE = "functions/_shared/og-template.ts";

/**
 * A builder that is deliberately kept with no Pages importer, and why.
 *
 * The AC's requirement is "imported, or listed WITH A REASON" — an entry here
 * is a claim someone made in writing, not a way to quiet the test. It may only
 * shrink: an entry that turns out to be imported after all fails below, so a
 * builder cannot be parked here and then quietly revived.
 */
const KEPT_WITHOUT_IMPORTER: Record<string, string> = {};

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

/** Every `export function build*Html` in the template module. */
function exportedBuilders(): string[] {
  const src = read(TEMPLATE);
  return [...src.matchAll(/^export function (build\w*Html)\b/gm)].map((m) => m[1]!);
}

/** Every .ts/.tsx under functions/, excluding the template itself and tests. */
function pagesSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "__tests__" || e.name === "node_modules") continue;
        walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        if (p.endsWith("og-template.ts")) continue;
        out.push(p);
      }
    }
  };
  walk("functions");
  return out;
}

const BUILDERS = exportedBuilders();
const SOURCES = pagesSources();
const CORPUS = SOURCES.map((f) => {
  try {
    return statSync(resolve(ROOT, f)).isFile() ? read(f) : "";
  } catch {
    return "";
  }
}).join("\n");

describe("US-2619: every OG template builder is wired or explained", () => {
  it("finds the builders and the corpus at all", () => {
    // Without this the whole file passes vacuously the moment the template is
    // renamed or the regex stops matching — which is how a scan quietly stops
    // guarding.
    expect(BUILDERS.length).toBeGreaterThanOrEqual(4);
    expect(SOURCES.length).toBeGreaterThan(10);
  });

  it("every exported builder has a Pages importer, or a written reason", () => {
    const dead: string[] = [];
    for (const name of BUILDERS) {
      if (name in KEPT_WITHOUT_IMPORTER) continue;
      if (!new RegExp(`\\b${name}\\b`).test(CORPUS)) dead.push(name);
    }
    expect(
      dead,
      "these builders are exported and nothing under functions/ renders them. " +
        "When a card moves to the edge-proxy shape, DELETE the Pages copy in " +
        "the same commit — three cert builders were left behind exactly this " +
        "way, with tests still pinning templates nobody rendered. If one is " +
        "kept on purpose, add it to KEPT_WITHOUT_IMPORTER with the reason.",
    ).toEqual([]);
  });

  it("the kept list may only shrink", () => {
    // A builder parked here and later revived should lose its entry, not keep
    // an explanation that has stopped being true.
    const revived = Object.keys(KEPT_WITHOUT_IMPORTER).filter((name) =>
      new RegExp(`\\b${name}\\b`).test(CORPUS),
    );
    expect(
      revived,
      "these are listed as kept-without-importer but ARE imported now. Remove " +
        "the entry.",
    ).toEqual([]);

    const gone = Object.keys(KEPT_WITHOUT_IMPORTER).filter(
      (name) => !BUILDERS.includes(name),
    );
    expect(gone, "these are listed but no longer exported at all").toEqual([]);
  });

  it("the three cert builders stayed deleted", () => {
    // Named, because they are the ones this guard exists for. Re-adding one to
    // the Pages template would mean two copies of a layout that is now authored
    // on the edge, and the Pages copy is the one nobody renders.
    const src = read(TEMPLATE);
    for (const name of [
      "buildCertOgHtml",
      "buildCertSlabHtml",
      "buildCertBadgeHtml",
    ]) {
      expect(
        src.includes(`export function ${name}`),
        `${name} is back in the Pages template. /og/cert, /slab/cert and ` +
          `/badge/cert render on the EDGE now; a Pages copy of that layout is ` +
          `dead the day it is written.`,
      ).toBe(false);
    }
  });
});

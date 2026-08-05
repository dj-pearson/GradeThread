// US-2401: the functions/ tree must stay in a lane that actually runs.
//
// tsconfig.functions.json existed for a long time and was referenced by nothing.
// `npm run build` and `npm run verify` both run `tsc -b`, which compiles only
// the ROOT tsconfig's references — so a config file that is never referenced is
// a config file that never runs, and 15+ Pages Functions serving live production
// traffic (the certificate SSR page, the blog/authors/value/durability
// renderers, both embed widgets, llms.txt, rss.xml, the OG image routes) were
// compiled by nothing at all.
//
// The failure mode this guards is the same one that created it: the lane can be
// switched off by deleting one line, with no test going red anywhere. This is
// that test.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** tsconfigs here carry // comments, which JSON.parse rejects. */
function readTsconfig(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(raw);
}

const root = readTsconfig("tsconfig.json") as { references?: Array<{ path: string }> };
const fns = readTsconfig("tsconfig.functions.json") as {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
};
const eslintConfig = readFileSync("eslint.config.js", "utf8");

describe("the functions/ typecheck lane (US-2401)", () => {
  it("is referenced from the root tsconfig, so tsc -b compiles it", () => {
    const paths = (root.references ?? []).map((r) => r.path);
    expect(paths).toContain("./tsconfig.functions.json");
  });

  it("covers the whole tree", () => {
    expect(fns.include).toEqual(["functions/**/*.ts"]);
  });

  it("loads the Workers types the tree relies on", () => {
    // PagesFunction / EventContext / KVNamespace are ambient globals from this
    // package. Without it the lane cannot compile a single Pages Function, and
    // the tempting "fix" is to weaken the lane rather than keep the types.
    expect(fns.compilerOptions?.types).toContain("@cloudflare/workers-types");
    expect(fns.compilerOptions?.lib).toContain("WebWorker");
  });

  it("holds functions/ to the same strictness as src/", () => {
    // A lane that runs but checks less than the app project is a lane that
    // reports green on code src/ would reject.
    const app = readTsconfig("tsconfig.app.json") as {
      compilerOptions?: Record<string, unknown>;
    };
    for (const flag of [
      "strict",
      "noUnusedLocals",
      "noUnusedParameters",
      "noFallthroughCasesInSwitch",
      "noUncheckedIndexedAccess",
    ]) {
      expect(app.compilerOptions?.[flag], `${flag} in tsconfig.app.json`).toBe(true);
      expect(fns.compilerOptions?.[flag], `${flag} in tsconfig.functions.json`).toBe(true);
    }
  });

  it("is not excluded from eslint", () => {
    // AC3: eslint DOES cover functions/ — `eslint .` matches **/*.{ts,tsx} and
    // the ignores list never names it. Pinned because adding it there is a
    // one-word change that would silently drop the tree from the lint lane too.
    const at = eslintConfig.indexOf("ignores: [");
    expect(at, "the ignores block moved — update this guard").toBeGreaterThan(-1);
    const entries = [
      ...eslintConfig
        .slice(at, eslintConfig.indexOf("]", at))
        .matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]!);
    // Matched on the ROOT segment, not a substring: "services/edge-functions/**"
    // is the Deno tree and is ignored on purpose — it is linted by `deno lint`.
    const blocked = entries.filter((e) => e.split("/")[0] === "functions");
    expect(blocked, "functions/ was added to the eslint ignore list").toEqual([]);
  });
});

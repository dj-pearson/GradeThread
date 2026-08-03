// react-router 8 removed `react-router-dom`. Three things now have to stay true
// together, and each of them fails in a way that is hard to read.
//
// 1. NO `react-router-dom` ANYWHERE. The package no longer exists on npm's v8
//    line. A single re-introduced import — copied from an old file, or from any
//    of the years of v6/v7 examples on the internet — resolves to nothing and
//    fails at build with a module-not-found that names the file, not the cause.
//    Worse, `npm i react-router-dom` still SUCCEEDS: it installs 7.x alongside
//    react-router 8, both packages register their own React context, and hooks
//    called through the wrong one return null at runtime instead of erroring at
//    build. That is the failure this guard is really for.
//
// 2. Node 22 in every workflow that touches the frontend. react-router 8
//    declares `engines: node >= 22.22.0` and ships ESM only. npm does not
//    enforce `engines` without engine-strict, so a workflow quietly pinned back
//    to 20 does not fail at install — it fails later, somewhere inside the
//    build, with an ESM error that reads like a bundler problem.
//
// 3. NO RSC. GHSA-qwww-vcr4-c8h2 (the advisory this upgrade closed) was a
//    bypass in React Router's RSC mode. The upgrade is the fix, so this is not
//    load-bearing for that advisory any more — it is here because the app's
//    "client-only SPA" claim is what makes the whole routing story simple, and
//    the first RSC import would end that silently.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** Every .ts/.tsx under the given roots, skipping build output. */
function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", "dist", "coverage", "test-results"]);
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an optional root that does not exist here
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const d of dirs) walk(resolve(root, d));
  return out;
}

// This file is excluded from its own scan: it necessarily spells out every
// forbidden string in order to look for them, and a guard that fails on its own
// text is a guard nobody keeps. Excluding exactly one known path — rather than a
// pattern — keeps the blind spot a single file wide.
const SELF = resolve(root, "src/test/react-router-8-contract.test.ts");
const SOURCES = sourceFiles(["src", "functions", "e2e", "scripts"]).filter(
  (f) => f !== SELF,
);

describe("react-router 8: the dom package is gone and must stay gone", () => {
  it("nothing imports react-router-dom", () => {
    const offenders = SOURCES.filter((f) =>
      readFileSync(f, "utf8").includes("react-router-dom"),
    ).map((f) => f.slice(root.length + 1));
    expect(
      offenders,
      "react-router-dom no longer exists on the v8 line. Import from 'react-router'.",
    ).toEqual([]);
  });

  it("react-router-dom is not a dependency, and react-router is", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...(pkg.devDependencies ?? {}) };
    expect(all["react-router-dom"]).toBeUndefined();
    expect(all["react-router"]).toBeDefined();
    // Installing both is the quiet failure: two copies of the router context,
    // hooks resolving through the wrong one, null at runtime and green at build.
    expect(Object.keys(all).filter((k) => /^react-router/.test(k))).toEqual([
      "react-router",
    ]);
  });

  it("the installed major is 8 or newer", () => {
    // Below 8 the advisory row this upgrade removed would apply again, and the
    // allowlist no longer carries an acceptance for it — so the audit gate goes
    // red rather than silently re-accepting.
    const major = Number(
      (
        JSON.parse(read("node_modules/react-router/package.json")) as {
          version: string;
        }
      ).version.split(".")[0],
    );
    expect(major).toBeGreaterThanOrEqual(8);
  });
});

describe("react-router 8: CI runs a Node it can actually use", () => {
  const workflows = readdirSync(resolve(root, ".github/workflows"))
    .filter((f) => f.endsWith(".yml"))
    .map((f) => ({ f, body: read(join(".github/workflows", f)) }));

  it("no workflow pins a Node older than 22", () => {
    const bad: string[] = [];
    for (const { f, body } of workflows) {
      for (const m of body.matchAll(/node-version:\s*"?(\d+)/g)) {
        if (Number(m[1]) < 22) bad.push(`${f} -> node ${m[1]}`);
      }
    }
    expect(
      bad,
      "react-router 8 requires Node >= 22.22.0 and is ESM-only; an older pin " +
        "fails inside the build, not at install.",
    ).toEqual([]);
  });

  it("at least one workflow still pins a Node version", () => {
    // Guards the guard: a regex that matches nothing passes the test above for
    // the wrong reason.
    const count = workflows.filter((w) =>
      /node-version:/.test(w.body),
    ).length;
    expect(count).toBeGreaterThan(0);
  });
});

describe("react-router 8: still a client-only SPA", () => {
  it("no RSC entry points are imported", () => {
    // The shapes that would mean RSC mode is in play. Matched as import
    // specifiers and identifiers rather than as loose substrings.
    const patterns: Array<[string, RegExp]> = [
      ["react-router/rsc", /["']react-router\/rsc["']/],
      ["RSCHydratedRouter", /\bRSCHydratedRouter\b/],
      ["createStaticHandler", /\bcreateStaticHandler\b/],
      ["unstable_createCallServer", /\bunstable_createCallServer\b/],
    ];
    const hits: string[] = [];
    for (const f of SOURCES) {
      const body = readFileSync(f, "utf8");
      for (const [label, re] of patterns) {
        if (re.test(body)) hits.push(`${f.slice(root.length + 1)}: ${label}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

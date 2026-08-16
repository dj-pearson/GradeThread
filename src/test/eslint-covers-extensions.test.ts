// @vitest-environment node
//
// US-2624: the three MV3 extensions are linted, and stay linted.
//
// They were in eslint.config.js's `ignores` from the day they were written, on
// the reasoning that "the app's ts/tsx config would mis-lint them". That was
// true, and the remedy was wrong: the answer to a config that does not fit is a
// config that does. For however long that stood, three extensions that run
// content scripts on Poshmark, Mercari, eBay and Grailed — holding the seller's
// token, with no build step and no type checker — had nothing at all checking
// them for an undeclared identifier.
//
// ASKED OF ESLINT ITSELF, NOT OF THE CONFIG FILE'S TEXT. A source assertion
// would pass while an `ignores` entry three blocks lower quietly won, and the
// resolved config is the only thing that answers "is this file actually
// linted". `no-undef` is the specific rule this protects: in vanilla JS with no
// compiler it is the last line before a seller hits the typo.
//
// COST. Loading the flat config pulls in typescript-eslint and the react
// plugins, which takes about half a minute on this box — all of it in the FIRST
// call, so every sample is resolved once in beforeAll and the cases read the
// results. `node` environment rather than jsdom for the same reason: this test
// touches no DOM and jsdom was a third of the runtime.

import { beforeAll, describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import type { Linter } from "eslint";

/** One representative real file per tree, plus a service worker and a suite. */
const SAMPLES = [
  "extension/content/common.js",
  "extension-condition/content/overlay-host.js",
  "extension-unified/lister/common.js",
  "extension-unified/background.js",
];
const CJS_SAMPLE = "extension-unified/test/depth.test.cjs";
const UMD_SAMPLE = "extension-unified/attribution.js";

const ignored = new Map<string, boolean>();
const configs = new Map<string, Linter.Config>();

beforeAll(async () => {
  const eslint = new ESLint();
  for (const file of [...SAMPLES, CJS_SAMPLE, UMD_SAMPLE]) {
    ignored.set(file, await eslint.isPathIgnored(file));
    configs.set(file, (await eslint.calculateConfigForFile(file)) as Linter.Config);
  }
}, 180_000);

const globalsOf = (file: string) =>
  (configs.get(file)?.languageOptions?.globals ?? {}) as Record<string, unknown>;

describe("US-2624: eslint covers the browser extensions", () => {
  it("none of the three trees is ignored", () => {
    for (const file of SAMPLES) {
      expect(ignored.get(file), `${file} is ignored by eslint`).toBe(false);
    }
  });

  it("no-undef is on for every one of them", () => {
    for (const file of SAMPLES) {
      // A file can match zero config blocks and be "not ignored" while having no
      // rules whatsoever, which is where these sat before the ignore list was
      // even consulted. So check the rule, not the ignore entry.
      expect(configs.get(file)?.rules?.["no-undef"], `${file} has no no-undef`).toBeTruthy();
    }
  });

  it("the .cjs suites are linted as Node, not as a browser", () => {
    // Given browser globals they trip no-redeclare on the DOM names they stub on
    // purpose (`global.CSS`), and a config that calls a deliberate stub an error
    // is a config someone switches off.
    expect(globalsOf(CJS_SAMPLE)).toHaveProperty("require");
    expect(globalsOf(CJS_SAMPLE)).not.toHaveProperty("document");
  });

  it("the UMD `module` guard is declared rather than disabled per file", () => {
    // Several shared modules export both ways so the .cjs suites can require the
    // same file the browser loads as a plain script. Declaring the global keeps
    // no-undef meaningful everywhere else; a per-file disable would not.
    expect(globalsOf(UMD_SAMPLE)).toHaveProperty("module");
  });
});

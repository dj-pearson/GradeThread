// US-1884 (AC4) — compile each extension's overlay.css into a content-script
// module that publishes the stylesheet as a STRING.
//
// WHY THIS EXISTS.
//
// The condition overlay now mounts inside a SHADOW ROOT (overlay-host.js), which
// is what actually makes it immune to a marketplace's stylesheet. But a content
// script's `"css": [...]` manifest entry injects into the DOCUMENT, and a
// document stylesheet cannot reach into a shadow tree — so the styles have to
// travel with the JS instead.
//
// Two ways to do that, and only one of them ages well:
//
//   • Paste the CSS into a JS template literal. Then the stylesheet is no longer
//     a stylesheet: no highlighting, no formatter, and 300 lines of it duplicated
//     by hand across two extensions. Hand-sync across those two copies has
//     already failed silently once in this repo (see legacy-parity.test.cjs).
//   • Keep overlay.css as the ONE authored artifact and generate the JS from it.
//
// This is the second. Each extension keeps its own overlay.css (they legitimately
// differ — the unified one also styles scan badges and the Flip panel), and the
// generator derives the shipped `overlay-css.js` beside it. A drift guard
// (test/overlay-shadow.test.cjs in both extensions) re-runs the derivation and
// fails the build if the generated file was edited by hand or left stale, so
// "someone forgot to regenerate" is loud rather than a styling bug nobody can
// reproduce.
//
// Lives in scripts/lib as CommonJS so the extensions' zero-dependency *.test.cjs
// guards can require() it directly; scripts/gen-extension-overlay-css.mjs is the
// CLI over it.

const fs = require("node:fs");
const path = require("node:path");
const { forcedThemeCss, overlayScope } = require("./theme-css.cjs");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Each extension's authored stylesheet and the module derived from it. */
const TARGETS = [
  {
    css: "extension-condition/overlay.css",
    out: "extension-condition/content/overlay-css.js",
  },
  {
    css: "extension-unified/research/overlay.css",
    out: "extension-unified/research/overlay-css.js",
  },
];

/**
 * Render the generated module for one stylesheet.
 *
 * Emitted as a JSON-quoted line array rather than one enormous string literal so
 * a `git diff` of the generated file still reads line-for-line against the CSS
 * it came from — a generated file nobody can read in review is one nobody
 * reviews.
 */
function renderModule(cssText, cssRelPath) {
  // US-3055: the theme preference. The authored sheet keeps its OS-driven dark
  // blocks; the shipped string also carries the same rules under
  // [data-theme="dark"] on the card / badge row and the light values under
  // [data-theme="light"], derived here so the two can never disagree.
  const themed = cssText.replace(/\r\n/g, "\n") +
    "\n/* ── generated: forced themes (US-3055), derived from the dark blocks above ── */\n" +
    forcedThemeCss(cssText, overlayScope);
  const lines = themed.split("\n");
  // Drop a single trailing empty line so the joined text ends exactly where the
  // stylesheet does.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const body = lines.map((l) => "    " + JSON.stringify(l)).join(",\n");
  return `// GENERATED FILE — DO NOT EDIT.
//
// Source:      ${cssRelPath}
// Regenerate:  node scripts/gen-extension-overlay-css.mjs
// Guarded by:  test/overlay-shadow.test.cjs (fails the build on drift)
//
// US-1884 (AC4): the overlay mounts in a shadow root, and a document stylesheet
// cannot cross that boundary — so the sheet ships as a string the content script
// adopts into the shadow tree itself. Edit the .css, then run the generator.

(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_CC_CSS = api; // content-script world
})(typeof self !== "undefined" ? self : this, function () {
  return [
${body}
  ].join("\\n");
});
`;
}

/** Read a target's authored CSS and return the module text it should produce. */
function expectedModule(target, repoRoot) {
  const base = repoRoot || REPO_ROOT;
  const cssText = fs.readFileSync(path.resolve(base, target.css), "utf8");
  return renderModule(cssText, target.css);
}

/** Names of the generated files that are missing or stale. */
function drift(repoRoot) {
  const base = repoRoot || REPO_ROOT;
  const stale = [];
  for (const t of TARGETS) {
    const want = expectedModule(t, base);
    let have = null;
    try {
      have = fs.readFileSync(path.resolve(base, t.out), "utf8");
    } catch (_e) {
      have = null;
    }
    // Compare with line endings normalized: git checks this tree out with CRLF
    // on Windows, so a byte compare would fail on the dev host and pass in CI.
    if (have === null || have.replace(/\r\n/g, "\n") !== want.replace(/\r\n/g, "\n")) {
      stale.push(t.out);
    }
  }
  return stale;
}

/** Write every generated file. Returns the list written. */
function generate(repoRoot) {
  const base = repoRoot || REPO_ROOT;
  for (const t of TARGETS) {
    fs.writeFileSync(path.resolve(base, t.out), expectedModule(t, base), "utf8");
  }
  return TARGETS.map((t) => t.out);
}

module.exports = { TARGETS, REPO_ROOT, renderModule, expectedModule, drift, generate };

#!/usr/bin/env node
// Run the edge (Deno) test suite from a network-restricted sandbox.
//
// WHY THIS EXISTS. Every edge story written from a Claude Code web session for
// about a month says the tests "could not be run: there is no deno binary in
// this container". True about the binary and useless as a conclusion -- Deno is
// simply not preinstalled, and one release download fixes it. What is NOT
// fixable is the network policy: the agent proxy allows jsr.io and
// registry.npmjs.org and refuses deno.land and esm.sh, which is where
// deno.json maps fifteen specifiers. So `deno test` resolves nothing.
//
// The workaround is an import map that points those fifteen at npm: and jsr:
// instead. This script BUILDS that map from deno.json rather than carrying a
// copy, because a hand-listed copy is a second source of truth that goes stale
// the first time someone bumps a version. CLAUDE.md carried exactly such a
// hand-listed recipe before this file existed.
//
// ⚠ THE SUBSTITUTION IS NOT FREE AND THIS SCRIPT SAYS SO RATHER THAN HIDING IT.
// `denomailer` and `imagescript` are Deno-only packages on deno.land/x with no
// npm equivalent: npm nodemailer does not export SMTPClient, and the npm
// imagescript build lacks the `.encode` the overlay code calls. Every test file
// that transitively imports src/lib/email.ts or imagescript therefore dies at
// MODULE LOAD, which looks exactly like a real failure.
//
// Measured 2026-09-18: that is 107 of the test files. A first pass here read the
// failing list off a truncated `tail -50`, called all 110 failures artifacts,
// and was wrong -- the real list was three times longer. So this script
// classifies by ERROR TEXT, never by a stored file list, and prints the
// unsubstitutable failures separately from anything it cannot explain.
//
// Usage:
//   node scripts/edge-test-sandboxed.mjs                 # whole suite
//   node scripts/edge-test-sandboxed.mjs src/tests/x.ts  # specific files
//   node scripts/edge-test-sandboxed.mjs --map-only       # just write the map
//
// Exit 0 when every failure is an explained substitution artifact, 1 otherwise.
// A file this cannot run is reported, never silently skipped: a suite that is
// green because it did not look is the failure mode this repo keeps finding.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EDGE = resolve(process.cwd(), "services/edge-functions");

/**
 * Specifiers whose substitute LOADS but is not the same package.
 *
 * ⚠ THE FIRST VERSION LEFT THESE TWO POINTING AT deno.land AND THAT ABORTED THE
 * WHOLE RUN. It looked like the careful choice: refuse to substitute what cannot
 * be substituted faithfully. But deno treats an unresolvable import as fatal, so
 * the run died at the first such file and printed no summary at all. Zero tests
 * measured is strictly worse than 9,673 measured with 110 accounted for.
 *
 * So each one IS mapped, to something that resolves and then fails in a way this
 * script can recognise by name. `breaks` is the recognisable symptom, and it is
 * what keeps these failures out of the UNEXPLAINED bucket without hiding them.
 * Deliberately NOT stubbed: a hand-written stub exporting SMTPClient would let
 * every email test pass without sending anything, which is a green that means
 * nothing.
 */
export const DEGRADED = {
  denomailer: {
    to: "npm:nodemailer@6.9.14",
    breaks:
      "nodemailer does not export SMTPClient, so every file transitively " +
      "importing src/lib/email.ts dies at module load",
    signature: /module 'denomailer' does not provide an export named 'SMTPClient'/,
  },
  imagescript: {
    to: "npm:imagescript@1.3.0",
    breaks:
      "the npm build lacks the .encode the overlay code calls, so the three " +
      "measure-overlay and measure-auto-upright cases fail at runtime",
    signature: /Cannot read properties of undefined \(reading 'encode'\)/,
  },
};

/**
 * Error text proving a failure is a DEGRADED substitution rather than a defect.
 *
 * Derived from DEGRADED, never a parallel list: a third degraded specifier must
 * bring its own signature or its failures read as unexplained, which is the
 * safe direction.
 */
const ARTIFACT_SIGNATURES = Object.values(DEGRADED).map((d) => d.signature);

/**
 * deno.json's imports, with the blocked hosts rewritten.
 *
 * esm.sh serves npm packages at a pinned version, so `https://esm.sh/x@1.2.3`
 * is `npm:x@1.2.3`. A `?target=deno` style query is dropped: it selects an
 * esm.sh build variant and means nothing to npm.
 */
export function rewriteImports(imports) {
  const out = {};
  const unresolved = [];
  for (const [key, value] of Object.entries(imports)) {
    if (key === "@std/assert") {
      out[key] = "jsr:@std/assert@1.0.8";
      continue;
    }
    if (DEGRADED[key]) {
      out[key] = DEGRADED[key].to;
      continue;
    }
    const esm = /^https:\/\/esm\.sh\/(.+?)@(\d[^/?]*)(?:[/?].*)?$/.exec(value);
    if (esm) {
      out[key] = `npm:${esm[1]}@${esm[2]}`;
      continue;
    }
    out[key] = value;
    if (/deno\.land|esm\.sh/.test(value)) unresolved.push([key, value]);
  }
  return { imports: out, unresolved };
}

function buildMap() {
  const cfg = JSON.parse(readFileSync(join(EDGE, "deno.json"), "utf8"));
  const { imports, unresolved } = rewriteImports(cfg.imports ?? {});
  const dir = mkdtempSync(join(tmpdir(), "gt-edge-map-"));
  const path = join(dir, "import-map.json");
  writeFileSync(path, JSON.stringify({ imports }, null, 2));
  return { path, unresolved };
}

function main() {
  const args = process.argv.slice(2);
  const mapOnly = args.includes("--map-only");
  const files = args.filter((a) => !a.startsWith("--"));

  // `!spawnSync(...).status === 0` was the first spelling and it is always
  // false: `!0 === 0` is `true === 0`. The guard existed and never fired, which
  // is the same class of defect as everything else in this file's header.
  if (spawnSync("deno", ["--version"], { stdio: "ignore" }).status !== 0) {
    console.error(
      "[edge-test] no deno on PATH. Install it -- it is one download, and the\n" +
        "[edge-test] version CI pins is 2.8.0:\n" +
        "[edge-test]   curl -fsSL https://github.com/denoland/deno/releases/download/" +
        "v2.8.0/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip\n" +
        "[edge-test]   unzip -o /tmp/deno.zip -d /tmp/denobin && " +
        "install -m755 /tmp/denobin/deno /usr/local/bin/deno",
    );
    return 2;
  }

  const { path: mapPath, unresolved } = buildMap();
  console.log(`[edge-test] import map: ${mapPath}`);
  for (const [key, d] of Object.entries(DEGRADED)) {
    console.log(`[edge-test] DEGRADED: ${key} -> ${d.to}\n[edge-test]   ${d.breaks}`);
  }
  // An entry here is a blocked host with no mapping at all, which deno treats as
  // fatal. It aborts the run rather than failing one file, so it is an error.
  for (const [key, value] of unresolved) {
    console.error(
      `[edge-test] UNMAPPED blocked specifier: ${key} -> ${value}\n` +
        `[edge-test]   deno aborts the whole run on an unresolvable import, so ` +
        `add it to DEGRADED with a signature, or nothing is measured.`,
    );
  }
  if (unresolved.length > 0) return 1;
  if (mapOnly) return 0;

  const run = spawnSync(
    "deno",
    [
      "test",
      "--allow-all",
      "--no-check",
      "--no-lock",
      `--import-map=${mapPath}`,
      ...(files.length ? files : ["src/tests/"]),
    ],
    { cwd: EDGE, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );

  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.replace(
    // Strip ANSI so the classification below reads the text, not the colours.
    /\u001b\[[0-9;]*m/g,
    "",
  );
  const summary = /\n(ok|FAILED)\s*\|\s*(\d+) passed[^\n]*/.exec(output);
  if (summary) console.log(`[edge-test] ${summary[0].trim()}`);

  // Classify every `error:` line. Anything not matching a known signature is
  // reported as UNEXPLAINED, which is the only kind worth a human's time.
  const errorLines = output
    .split("\n")
    .filter((l) => /^error:/.test(l.trim()))
    .map((l) => l.trim());
  const unexplained = errorLines.filter(
    (l) => !ARTIFACT_SIGNATURES.some((re) => re.test(l)),
  );
  const artifacts = errorLines.length - unexplained.length;

  if (artifacts > 0) {
    console.log(
      `[edge-test] ${artifacts} failure(s) explained by an unsubstitutable ` +
        `dependency. Not defects; not evidence of health either.`,
    );
  }
  if (unexplained.length > 0) {
    console.error(`[edge-test] ${unexplained.length} UNEXPLAINED failure(s):`);
    for (const line of [...new Set(unexplained)].slice(0, 20)) {
      console.error(`  ${line}`);
    }
    return 1;
  }
  if (run.status !== 0 && errorLines.length === 0) {
    console.error(
      `[edge-test] deno exited ${run.status} with no error line this script ` +
        `recognises. Read the output rather than trusting this exit code.`,
    );
    return 1;
  }
  console.log("[edge-test] no unexplained failures.");
  return 0;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}

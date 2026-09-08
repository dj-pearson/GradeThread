#!/usr/bin/env node
// US-3139: stage the tesseract.js runtime into public/tesseract/ so the
// AutoLister's tag OCR loads it from OUR origin.
//
// This is not a preference. public/_headers pins the app to
// `script-src 'self'` and `connect-src 'self' …` — tesseract.js's defaults
// fetch the worker, the wasm core and the language data from
// unpkg/tessdata.projectnaptha.com, and every one of those is blocked with no
// visible error beyond a CSP report. Self-hosting is the only configuration
// that runs in production.
//
// The staged tree is ~14 MB of binaries (a given browser downloads ~7 MB of it:
// one core plus the language data), so public/tesseract/ is gitignored and
// rebuilt from node_modules on every install and build. Nothing here is
// committed.
//
//   node scripts/copy-tesseract-assets.mjs [--check]
//
// --check verifies the staged tree matches the installed packages and exits
// non-zero if not, without writing. That is what CI runs.

import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A path built from import.meta.url MUST go through fileURLToPath: `.pathname`
// is "/C:/…" on Windows and relative-looking after a naive strip.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const OUT_DIR = join(repoRoot, "public", "tesseract");

/** The exact files the browser fetches at runtime, and nothing else.
 *
 *  Cores: the worker picks its core by feature detection —
 *  relaxedsimd > simd > plain — and appends `-lstm` because we never enable
 *  `legacyCore`. All three LSTM variants ship so the fallback chain resolves on
 *  any browser; the legacy trio and the bare `.wasm` payloads do not, because
 *  the `.wasm.js` files are single-file emscripten builds with the binary
 *  base64-embedded and the worker never requests a bare `.wasm`.
 *
 *  Language data: 4.0.0_best_int is the default tesseract.js resolves, and the
 *  3 MB one rather than the 11 MB `4.0.0` build. Accuracy on a printed garment
 *  label is indistinguishable and the download is a quarter of the size.
 */
const SOURCES = [
  { pkg: "tesseract.js/package.json", files: ["dist/worker.min.js"] },
  {
    pkg: "tesseract.js-core/package.json",
    files: [
      "tesseract-core-lstm.wasm.js",
      "tesseract-core-simd-lstm.wasm.js",
      "tesseract-core-relaxedsimd-lstm.wasm.js",
    ],
  },
  {
    pkg: "@tesseract.js-data/eng/package.json",
    files: ["4.0.0_best_int/eng.traineddata.gz"],
  },
];

function plan() {
  const jobs = [];
  for (const { pkg, files } of SOURCES) {
    const pkgDir = dirname(require.resolve(pkg));
    for (const file of files) {
      const from = join(pkgDir, file);
      if (!existsSync(from)) {
        throw new Error(
          `tesseract asset missing from node_modules: ${pkg} -> ${file}. ` +
            `Run npm install.`,
        );
      }
      // Flattened: the worker resolves everything against one langPath /
      // corePath directory, and eng.traineddata.gz must sit at the root of it.
      jobs.push({ from, to: join(OUT_DIR, file.split("/").pop()) });
    }
  }
  return jobs;
}

function main() {
  const check = process.argv.includes("--check");
  const jobs = plan();

  if (check) {
    const missing = jobs.filter(
      (j) => !existsSync(j.to) || statSync(j.to).size !== statSync(j.from).size,
    );
    if (missing.length > 0) {
      console.error(
        `[tesseract] ${missing.length} staged asset(s) missing or stale:\n` +
          missing.map((j) => `  ${j.to}`).join("\n") +
          `\nRun: node scripts/copy-tesseract-assets.mjs`,
      );
      process.exit(1);
    }
    console.log(`[tesseract] ${jobs.length} asset(s) staged and current.`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  let copied = 0;
  for (const { from, to } of jobs) {
    if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
    copyFileSync(from, to);
    copied++;
  }
  const bytes = readdirSync(OUT_DIR).reduce(
    (n, f) => n + statSync(join(OUT_DIR, f)).size,
    0,
  );
  console.log(
    `[tesseract] staged ${jobs.length} file(s) into public/tesseract/ ` +
      `(${copied} copied, ${(bytes / 1024 / 1024).toFixed(1)} MB total).`,
  );
}

main();

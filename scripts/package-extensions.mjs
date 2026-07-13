#!/usr/bin/env node
// US-1757 / store submission: package the browser extensions into store-ready
// zips. Both the Chrome Web Store and Firefox AMO accept a plain .zip of the
// extension folder (manifest.json at the root) — CRX is only for Chrome
// self-hosting and is NOT needed for the Web Store. Dependency-free (Node zlib),
// so it runs the same on Windows and CI Linux.
//
// Usage:  node scripts/package-extensions.mjs [--out dist-ext]
// Output: dist-ext/<name>-v<version>-<target>.zip  (+ a manifest-validation and
// Firefox-readiness report). Non-zero exit on a validation failure.
//
// Firefox notes (per-extension, encoded below):
//   • condition-check (BUYER) is Firefox-ready — content-script + runtime
//     messaging only. We emit a Firefox variant with a gecko id and an
//     event-page background (broad MV3 compat).
//   • lister (SELLER) uses `externally_connectable` (page→extension messaging),
//     which Firefox does NOT support — so its Firefox zip is SKIPPED until the
//     postMessage transport bridge (US-1882) lands. Chrome is unaffected.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative, sep } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outDir = resolve(root, args[(args.indexOf("--out") + 1) || -1] || "dist-ext");

// ── what we ship ────────────────────────────────────────────────────────────
const EXTENSIONS = [
  {
    dir: "extension-condition",
    name: "gradethread-condition-check",
    role: "buyer",
    firefox: { geckoId: "condition-check@gradethread.com" },
  },
  {
    dir: "extension",
    name: "gradethread-lister",
    role: "seller",
    // externally_connectable is Firefox-unsupported → Chrome only until US-1882.
    firefox: { blocked: "uses externally_connectable (Firefox-unsupported) — needs the postMessage bridge (US-1882)" },
  },
  {
    // US-1873: the merged extension (buyer research + seller Lister, role-gated).
    // Supersedes the two folders above once it reaches store parity (US-1872 AC5).
    dir: "extension-unified",
    name: "gradethread",
    role: "unified",
    // Inherits the Lister's externally_connectable → Chrome only until US-1882.
    firefox: { blocked: "uses externally_connectable (Firefox-unsupported) — needs the postMessage bridge (US-1882)" },
  },
];

// Files/dirs never shipped to a store (dev-only or noise).
const EXCLUDE_DIRS = new Set(["test", "node_modules", ".git"]);
const EXCLUDE_FILE = (name) => name.startsWith(".") || name.endsWith(".md");

// ── minimal ZIP writer (store + deflate), dependency-free ─────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// Deterministic DOS timestamp (1980-01-01 00:00) so a rebuild is byte-stable.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function zip(entries) {
  // entries: [{ name: "posix/path", data: Buffer }]
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const deflated = deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const method = useDeflate ? 8 : 0;
    const body = useDeflate ? deflated : e.data;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, body);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(0, 34); // internal/external attrs region zeroed
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ── collect the files an extension ships ──────────────────────────────────────
function collectFiles(absDir) {
  const files = [];
  const walk = (abs) => {
    for (const entry of readdirSync(abs)) {
      const p = join(abs, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!EXCLUDE_DIRS.has(entry)) walk(p);
      } else if (!EXCLUDE_FILE(entry)) {
        files.push(p);
      }
    }
  };
  walk(absDir);
  return files.sort();
}

// ── validate + build manifest for a target ────────────────────────────────────
function validateManifest(manifest, absDir, problems) {
  if (manifest.manifest_version !== 3) problems.push("manifest_version must be 3");
  for (const k of ["name", "version", "description"]) {
    if (!manifest[k]) problems.push(`manifest missing "${k}"`);
  }
  const refs = new Set();
  for (const v of Object.values(manifest.icons || {})) refs.add(v);
  for (const v of Object.values((manifest.action || {}).default_icon || {})) refs.add(v);
  if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) {
    for (const j of cs.js || []) refs.add(j);
    for (const c of cs.css || []) refs.add(c);
  }
  if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
  for (const r of refs) {
    if (!existsSync(join(absDir, r))) problems.push(`manifest references missing file: ${r}`);
  }
}

// Firefox needs a gecko id and, for broad MV3 compat, an event-page background
// (background.scripts) rather than a service worker.
function firefoxManifest(manifest, geckoId) {
  const m = JSON.parse(JSON.stringify(manifest));
  m.browser_specific_settings = { gecko: { id: geckoId } };
  if (m.background?.service_worker) {
    m.background = { scripts: [m.background.service_worker] };
  }
  return m;
}

// ── run ───────────────────────────────────────────────────────────────────────
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let failed = 0;
const report = [];

for (const ext of EXTENSIONS) {
  const absDir = resolve(root, ext.dir);
  const manifestPath = join(absDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    report.push(`✗ ${ext.name}: no manifest.json in ${ext.dir}`);
    failed++;
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = [];
  validateManifest(manifest, absDir, problems);
  if (problems.length) {
    report.push(`✗ ${ext.name} (${ext.role}): ${problems.join("; ")}`);
    failed++;
    continue;
  }

  const files = collectFiles(absDir);
  const toPosix = (abs) => relative(absDir, abs).split(sep).join("/");

  // Chrome: ship the manifest verbatim.
  const chromeEntries = files.map((f) => ({ name: toPosix(f), data: readFileSync(f) }));
  const chromeZip = zip(chromeEntries);
  const chromePath = join(outDir, `${ext.name}-v${manifest.version}-chrome.zip`);
  writeFileSync(chromePath, chromeZip);
  report.push(`✓ ${ext.name} (${ext.role}) → chrome  ${(chromeZip.length / 1024).toFixed(0)}KB  ${files.length} files  [${relative(root, chromePath)}]`);

  // Firefox: either a transformed variant, or a skip with the blocking reason.
  if (ext.firefox?.blocked) {
    report.push(`  ⚠ firefox SKIPPED — ${ext.firefox.blocked}`);
  } else if (ext.firefox?.geckoId) {
    const ffManifest = firefoxManifest(manifest, ext.firefox.geckoId);
    const ffEntries = files.map((f) =>
      toPosix(f) === "manifest.json"
        ? { name: "manifest.json", data: Buffer.from(JSON.stringify(ffManifest, null, 2) + "\n", "utf8") }
        : { name: toPosix(f), data: readFileSync(f) },
    );
    const ffZip = zip(ffEntries);
    const ffPath = join(outDir, `${ext.name}-v${manifest.version}-firefox.zip`);
    writeFileSync(ffPath, ffZip);
    report.push(`✓ ${ext.name} (${ext.role}) → firefox ${(ffZip.length / 1024).toFixed(0)}KB  gecko:${ext.firefox.geckoId}  [${relative(root, ffPath)}]`);
  }
}

process.stdout.write(`\nExtension packages → ${relative(root, outDir)}/\n`);
for (const line of report) process.stdout.write(`  ${line}\n`);
if (failed) {
  process.stderr.write(`\n${failed} extension(s) failed validation.\n`);
  process.exit(1);
}
process.stdout.write(`\nDone. Upload the chrome zip to the Web Store and the firefox zip to AMO.\n`);

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
//   • gradethread (UNIFIED) is Firefox-ready (US-1881/1882): the browser bits are
//     handled in-code (browser.* alias, importScripts guard, postMessage bridge
//     replacing externally_connectable) and the FF manifest transform lists the
//     background deps as event-page scripts + strips externally_connectable.
//   • lister (SELLER, legacy) still uses raw `externally_connectable` — Firefox zip
//     SKIPPED (superseded by the unified extension anyway). Chrome is unaffected.

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
//
// US-2020 — WHY THREE, and when it stops being three.
//
// extension/ and extension-condition/ are DEPRECATED (founder decision
// 2026-07-09) in favour of extension-unified/, which merges both behind one
// role-aware manifest. They are still built here because deleting them is
// US-1872 AC5, and that gate is computed in scripts/lib/extension-retirement-gate.cjs
// — read it there, not here. Short version: CODE parity is met; the STORE half is
// not (US-1757 AC1, operator-gated). Users have the legacy ones installed from
// live listings, so those builds must keep working until the listings are
// unpublished — an extension we stop building is one we cannot patch.
//
// The cost is real and is the reason this comment exists rather than a shrug:
// three store listings means three review cycles, and every selector fix has to
// be made twice against the same marketplace DOMs. That hand-sync already failed
// once — the US-1875 delist fix reached only the unified copy and the legacy
// Lister shipped a Poshmark delist that failed every run. Guarded now by
// extension-unified/test/legacy-parity.test.cjs.
//
// WHEN THE GATE OPENS: drop the first two entries below, and the legacy-parity
// guard along with them — it exists only to make the overlap survivable, not to
// make it permanent. You will not have to remember: legacy-retirement-gate.test.cjs
// fails the build the moment the gate is satisfied and they are still here.
const EXTENSIONS = [
  {
    dir: "extension-condition",
    name: "gradethread-condition-check",
    role: "buyer",
    firefox: {
      geckoId: "condition-check@gradethread.com",
      // Same grading transmission as the unified extension.
      dataCollection: { required: ["websiteContent"] },
    },
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
    // US-1881/1882: Firefox-ready. externally_connectable is replaced by the
    // gradethread.com postMessage bridge (gt-bridge.js), the service worker runs as
    // an event page (background.scripts, in dependency order — Firefox has no
    // importScripts), and the API namespace is aliased (browser/promises).
    firefox: {
      // Fallback only — extension-unified/manifest.json declares gecko.id (and
      // strict_min_version), and the manifest wins. Kept in sync with it so the
      // two can never disagree; background scripts are read from the manifest's
      // own background.scripts rather than restated here (see firefoxManifest).
      geckoId: "unified@gradethread.com",
      // Firefox data-consent (mzl.la/firefox-builtin-data-consent): the condition
      // read transmits the listing's page content (image URLs + title/brand/price)
      // to the grading endpoint on user action. Nothing is persisted server-side
      // and no PII/cookies are read, so websiteContent is the required category.
      // US-1880 AC3 adds OPTIONAL technicalAndInteraction: the selector-failure
      // ping (adapter key + which selector list was empty + config version, no
      // URL and nothing about the user). It is off by default and opt-in per
      // install, which is exactly what `optional` means here — declaring it
      // required would misstate it, and omitting it entirely would understate
      // what the add-on can send.
      //
      // US-1757 AC2 adds a SECOND opt-in under the same category: anonymous
      // usage totals (reads + click-throughs, no timestamps, no ids). AMO's
      // vocabulary has one bucket for both, so the declaration does not change
      // — the DISCLOSURE does, and it lives in SUBMISSION.md and in the privacy
      // policy's extension section, which state the two toggles separately
      // because they are two separate consents.
      dataCollection: {
        required: ["websiteContent"],
        optional: ["technicalAndInteraction"],
      },
    },
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
  // Store hard limits — an over-long field rejects the upload with a cryptic
  // message, so fail here (locally) instead. Firefox AMO caps the name at 30
  // (stricter than Chrome's 45); description ≤ 132. Character counts, not bytes.
  if (typeof manifest.name === "string" && manifest.name.length > 30) {
    problems.push(`"name" is ${manifest.name.length} chars (AMO max 30)`);
  }
  if (typeof manifest.description === "string" && manifest.description.length > 132) {
    problems.push(`"description" is ${manifest.description.length} chars (store max 132)`);
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
  // Icon dimensions must match their manifest key — Chrome rejects a "128" icon
  // that isn't exactly 128×128 (and it's an easy mismatch to miss). Read the PNG
  // IHDR (bytes 16–23, big-endian) directly; dependency-free.
  for (const [size, rel] of Object.entries(manifest.icons || {})) {
    const px = Number(size);
    if (!Number.isFinite(px)) continue;
    const abs = join(absDir, rel);
    if (!existsSync(abs)) continue; // already reported as missing above
    const dim = pngSize(readFileSync(abs));
    if (!dim) problems.push(`icon ${rel} is not a valid PNG`);
    else if (dim.w !== px || dim.h !== px) {
      problems.push(`icon "${size}" (${rel}) is ${dim.w}×${dim.h}, must be ${px}×${px}`);
    }
  }
}

// Width/height from a PNG's IHDR chunk, or null if not a PNG.
function pngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// Firefox needs a gecko id and, for broad MV3 compat, an event-page background
// (background.scripts) rather than a service worker.
//
// DERIVE, NEVER RE-DECLARE (US-1881). Everything this transform needs is already
// in the manifest, and the manifest is the copy under test
// (extension-unified/test/background-deps.test.cjs). Any value this function
// *states* instead of *reads* is a second source of truth that no test can see,
// because the guard checks the repo manifest while the STORE gets this output.
// That drift already shipped three separate breakages:
//   • a hand-listed backgroundScripts that predated lister/job-store.js, so the
//     Firefox event page loaded with GT_LISTER_JOBS undefined — the tab opened,
//     the form never filled, and the seller waited out a 130s timeout;
//   • a wholesale overwrite of browser_specific_settings that dropped
//     strict_min_version, letting the add-on install on pre-109 Firefox with no
//     MV3 at all;
//   • a gecko id that disagreed with the manifest's, so a dev-loaded temporary
//     add-on and the shipped one had different identities.
// So: read from the manifest, and let `firefox.*` only FILL GAPS.
function firefoxManifest(manifest, firefox) {
  const m = JSON.parse(JSON.stringify(manifest));

  const gecko = { ...(m.browser_specific_settings?.gecko || {}) };
  // Manifest wins; the config value is a fallback for extensions whose manifest
  // does not declare one (it also doubles as the "emit a Firefox zip" flag).
  gecko.id = gecko.id || firefox.geckoId;
  // Firefox now REQUIRES a data-collection disclosure on new add-ons/versions
  // (mzl.la/firefox-builtin-data-consent). Declared per-extension; defaults to
  // "no user data collected".
  gecko.data_collection_permissions =
    gecko.data_collection_permissions || firefox.dataCollection || { required: ["none"] };
  m.browser_specific_settings = { ...m.browser_specific_settings, gecko };

  if (m.background?.service_worker) {
    // background.scripts is the manifest's own Firefox half, kept in lockstep
    // with background.js's importScripts by background-deps.test.cjs. Prefer it
    // over anything restated here.
    const scripts = m.background.scripts?.length
      ? m.background.scripts
      : firefox.backgroundScripts?.length
        ? firefox.backgroundScripts
        : [m.background.service_worker];
    m.background = { scripts };
  }
  // externally_connectable is unsupported on Firefox (AMO linter flags it); the
  // gradethread.com postMessage bridge content script replaces it (US-1882).
  delete m.externally_connectable;

  // US-3062: the side panel. Chromium reads `side_panel.default_path` and the
  // `sidePanel` permission; Firefox reads `sidebar_action` and has no such
  // permission. Shipping either key to the wrong browser is a load warning at
  // best and an AMO linter rejection at worst, so exactly one survives per zip.
  //
  // DERIVED by transform, never restated: the panel path comes out of the
  // Chromium key rather than being written twice, so a rename cannot leave
  // Firefox pointing at a file that no longer exists.
  if (m.side_panel?.default_path) {
    m.sidebar_action = {
      default_panel: m.side_panel.default_path,
      default_title: m.action?.default_title ?? m.name,
      // Firefox draws the sidebar icon in the browser chrome at 16/32; reusing
      // the action's icon set keeps one source for it.
      default_icon: m.action?.default_icon ?? m.icons,
    };
  }
  delete m.side_panel;
  if (Array.isArray(m.permissions)) {
    m.permissions = m.permissions.filter((p) => p !== "sidePanel");
  }
  return m;
}

// Chrome (MV3) runs the background as a SERVICE WORKER and reads
// `background.service_worker`; it does NOT recognise `background.scripts`, which
// is the Firefox event-page half. Shipping that key to Chrome triggers a
// "'background.scripts' requires manifest version of 2 or lower" load warning
// (visible on every unpacked load, and noise on the store listing).
//
// The source manifest must keep BOTH keys — Firefox reads `scripts`, and
// extension-unified/test/background-deps.test.cjs enforces the service_worker +
// scripts pair as the single source of truth. So, exactly as firefoxManifest()
// strips `service_worker` for the Firefox build, strip `scripts` here for the
// Chrome build. DERIVE by deletion (never restate the Chrome background), so this
// can never drift from the manifest.
function chromeManifest(manifest) {
  const m = JSON.parse(JSON.stringify(manifest));
  if (m.background && Array.isArray(m.background.scripts)) {
    delete m.background.scripts;
  }
  return m;
}

// Exported so the transforms can be asserted on their ACTUAL OUTPUT rather than
// re-described in a test (extension-unified/test/background-deps.test.cjs).
// A guard that restates the expected values has the same blind spot as the bug it
// is guarding against.
export { EXTENSIONS, firefoxManifest, chromeManifest };

// ── run ───────────────────────────────────────────────────────────────────────
// Guarded so importing this module for tests has no side effects (no zip writes,
// no rm -rf of outDir).
const isEntry =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main();

/**
 * Write a target's entries to a real folder as well as a zip.
 *
 * WHY (2026-08-10). `chrome://extensions → Load unpacked → extension-unified/`
 * reads the SOURCE manifest, which carries both browsers' background keys, so
 * Chrome shows `'background.scripts' requires manifest version of 2 or lower`
 * on every load. Nothing ships with it — the zips are transformed — but it was
 * reported three times in one session as a suspected bug, and "expected, ignore
 * it" is a bad answer to a warning that looks like a broken extension.
 *
 * So `--unpacked` emits the transformed tree. Load THAT folder and Chrome is
 * silent, because it is the same bytes the Web Store gets. The source manifest
 * keeps both keys, and background-deps.test.cjs keeps guarding the pair.
 */
function writeTree(dir, entries) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  for (const e of entries) {
    const abs = join(dir, ...e.name.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, e.data);
  }
  return dir;
}

function main() {
const unpacked = process.argv.includes("--unpacked");
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

  // Chrome: ship every file as-is EXCEPT the manifest, which drops the Firefox-only
  // background.scripts key (chromeManifest) so Chrome MV3 loads without the
  // "'background.scripts' requires manifest version of 2 or lower" warning.
  const chromeManifestJson = JSON.stringify(chromeManifest(manifest), null, 2) + "\n";
  const chromeEntries = files.map((f) =>
    toPosix(f) === "manifest.json"
      ? { name: "manifest.json", data: Buffer.from(chromeManifestJson, "utf8") }
      : { name: toPosix(f), data: readFileSync(f) },
  );
  const chromeZip = zip(chromeEntries);
  const chromePath = join(outDir, `${ext.name}-v${manifest.version}-chrome.zip`);
  writeFileSync(chromePath, chromeZip);
  report.push(`✓ ${ext.name} (${ext.role}) → chrome  ${(chromeZip.length / 1024).toFixed(0)}KB  ${files.length} files  [${relative(root, chromePath)}]`);
  if (unpacked) {
    const d = writeTree(join(outDir, `${ext.name}-chrome`), chromeEntries);
    report.push(`  ↳ unpacked (load this in Chrome, no MV2 warning): ${relative(root, d)}`);
  }

  // Firefox: either a transformed variant, or a skip with the blocking reason.
  if (ext.firefox?.blocked) {
    report.push(`  ⚠ firefox SKIPPED — ${ext.firefox.blocked}`);
  } else if (ext.firefox?.geckoId) {
    const ffManifest = firefoxManifest(manifest, ext.firefox);
    const ffEntries = files.map((f) =>
      toPosix(f) === "manifest.json"
        ? { name: "manifest.json", data: Buffer.from(JSON.stringify(ffManifest, null, 2) + "\n", "utf8") }
        : { name: toPosix(f), data: readFileSync(f) },
    );
    // US-1881 follow-up: REFUSE to emit a Firefox zip with no version floor.
    //
    // An MV3 add-on without strict_min_version installs on pre-109 Firefox,
    // where MV3 does not exist — so it lands, does nothing, and looks like our
    // bug. That exact breakage is one of the three listed in the firefoxManifest
    // comment above, and it silently recurred: extension-condition declared no
    // browser_specific_settings at all, so the config fallback supplied an id
    // and nothing constrained the version. It shipped that way.
    //
    // A hard failure rather than a warning: this is the packaging step for a
    // store upload, the output goes somewhere we cannot recall it from, and a
    // warning in a build log is exactly what got missed the first time.
    if (!ffManifest.browser_specific_settings?.gecko?.strict_min_version) {
      throw new Error(
        `${ext.name}: Firefox build has no browser_specific_settings.gecko.strict_min_version. ` +
          `An MV3 add-on without a floor installs on pre-109 Firefox where MV3 does not exist. ` +
          `Declare it in ${ext.dir}/manifest.json (the manifest is the source of truth; ` +
          `firefox.* config only fills gaps).`,
      );
    }

    const ffZip = zip(ffEntries);
    const ffPath = join(outDir, `${ext.name}-v${manifest.version}-firefox.zip`);
    writeFileSync(ffPath, ffZip);
    // Report the id/scripts actually written, not the config's fallback — the
    // whole point of the transform is that the manifest can override it.
    const g = ffManifest.browser_specific_settings.gecko;
    report.push(`✓ ${ext.name} (${ext.role}) → firefox ${(ffZip.length / 1024).toFixed(0)}KB  gecko:${g.id}${g.strict_min_version ? ` min:${g.strict_min_version}` : ""}  bg:${(ffManifest.background?.scripts || []).length} scripts  [${relative(root, ffPath)}]`);
    if (unpacked) {
      const d = writeTree(join(outDir, `${ext.name}-firefox`), ffEntries);
      report.push(`  ↳ unpacked (about:debugging → load its manifest.json): ${relative(root, d)}`);
    }
  }
}

process.stdout.write(`\nExtension packages → ${relative(root, outDir)}/\n`);
for (const line of report) process.stdout.write(`  ${line}\n`);
if (failed) {
  process.stderr.write(`\n${failed} extension(s) failed validation.\n`);
  process.exit(1);
}
process.stdout.write(`\nDone. Upload the chrome zip to the Web Store and the firefox zip to AMO.\n`);
}

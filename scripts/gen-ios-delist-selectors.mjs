#!/usr/bin/env node
// US-3281 — generate the iOS delist flow table from the extension's selectors.
//
//   node scripts/gen-ios-delist-selectors.mjs           # write the Swift file
//   node scripts/gen-ios-delist-selectors.mjs --check   # exit 1 on drift
//
// WHY GENERATED RATHER THAN TYPED. The iOS app has to hold the same menu /
// remove / confirm selectors the desktop extension holds, and those selectors
// break every few weeks when a marketplace ships a redesign. A hand-kept second
// copy would go stale on the exact day the first one was fixed, and the failure
// is silent on both sides: a selector that misses does not throw, it fills
// nothing and reports a delist that never happened.
//
// The generated Swift is COMMITTED and compiled into the binary, which is the
// other half of the point. App Review guideline 4.7 covers software not embedded
// in the binary, and the whole case for this feature (see
// vault/10-ops/ios-webview-delist-app-review.md) rests on the app downloading no
// executable code at runtime. So: one source of truth, resolved at build time,
// shipped inside the app. Do not replace this with a fetch.
//
// ONLY THE DELIST FLOW is carried across. The lister's fill flow is far larger
// and iOS does not run it; copying fields nothing reads would just be more
// surface to drift.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectorsPath = path.join(root, "extension-unified", "lister", "selectors.js");
const outPath = path.join(
  root, "ios", "GradeThread", "Marketplaces", "WebDelist", "DelistFlows.generated.swift",
);

const PLATFORMS = ["poshmark", "mercari", "grailed", "vinted", "facebook"];

// Labels the seller reads. Mirrors MARKETPLACE_LABELS in src/lib/constants.ts;
// kept here rather than imported because that file is TypeScript in the eager
// web graph and this script must stay a plain node read of one file.
const LABELS = {
  poshmark: "Poshmark",
  mercari: "Mercari",
  grailed: "Grailed",
  vinted: "Vinted",
  facebook: "Facebook Marketplace",
};

function loadSelectors() {
  const src = readFileSync(selectorsPath, "utf8");
  return new Function("self", `${src}; return self.GT_LISTER_SELECTORS;`)({});
}

/** Swift string literal. Escapes only what Swift needs; the input is CSS. */
function swiftString(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function optionalString(value) {
  return typeof value === "string" && value ? swiftString(value) : "nil";
}

function flowLiteral(platform, cfg) {
  const d = cfg.delist || {};
  const v = d.verify || {};
  return [
    `        "${platform}": Flow(`,
    `            platform: "${platform}",`,
    `            label: ${swiftString(LABELS[platform] || platform)},`,
    // `enabled` is the extension's own verification claim, carried across
    // unchanged. A draft flow on desktop is a draft flow here: the runner
    // refuses it by name rather than aiming unverified selectors at a real
    // listing (US-2165).
    `            enabled: ${d.enabled === true},`,
    `            version: ${swiftString(d.version || "none")},`,
    `            hosts: [${(cfg.hosts || []).map(swiftString).join(", ")}],`,
    `            liveListingUrlPattern: ${optionalString(cfg.liveListingUrlPattern)},`,
    `            navigatesTo: ${optionalString(d.navigatesTo)},`,
    `            menu: ${optionalString(d.menu)},`,
    `            remove: ${optionalString(d.remove)},`,
    `            confirm: ${optionalString(d.confirm)},`,
    `            goneWhenEnded: ${optionalString(v.gone)}`,
    `        ),`,
  ].join("\n");
}

function generate() {
  const selectors = loadSelectors();
  const flows = PLATFORMS
    .filter((p) => selectors[p])
    .map((p) => flowLiteral(p, selectors[p]))
    .join("\n");

  return `// GENERATED FILE. DO NOT EDIT.
//
// Source:      extension-unified/lister/selectors.js (each platform's delist block)
// Regenerate:  node scripts/gen-ios-delist-selectors.mjs
// Guarded by:  scripts/gen-ios-delist-selectors.mjs --check, in npm run verify
//
// US-3281. The iOS app ends a listing in a WKWebView the seller is signed into
// and watching. The selectors it clicks are the same ones the desktop extension
// clicks, resolved at build time and compiled in, because the app must download
// no executable code at runtime (App Review 4.7) and because a hand-kept second
// copy of a marketplace's DOM goes stale the day the first one is fixed.
//
// \`enabled: false\` means nobody has verified that platform's delist flow
// against the live site. The runner refuses those by name.

import Foundation

enum DelistFlows {

    struct Flow {
        let platform: String
        let label: String
        /// Verified against the live site. False means refuse, never guess.
        let enabled: Bool
        /// The selector-set version, reported in failures so a stale build is
        /// diagnosable from a screenshot.
        let version: String
        /// Hosts a listing URL must match before anything is loaded.
        let hosts: [String]
        /// What a live listing's URL looks like, so a page that is not one is
        /// never clicked on.
        let liveListingUrlPattern: String?
        /// Set when the menu control navigates to another page (Poshmark's
        /// delete lives on the edit page) rather than opening a panel in place.
        let navigatesTo: String?
        let menu: String?
        let remove: String?
        let confirm: String?
        /// Absent from the page once the listing is gone. Used to confirm the
        /// end actually happened rather than trusting the click.
        let goneWhenEnded: String?
    }

    static let flows: [String: Flow] = [
${flows}
    ]

    static func flow(for platform: String) -> Flow? {
        flows[platform]
    }

    /// Platforms this build will attempt. Everything else is refused with the
    /// reason, which is the honest answer and the one a seller can act on.
    static var runnable: [String] {
        flows.values.filter { $0.enabled }.map { $0.platform }.sorted()
    }
}
`;
}

const next = generate();
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    current = "";
  }
  if (current !== next) {
    console.error(
      "gen-ios-delist-selectors: DelistFlows.generated.swift is stale. " +
        "A marketplace's delist selectors changed in extension-unified/lister/selectors.js " +
        "and iOS is still clicking the old ones. Run: node scripts/gen-ios-delist-selectors.mjs",
    );
    process.exit(1);
  }
  console.log("✓ gen-ios-delist-selectors: iOS delist flows match the extension's selectors");
} else {
  writeFileSync(outPath, next);
  console.log(`gen-ios-delist-selectors: wrote ${path.relative(root, outPath)}`);
}

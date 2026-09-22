#!/usr/bin/env node
// US-3455 -- generate the iOS list flow table from the extension's selectors.
//
//   node scripts/gen-ios-list-selectors.mjs           # write the Swift file
//   node scripts/gen-ios-list-selectors.mjs --check   # exit 1 on drift
//
// The sibling of scripts/gen-ios-delist-selectors.mjs, for the CREATE form
// rather than the end-listing flow. Same reasons, same shape: the phone fills
// the same title, description, price and brand fields the desktop extension
// fills, resolved at build time from the one source of truth and compiled into
// the binary (App Review 4.7, vault/10-ops/ios-webview-delist-app-review.md).
//
// WHAT IS CARRIED. The create URL, the hosts, the login and live-listing URL
// patterns, the `required` probe list, the text-field selectors, the photo
// input, Poshmark's price dialog, the submit selector (probed so the run can
// confirm it is on the form; NEVER clicked by the app) and the `enabled` claim.
//
// WHAT IS NOT. The pickers. US-3210 asked for category, size, condition and
// colour selectors and extension-unified/lister/selectors.js deliberately does
// not carry them ("driving an option list is a different problem with its own
// verification"). There is nothing to copy, so the phone does what the Listing
// Kit does: it names the pickers the seller still sets, from the same
// manualFields list src/lib/marketplace-specs.ts declares. That list is pinned
// here by src/test/ios-list-flows-drift.test.ts against the real export.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectorsPath = path.join(root, "extension-unified", "lister", "selectors.js");
const outPath = path.join(
  root, "ios", "GradeThread", "Marketplaces", "WebList", "ListFlows.generated.swift",
);

// Only the two platforms the desktop extension has verified a create form for.
// Grailed, Vinted and Facebook are queue-only on the phone until their list
// flow is `enabled` in selectors.js, at which point adding them here is the
// whole change.
const PLATFORMS = ["poshmark", "mercari"];

const LABELS = {
  poshmark: "Poshmark",
  mercari: "Mercari",
};

// Mirrors `manualFields` in src/lib/marketplace-specs.ts. Pinned by
// src/test/ios-list-flows-drift.test.ts, which imports the real export and
// fails if these lists diverge from it.
export const MANUAL_FIELDS = {
  poshmark: ["category", "size", "color", "nwt"],
  mercari: ["category", "condition", "size"],
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

function stringList(values) {
  return "[" + (Array.isArray(values) ? values : []).map(swiftString).join(", ") + "]";
}

function flowLiteral(platform, cfg) {
  const f = cfg.fields || {};
  const dialog = cfg.priceDialog || {};
  return [
    `        "${platform}": Flow(`,
    `            platform: "${platform}",`,
    `            label: ${swiftString(LABELS[platform] || platform)},`,
    // The extension's own verification claim for the DESKTOP form, which is
    // the tree the phone requests (preferredContentMode = .desktop). A draft
    // flow on desktop is a draft flow here.
    `            enabled: ${cfg.enabled === true},`,
    `            version: ${swiftString(cfg.version || "none")},`,
    `            hosts: ${stringList(cfg.hosts)},`,
    `            newListingUrl: ${swiftString(cfg.newListingUrl || "")},`,
    `            loginUrlPattern: ${optionalString(cfg.login && cfg.login.urlPattern)},`,
    `            liveListingUrlPattern: ${optionalString(cfg.liveListingUrlPattern)},`,
    `            required: ${stringList(cfg.required)},`,
    `            title: ${optionalString(f.title)},`,
    `            description: ${optionalString(f.description)},`,
    `            price: ${optionalString(f.price)},`,
    `            originalPrice: ${optionalString(f.originalPrice)},`,
    `            brand: ${optionalString(f.brand)},`,
    `            photoInput: ${optionalString(f.photoInput)},`,
    `            priceDialogOpen: ${optionalString(dialog.open)},`,
    `            priceDialogPrice: ${optionalString(dialog.price)},`,
    `            submit: ${optionalString(cfg.submit)},`,
    `            manualFields: ${stringList(MANUAL_FIELDS[platform])}`,
    `        ),`,
  ].join("\n");
}

export function generate() {
  const selectors = loadSelectors();
  const flows = PLATFORMS
    .filter((p) => selectors[p])
    .map((p) => flowLiteral(p, selectors[p]))
    .join("\n");

  return `// GENERATED FILE. DO NOT EDIT.
//
// Source:      extension-unified/lister/selectors.js (each platform's list block)
// Regenerate:  node scripts/gen-ios-list-selectors.mjs
// Guarded by:  scripts/gen-ios-list-selectors.mjs --check, run by
//              src/test/ios-list-flows-drift.test.ts in npm run verify
//
// US-3455. The iOS app fills a marketplace's create-listing form in a
// WKWebView the seller is signed into and watching, then stops with the
// marketplace's own Post button on screen. The selectors it fills are the same
// ones the desktop extension fills, resolved at build time and compiled in,
// because the app must download no executable code at runtime (App Review 4.7)
// and because a hand-kept second copy of a marketplace's DOM goes stale the
// day the first one is fixed.
//
// \`submit\` is carried so the run can PROBE that it is on the real form. It is
// never clicked: the seller posts.

import Foundation

enum ListFlows {

    struct Flow {
        let platform: String
        let label: String
        /// Verified against the live site. False means refuse, never guess.
        let enabled: Bool
        /// The selector-set version, named in a refusal so a stale build is
        /// diagnosable from a screenshot.
        let version: String
        /// Hosts the run may load. Anything else stops it.
        let hosts: [String]
        /// The create-listing page. The only URL this flow opens on its own.
        let newListingUrl: String
        /// A URL that means the marketplace wants a sign-in first.
        let loginUrlPattern: String?
        /// What a live listing's URL looks like: landing on one means the
        /// seller posted, and is the only thing that records a listing.
        let liveListingUrlPattern: String?
        /// Field names that must ALL be present before anything is filled.
        let required: [String]
        let title: String?
        let description: String?
        let price: String?
        let originalPrice: String?
        let brand: String?
        /// The form's file input. Photos go through the marketplace's own
        /// picker, which this input opens when the seller taps it.
        let photoInput: String?
        /// Poshmark keeps the price behind a dialog; nil elsewhere.
        let priceDialogOpen: String?
        let priceDialogPrice: String?
        /// Probed, never clicked.
        let submit: String?
        /// Pickers the seller sets by hand on the form, in this order.
        let manualFields: [String]

        /// The selector a \`required\` name refers to.
        func selector(named name: String) -> String? {
            switch name {
            case "title": return title
            case "description": return description
            case "price": return price
            case "originalPrice": return originalPrice
            case "brand": return brand
            case "photoInput": return photoInput
            case "submit": return submit
            default: return nil
            }
        }
    }

    static let flows: [String: Flow] = [
${flows}
    ]

    static func flow(for platform: String) -> Flow? {
        flows[platform]
    }

    /// Platforms this build will fill for. Everything else queues for the
    /// desktop, which is the honest answer and the one a seller can act on.
    static var runnable: [String] {
        flows.values.filter { $0.enabled }.map { $0.platform }.sorted()
    }
}
`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
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
        "gen-ios-list-selectors: ListFlows.generated.swift is stale. " +
          "A marketplace's list selectors changed in extension-unified/lister/selectors.js " +
          "and iOS is still filling the old ones. Run: node scripts/gen-ios-list-selectors.mjs",
      );
      process.exit(1);
    }
    console.log("gen-ios-list-selectors: iOS list flows match the extension's selectors");
  } else {
    writeFileSync(outPath, next);
    console.log(`gen-ios-list-selectors: wrote ${path.relative(root, outPath)}`);
  }
}

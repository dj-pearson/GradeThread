#!/usr/bin/env node
// US-3054: render the unified extension's surfaces headlessly, for review and
// for the store listing — and catch a visual drift nobody meant.
//
//   node scripts/extension-screenshots.mjs            # write dist-ext/screenshots/*.png
//   node scripts/extension-screenshots.mjs --check    # compare against the committed baseline
//   node scripts/extension-screenshots.mjs --update   # render and rewrite the baseline
//
// Renders popup.html (Reads, Selling, Settings), onboarding.html, options.html
// and compare.html, in light and dark, for three fixture states (anonymous,
// signed-in buyer, seller with work in every queue), through the chrome.* stub
// in scripts/lib/extension-stub.mjs. No network, no signed-in account, and a
// FROZEN clock: every "2h ago" and "try again after 6:12" is computed against
// the same instant on every run, which is what makes a hash comparison possible.
//
// THE BASELINE IS TIED TO A BROWSER BUILD. A PNG's bytes depend on the
// renderer and the fonts on the machine, so the baseline records the Chromium
// version it was made with; --check on a different build reports that plainly
// (exit 2) rather than pretending every pixel drifted. Rerun --update on the
// build the baseline should track, and commit it.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { fixture, installStub, launchChromium } from "./lib/extension-stub.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extDir = path.join(root, "extension-unified");
const outDir = path.join(root, "dist-ext", "screenshots");
const baselinePath = path.join(extDir, "test", "fixtures", "screenshot-baseline.json");
const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--update") ? "update" : "render";

// Frozen "now": a Wednesday morning, so "3d ago" and the reset time read alike every run.
export const FROZEN_NOW = Date.UTC(2026, 8, 2, 15, 30, 0);
export const STATES = ["anon", "buyer", "seller"];
// US-3055: the OS scheme under System, then each forced preference against the
// OPPOSITE OS scheme, which is the only render that proves the override.
export const VARIANTS = [
  { tag: "system-light", scheme: "light", theme: null },
  { tag: "system-dark", scheme: "dark", theme: null },
  { tag: "forced-light", scheme: "dark", theme: "light" },
  { tag: "forced-dark", scheme: "light", theme: "dark" },
];
export const POPUP_TABS = ["Reads", "Selling", "Settings"];
export const PAGES = [
  ["onboarding.html", 900],
  ["options.html", 900],
  ["compare.html", 1000],
];

/** Every render this script makes, in a fixed order: [name, kind, state, scheme, tab-or-page]. */
export function renderPlan() {
  const plan = [];
  for (const state of STATES) {
    for (const v of VARIANTS) {
      for (const tab of POPUP_TABS) plan.push({ name: `popup-${state}-${v.tag}-${tab.toLowerCase()}`, kind: "popup", state, scheme: v.scheme, theme: v.theme, tab });
    }
  }
  for (const [page, width] of PAGES) {
    for (const v of VARIANTS) {
      // Pages carry no plan-gated state; the buyer fixture gives the compare
      // page rows and the options page counts, which is the useful picture.
      plan.push({ name: `${page.replace(".html", "")}-${v.tag}`, kind: "page", state: "buyer", scheme: v.scheme, theme: v.theme, page, width });
    }
  }
  return plan;
}

function sha(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function render(browser) {
  mkdirSync(outDir, { recursive: true });
  const hashes = {};
  for (const item of renderPlan()) {
    const ctx = await browser.newContext({
      viewport: { width: item.kind === "popup" ? 380 : item.width, height: 700 },
      colorScheme: item.scheme,
      deviceScaleFactor: 2,
      locale: "en-US",
      timezoneId: "America/Chicago",
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(FROZEN_NOW);
    const fx = fixture(item.state, FROZEN_NOW);
    if (item.theme) fx.state.theme = item.theme;
    await page.addInitScript(installStub, fx);
    const file = item.kind === "popup" ? "popup.html" : item.page;
    await page.goto(pathToFileURL(path.join(extDir, file)).href);
    await page.waitForTimeout(400);
    if (item.kind === "popup") {
      await page.click("#nav" + item.tab);
      await page.waitForTimeout(150);
    }
    const buf = await page.screenshot({ fullPage: true, animations: "disabled" });
    writeFileSync(path.join(outDir, item.name + ".png"), buf);
    hashes[item.name] = sha(buf);
    await ctx.close();
  }
  return hashes;
}

const browser = await launchChromium(chromium);
let hashes;
let version;
try {
  version = browser.version();
  hashes = await render(browser);
} finally {
  await browser.close();
}
console.log(`extension-screenshots: ${Object.keys(hashes).length} renders in ${path.relative(root, outDir)} (Chromium ${version})`);

if (mode === "update") {
  mkdirSync(path.dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify({ chromium: version, hashes }, null, 2) + "\n");
  console.log("baseline written: " + path.relative(root, baselinePath));
} else if (mode === "check") {
  if (!existsSync(baselinePath)) {
    console.error("extension-screenshots: no baseline. Run with --update on the build it should track.");
    process.exit(2);
  }
  const base = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (base.chromium !== version) {
    console.error(
      `extension-screenshots: the baseline was made with Chromium ${base.chromium}; this is ${version}. ` +
        "Pixels differ between builds, so a byte comparison would report drift that is not ours. " +
        "Run --update on the build the baseline should track.",
    );
    process.exit(2);
  }
  const names = new Set([...Object.keys(base.hashes), ...Object.keys(hashes)]);
  let drift = 0;
  for (const name of [...names].sort()) {
    if (!(name in base.hashes)) { console.log("NEW    " + name); drift++; }
    else if (!(name in hashes)) { console.log("GONE   " + name); drift++; }
    else if (base.hashes[name] !== hashes[name]) { console.log("DRIFT  " + name); drift++; }
  }
  if (drift) {
    console.error(`extension-screenshots: ${drift} render(s) differ from the baseline. Look at dist-ext/screenshots/, then --update if the change is intended.`);
    process.exit(1);
  }
  console.log("extension-screenshots: every render matches the baseline.");
}

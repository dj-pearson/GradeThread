#!/usr/bin/env node
// US-3053: axe-core over the unified extension's popup, in three fixture states.
//
//   node scripts/extension-a11y.mjs          # exits 1 on any serious/critical
//   node scripts/extension-a11y.mjs --all    # also print moderate/minor
//
// The popup is rendered from popup.html with the chrome.* API stubbed
// (scripts/lib/extension-stub.mjs), each of the three tabs is opened, and
// axe runs on every tab. Serious and critical violations fail the run; the
// rest are printed as advice. No network, no signed-in account.

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { fixture, installStub, launchChromium } from "./lib/extension-stub.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const axePath = require.resolve("axe-core/axe.min.js");
const popup = pathToFileURL(path.join(root, "extension-unified", "popup.html")).href;
const showAll = process.argv.includes("--all");

const browser = await launchChromium(chromium);
let failing = 0;
try {
  for (const name of ["anon", "buyer", "seller"]) {
    const ctx = await browser.newContext({ viewport: { width: 380, height: 700 } });
    const page = await ctx.newPage();
    await page.addInitScript(installStub, fixture(name));
    await page.goto(popup);
    await page.waitForTimeout(500);
    await page.addScriptTag({ path: axePath });
    for (const tab of ["Reads", "Selling", "Settings"]) {
      await page.click("#nav" + tab);
      await page.waitForTimeout(150);
      const result = await page.evaluate(async () => {
        // @ts-ignore axe is injected above
        return await globalThis.axe.run(document, { resultTypes: ["violations"] });
      });
      for (const v of result.violations) {
        const bad = v.impact === "serious" || v.impact === "critical";
        if (bad) failing++;
        if (bad || showAll) {
          console.log(`${bad ? "FAIL" : "note"} [${name}/${tab}] ${v.id} (${v.impact}): ${v.help}`);
          for (const n of v.nodes.slice(0, 3)) console.log("    " + n.target.join(" "));
        }
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (failing) {
  console.error(`extension-a11y: ${failing} serious/critical violation(s).`);
  process.exit(1);
}
console.log("extension-a11y: 3 states x 3 tabs, no serious or critical violations.");

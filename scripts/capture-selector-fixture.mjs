#!/usr/bin/env node
// US-3063: capture a sanitised copy of a marketplace page, for the selector spec.
//
// THE PROBLEM THIS SOLVES. Selector health is only observable live: a person
// with a logged-in account presses "Check selectors" in the popup. So a
// Poshmark redesign is discovered by a seller whose cross-post silently did
// nothing, and the US-1875 delist regression shipped for exactly that reason —
// nothing in CI could exercise the DOM.
//
// A checked-in fixture makes the DOM testable without an account. What it can
// never be is CURRENT: a fixture is a photograph of a page on the day it was
// taken, so this catches "our selectors stopped matching the page we last saw",
// not "the page changed this morning". That is still the whole regression class
// the delist bug belonged to.
//
// HOW IT ATTACHES. Playwright's connectOverCDP against a Chrome the operator
// already has open and is already signed into. It reads no credential, stores
// no cookie and drives no login: the human navigates to the page, then runs
// this. Start Chrome with --remote-debugging-port=9222 first.
//
//   node scripts/capture-selector-fixture.mjs poshmark list --redact myhandle
//
// WHAT IT REMOVES, and why each one:
//   - every <script>: a marketplace page's inline JSON blobs carry the signed-in
//     user's id, email, address book and sometimes a session token. This is the
//     single most important removal and it is why the fixture is not just
//     outerHTML.
//   - every image src/srcset: replaced with a 1x1 data URI. Keeps the <img>
//     elements a gallery selector counts, drops the CDN URLs (which encode the
//     account) and keeps the file small.
//   - every input/textarea VALUE: a half-filled form carries whatever the
//     operator had typed.
//   - anything passed to --redact: the handle and email appear in nav chrome,
//     og: tags and data attributes, in forms this cannot enumerate.
//
// Then gitleaks runs over the written file, and a fixture that trips it is
// DELETED before this exits non-zero. A leaked fixture that merely fails the
// build is still on disk and one `git add -A` from being committed.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "extension-unified", "test", "fixtures", "dom");

/** A 1x1 transparent GIF. Shorter than a PNG and every browser renders it. */
export const BLANK_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function usage(msg) {
  if (msg) console.error(`\n  ${msg}\n`);
  console.error(
    `Usage: node scripts/capture-selector-fixture.mjs <platform> <flow> [options]

  <platform>   poshmark | mercari | grailed | vinted | depop
  <flow>       list | detail | research

  --redact <s> Text to scrub from the page. Repeatable. Pass your handle AND
               your email; both appear in nav chrome and og: tags.
  --port <n>   Chrome CDP port (default 9222)
  --cdp <url>  Full CDP endpoint, overrides --port

  Start Chrome with --remote-debugging-port=9222, sign in, navigate to the page
  you want, then run this. Nothing here logs in or reads a credential.`,
  );
  process.exit(2);
}

/**
 * Sanitise a captured document.
 *
 * Pure and exported so the test can assert the RULES rather than re-describe
 * them: a sanitiser that is only exercised by the operator script is one nobody
 * checks until a fixture leaks.
 */
export function sanitiseHtml(html, redactions = []) {
  let out = String(html);

  // Scripts first. Everything else is cosmetic next to a page's inline JSON
  // state blob, which routinely carries the signed-in user's id and email.
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<script\b[^>]*\/>/gi, "");
  // noscript can carry a tracking pixel with an account id in the query string.
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");

  // Images: keep the element, drop the URL.
  out = out.replace(/\ssrcset\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\ssrcset\s*=\s*'[^']*'/gi, "");
  out = out.replace(/(<img\b[^>]*?)\ssrc\s*=\s*"[^"]*"/gi, `$1 src="${BLANK_IMAGE}"`);
  out = out.replace(/(<img\b[^>]*?)\ssrc\s*=\s*'[^']*'/gi, `$1 src="${BLANK_IMAGE}"`);

  // Input values. `value` on a checkbox/radio is semantic, but a fixture is for
  // resolving selectors, not for reading values, so emptying all of them is the
  // safe direction.
  out = out.replace(/(<input\b[^>]*?)\svalue\s*=\s*"[^"]*"/gi, '$1 value=""');
  out = out.replace(/(<input\b[^>]*?)\svalue\s*=\s*'[^']*'/gi, '$1 value=""');
  out = out.replace(
    /(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/gi,
    "$1$2",
  );

  // The operator's own strings, last, so they also catch anything the rules
  // above left behind.
  for (const raw of redactions) {
    const needle = String(raw || "").trim();
    if (needle.length < 3) continue; // too short to redact safely
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "REDACTED");
  }

  return out;
}

/** Path only. A full URL carries query parameters that identify the account. */
export function pathOf(url) {
  try {
    return new URL(url).pathname;
    } catch (_e) {
    return "";
  }
}

function parseArgs(argv) {
  const positional = [];
  const redact = [];
  let port = "9222";
  let cdp = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--redact") redact.push(argv[++i]);
    else if (a === "--port") port = argv[++i];
    else if (a === "--cdp") cdp = argv[++i];
    else if (a.startsWith("--")) usage(`unknown option ${a}`);
    else positional.push(a);
  }
  return { positional, redact, port, cdp };
}

async function main() {
  const { positional, redact, port, cdp } = parseArgs(process.argv.slice(2));
  const [platform, flow] = positional;
  if (!platform || !flow) usage("platform and flow are required");
  if (redact.length === 0) {
    usage(
      "--redact is required. Pass your handle and your email: they appear in " +
        "nav chrome and og: tags that no structural rule can find.",
    );
  }

  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch (_e) {
    console.error("Playwright is not installed. Run: npm i -D @playwright/test");
    process.exit(1);
  }

  const endpoint = cdp || `http://127.0.0.1:${port}`;
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    console.error(
      `Could not attach to Chrome at ${endpoint}.\n` +
        `Start it with --remote-debugging-port=${port}, sign in, and navigate ` +
        `to the page you want captured.\n${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page = context && context.pages().find((p) => !p.isClosed());
  if (!page) {
    console.error("No open page found in that Chrome.");
    await browser.close();
    process.exit(1);
  }

  const url = page.url();
  const html = await page.evaluate(() => document.documentElement.outerHTML);
  await browser.close();

  const clean = sanitiseHtml(html, redact);
  const dir = join(FIXTURE_DIR, platform);
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, `${flow}.html`);
  const metaPath = join(dir, `${flow}.json`);

  const selectorsVersion = readSelectorsVersion(platform);
  writeFileSync(htmlPath, clean, "utf8");
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString().slice(0, 10),
        selectorsVersion,
        // PATH ONLY. A captured URL with its query string identifies the
        // account that captured it.
        path: pathOf(url),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // The leak check, and the deletion if it trips. A fixture that merely fails
  // the build is still on disk and one `git add -A` from being committed.
  const leak = spawnSync(
    "gitleaks",
    ["detect", "--no-git", "--source", dir, "--redact"],
    { stdio: "inherit", shell: false },
  );
  if (leak.error) {
    console.warn(
      "\ngitleaks is not installed, so the capture was NOT leak-checked. " +
        "Install it (scoop install gitleaks) and re-run before committing.",
    );
  } else if (leak.status !== 0) {
    rmSync(htmlPath, { force: true });
    rmSync(metaPath, { force: true });
    console.error(
      `\ngitleaks flagged the capture. Both files were DELETED rather than ` +
        `left on disk.\nAdd the offending string to --redact and capture again.`,
    );
    process.exit(1);
  }

  const kb = Math.round(clean.length / 1024);
  console.log(
    `\n  wrote ${platform}/${flow}.html (${kb} KB) and its sidecar` +
      `\n  selectorsVersion ${selectorsVersion}\n  path ${pathOf(url)}\n`,
  );
}

/** The platform's version string from the bundled selectors, or "". */
export function readSelectorsVersion(platform) {
  try {
    const file = join(ROOT, "extension-unified", "lister", "selectors.js");
    if (!existsSync(file)) return "";
    const scope = { self: {} };
    new Function("self", readFileSync(file, "utf8"))(scope.self);
    const cfg = scope.self.GT_LISTER_SELECTORS?.[platform];
    return (cfg && cfg.version) || "";
  } catch (_e) {
    return "";
  }
}

const isEntry = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

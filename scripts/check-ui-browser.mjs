#!/usr/bin/env node
// US-2833: the browser-scoped half of the UI gate.
//
// scripts/check-ui-antipatterns.mjs reads FILES, so it can only ever raise the
// rules a source scan can decide. Four of CLAUDE.md's craft-floor tells are not
// among them - they need computed styles and a laid-out DOM - and until this
// existed nothing checked them at all, while the source gate's rule list made
// it look like something did.
//
// The four, with the names impeccable ACTUALLY uses:
//
//   nested-cards                 cards inside cards
//   icon-tile-stack              rounded-square icon tile above a heading
//   hero-eyebrow-chip            tracked uppercase eyebrow over a hero headline
//   gpt-thin-border-wide-shadow  1px border under a wide soft shadow
//
// THE FOURTH ONE WAS RECORDED AS NOT EXISTING. CLAUDE.md and US-2833 both say
// "border-and-shadow exists under no spelling". It exists, spelled
// gpt-thin-border-wide-shadow, and it fires. What is true is that a SOURCE scan
// cannot raise it: it carries no `scopes` field, which reads as
// source-checkable, and a fixture with the exact border-plus-shadow pattern in
// .tsx and .css produced ZERO findings from `impeccable detect <dir>`. So the
// conclusion was right and the reason was wrong, which is worse than being
// wrong outright - nobody re-checks a rule they have been told does not exist.
//
// ONE URL PER INVOCATION, AND THAT IS NOT A STYLE CHOICE. Passing several URLs
// to one `impeccable detect` call silently under-reports. Measured 2026-08-23:
// /pricing scanned alone returns 26 findings including 14 nested-cards; the
// same page inside a five-URL call returns 2, with zero nested-cards. Nothing
// errors and nothing warns. A CI job written the batch way would have read as
// almost-clean against a page carrying 14 instances of a banned tell.
//
// WHAT THIS TOOL CANNOT DO, stated because AC5 asks for something it cannot
// support. A browser finding carries only { antipattern, file, severity } - no
// selector, no DOM path, no line, and a snippet that is the literal string
// "Card inside card". Fourteen findings on a page are indistinguishable from
// each other, so a per-FINDING allowlist is impossible; the finest grain
// available is (page, rule). That is a named list rather than a global number,
// but it does not pin instance counts, and pretending otherwise would be the
// numeric baseline AC5 exists to prevent, wearing a list's clothes.
//
// AND YOU CANNOT RECONSTRUCT THE POSITION EITHER - tried 2026-08-23, twice.
// Text mode is no better than JSON for this rule: other rules quote their
// context (low-contrast prints the sentence it measured), nested-cards prints
// the literal words "Card inside card" and nothing else. A class-based walk over
// the prerendered HTML, approximating a card as a rounded container with a
// border or a raised background, does not reproduce the tool either: it found 15
// on /pricing against the browser's 14, 19 on / against 8, and ZERO on
// /flipdesk, /verify and /grading-standard against 8, 1 and 1. Disagreeing in
// BOTH directions is what makes it useless as a locator rather than merely
// noisy - it is not a superset to filter down.
//
// So the practical cost of acting on a finding here is a human opening the page
// and looking. That belongs in AC1's decision, not discovered after it.
//
// Usage:
//   node scripts/check-ui-browser.mjs              # report, exit 0
//   node scripts/check-ui-browser.mjs --enforce    # fail on un-allowlisted
//   BASE_URL=http://localhost:5173 node scripts/check-ui-browser.mjs
//
// NOT wired into `npm run verify` or CI. US-2833 AC1 is the owner's decision
// about cost, and "nothing" is a legitimate answer there.

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "scripts", "fixtures", "ui-browser", "index.html");

export const ENFORCED_BROWSER_RULES = [
  "nested-cards",
  "icon-tile-stack",
  "hero-eyebrow-chip",
  "gpt-thin-border-wide-shadow",
];

/** Representative pages, not the whole site (AC2). */
export const PAGES = [
  "/",
  "/pricing",
  "/how-it-works",
  "/for-resellers",
  "/flipdesk",
  "/grading-standard",
  "/faq",
  "/verify",
  "/about",
];

/**
 * Permitted (page, rule) pairs, each with a reason.
 *
 * EMPTY ON PURPOSE, and it should stay that way. Production carries findings on
 * five of the nine pages above, and the right answer to those is to flatten the
 * markup rather than write them down as accepted. An entry here asserts that a
 * banned tell is CORRECT on that page, which is a bar the craft floor rarely
 * leaves room for.
 */
export const ALLOWED = {
  // "/pricing::nested-cards": "a reason a human wrote, never a count",
};

export function countByRule(findings) {
  const m = {};
  for (const f of findings) m[f.antipattern] = (m[f.antipattern] ?? 0) + 1;
  return m;
}

/** Findings of enforced rules that no ALLOWED entry names. */
export function unlistedPairs(rows, allowed = ALLOWED) {
  return rows.filter((r) => !(`${r.path}::${r.rule}` in allowed));
}

/**
 * ASYNC, and that is load-bearing rather than tidy.
 *
 * The first cut used execFileSync, which blocks the event loop of the very
 * process hosting the fixture server below - so Puppeteer sat waiting on a
 * server that could not answer until Puppeteer finished, and the self-check
 * reported all four rules as no longer firing. It failed LOUDLY, which is what
 * saved it: a check designed to go quiet would have called that a clean page.
 */
async function scan(url) {
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["impeccable", "detect", url, "--json"],
      { cwd: ROOT, encoding: "utf8", timeout: 240000, maxBuffer: 32 * 1024 * 1024, shell: process.platform === "win32" },
    );
    return JSON.parse(stdout);
  } catch (err) {
    // Exit code 2 means "findings", which is the normal case here, not a failure.
    if (err && typeof err.stdout === "string" && err.stdout.trim().startsWith("[")) {
      return JSON.parse(err.stdout);
    }
    throw new Error(`scan of ${url} failed: ${err && err.message}`);
  }
}

/**
 * Prove every enforced rule still fires before trusting a quiet run.
 *
 * Same contract as check-ui-antipatterns.mjs selfCheck: a rule that stops firing
 * must fail loudly, because "no findings" and "no working rule" are the same
 * output. Serves the fixture on a throwaway port, so this needs no dev server
 * and no network.
 */
async function selfCheck() {
  const html = readFileSync(FIXTURE);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const found = countByRule(await scan(`http://127.0.0.1:${port}/`));
    const silent = ENFORCED_BROWSER_RULES.filter((r) => !found[r]);
    if (silent.length) {
      console.error(
        "\n[ui-browser] SELF-CHECK FAILED - these rules no longer fire on the " +
          "fixture that exists to trip them:\n\n" +
          silent.map((r) => `    ${r}`).join("\n") +
          "\n\n  Renamed, removed or broken. Until that is resolved, a clean run" +
          "\n  below means nothing - it is indistinguishable from the rule being" +
          "\n  absent. Fixture: scripts/fixtures/ui-browser/index.html\n",
      );
      process.exit(1);
    }
    console.log(
      `[ui-browser] self-check OK - all ${ENFORCED_BROWSER_RULES.length} rules ` +
        `fire on the fixture ${JSON.stringify(found)}`,
    );
  } finally {
    server.close();
  }
}

async function main() {
  const enforce = process.argv.includes("--enforce");
  const base = process.env.BASE_URL ?? "https://gradethread.com";

  await selfCheck();
  console.log(`\n[ui-browser] scanning ${PAGES.length} page(s) at ${base}\n`);

  const rows = [];
  for (const path of PAGES) {
    const found = countByRule(await scan(base + path));
    const mine = ENFORCED_BROWSER_RULES.filter((r) => found[r]);
    for (const rule of mine) rows.push({ path, rule, count: found[rule] });
    console.log(
      `  ${path.padEnd(18)} ` +
        (mine.length ? mine.map((r) => `${r} x${found[r]}`).join(", ") : "clean"),
    );
  }

  const unlisted = unlistedPairs(rows);
  const total = unlisted.reduce((n, r) => n + r.count, 0);

  if (!unlisted.length) {
    console.log("\n[ui-browser] OK - no un-allowlisted browser-scoped tells.");
    return;
  }

  console.log(
    `\n[ui-browser] ${total} finding(s) across ${unlisted.length} (page, rule) pair(s):\n` +
      unlisted.map((r) => `    ${r.path}  ${r.rule}  x${r.count}`).join("\n") +
      "\n\n  Flatten the markup, or add the pair to ALLOWED with a written reason." +
      "\n  The counts are NOT pinned - see the header on why this tool cannot" +
      "\n  identify individual findings.\n",
  );
  if (enforce) process.exit(1);
  console.log("  Reporting only (no --enforce). US-2833 AC1 is undecided.");
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) await main();

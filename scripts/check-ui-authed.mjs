#!/usr/bin/env node
// US-3013: the browser-scoped UI rules, pointed at screens behind a login.
//
// scripts/check-ui-browser.mjs scans nine PUBLIC marketing URLs. Four
// craft-floor tells need a laid-out DOM - nested-cards, icon-tile-stack,
// hero-eyebrow-chip and gpt-thin-border-wide-shadow - so nothing has ever
// checked them on the dashboard, which is most of the product.
//
// TWO THINGS SANK THE FIRST ATTEMPT (US-2999), and both are fixed here rather
// than worked around.
//
//  1. THE STYLESHEET IS SCANNED, NOT ONLY THE COMPUTED STYLES. Measured
//     2026-08-30: a page whose whole body is `<h1>Hello</h1>`, with the app's
//     built CSS inlined, reports gradient-text, bounce-easing and dark-glow -
//     three findings from utility DEFINITIONS the page never uses. So the CSS
//     handed to the scanner is narrowed to the rules the page's own classes
//     can reach (scripts/lib/narrow-css.mjs). The same page then reports
//     nothing at all, which is AC3.
//
//  2. A PAGE BUILT FROM THE APP COMPONENTS REPORTED ZERO. It was unstyled:
//     `vite.transformRequest("/src/index.css")` returns the HMR JavaScript that
//     injects the css, not the css. This script reads the BUILT stylesheet out
//     of dist/ instead, so there is no transform to get wrong - and it refuses
//     to run without one rather than scanning an unstyled page and calling it
//     clean.
//
// THE SELF-CHECK IS THE CONTRACT. A fixture built from the real Card
// component's own className must raise nested-cards before any clean result is
// believed. That is the requirement US-2999 could not meet.
//
// ONE URL PER INVOCATION, inherited from check-ui-browser.mjs and not a style
// choice: batching URLs into one `impeccable detect` call silently
// under-reports (measured 2026-08-23, /pricing 26 findings alone versus 2 in a
// five-URL call, with no error and no warning).
//
// Usage:
//   node scripts/check-ui-authed.mjs            # every screen, report only
//   node scripts/check-ui-authed.mjs money      # one screen
//
// REPORT-ONLY, deliberately (AC5). The enforce flag and the CI wiring wait for
// a baseline that does not exist yet, and adding them now would either pin
// numbers nobody has read or pass vacuously.

import { createServer as createHttpServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer as createViteServer, loadEnv } from "vite";

import { narrowCss, classesIn } from "./lib/narrow-css.mjs";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Below this, a render is treated as failed rather than clean.
 *
 * Measured 2026-08-30: Money overview 53 elements, Expenses 140. So 40 is a
 * floor rather than a target, and it exists because "the page rendered nothing"
 * and "the page is clean" are the same output from a scanner.
 */
export const MIN_ELEMENTS = 40;

/** The four rules a source scan cannot decide. Same list as check-ui-browser. */
export const BROWSER_RULES = [
  "nested-cards",
  "icon-tile-stack",
  "hero-eyebrow-chip",
  "gpt-thin-border-wide-shadow",
];

/**
 * The real Card component's className, copied from src/components/ui/card.tsx.
 *
 * A COPY, and the drift is checked: [assertCardClassesCurrent] reads the
 * component and fails if these classes are no longer what it emits. Importing
 * the component instead would mean rendering React inside the self-check, which
 * puts the thing being verified and the thing verifying it in the same bundle.
 */
const CARD_CLASSES =
  "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm";

function assertCardClassesCurrent() {
  const src = readFileSync(join(ROOT, "src/components/ui/card.tsx"), "utf8");
  const missing = CARD_CLASSES.split(" ").filter((c) => !src.includes(c));
  if (missing.length) {
    console.error(
      "\n[ui-authed] SELF-CHECK FAILED - the Card component no longer emits:\n\n" +
        missing.map((c) => `    ${c}`).join("\n") +
        "\n\n  The fixture below is meant to be a real card. If it is not, a clean" +
        "\n  run means nothing. Update CARD_CLASSES from src/components/ui/card.tsx.\n",
    );
    process.exit(1);
  }
}

/** The built stylesheet, which is the only one that is real CSS. */
function builtCss() {
  const dir = join(ROOT, "dist", "assets");
  if (!existsSync(dir)) {
    console.error(
      "\n[ui-authed] no dist/assets - run `npm run build` first.\n\n" +
        "  Refusing to scan rather than falling back to the dev server's CSS:\n" +
        "  vite.transformRequest('/src/index.css') returns the HMR JavaScript\n" +
        "  that injects the stylesheet, not the stylesheet. A page rendered with\n" +
        "  that is UNSTYLED, and an unstyled page reports every rule clean.\n",
    );
    process.exit(1);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
  if (!files.length) {
    console.error(
      "\n[ui-authed] dist/assets has no .css - the build is incomplete.\n",
    );
    process.exit(1);
  }
  return files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

/** A full document: the body's own classes, and only the CSS they reach. */
export function pageFor(body, css, title) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title}</title><style>${narrowCss(css, classesIn(body))}</style>` +
    `</head><body><div id="root">${body}</div></body></html>`
  );
}

/** Serve one document on a throwaway port and hand back its URL. */
async function serve(html) {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => server.close(),
  };
}

/**
 * ASYNC, and load-bearing rather than tidy.
 *
 * execFileSync would block the event loop of the very process hosting the
 * server above, so the browser would wait on a server that cannot answer until
 * the browser finishes. check-ui-browser.mjs hit exactly this and reported
 * every rule as no longer firing.
 */
async function scan(url) {
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["impeccable", "detect", url, "--json"],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 240000,
        maxBuffer: 32 * 1024 * 1024,
        shell: process.platform === "win32",
      },
    );
    return JSON.parse(stdout);
  } catch (err) {
    // Exit code 2 means "findings", which is the normal case, not a failure.
    if (
      err &&
      typeof err.stdout === "string" &&
      err.stdout.trim().startsWith("[")
    ) {
      return JSON.parse(err.stdout);
    }
    throw new Error(`scan of ${url} failed: ${err && err.message}`);
  }
}

export function countByRule(findings) {
  const m = {};
  for (const f of findings) m[f.antipattern] = (m[f.antipattern] ?? 0) + 1;
  return m;
}

/** A card inside a card, from the real component's own classes. */
export function nestedCardFixture() {
  const card = `data-slot="card" class="${CARD_CLASSES}"`;
  return (
    `<main class="p-8 flex flex-col gap-6"><div ${card}>` +
    `<div class="px-6"><div class="leading-none font-semibold">Outer</div></div>` +
    `<div class="px-6"><div ${card}>` +
    `<div class="px-6"><div class="leading-none font-semibold">Inner</div></div>` +
    `<div class="px-6"><p>A card inside a card.</p></div>` +
    `</div></div></div></main>`
  );
}

/**
 * Refuse a clean run unless the fixture that exists to trip nested-cards
 * trips it.
 *
 * This is AC2, and it is the whole reason the first attempt was deleted rather
 * than shipped: a harness that renders an unstyled page reports nothing, which
 * is the same output as a harness that works on a clean codebase.
 */
async function selfCheck(css) {
  assertCardClassesCurrent();
  const html = pageFor(nestedCardFixture(), css, "self-check");
  const { url, close } = await serve(html);
  try {
    const found = countByRule(await scan(url));
    if (!found["nested-cards"]) {
      console.error(
        "\n[ui-authed] SELF-CHECK FAILED - a card inside a card, built from the\n" +
          "  real Card component's own classes, did not raise nested-cards.\n\n" +
          `  Got: ${JSON.stringify(found)}\n\n` +
          "  Either the rule stopped firing, or the page is not being styled -\n" +
          "  and an unstyled page reports every rule clean, which is why this\n" +
          "  check exists at all. Nothing below can be believed until it passes.\n",
      );
      process.exit(1);
    }
    console.log(
      `[ui-authed] self-check OK - nested-cards fires on the real Card fixture ` +
        `${JSON.stringify(found)}`,
    );
  } finally {
    close();
  }
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const css = builtCss();

  await selfCheck(css);

  // src/lib/supabase.ts THROWS AT IMPORT without these, and every Money view
  // reaches it through @/lib/ledger. Real values when .env has them, obvious
  // placeholders otherwise: this harness renders to a string and never opens a
  // socket, so the only thing the client has to do is construct.
  const env = loadEnv("production", ROOT, "VITE_");
  for (const [k, v] of Object.entries(env))
    if (process.env[k] === undefined) process.env[k] = v;
  process.env.VITE_SUPABASE_URL ??= "https://ui-harness.invalid";
  process.env.VITE_SUPABASE_ANON_KEY ??= "ui-harness-not-a-key";

  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    // Nothing is served to a browser here, and the discovery pass otherwise
    // walks every extension and dist-ext HTML file in the repo and fails.
    optimizeDeps: { noDiscovery: true, include: [] },
    // The stub is what makes a page render its LOADED branch: renderToString
    // does not await, so the real useQuery would render skeletons and this
    // whole harness would scan a page of grey rectangles.
    resolve: {
      alias: [
        {
          find: /^@tanstack\/react-query$/,
          replacement: join(ROOT, "src/prerender/authed-query-stub.tsx"),
          customResolver(id, importer) {
            // The stub itself re-exports the real package; without this it
            // would resolve to itself and stack-overflow on load.
            if (importer && importer.includes("authed-query-stub")) return null;
            return id;
          },
        },
      ],
    },
  });

  let failures = 0;
  try {
    const { SCREENS, renderScreen } = await vite.ssrLoadModule(
      "/src/prerender/entry-authed.tsx",
    );
    const screens = only.length
      ? SCREENS.filter((s) => only.includes(s.key))
      : SCREENS;
    if (!screens.length) {
      console.error(
        `\n[ui-authed] no screen matches ${JSON.stringify(only)}. Known: ` +
          SCREENS.map((s) => s.key).join(", ") +
          "\n",
      );
      process.exit(1);
    }

    console.log(`\n[ui-authed] scanning ${screens.length} authed screen(s)\n`);
    for (const screen of screens) {
      let body;
      try {
        body = renderScreen(screen.key);
      } catch (err) {
        failures += 1;
        console.log(
          `  ${screen.key.padEnd(12)} RENDER FAILED: ${err && err.message}`,
        );
        continue;
      }
      // A SCREEN THAT RENDERED ALMOST NOTHING SCANS CLEAN, which is the exact
      // failure this harness exists to avoid. Loud rather than quiet: an early
      // return in a page, a missing provider swallowed somewhere, or a fixture
      // that no longer matches all end here.
      const elements = (body.match(/<[a-z]/g) ?? []).length;
      if (elements < MIN_ELEMENTS) {
        failures += 1;
        console.log(
          `  ${screen.key.padEnd(12)} TOO SMALL TO SCAN: ${elements} elements ` +
            `(need ${MIN_ELEMENTS}). A near-empty page reports every rule clean.`,
        );
        continue;
      }
      const { url, close } = await serve(pageFor(body, css, screen.key));
      try {
        const found = countByRule(await scan(url));
        const mine = BROWSER_RULES.filter((r) => found[r]);
        const total = Object.values(found).reduce((n, v) => n + v, 0);
        console.log(
          `  ${screen.key.padEnd(12)} ${String(elements).padStart(4)} el  ` +
            (mine.length
              ? mine.map((r) => `${r} x${found[r]}`).join(", ")
              : "clean of the four") +
            `   (${total} finding(s) across all rules)`,
        );
      } finally {
        close();
      }
    }
  } finally {
    await vite.close();
  }

  console.log(
    "\n  Report only (AC5). No enforce flag and no CI wiring until the baseline\n" +
      "  above has been read by a human and the markup flattened where it should be.\n",
  );
  if (failures) process.exit(1);
}

const invoked =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) await main();

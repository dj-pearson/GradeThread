// US-2038 AC3: a dist-gated suite must not SILENTLY skip in CI.
//
// Suites that gate on `dist/index.html` skip when it is absent. `dist/` is
// gitignored, so on a fresh runner it did not exist when tests ran — and CI used
// to order Test BEFORE Build. Those SEO/hydration-parity guards therefore NEVER
// fired in CI, once, since they were written, while the workflow reported green.
//
// ⚠ HEADCOUNT CORRECTED 2026-08-16 (US-2637). This header said "three suites …
// prerender.test.ts (10 tests), crawl-parity.test.ts (1) and
// responsive-images.test.ts (26)", i.e. 37. Two of those files no longer exist,
// and `requireDist` has exactly ONE caller today with ONE test behind it. The
// reasoning below is unchanged and still right; the number was doing rhetorical
// work it had stopped earning, and a stale figure in the file whose job is to
// stop silent skips is the wrong place to leave one.
//
// CI now builds first, so they do run. But that fix is a STEP ORDER in a YAML
// file — one reorder, one build that stops emitting index.html, and all 37 go
// back to skipping silently with nothing to show for it. A skip and a pass look
// identical in the summary; that is the whole failure mode.
//
// So: locally, skipping is right (you have not necessarily built). In CI it is a
// HARD FAILURE. This mirrors the pattern the repo already uses for
// tenant-isolation_test.ts, which refuses to skip when TENANT_ISOLATION_REQUIRED=1.
//
// Escape hatch: DIST_TESTS_REQUIRED=0 forces the local behaviour, for a CI job
// that legitimately does not build (a lint-only lane). Deliberately opt-OUT,
// not opt-in — the default has to be the safe one, because the failure this
// guards against is precisely someone not thinking about it.

import { existsSync, readFileSync } from "node:fs";

/**
 * The marker `index.html` carries until the prerender replaces it with the SSR
 * body. Its presence in a BUILT file means `vite build` finished and
 * `node scripts/prerender.mjs` did not.
 */
const UNPRERENDERED_MARKER = "<!--prerender:body-->";

/** True when we are somewhere a missing dist/ should FAIL rather than skip. */
export function distIsRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = (env.DIST_TESTS_REQUIRED ?? "").trim();
  if (explicit === "0" || explicit.toLowerCase() === "false") return false;
  if (explicit === "1" || explicit.toLowerCase() === "true") return true;
  // GitHub Actions and most CI providers set CI=true.
  return (env.CI ?? "").trim().toLowerCase() === "true" || env.CI === "1";
}

/**
 * Decide whether a dist-gated suite should run, and blow up rather than skip
 * when the build output is missing somewhere it was supposed to exist.
 *
 * Throws at MODULE LOAD (not inside a test) on purpose: a thrown suite is a
 * loud red file in the report, whereas a failing test inside a suite that
 * "ran 0 tests" is easy to scroll past.
 */
export function requireDist(indexHtmlPath: string, suiteName: string): boolean {
  const present = existsSync(indexHtmlPath);
  if (present && !isHalfBuilt(indexHtmlPath)) return true;

  if (distIsRequired()) {
    throw new Error(
      present
        ? halfBuiltMessage(indexHtmlPath, suiteName)
        : `[US-2038] ${suiteName} needs build output that is not there: ${indexHtmlPath}\n` +
          `CI must run \`npm run build\` BEFORE the vitest step, or this suite skips ` +
          `silently and its guards never fire — which is exactly how 37 SEO/hydration ` +
          `tests went unrun since they were written.\n` +
          `If this lane genuinely does not build, set DIST_TESTS_REQUIRED=0.`,
    );
  }
  return false;
}

/**
 * US-2637: `vite build` wrote this, `scripts/prerender.mjs` did not.
 *
 * `npm run build` is `tsc -b && vite build && node scripts/prerender.mjs`, so a
 * prerender that errors or is KILLED — the pre-push lane has been killed at the
 * coverage step for memory before — leaves a `dist/` with 688 asset files, a
 * `seo-manifest.json`, and an `index.html` that is still the raw template.
 *
 * That state is worse than no `dist/` at all. `existsSync` says built, so all
 * 37 dist-gated guards RUN, against a document that has none of the content
 * they assert on. They then fail with messages about a missing logo filename or
 * an absent canonical, none of which name the actual problem, and the reader
 * goes looking for a regression in the page. That has cost real time twice.
 */
function isHalfBuilt(indexHtmlPath: string): boolean {
  try {
    return readFileSync(indexHtmlPath, "utf8").includes(UNPRERENDERED_MARKER);
  } catch {
    // Unreadable is not half-built; let the caller's own error surface.
    return false;
  }
}

function halfBuiltMessage(indexHtmlPath: string, suiteName: string): string {
  return (
    `[US-2637] ${suiteName} found a HALF-BUILT dist/: ${indexHtmlPath} still contains ` +
    `${UNPRERENDERED_MARKER}, so \`vite build\` finished and the prerender did not.\n` +
    `Every dist-gated assertion here would fail against the raw template and none of ` +
    `those failures would name this cause.\n` +
    `Re-run \`npm run build\` and check for the "[prerender] wrote N static page(s)" line ` +
    `— a build with no such line did not finish, whatever its exit looked like.`
  );
}

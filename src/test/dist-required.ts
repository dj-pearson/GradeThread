// US-2038 AC3: a dist-gated suite must not SILENTLY skip in CI.
//
// Three suites gate on `existsSync(dist/index.html)` and skip when it is
// absent: prerender.test.ts (10 tests), crawl-parity.test.ts (1) and
// responsive-images.test.ts (26). `dist/` is gitignored, so on a fresh runner
// it did not exist when tests ran — and CI used to order Test BEFORE Build.
// Those 37 SEO/hydration-parity guards therefore NEVER fired in CI, once, since
// they were written, while the workflow reported green.
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

import { existsSync } from "node:fs";

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
  if (present) return true;

  if (distIsRequired()) {
    throw new Error(
      `[US-2038] ${suiteName} needs build output that is not there: ${indexHtmlPath}\n` +
        `CI must run \`npm run build\` BEFORE the vitest step, or this suite skips ` +
        `silently and its guards never fire — which is exactly how 37 SEO/hydration ` +
        `tests went unrun since they were written.\n` +
        `If this lane genuinely does not build, set DIST_TESTS_REQUIRED=0.`,
    );
  }
  return false;
}

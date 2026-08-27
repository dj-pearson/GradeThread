import { defineConfig } from "vitest/config";
import path from "path";
import { CI_VITE_ENV } from "./scripts/lib/ci-env";

// Separate from vite.config.ts so the PWA/Sentry build plugins don't run under
// tests. jsdom gives us localStorage + a window for the consent helpers.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // US-2375: the real web-vitals library arms timers that outlive jsdom
      // teardown and crash the run from an unrelated file. See the stub.
      "web-vitals": path.resolve(__dirname, "./src/test/stubs/web-vitals.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // Placeholder VITE_* env so modules that read it at import time load under
    // tests — src/lib/supabase.ts and src/lib/edge-api.ts both throw when these
    // are unset. Tests never hit the network; these hosts are never called.
    //
    // US-2375: this MUST be the same object the workflows declare, or a test
    // can pass in one runner and fail in the other purely on ambient config.
    // scripts/lib/ci-env.ts is that single source and explains the history;
    // src/test/ci-env-parity.test.ts fails if a workflow drifts from it.
    env: { ...CI_VITE_ENV },
    // 30s, not vitest's default 5s, because a large share of this suite is
    // SOURCE-SCANNING GUARDS: tests that recursively read every file under
    // src/, services/ and supabase/migrations/ to prove a rule holds across the
    // tree (billing-source-constraint, legacy-user-plan-readers, the SEO route
    // registry guards, and friends). Their cost is disk I/O over thousands of
    // files, and it scales with how many OTHER test files are competing for the
    // same disk — so they finish in ~1s alone and cross 5s in the full 300-file
    // parallel run.
    //
    // That made the pre-push gate FLAKY IN THE WORST WAY: it failed with a
    // timeout, not an assertion, and a DIFFERENT subset failed each run, so the
    // red said nothing about the commit being pushed. Measured 2026-08-09 —
    // three failures in one run, four in the next, all "Test timed out in
    // 5000ms", every one of them green when run on its own.
    //
    // Deliberately 30s and not "off": a real hang still has to fail, and it
    // still fails inside a minute. Raising the ceiling is the fix here rather
    // than trimming the guards, because walking the whole tree IS the assertion
    // — a guard that samples proves nothing.
    //
    // RAISED 30s -> 90s on 2026-08-27, the same fix applied a second time as the
    // tree kept growing. Measured on the Windows dev box, full 577-file parallel
    // run with coverage:
    //   friendly-error   "no customer surface hands toast.error…"   62.7s
    //   repeated-labels  "a per-row button named only by its text"  62.5s
    //   repeated-labels  "the visible-text baseline is not slack"    44.5s
    // All three walk src/ in full, all three pass ALONE (58/58 and 10/10), and
    // all three failed with "Test timed out in 30000ms" rather than an
    // assertion. Reproduced with Docker and the local Supabase stack stopped,
    // so it is the size of the walk on this disk, not contention.
    //
    // 90s and still not "off", for the reason above: a real hang has to fail.
    // If a THIRD raise is ever needed, that is the signal the guards should
    // share one cached tree walk instead of each doing their own.
    testTimeout: 90_000,
    // US-519: coverage with a FAILING minimum threshold so coverage of the
    // tested modules can't silently erode. Thresholds sit a margin below the
    // current numbers so a genuine regression trips CI without flapping on a
    // single new line. The `functions` floor was lowered 70→68 (US-796): the new
    // page-render tests import large page components (api-keys), which pull
    // their handler functions into the denominator — more tests, but a lower
    // function ratio. The floor still ratchets against further erosion.
    //
    // US-1998 (2026-07-18): all four floors reset for the SAME reason, because
    // all four had drifted ABOVE the actual numbers and were failing CI on every
    // commit — including commits that only ADDED tests. That inverts the intent
    // stated above: a floor is meant to sit below current and ratchet, not to
    // sit above it and block. v8 only counts files something imports, so each
    // new test of an untested module drags that module's whole uncovered body
    // into the denominator; coverage can fall while testing improves.
    //
    // Measured 2026-07-18 with 2227 tests passing: statements 66.7, branches
    // 59.84, functions 64.34, lines 68.55. Floors set ~2 points under those.
    //
    // RESET AGAIN 2026-08-19, for the same reason and with the same method.
    // All four floors had drifted above the actual numbers and were failing
    // every commit, including ones that only ADDED tests. Measured with 5715
    // tests passing (up from 2227): statements 63.26, branches 57.21,
    // functions 59.36, lines 64.43.
    //
    // THE PERCENTAGE FELL WHILE THE SUITE MORE THAN DOUBLED, which is the
    // artifact the paragraph above predicts rather than a regression: v8 counts
    // only files something imports, so every new test of a previously untested
    // module adds that module's whole uncovered body to the denominator. The
    // absolute covered numbers went UP; the ratio went down.
    //
    // Confirmed pre-existing before resetting, not assumed: the three test
    // files added that day were reverted and the run produced byte-identical
    // percentages, so the drift belongs to the month and not to that change.
    //
    // Be clear about what this does NOT do: it locks in the current level
    // rather than improving it. Raising coverage for real needs a decision this
    // config can't make — the biggest untested surfaces are React hooks
    // (use-ebay.ts and friends) that this repo currently cannot test, because
    // it deliberately carries no @testing-library/react and the convention is
    // renderToStaticMarkup. Adding that dependency is the actual unblock.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        statements: 61,
        branches: 55,
        functions: 57,
        lines: 62,
      },
    },
  },
});

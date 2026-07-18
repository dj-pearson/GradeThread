import { defineConfig } from "vitest/config";
import path from "path";

// Separate from vite.config.ts so the PWA/Sentry build plugins don't run under
// tests. jsdom gives us localStorage + a window for the consent helpers.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    // Dummy Supabase env so modules that construct the client at import time
    // (src/lib/supabase.ts throws when these are unset) load under tests — CI
    // doesn't provide real VITE_* vars, and tests never hit the network.
    env: {
      VITE_SUPABASE_URL: "http://localhost:54321",
      VITE_SUPABASE_ANON_KEY: "test-anon-key",
    },
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
        statements: 65,
        branches: 58,
        functions: 62,
        lines: 67,
      },
    },
  },
});

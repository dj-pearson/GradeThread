// US-1612: an ISOLATED vitest project for the host-side Ralph Governor scripts
// (scripts/*.test.mjs). Kept separate from vitest.config.ts so these Node ESM
// scripts run in a node environment (no jsdom, no @ alias, no Supabase env) and
// do NOT enter the web coverage thresholds.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/**/*.test.mjs"],
    globals: true,
    // Several of these tests WALK THE REPO — every .ts under the edge, every
    // migration, every workflow file — and on Windows with 611 migrations that
    // lands at 5-6s against vitest's 5s default. Three of them were passing at
    // 4.9s and failing at 5.3s depending on nothing but the filesystem cache,
    // which is a gate reporting the weather. 30s still catches a genuine hang;
    // it just stops calling a slow directory walk a failure.
    testTimeout: 30_000,
  },
});

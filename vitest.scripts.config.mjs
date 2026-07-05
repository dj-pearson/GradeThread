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
  },
});

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
    // US-519: coverage with a FAILING minimum threshold so coverage of the
    // tested modules can't silently erode. Thresholds sit a margin below the
    // current numbers (stmts 81.7 / branches 74.2 / funcs 80 / lines 83.7) so a
    // genuine regression trips CI without flapping on a single new line.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        statements: 72,
        branches: 65,
        functions: 70,
        lines: 72,
      },
    },
  },
});

// US-2375: `npm run verify` must agree with GitHub Actions on the same commit.
//
// The defect this guards was invisible in both directions. CI declared three
// VITE_* values in a workflow-level `env:` block; vitest.config.ts injected two
// different ones. Under the local values src/lib/edge-api.ts could not resolve
// an edge host, so two affiliate-attribution assertions failed locally and
// passed in CI on the identical commit. Nothing was wrong with the product
// code — the harness disagreed with itself, and the developer-visible symptom
// was a red suite on a clean commit.
//
// The fix is a single source (scripts/lib/ci-env.ts). This file is the part
// that keeps it single: a workflow editor who adds, renames or re-values one of
// these lines without touching the shared object fails here, in the same run
// that would otherwise have introduced the drift.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CI_VITE_ENV, CI_ENV_WORKFLOWS } from "../../scripts/lib/ci-env";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Pull the top-level `env:` mapping out of a workflow file.
 *
 * Deliberately a small parser rather than a YAML dependency: the block is three
 * flat `KEY: value` lines at column 2, and the repo carries no YAML parser. It
 * reads only the FIRST top-level `env:` (the workflow-level one) and stops at
 * the next unindented key, so a job-level `env:` further down can't be mistaken
 * for it.
 */
function workflowEnv(source: string): Record<string, string> {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => l === "env:");
  if (start === -1) return {};
  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) break; // back at column 0 — the block ended
    const match = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    out[match[1] as string] = (match[2] as string).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

describe("the shared CI/local VITE_* env", () => {
  it.each(CI_ENV_WORKFLOWS)("%s declares exactly the shared values", (path) => {
    // Exact equality both ways: an EXTRA key in the workflow is drift too,
    // because local verify would then be missing config CI has.
    expect(workflowEnv(read(path))).toEqual({ ...CI_VITE_ENV });
  });

  it("is what vitest injects, so local test runs match the workflows", () => {
    // Asserted through import.meta.env rather than by re-reading the config, so
    // this fails if the values are ever overridden downstream of the config too.
    expect(import.meta.env.VITE_SUPABASE_URL).toBe(CI_VITE_ENV.VITE_SUPABASE_URL);
    expect(import.meta.env.VITE_SUPABASE_ANON_KEY).toBe(CI_VITE_ENV.VITE_SUPABASE_ANON_KEY);
    expect(import.meta.env.VITE_EDGE_API_URL).toBe(CI_VITE_ENV.VITE_EDGE_API_URL);
  });

  it("carries a Supabase URL the edge-api derivation accepts", () => {
    // The original break was exactly this property failing: edge-api.ts derives
    // `functions.*` from an `api.*` Supabase host, and `localhost` is neither.
    // Asserting the property (not the string) means a future host change that
    // keeps parity but breaks derivation still fails here.
    expect(new URL(CI_VITE_ENV.VITE_SUPABASE_URL).hostname.startsWith("api.")).toBe(true);
  });

  it("holds no value that looks like a real secret", () => {
    // These are committed placeholders. A real anon key is a long JWT; keeping
    // that shape out of this file is the cheap half of the gitleaks guard.
    for (const value of Object.values(CI_VITE_ENV)) {
      expect(value).not.toMatch(/^eyJ/); // JWT
      expect(value.length).toBeLessThan(120);
    }
  });
});

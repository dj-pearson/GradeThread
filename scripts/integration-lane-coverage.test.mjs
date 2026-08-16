// Every fixture-gated edge test must be claimed by a lane that provides the
// fixture. Otherwise it is a guard that cannot fail.
//
// FOUND 2026-08-16 by running the CI-only lanes locally for the first time.
// `src/tests/ledger-append-only_test.ts` was named in NO workflow. Its seven
// source-scanning cases run everywhere and pass; its ONE integration case —
// "service_role cannot UPDATE or DELETE a ledger row" — carries `ignore: !RUN`
// and so was skipped in every run that has ever happened. That case is the
// entire proof of the 00597 append-only trigger: that the credit ledger cannot
// be rewritten even by the service role, which is the control standing between
// a bug and silently edited money.
//
// It passed the moment it was given a fixture, so nothing was broken. What was
// broken is that nobody would have found out.
//
// WHY THIS IS A SEPARATE CHECK RATHER THAN A COMMENT IN THE WORKFLOW: a new
// integration test is added by copying an existing one, which copies the
// `ignore: !RUN` line and not the workflow entry. The failure is silent by
// construction, it looks like a passing suite, and the file this catches sat
// that way long enough for the guard it protects to be built, shipped and
// documented.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TESTS = join(ROOT, "services/edge-functions/src/tests");
const WORKFLOWS = join(ROOT, ".github/workflows");

/**
 * Edge test files with at least one case gated on a fixture.
 *
 * `ignore: !RUN` is the money-lane idiom and `!CONFIGURED` / `!BASE` the
 * tenant-isolation one. Both mean the same thing: without seeded env this case
 * does not execute.
 */
function fixtureGatedFiles() {
  return readdirSync(TESTS)
    .filter((f) => f.endsWith("_test.ts"))
    .filter((f) => {
      const src = readFileSync(join(TESTS, f), "utf8");
      return /ignore:\s*!(RUN|CONFIGURED|BASE|REQUIRED|VIEWER_READY)\b/.test(src);
    })
    .sort();
}

/** Every workflow file's text, so "is this file named anywhere" is one search. */
function workflowText() {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readFileSync(join(WORKFLOWS, f), "utf8"))
    .join("\n");
}

describe("no fixture-gated edge test is orphaned", () => {
  it("every gated file is named in a workflow that runs it", () => {
    const yaml = workflowText();
    const orphans = fixtureGatedFiles().filter((f) => !yaml.includes(f));

    expect(
      orphans,
      "These edge tests skip without a seeded fixture and NO workflow names " +
        "them, so their gated cases have never executed:\n" +
        orphans.map((f) => `  src/tests/${f}`).join("\n") +
        "\n\nAdd the file to the `deno test` list in " +
        ".github/workflows/money-cert-integration.yml (or tenant-isolation.yml " +
        "if it needs the two-tenant fixture). Do NOT remove the gate to make " +
        "this pass — an integration test that runs without its fixture is " +
        "asserting against an empty database.",
    ).toEqual([]);
  });

  it("finds the gated files at all", () => {
    // Both assertions pass if the detector matches nothing. Pin the count and
    // two known members so a regex that stops working is visible.
    const gated = fixtureGatedFiles();
    expect(gated.length).toBeGreaterThanOrEqual(7);
    expect(gated).toContain("tenant-isolation_test.ts");
    expect(gated).toContain("ledger-append-only_test.ts");
  });

  it("the ledger append-only case is the one this was written for", () => {
    // Named explicitly. The general check above passes the moment the file is
    // listed anywhere; this says WHICH assertion the listing exists to run, so
    // deleting the case and keeping the file entry does not read as fine.
    const src = readFileSync(join(TESTS, "ledger-append-only_test.ts"), "utf8");
    expect(src).toMatch(/service_role cannot UPDATE or DELETE a ledger row/);
    expect(readFileSync(join(WORKFLOWS, "money-cert-integration.yml"), "utf8"))
      .toContain("src/tests/ledger-append-only_test.ts");
  });
});

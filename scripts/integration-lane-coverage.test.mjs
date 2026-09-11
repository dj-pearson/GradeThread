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
 *
 * US-3368: this used to match a NAMED LIST of gate variables (RUN, CONFIGURED,
 * BASE, REQUIRED, VIEWER_READY), and `body-check-denies-anon_test.ts` gates on
 * `!READY`, which is in none of them. That file happens to be wired into
 * tenant-isolation.yml, so nothing was orphaned by it, but a detector that
 * matches an allowlist of identifiers fails in the direction that looks clean:
 * a new suite picking any other variable name is simply absent from the
 * findings. The gate is the SHAPE `ignore: !SOMETHING`, so match the shape.
 */
function fixtureGatedFiles() {
  return readdirSync(TESTS)
    .filter((f) => f.endsWith("_test.ts"))
    .filter((f) => {
      const src = readFileSync(join(TESTS, f), "utf8");
      return /ignore:\s*!\s*[A-Z][A-Z0-9_]*\b/.test(src);
    })
    .sort();
}

/**
 * Every workflow file's text, so "is this file named anywhere" is one search.
 *
 * US-3368: COMMENT LINES ARE DROPPED. Every workflow in this repo explains
 * itself at length and several name test files in prose, so `yaml.includes(f)`
 * could be satisfied by a note ABOUT a file rather than a step that runs it,
 * and a comment saying a suite ought to be wired up is the exact artefact a
 * half-finished wiring leaves behind.
 */
function workflowText() {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => readFileSync(join(WORKFLOWS, f), "utf8"))
    .join("\n")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
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
    //
    // US-3368: floor raised 7 -> 13, measured on 2026-09-11. Thirteen edge test
    // files carry at least one `ignore: !VAR` case; eight of them go through
    // requireIntegrationFixtures and the rest gate by hand.
    const gated = fixtureGatedFiles();
    expect(gated.length).toBeGreaterThanOrEqual(13);
    expect(gated).toContain("tenant-isolation_test.ts");
    expect(gated).toContain("ledger-append-only_test.ts");
    // The two the allowlist regex used to miss, and the one it did miss.
    expect(gated).toContain("sync-review-lands_test.ts");
    expect(gated).toContain("grade-outcome-lands_test.ts");
    expect(gated).toContain("body-check-denies-anon_test.ts");
  });

  it("a comment naming a file does not count as running it", () => {
    // The self-check for the comment-stripping above. Without it, a change that
    // reverted workflowText() to raw text would leave every assertion in this
    // file passing, which is the failure mode the file exists to describe.
    const named = "grade-outcome-lands_test.ts";
    const raw = readdirSync(WORKFLOWS)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => readFileSync(join(WORKFLOWS, f), "utf8"))
      .join("\n");
    const commentOnly = raw.replace(
      new RegExp(`^(?![ \\t]*#).*${named.replace(/\./g, "\\.")}.*$`, "gm"),
      "          # $&",
    );
    expect(commentOnly).toContain(named);
    const stripped = commentOnly
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(stripped).not.toContain(named);
  });

  it("the two write-lands suites are run by the money/cert lane", () => {
    // US-3368. Named explicitly for the same reason the ledger case below is:
    // the general check above goes green the moment a filename appears
    // anywhere, and that is not the claim. These two are the ONLY proof that
    // their writes reach a real Postgres, and both were orphaned from the day
    // they were written until this check was read.
    const wf = readFileSync(join(WORKFLOWS, "money-cert-integration.yml"), "utf8");
    expect(wf).toContain("src/tests/sync-review-lands_test.ts");
    expect(wf).toContain("src/tests/grade-outcome-lands_test.ts");
    // sync-review-lands asserts against a user who owns a listing. The sweep
    // seed is the only fixture in this lane that creates one, so the step must
    // hand its id over; without this the suite loads, throws on the missing
    // var and reads as a broken lane rather than a missing fixture.
    expect(wf).toContain("TEST_SYNC_REVIEW_USER_ID: ${{ env.TEST_SWEEP_USER_ID }}");
    expect(wf).toContain('INTEGRATION_TESTS_REQUIRED: "1"');
  });

  it("a skipped suite announces itself where CI shows results", () => {
    // US-3368 AC3. `ok | 0 passed | 0 failed | 3 ignored` is what a suite that
    // did nothing wrong looks like, so a skip has to reach the Annotations
    // panel and not only the log body. A console.warn does not.
    const src = readFileSync(
      join(ROOT, "services/edge-functions/src/tests/integration-required.ts"),
      "utf8",
    );
    expect(src).toContain("::warning title=Integration suite skipped::");
    expect(src).toContain("GITHUB_ACTIONS");
    // The annotation must name the suite, or it says only that SOMETHING was
    // skipped, which is not actionable and reads as noise until it is ignored.
    expect(src).toMatch(/::warning title=Integration suite skipped::\$\{suite\}/);
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

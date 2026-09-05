// The pre-push hook must not be HARDER to pass than the merge gate.
//
// THE INCIDENT THIS EXISTS FOR (2026-09-04). `scripts/verify.mjs` — which is the
// pre-push hook — blocked on `npm audit --audit-level=high` over the WHOLE
// dependency tree. `.github/workflows/security.yml` blocks on
// `scripts/audit-gate.mjs` instead (production deps, `--omit=dev`, with dated
// per-advisory acceptances) and runs the full-tree audit with `|| true`,
// deliberately non-blocking, because a dev-only CVE in build tooling would
// otherwise force a breaking major on something nobody ships.
//
// So a push was refused for two high advisories — browserslist, reached through
// @vitejs/plugin-react and the shadcn CLI, and fast-uri, reached through the
// Claude agent SDK — while CI's Security lane was GREEN on the same commit.
// Neither package reaches a user. The commit being blocked was a one-line
// documentation fix for a different red CI gate.
//
// This is the mirror image of [[ci-parity-vault-lint]] and the more insidious
// direction. A local command WEAKER than CI manufactures confidence. A local
// command STRICTER than CI manufactures `--no-verify`: the block is not
// actionable (you cannot upgrade a transitive dev dep on demand), so the habit
// it teaches is to bypass the hook, and the hook stops protecting anything.
//
// The rule: for any check that gates both, the local gate and the CI gate must
// run the SAME command. Report more locally if you like — `advisory()` exists
// for that — but do not block on more.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const VERIFY = read("scripts/verify.mjs");
const SECURITY_YML = read(".github/workflows/security.yml");

/** The blocking gate, named once so a rename fails here rather than silently. */
const GATE = "scripts/audit-gate.mjs";

/**
 * `run(...)` blocks the lane; `advisory(...)` only reports. Pull out which
 * wrapper each npm-audit call in verify.mjs uses.
 *
 * Deliberately matched on the call, not on the whole file: this test's own
 * prose says `npm audit --audit-level=high` several times, and a scan that
 * cannot tell documentation from code reddens on itself (the trap that has hit
 * three guards in this repo already).
 */
function auditCalls(): { wrapper: string; cmd: string }[] {
  const out: { wrapper: string; cmd: string }[] = [];
  const re = /\b(run|advisory)\(\s*"[^"]*npm audit[^"]*"\s*,\s*"([^"]+)"/g;
  for (const m of VERIFY.matchAll(re)) {
    out.push({ wrapper: m[1]!, cmd: m[2]! });
  }
  return out;
}

describe("CI parity: the npm-audit gate", () => {
  it("verify.mjs has npm-audit calls at all", () => {
    // If this ever parses empty, every assertion below passes vacuously.
    expect(auditCalls().length).toBeGreaterThanOrEqual(2);
  });

  it("every BLOCKING audit in verify.mjs is the same gate CI blocks on", () => {
    const blocking = auditCalls().filter((c) => c.wrapper === "run");
    expect(blocking.length).toBeGreaterThan(0);
    for (const c of blocking) {
      expect(
        c.cmd.includes(GATE),
        `verify.mjs blocks the lane on \`${c.cmd}\`, which is not the gate CI ` +
          `blocks on (${GATE}). A pre-push hook stricter than the merge gate ` +
          `is not caught by anything and teaches --no-verify. If you want the ` +
          `wider audit locally, run it through advisory().`,
      ).toBe(true);
    }
  });

  it("the full-tree audit is advisory locally, matching CI's `|| true`", () => {
    const fullTree = auditCalls().filter(
      (c) => c.cmd.includes("npm audit") && !c.cmd.includes(GATE),
    );
    expect(
      fullTree.length,
      "the full-tree audit should still RUN locally — losing the report is not " +
        "the fix for it being too strict",
    ).toBeGreaterThan(0);
    for (const c of fullTree) {
      expect(
        c.wrapper,
        `\`${c.cmd}\` blocks the lane. CI runs the same audit with \`|| true\`; ` +
          `it covers devDependencies, which do not ship.`,
      ).toBe("advisory");
    }
  });

  it("security.yml still blocks on the gate and still tolerates the full tree", () => {
    // The parity is only meaningful while CI is the shape described above. If
    // someone makes CI block on the full tree, this test should be revisited
    // rather than quietly keeping verify.mjs looser.
    expect(SECURITY_YML).toContain(`node ${GATE}`);
    expect(SECURITY_YML).toMatch(/npm audit --audit-level=high \|\| true/);
  });
});

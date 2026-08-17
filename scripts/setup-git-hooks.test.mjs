// The `prepare` script has to run on cmd.exe, because that is what npm uses on
// Windows — and for a long time it did not.
//
// It was `git config core.hooksPath .githooks 2>/dev/null || true`. cmd.exe
// reads `/dev/null` as a path, fails with "The system cannot find the path
// specified", never runs `git config`, and `|| true` returns 0. So `npm install`
// looked fine and left BOTH hooks off: no gitleaks on commit, no verify on push.
// On 2026-08-17 that let a push reach origin/main ungated.
//
// These cases pin the two properties that failure needed: a POSIX-only construct
// in the script, and nothing checking whether it had worked.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

describe("the prepare script configures git hooks on every platform", () => {
  it("uses no shell construct cmd.exe cannot parse", () => {
    const prepare = pkg.scripts?.prepare ?? "";
    // /dev/null is the one that actually bit, but the whole class is unsafe:
    // npm on Windows does not go through a POSIX shell unless script-shell says
    // so, and this repo has no .npmrc.
    for (const bad of ["/dev/null", "2>&1 >", "$(", "`", "&&  true"]) {
      expect(
        prepare.includes(bad),
        `prepare contains ${bad}, which npm runs through cmd.exe on Windows: "${prepare}"`,
      ).toBe(false);
    }
  });

  it("delegates to a node script rather than an inline shell command", () => {
    // Node is the only interpreter guaranteed present when npm runs a lifecycle
    // script, so it is the only portable place to put this logic.
    expect(pkg.scripts?.prepare).toMatch(/^node /);
  });

  it("actually sets core.hooksPath, checked by running it", () => {
    // The property that matters is not the string — it is the effect. The old
    // form passed every source-level reading of "it configures the hooks" and
    // configured nothing.
    execFileSync("node", ["scripts/setup-git-hooks.mjs"], { stdio: "ignore" });
    const configured = execFileSync("git", ["config", "core.hooksPath"], {
      encoding: "utf8",
    }).trim();
    expect(configured).toBe(".githooks");
  });

  it("the hooks it points at exist", () => {
    // A hooksPath aimed at an empty directory is the same silence by a different
    // route: git finds no hook and runs nothing, with no error either way.
    for (const hook of ["pre-commit", "pre-push"]) {
      const body = readFileSync(resolve(process.cwd(), ".githooks", hook), "utf8");
      expect(body.length, `.githooks/${hook} is empty`).toBeGreaterThan(0);
    }
  });
});

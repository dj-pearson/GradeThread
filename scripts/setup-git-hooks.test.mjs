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
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Every file actually sitting in .githooks/, so a new hook is covered on arrival. */
function hooksOnDisk() {
  return readdirSync(resolve(process.cwd(), ".githooks"), { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
}

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
    //
    // Enumerated rather than listed. This case named "pre-commit" and "pre-push"
    // for two months while .githooks/ grew commit-msg and reference-transaction,
    // and a hardcoded pair cannot report a hook it was never told about.
    for (const hook of hooksOnDisk()) {
      const body = readFileSync(resolve(process.cwd(), ".githooks", hook), "utf8");
      expect(body.length, `.githooks/${hook} is empty`).toBeGreaterThan(0);
    }
    expect(hooksOnDisk().length, ".githooks/ is empty").toBeGreaterThan(0);
  });

  it("every hook is executable in the INDEX, not just on this disk", () => {
    // MEASURED 2026-09-18: .githooks/commit-msg was committed 100644 on
    // 2026-09-07 and 536 commits went by without it running once. git says so
    // every single time -- "The '.githooks/commit-msg' hook was ignored because
    // it's not set as executable" -- as a hint line in the commit output, next
    // to the three gitleaks lines nobody reads either.
    //
    // scripts/check-close-claims.mjs, the thing that hook calls, works: run by
    // hand against a subject claiming to close a passes:false story it exits 1
    // with the right message. The guard was never broken. It was never invoked.
    //
    // The INDEX mode is what matters and is the reason this is not a statSync.
    // A fresh clone gets its permissions from git, so a hook that is 100644 in
    // the index is dead for every contributor no matter how the file sits here.
    // chmod +x alone does not fix it; `git update-index --chmod=+x` does.
    const entries = execFileSync("git", ["ls-files", "-s", ".githooks/"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [mode, , , path] = line.split(/\s+/);
        return { mode, path };
      });

    expect(entries.length, "no tracked files under .githooks/").toBeGreaterThan(0);

    const dead = entries.filter((e) => e.mode !== "100755");
    expect(
      dead.map((e) => `${e.path} is ${e.mode}`),
      "a hook that is not 100755 in the index never runs on a fresh clone",
    ).toEqual([]);
  });

  it("no hook is tracked that setup does not point at", () => {
    // The inverse gap: a file sitting in .githooks/ that git will never look for
    // because its name is not a hook name. It reads as a live gate in the tree
    // and is inert, which is the same failure one directory over.
    const GIT_HOOK_NAMES = new Set([
      "applypatch-msg", "pre-applypatch", "post-applypatch",
      "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg",
      "post-commit", "pre-rebase", "post-checkout", "post-merge",
      "pre-push", "pre-receive", "update", "proc-receive", "post-receive",
      "post-update", "reference-transaction", "push-to-checkout",
      "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
      "p4-changelist", "p4-prepare-changelist", "p4-post-changelist",
      "p4-pre-submit", "post-index-change",
    ]);
    const stray = hooksOnDisk().filter((name) => !GIT_HOOK_NAMES.has(name));
    expect(stray, "not a name git ever invokes, so it is decoration").toEqual([]);
  });
});

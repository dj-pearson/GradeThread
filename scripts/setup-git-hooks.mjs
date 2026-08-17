#!/usr/bin/env node
// The `prepare` script: point git at .githooks so pre-commit (gitleaks) and
// pre-push (the local CI mirror) actually run.
//
// WHY THIS IS A FILE AND NOT A ONE-LINER. It used to be:
//
//   "prepare": "git config core.hooksPath .githooks 2>/dev/null || true"
//
// npm runs scripts through cmd.exe on Windows, and `2>/dev/null` is not a cmd
// redirect — cmd reads it as a path, fails with "The system cannot find the
// path specified", and never runs `git config` at all. `|| true` then swallows
// the failure, so `npm install` printed one unremarkable line and exited 0 with
// the hooks left OFF.
//
// WHAT THAT COST, measured rather than imagined: on 2026-08-17 a push went to
// origin/main with no pre-push verify and no held-migration gate, because
// `git config core.hooksPath` returned empty on a machine that had run
// `npm install` many times. Every Windows contributor has been in that state.
// The gitleaks pre-commit scan was off too.
//
// Failure here is deliberately non-fatal: outside a git repository (a tarball
// install, a Docker build context) there is nothing to configure and that is
// not an error. But it SAYS so, which the old `|| true` did not.

import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
} catch {
  console.log("[hooks] not a git repository — skipping hooks setup.");
  process.exit(0);
}

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  console.log("[hooks] core.hooksPath = .githooks (pre-commit + pre-push are live).");
} catch (err) {
  // Not fatal, but not silent either: a contributor whose hooks are off should
  // be able to find out from the install output rather than from a bad push.
  console.warn(
    `[hooks] could not set core.hooksPath: ${err instanceof Error ? err.message : err}\n` +
      "[hooks] Run it by hand:  git config core.hooksPath .githooks",
  );
}

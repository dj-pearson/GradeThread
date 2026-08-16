// US-2655: local gates whose TOOL is absent, so the gate runs and does nothing.
//
// WHY THIS IS WORTH A LINE IN THE SUMMARY. The pre-commit secret scan is the
// case that prompted it: `.githooks/pre-commit` prints three lines and exits 0
// when gitleaks is missing, and those three lines scroll past inside the commit
// output. A whole session of commits went out with no local secret scan and
// nothing in any summary said so. That is the same shape as every other finding
// this repo keeps making — a guard that is green because it is not looking.
//
// These are NOT failures. CI runs both (secret-scan.yml on push,
// secret-scan-history.yml weekly, trivy in the security workflow), so nothing is
// unguarded. What is lost is the LOCAL catch, which is the one that saves you
// before the thing is pushed. Worth reporting; not worth failing a run over.
//
// It lives in scripts/lib/ rather than inside verify.mjs because importing that
// file RUNS the whole verification — so a test of this logic could not import
// it. Same reason ci-env and prd-priority live here.

import { spawnSync } from "node:child_process";

/** Tool → what stops working when it is missing. */
export const LOCAL_GATES = [
  [
    "gitleaks",
    "pre-commit secret scan (.githooks/pre-commit exits 0 when it is missing)",
  ],
  ["trivy", "security lane image scan"],
];

/** True when `tool` is on PATH. */
export function onPath(tool) {
  return (
    spawnSync(process.platform === "win32" ? "where" : "which", [tool], {
      stdio: "ignore",
      shell: true,
    }).status === 0
  );
}

/**
 * One line per gate whose tool is absent.
 *
 * `lookup` is injected so a test can assert the shape without depending on what
 * happens to be installed on the machine running it — which is the whole point
 * of the check, and would otherwise make the test machine-specific and useless.
 */
export function inertLocalGates(lookup = onPath) {
  return LOCAL_GATES.filter(([tool]) => !lookup(tool)).map(
    ([tool, what]) => `${tool} not installed — ${what}`,
  );
}

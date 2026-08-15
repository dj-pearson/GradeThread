import { spawnSync } from "node:child_process";

/**
 * The interpreter for every *.py guard in this repo.
 *
 * CI calls them as `python3`, which does not exist on a stock Windows install —
 * there it is `python` and the `py` launcher. Hardcoding `python3` locally is
 * how a guard ends up being a thing only CI ever runs, and this repo has the
 * receipt: CLAUDE.md said the iOS source guards were CI-only "because there is
 * no python3 on the Windows dev box". There is a Python 3; it answers to a
 * different name. Six guards sat unrunnable behind a naming difference.
 *
 * Lives in scripts/lib/ rather than in the Android toolchain because it is not
 * an Android fact. android/scripts/toolchain.mjs re-exports it so its own
 * callers are unchanged.
 *
 * @returns {string|null} the command to invoke, or null when no Python 3 is on PATH.
 */
export function resolvePython() {
  for (const cmd of ["python3", "python", "py"]) {
    // No shell: an unfound command comes back as status null rather than
    // throwing, and shell:true with args is a deprecated (and injectable) shape.
    const r = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return cmd;
  }
  return null;
}

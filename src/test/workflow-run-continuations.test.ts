// US-3408: a dropped `\` in a workflow `run:` block turns an argument into a command.
//
// THE DEFECT THIS EXISTS FOR, and it ran red in CI for an hour before anyone
// read it. money-cert-integration.yml grew a third test file under a `deno test`
// invocation and the line above it kept no continuation:
//
//   deno test --allow-net --allow-env --allow-read \
//     src/tests/sync-review-lands_test.ts \
//     src/tests/grade-outcome-lands_test.ts
//     src/tests/storage-anon-list_test.ts     <-- its own command now
//
// The shell runs the deno test, then tries to EXECUTE the .ts file. It is not
// executable, so the step dies with **exit code 126**, which is the one exit
// code that means "found it, could not run it". Two things go wrong at once and
// only one is visible: the lane fails, AND the third suite never ran. A reader
// scanning the log sees green test groups followed by a bare exit code with no
// assertion attached to it.
//
// It is invisible to every other check in the repo. The YAML is valid, so the
// yaml parser is happy. The shell is valid, so `bash -n` is happy. Nothing
// type-checks a workflow. The file exists, so a path-existence guard passes.
// The only tell is that a line inside a `run:` block is a bare path.
//
// WHY THE RULE IS SHAPED THIS WAY. It does not try to understand shell. It asks
// one question: is this line, on its own, nothing but a path to a file that
// exists in this repo? A real command line has a verb. A continuation argument
// does not, and is only legal when the line above it ends in `\`, `|`, `&&` or
// `||`. That is narrow enough to have produced exactly one finding across every
// workflow in the repo and zero false positives.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// process.cwd(), which every other guard under src/test/ uses: vitest runs from
// the repo root. import.meta.url is NOT a file: URL after vitest's transform and
// throws "The URL must be of scheme file" at collection time -- which the runner
// reports as "no tests", not as a failure, so it would have read as a guard that
// simply found nothing.
const REPO = resolve(process.cwd());
const WORKFLOWS = join(REPO, ".github", "workflows");

/** A line that is nothing but a path to a real file, with no command around it. */
const BARE_PATH = /^\s{4,}([A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|cjs|js|sh|py|sql|json|yml))\s*$/;

/** The characters that make the NEXT line a continuation rather than a command. */
const CONTINUES = /(\\|\||&&|\|\|)$/;

interface Finding {
  file: string;
  line: number;
  text: string;
  previous: string;
}

function workflowFiles(): string[] {
  if (!existsSync(WORKFLOWS)) return [];
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => join(WORKFLOWS, f));
}

/** Roots a workflow path could be relative to, since steps set working-directory. */
const ROOTS = ["", "services/edge-functions", "android", "ios", "extension-unified"];

function resolvesInRepo(p: string): boolean {
  return ROOTS.some((r) => existsSync(join(REPO, r, p)));
}

function scan(): { findings: Finding[]; files: number; lines: number } {
  const findings: Finding[] = [];
  const files = workflowFiles();
  let lines = 0;
  for (const file of files) {
    const src = readFileSync(file, "utf8").split(/\r?\n/);
    lines += src.length;
    for (let i = 1; i < src.length; i++) {
      const cur = src[i] ?? "";
      const prev = (src[i - 1] ?? "").replace(/\s+$/, "");
      const m = BARE_PATH.exec(cur);
      if (!m) continue;
      if (CONTINUES.test(prev)) continue;
      // The previous line must itself look like part of a command for this to be
      // a dropped continuation; a bare path directly under `run: |` is a real
      // (if odd) command and not this defect.
      if (!/\S/.test(prev)) continue;
      const path = m[1] ?? "";
      if (!resolvesInRepo(path)) continue;
      findings.push({
        file: file.slice(REPO.length + 1).replace(/\\/g, "/"),
        line: i + 1,
        text: cur.trim(),
        previous: prev.trim(),
      });
    }
  }
  return { findings, files: files.length, lines };
}

describe("US-3408: workflow run blocks keep their line continuations", () => {
  it("walks a real corpus of workflow files", () => {
    // Fail-closed. A broken path or a renamed directory would otherwise report a
    // clean tree, which is the exact failure mode this repo keeps recording.
    const { files, lines } = scan();
    expect(files).toBeGreaterThan(5);
    expect(lines).toBeGreaterThan(500);
  });

  it("finds no argument line orphaned from its command", () => {
    const { findings } = scan();
    const detail = findings
      .map((f) => `${f.file}:${f.line}\n    line: ${f.text}\n    above: ${f.previous}`)
      .join("\n");
    expect(
      findings,
      "These lines are bare file paths inside a `run:` block whose previous line " +
        "carries no continuation, so the shell runs them as COMMANDS. A .ts or " +
        ".sh file invoked that way exits 126 and the step fails with no assertion " +
        "attached to it, while the suite named on that line never runs. Add the " +
        "missing `\\` to the line above.\n" + detail,
    ).toEqual([]);
  });

  it("the rule actually fires, proved on a fixture rather than argued for", () => {
    // A guard that matched nothing would pass the case above forever. This drives
    // the same predicate over synthetic lines, so the regex cannot quietly rot.
    const fire = (prev: string, cur: string) =>
      BARE_PATH.test(cur) && !CONTINUES.test(prev.replace(/\s+$/, "")) && /\S/.test(prev);

    // The real defect.
    expect(fire("            src/main.ts \\", "            src/tests/a_test.ts")).toBe(false);
    expect(fire("            src/main.ts", "            src/tests/a_test.ts")).toBe(true);
    // Pipes and && are continuations too.
    expect(fire("          cat foo |", "            src/tests/a_test.ts")).toBe(false);
    expect(fire("          npm ci &&", "            src/tests/a_test.ts")).toBe(false);
    // A line with a verb on it is a command, not an orphaned argument.
    expect(fire("          npm ci", "            node scripts/x.mjs")).toBe(false);
    // Indentation under four spaces is YAML structure, not a run-block body.
    expect(fire("  foo:", "  bar.ts")).toBe(false);
  });
});

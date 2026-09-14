import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// US-3308 AC1, second pass.
//
// GitHub Actions skips a step with no `if:` once an earlier step in the job has
// failed. The `build` job runs the held-migration gate FIRST, on purpose, so a
// leak is reported in seconds instead of after twenty minutes -- and a held
// migration is a NORMAL state in this repo, so that gate blocks routinely.
//
// The consequence is the whole reason this story exists. On 2026-09-10 a
// blocked gate skipped `npm ci`, and then every node script in the rest of the
// job died on "Cannot find package": the vault lint, the Swift mirrors and the
// env reference all reported themselves broken when all three were simply
// running without node_modules. Main CI had been red for days that way, showing
// dozens of errors that were one skipped install.
//
// That was fixed with a one-line `if: ${{ !cancelled() }}` and a comment saying
// why. The comment did not hold. On 2026-09-13 the identical failure arrived on
// a different step: `denoland/setup-deno@v2` was added without a condition, the
// blocked gate skipped it, and `scripts/cron-render-scripts.test.mjs` failed
// four cases with "/bin/sh: 1: deno: not found", taking the `Test (scripts)`
// lane down. Run 34769726043 reads as a broken guard. It was a skipped install.
//
// So this asserts the PROPERTY rather than trusting prose: once the gate has
// run, every step after it declares its own condition. The check is a pure
// function over the workflow text and is exported, so the broken shape can be
// fed to it as a string literal instead of by editing the real file.

const WORKFLOW = ".github/workflows/ci.yml";

export interface CascadeStep {
  label: string;
  condition: string | null;
}

/**
 * Steps of one job, in order, with whatever `if:` each declares.
 *
 * A deliberately small YAML reader: job steps sit at a known indent in this
 * file and a real parser would pull a dependency in to answer one question.
 * Line endings are normalized at the read because a CRLF checkout otherwise
 * makes every needle here miss (and a guard that silently matches nothing
 * passes).
 */
export function parseJobSteps(yaml: string, job: string): CascadeStep[] {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const jobAt = lines.findIndex((l) => l === `  ${job}:`);
  if (jobAt === -1) throw new Error(`job "${job}" not found in ${WORKFLOW}`);

  const stepsAt = lines.findIndex((l, i) => i > jobAt && l === "    steps:");
  if (stepsAt === -1) throw new Error(`job "${job}" declares no steps`);

  const steps: CascadeStep[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.join("\n");
    const label =
      /^\s*- (?:name|uses):\s*(.+?)\s*$/m.exec(body)?.[1]?.replace(/^["']|["']$/g, "") ??
      "(unnamed)";
    // Only a step-level `if:`, i.e. one indented exactly as a step's keys are.
    const condition = /^ {8}if:\s*(.+?)\s*$/m.exec(body)?.[1] ?? null;
    steps.push({ label, condition });
    current = null;
  };

  for (let i = stepsAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // The next job, or anything dedented out of this one, ends the list.
    if (/^ {0,3}\S/.test(line)) break;
    if (/^ {6}- /.test(line)) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return steps;
}

/**
 * Steps a failing first gate would SILENTLY SKIP, making their absence read as
 * a pass and everything downstream of them report a falsehood.
 *
 * A step is safe when it declares a condition that survives a prior failure:
 * `!cancelled()` (run anyway) or `failure()` (run BECAUSE of it -- the
 * annotation step that names the gate). Anything else after the gate is the
 * 2026-09-10 and 2026-09-13 shape again.
 */
export function stepsSkippedByAFailingGate(yaml: string, job = "build"): string[] {
  const steps = parseJobSteps(yaml, job);
  const gateAt = steps.findIndex((s) => /held-migration gate/i.test(s.label));
  if (gateAt === -1) {
    throw new Error(
      `no held-migration gate step in "${job}" -- if it moved, this guard is ` +
        `pointed at the wrong job and is passing vacuously`,
    );
  }
  return steps
    .slice(gateAt + 1)
    .filter((s) => {
      const c = s.condition ?? "";
      return !/!\s*cancelled\(\)/.test(c) && !/failure\(\)/.test(c);
    })
    .map((s) => s.label);
}

describe("a blocked held-migration gate cannot make the rest of CI lie", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");

  it("every build step after the gate declares its own condition", () => {
    expect(stepsSkippedByAFailingGate(yaml)).toEqual([]);
  });

  it("the gate really is the first thing the job runs after setup", () => {
    const steps = parseJobSteps(yaml, "build");
    const gateAt = steps.findIndex((s) => /held-migration gate/i.test(s.label));
    const installAt = steps.findIndex((s) => /Install dependencies/i.test(s.label));
    // The ordering is the point: the gate is cheap and reports in seconds, and
    // that is precisely why everything expensive sits behind it and needs the
    // condition. If the install ever moves ahead of the gate this guard still
    // holds, but the reason for it changes, so pin the order too.
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(installAt).toBeGreaterThan(gateAt);
  });

  it("catches the 2026-09-13 recurrence: a setup step added with no condition", () => {
    // The real shape, reduced. `setup-deno` landed exactly like this.
    const broken = [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Held-migration gate",
      "        id: held_migration_gate",
      "        run: node scripts/held-migration-gate.mjs --ci",
      "      - uses: denoland/setup-deno@v2",
      "        with:",
      '          deno-version: "2.8.0"',
      "      - name: Test (scripts)",
      "        if: ${{ !cancelled() }}",
      "        run: npm run test:scripts",
      "",
    ].join("\n");
    expect(stepsSkippedByAFailingGate(broken)).toEqual(["denoland/setup-deno@v2"]);
  });

  it("catches the 2026-09-10 original: a bare `run: npm ci`", () => {
    const broken = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: Held-migration gate",
      "        run: node scripts/held-migration-gate.mjs --ci",
      "      - name: Install dependencies",
      "        run: npm ci",
      "",
    ].join("\n");
    expect(stepsSkippedByAFailingGate(broken)).toEqual(["Install dependencies"]);
  });

  it("does not count the annotation step, which runs BECAUSE the gate failed", () => {
    const ok = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: Held-migration gate",
      "        run: node scripts/held-migration-gate.mjs --ci",
      "      - name: Say out loud that this is the gate",
      "        if: ${{ failure() && steps.held_migration_gate.outcome == 'failure' }}",
      "        run: echo hi",
      "",
    ].join("\n");
    expect(stepsSkippedByAFailingGate(ok)).toEqual([]);
  });

  it("is not satisfied by an `if:` that belongs to something else", () => {
    // A condition nested inside a `with:` block is not a step condition. An
    // indent-blind regex would read this as covered.
    const broken = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: Held-migration gate",
      "        run: node scripts/held-migration-gate.mjs --ci",
      "      - name: Something",
      "        with:",
      "          if: ${{ !cancelled() }}",
      "        run: echo hi",
      "",
    ].join("\n");
    expect(stepsSkippedByAFailingGate(broken)).toEqual(["Something"]);
  });

  it("refuses to pass vacuously when the gate is not in the job it was given", () => {
    const noGate = ["jobs:", "  build:", "    steps:", "      - run: echo hi", ""].join("\n");
    expect(() => stepsSkippedByAFailingGate(noGate)).toThrow(/held-migration gate/);
  });
});

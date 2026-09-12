// US-3411: time every test in src/test/ and print the slowest, so a guard
// drifting toward its timeout is found by looking rather than by flaking.
//
// The history: no-dead-column-writes.test.ts sat at 27.4 seconds against a
// 30-second budget for months. Nobody knew, because the only thing that ever
// reports a guard's cost is the moment it blows the budget — and by then the
// red is a timeout, which reads like a broken guard rather than a slow one.
// The fix for that file was to stop reading its corpus once per case. The fix
// for NOT FINDING THE NEXT ONE BY ACCIDENT is this script.
//
// Usage:
//   node scripts/time-test-guards.mjs              # slowest 10, src/test/
//   node scripts/time-test-guards.mjs --top 25
//   node scripts/time-test-guards.mjs --dir src/   # any vitest path filter
//
// Deliberately NOT wired into `npm run verify`: it runs the suite a second
// time, and a report whose only effect is to double the pre-push cost is a
// report people will delete. Run it when a guard gets slower, or when adding
// one that walks the tree.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
}
const top = Number(flag("--top", "10"));
const dir = flag("--dir", "src/test/");

const scratch = mkdtempSync(join(tmpdir(), "gt-guard-timing-"));
const out = join(scratch, "timing.json");

console.log(`[timing] running vitest over ${dir} ...`);
const started = Date.now();
// `shell: true` is REQUIRED and not a convenience. Since Node 22 hardened
// against CVE-2024-27980, spawnSync on a .cmd or .bat WITHOUT a shell fails
// with EINVAL, and spawnSync reports that as `status: null` with no output --
// which reads exactly like "vitest ran and produced nothing", not like "the
// command never started". That cost a run here before it was diagnosed.
const run = spawnSync(
  "npx vitest run",
  [dir, "--reporter=json", "--outputFile", JSON.stringify(out)],
  { stdio: ["ignore", "ignore", "inherit"], shell: true },
);
const wallSeconds = ((Date.now() - started) / 1000).toFixed(1);

let report;
try {
  report = JSON.parse(readFileSync(out, "utf8"));
} catch {
  rmSync(scratch, { recursive: true, force: true });
  console.error(
    "[timing] vitest produced no JSON report. Exit code " + run.status +
      (run.error ? ", spawn error " + run.error.code : "") + "." +
      (run.error ? " A spawn error means vitest never ran at all." : ""),
  );
  process.exit(1);
}
rmSync(scratch, { recursive: true, force: true });

const files = [];
const tests = [];
let failed = 0;
for (const result of report.testResults ?? []) {
  const name = String(result.name)
    .replace(/\\/g, "/")
    .replace(/^.*\/(src\/)/, "$1");
  let sum = 0;
  for (const assertion of result.assertionResults ?? []) {
    const ms = assertion.duration ?? 0;
    sum += ms;
    if (assertion.status === "failed") failed++;
    tests.push({ file: name, title: assertion.fullName, ms });
  }
  files.push({ name, ms: sum, count: (result.assertionResults ?? []).length });
}

// The budget a test is measured against: its own `}, N)` if it pins one, else
// vitest.config.ts's testTimeout. Parsed rather than hard-coded so this script
// cannot quietly disagree with the config it is reporting on.
let configTimeout = 5000;
try {
  const config = readFileSync("vitest.config.ts", "utf8");
  const match = /testTimeout:\s*([\d_]+)/.exec(config);
  if (match) configTimeout = Number(match[1].replace(/_/g, ""));
} catch {
  /* fall back to vitest's own default */
}

files.sort((a, b) => b.ms - a.ms);
tests.sort((a, b) => b.ms - a.ms);

console.log(
  `\n[timing] ${files.length} files, ${tests.length} tests, ${failed} failed, ` +
    `${wallSeconds}s wall. Budget ${configTimeout / 1000}s per test unless the ` +
    `file pins its own.\n`,
);
console.log(`slowest ${top} TESTS`);
for (const t of tests.slice(0, top)) {
  const share = ((t.ms / configTimeout) * 100).toFixed(0);
  console.log(
    `${String(Math.round(t.ms)).padStart(7)}ms  ${String(share).padStart(3)}% of budget  ${t.title}`,
  );
}
console.log(`\nslowest ${top} FILES (sum of their tests)`);
for (const f of files.slice(0, top)) {
  console.log(
    `${String(Math.round(f.ms)).padStart(7)}ms  ${String(f.count).padStart(4)} tests  ${f.name}`,
  );
}

// Anything already past half its budget on an IDLE box will not survive a
// loaded one: the dev-box measurement for US-3411 was 8.7s inside a parallel
// run against 0.5s alone, and 27.4s on a box with three other agents on it.
const atRisk = tests.filter((t) => t.ms > configTimeout / 2);
if (atRisk.length) {
  console.log(
    `\n[timing] ${atRisk.length} test(s) past half the ${configTimeout / 1000}s ` +
      `budget. Contention multiplies these, it does not add to them.`,
  );
  for (const t of atRisk) {
    console.log(`  ${Math.round(t.ms)}ms  ${t.title}`);
  }
}

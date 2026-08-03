// US-2344 AC3: an edge coverage floor that can actually fail.
//
// `deno coverage cov_profile || true` in security.yml printed a number and threw
// away its exit code, so edge coverage has never been enforced. A check that
// cannot fail is worse than no check: it occupies the slot where a real one
// would go, and it looks like a safety net on the dashboard.
//
// WHY FLOORS RATHER THAN A TARGET. The measured line coverage is ~49%, and a
// target of 80 would be aspirational — the kind of number that gets lowered the
// first time it blocks someone, which is how a floor becomes decoration. These
// are set just BELOW the current measurement: they cannot be met by accident and
// they cannot be missed except by a real regression. Ratchet them up when the
// number moves, in the same commit as the tests that moved it.
//
// WHY THE SCOPE IS src/lib AND src/routes. The unscoped run also counts
// scripts/*.mjs and the test files themselves, which measures the wrong thing in
// both directions — a well-tested script flatters the total, and a test file is
// 100% covered by definition.
//
// Usage: deno run -A scripts/coverage-floor.mjs [cov_profile_dir]

const DIR = Deno.args[0] ?? "cov_profile";

// Set from the 2026-08-03 measurement: branch 86.3, function 62.5, line 49.4.
// The gap is deliberately small — a point or so of slack absorbs the noise of an
// unrelated refactor without absorbing a real drop.
const FLOORS = { branch: 85, function: 61, line: 48 };

const cmd = new Deno.Command("deno", {
  args: [
    "coverage",
    DIR,
    "--include=services/edge-functions/src/(lib|routes)/",
    "--exclude=_test\\.ts$",
  ],
  stdout: "piped",
  stderr: "piped",
});
const { code, stdout, stderr } = await cmd.output();
const out = new TextDecoder().decode(stdout);
if (code !== 0) {
  console.error(new TextDecoder().decode(stderr));
  console.error(`coverage-floor: \`deno coverage\` exited ${code}`);
  Deno.exit(1);
}

// The summary row. Strip ANSI first — the table is colourised, and the escape
// codes sit between the pipe and the number.
const plain = out.replace(/\[[0-9;]*m/g, "");
const row = plain.split("\n").find((l) => l.includes("All files"));
if (!row) {
  console.error(plain);
  console.error(
    "coverage-floor: no 'All files' row. Either the profile is empty or the " +
      "table format changed — either way this must fail rather than pass.",
  );
  Deno.exit(1);
}

const nums = row.match(/\d+\.\d+/g)?.map(Number) ?? [];
if (nums.length < 3) {
  console.error(row);
  console.error("coverage-floor: could not read three percentages from the summary");
  Deno.exit(1);
}
const [branch, fn, line] = nums;

// A profile that measured nothing would report 0 across the board and read as a
// catastrophic regression; it is more likely that the test run never happened.
// Say which, because the two need different fixes.
if (branch === 0 && fn === 0 && line === 0) {
  console.error(
    "coverage-floor: every metric is 0. The coverage profile is almost " +
      "certainly empty — check that `deno test --coverage` ran before this.",
  );
  Deno.exit(1);
}

const results = [
  ["branch", branch, FLOORS.branch],
  ["function", fn, FLOORS.function],
  ["line", line, FLOORS.line],
];

let failed = false;
for (const [name, actual, floor] of results) {
  const ok = actual >= floor;
  if (!ok) failed = true;
  console.log(
    `${ok ? "✓" : "✗"} ${String(name).padEnd(9)} ${String(actual).padStart(5)}%  (floor ${floor}%)`,
  );
}

if (failed) {
  console.error(
    "\ncoverage-floor: edge coverage dropped below the floor. Add tests for what " +
      "you changed, or — if the drop is genuinely correct, e.g. a large tested " +
      "module was deleted — lower the floor in this file and say why in the " +
      "commit.",
  );
  Deno.exit(1);
}

// Ratchet reminder: silent when there is nothing to say, loud when there is.
const slack = Math.min(
  branch - FLOORS.branch,
  fn - FLOORS.function,
  line - FLOORS.line,
);
if (slack >= 5) {
  console.log(
    `\ncoverage-floor: every metric is ${slack.toFixed(1)}+ points above its ` +
      `floor. Raise the floors in this file so the gains cannot be given back.`,
  );
}

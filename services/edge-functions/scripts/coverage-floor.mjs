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

// ── US-2345 AC5: a floor over the MONEY paths specifically ───────────────────
//
// The fleet-wide floors above cannot see a money file: grade.ts and
// admin-billing.ts together are ~3,150 lines that no test imports, so they are
// absent from the table entirely and contribute nothing to the average. A
// project-wide number can rise while the three files where a bug costs real
// money stay at zero.
//
// Two mechanisms, because the files are in two different states.
//
//   • MONEY_FLOORS — files that ARE exercised. Set just below the current
//     measurement, so adding untested lines to one drops its percentage and
//     fails here. That is the "prevents new untested money code" the AC asks
//     for, applied where it can actually bite.
//
//   • MONEY_DEBT — files with NO coverage at all. Enumerated rather than
//     silently excluded, and the list is SHRINK-ONLY: a file that starts being
//     covered must be moved into MONEY_FLOORS in the same commit. Otherwise the
//     first test written against grade.ts would set no floor, and the coverage
//     it bought could be given straight back.
//
// Measured 2026-08-03. affiliate-payout ratcheted 4 -> 11 when US-2345 AC1
// made fireTransfer testable — raise a floor in the same commit as the tests
// that earned it, or the gain can be given straight back.
const MONEY_FLOORS = {
  "lib/affiliate-payout.ts": 11,
  "lib/quick-grade.ts": 12,
  // US-2345 AC1: the admin manual-refund SEQUENCE, extracted from
  // admin-billing.ts so its failure branches could be reached without Stripe.
  // Measured at 97.9% line — floored just below, so adding an untested branch
  // drops the percentage and fails rather than riding on the existing margin.
  // admin-billing.ts itself stays in MONEY_DEBT: nothing imports it, this test
  // reads it as TEXT, so its own coverage is still zero.
  "lib/admin-charge-refund.ts": 97,
  // US-2345 AC1: the admin CREDIT-PACK refund sequence, extracted for the same
  // reason and measured at 100% line / 95.8% branch. Floored at 99 rather than
  // 100 only so a comment or a type line cannot fail the build; every executable
  // line is covered today, so the first untested branch added here drops it.
  // This is the path that moves Stripe money AND claws credits back, so the gap
  // it closes is the half-completed refund the charge-refund lib cannot have.
  "lib/admin-pack-refund.ts": 99,
};
const MONEY_DEBT = new Set([
  // ~1,400 lines. The charge/refund path. AC1 of US-2345 owns this; the work is
  // a request-context + Stripe-double harness, not a test file.
  "routes/grade.ts",
  // ~1,750 lines. Refunds, credits and plan changes, same harness problem.
  "routes/admin-billing.ts",
]);

const seen = new Map();
for (const l of plain.split("\n")) {
  const m = l.match(/\|\s*((?:lib|routes)\/[\w.-]+\.ts)\s*\|[^|]*\|[^|]*\|\s*(\d+\.\d+)\s*\|/);
  if (m) seen.set(m[1], Number(m[2]));
}

let moneyFailed = false;
for (const [file, floor] of Object.entries(MONEY_FLOORS)) {
  const actual = seen.get(file);
  if (actual === undefined) {
    console.error(
      `✗ money ${file} — expected in the coverage table and absent. Either its ` +
        `tests stopped importing it (in which case the floor is doing its job) ` +
        `or the file moved.`,
    );
    moneyFailed = true;
    continue;
  }
  const ok = actual >= floor;
  if (!ok) moneyFailed = true;
  console.log(
    `${ok ? "✓" : "✗"} money ${file.padEnd(30)} ${String(actual).padStart(5)}%  (floor ${floor}%)`,
  );
}

for (const file of MONEY_DEBT) {
  if (seen.has(file)) {
    console.error(
      `✗ money ${file} now has coverage (${seen.get(file)}% lines). Move it from ` +
        `MONEY_DEBT into MONEY_FLOORS in this commit, or the coverage you just ` +
        `bought has no floor under it.`,
    );
    moneyFailed = true;
  } else {
    console.log(`· money ${file.padEnd(30)}      —  (no coverage, declared debt)`);
  }
}

if (moneyFailed) {
  console.error(
    "\ncoverage-floor: the money paths regressed. These are the files where a " +
      "bug costs real money (US-2345); a drop here is not the same kind of news " +
      "as a drop in the project average.",
  );
  Deno.exit(1);
}

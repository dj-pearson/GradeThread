#!/usr/bin/env node
// US-3414 -- prove the SKU odometer actually renders, carries and parses.
//
// This exists because CREATE FUNCTION succeeding proves nothing. A plpgsql body
// is not validated at creation: a function with a typo installs cleanly, raises
// on its first call, and a source scan reads the CREATE statement as correct.
// The whole feature is one string that either is unique inside the tenant or is
// not, and there is no way to tell which from the outside.
//
// The assertion that matters most is j9999_next. J9999 becoming K0000 is the
// carry reaching the letter wheel; J0000 would mean the number wheel rolled
// over on its own and the carry went nowhere, and both look identical in the
// migration source.
//
// Usage:
//   node scripts/check-sku-sequences.mjs
//   node scripts/check-sku-sequences.mjs --container my_db_container

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// .pathname is relative on Linux; fileURLToPath is the portable form.
const HERE = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const containerAt = args.indexOf("--container");
const container =
  containerAt >= 0 ? args[containerAt + 1] : "supabase_db_gradethread";

/** Run one fixture and return the JSON object it printed. */
function runFixture(name) {
  const path = join(HERE, "fixtures", name);
  if (!existsSync(path)) {
    console.error(`✗ fixture missing: ${path}`);
    process.exit(1);
  }
  let raw;
  try {
    raw = execFileSync(
      "docker",
      ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A"],
      { input: readFileSync(path, "utf8"), encoding: "utf8" },
    );
  } catch (err) {
    console.error(
      `✗ could not reach Postgres in container "${container}".\n` +
        `  Start it with: docker start ${container}\n` +
        `  ${err.stderr?.toString().split("\n").find(Boolean) ?? err.message?.split("\n")[0] ?? err}`,
    );
    process.exit(2);
  }
  const start = raw.lastIndexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) {
    console.error(
      `✗ ${name} printed no result object. Raw tail:\n` + raw.slice(-1200),
    );
    process.exit(1);
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    console.error(`✗ ${name} output was not JSON: ${err.message}`);
    process.exit(1);
  }
}

const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Fixture 1: the pure odometer functions (US-3414)
// ---------------------------------------------------------------------------

const r = runFixture("sku-odometer.sql");

console.log(`  render 1032            ${r.plain_1032}`);
console.log(`  advance 1032           ${r.plain_next}`);
console.log(`  render J9999           ${r.j9999}`);
console.log(`  advance J9999          ${r.j9999_next}`);
console.log(`  advance Z9999          ${r.z9999_next_null ? "NULL (exhausted)" : "NOT NULL"}`);
console.log(`  render GT-YY-#####     ${r.dated}`);
console.log(`  parse 'J1234'          ${JSON.stringify(r.parse_jnum)}`);
console.log(`  policies on the table  ${JSON.stringify(r.policy_cmds)}`);

// 1. Rendering. An unpadded number keeps no leading zeros -- lpad with a length
// of 0 returns the empty string, so a render that folded the unpadded case into
// lpad reports "" here rather than "1032".
if (r.plain_1032 !== "1032") {
  fail(
    `an unpadded number did not render.\n` +
      `  expected "1032", got ${JSON.stringify(r.plain_1032)}` +
      (r.plain_1032 === ""
        ? `\n  The empty string is lpad(x, 0, '0'). The width-0 case needs its own branch.`
        : ""),
  );
}
if (r.plain_next !== "1033") {
  fail(`advancing 1032 gave ${JSON.stringify(r.plain_next)}, expected "1033".`);
}
if (r.j9999 !== "J9999") {
  fail(
    `the letter wheel did not render.\n` +
      `  expected "J9999", got ${JSON.stringify(r.j9999)}\n` +
      `  Counter 9 must map to J in ABCDEFGHIJKLMNOPQRSTUVWXYZ (0-based).`,
  );
}

// 2. THE case this feature exists for.
if (r.j9999_next !== "K0000") {
  fail(
    `the carry did not reach the letter wheel.\n` +
      `  expected "K0000", got ${JSON.stringify(r.j9999_next)}` +
      (r.j9999_next === "J0000"
        ? `\n  The number wheel rolled over to its min but nothing carried left.`
        : r.j9999_next === null
          ? `\n  advance returned NULL, so it read J9999 as the END of the sequence.`
          : ""),
  );
}
if (r.padded_rollover !== "B0000") {
  fail(
    `a mid-alphabet carry is wrong.\n` +
      `  A9999 should advance to B0000, got ${JSON.stringify(r.padded_rollover)}.`,
  );
}
if (r.j1234 !== "J1234") {
  fail(`render(jnum, {9,1234}) gave ${JSON.stringify(r.j1234)}, expected "J1234".`);
}

// 3. Exhaustion is NULL, never a wrap. A wrap reissues a number the tenant has
// already used, which is the one thing this feature exists to prevent.
if (r.z9999_next_null !== true) {
  fail(
    "advancing past Z9999 did not return NULL.\n" +
      "  The odometer wrapped instead of reporting exhaustion, so it will\n" +
      "  reissue SKUs the tenant already holds.",
  );
}

// 4. Date segments render from the argument and consume no counter slot.
if (r.dated !== "GT-26-00042") {
  fail(
    `a pattern with a date segment did not render.\n` +
      `  expected "GT-26-00042", got ${JSON.stringify(r.dated)}` +
      (r.dated === "GT-26-0042" || r.dated === "GT-26-042"
        ? `\n  The date segment is eating a counter slot it should not.`
        : ""),
  );
}
if (r.date_stamp !== "26") {
  fail(`the date stamp was ${JSON.stringify(r.date_stamp)}, expected "26".`);
}
if (r.date_stamp_none !== "") {
  fail(
    `a pattern with no date segment produced a stamp of ${JSON.stringify(r.date_stamp_none)}.\n` +
      `  It must be the empty string, because the trigger compares stamps for equality.`,
  );
}
if (r.bounds_len_dated !== 1) {
  fail(
    `bounds returned ${r.bounds_len_dated} entries for a pattern with ONE counting segment.\n` +
      `  bounds must index 1:1 onto counters, so text and date segments are absent from it.`,
  );
}

// 5. Parse is the inverse of render.
if (!same(r.parse_plain, [1031])) {
  fail(`parse('1031') gave ${JSON.stringify(r.parse_plain)}, expected [1031].`);
}
if (!same(r.parse_jnum, [9, 1234])) {
  fail(
    `parse('J1234') gave ${JSON.stringify(r.parse_jnum)}, expected [9,1234].\n` +
      `  The seed reads the highest existing SKU through this, so a wrong\n` +
      `  answer here starts a tenant's numbering on top of items they own.`,
  );
}
if (!same(r.parse_dated, [42])) {
  fail(
    `parse('GT-26-00042') gave ${JSON.stringify(r.parse_dated)}, expected [42].\n` +
      `  A date is consumed and discarded; it does not participate in ordering.`,
  );
}

// 6. Anything that is not ours parses to NULL, so the seed ignores it rather
// than starting the counter somewhere arbitrary.
for (const [key, why] of [
  ["parse_foreign", "'hoodie-blue' does not fit the pattern at all"],
  ["parse_short", "'J123' is one digit short"],
  ["parse_trailing", "'J1234X' has trailing junk"],
  ["parse_badletter", "'91234' has a digit where the alphabet requires a letter"],
]) {
  if (r[key] !== true) {
    fail(`parse should have returned NULL: ${why}.`);
  }
}

// 7. Floors.
if (!same(r.floor_jnum, [0, 0])) {
  fail(`floor(jnum) gave ${JSON.stringify(r.floor_jnum)}, expected [0,0].`);
}
if (!same(r.floor_dated, [1])) {
  fail(
    `floor(dated) gave ${JSON.stringify(r.floor_dated)}, expected [1].\n` +
      `  That pattern's number segment has min 1, and the floor is the min.`,
  );
}

// 8. The table the US-3415 trigger will read.
if (r.rls_enabled !== true) {
  fail("RLS is not enabled on flipdesk_sku_sequences.");
}
if (!same(r.policy_cmds, ["SELECT"])) {
  fail(
    `flipdesk_sku_sequences has policies ${JSON.stringify(r.policy_cmds)}.\n` +
      `  It must carry EXACTLY ONE, a SELECT. A client that can write this row\n` +
      `  can set the counter backwards and manufacture duplicate SKUs; every\n` +
      `  write goes through the SECURITY DEFINER functions in US-3416.`,
  );
}
if (!/false/.test(String(r.default_enabled))) {
  fail(
    `flipdesk_sku_sequences.enabled defaults to ${r.default_enabled}, not false.\n` +
      `  Numbering must be off until a tenant turns it on.`,
  );
}
if (!/false/.test(String(r.default_exhausted))) {
  fail(`flipdesk_sku_sequences.exhausted defaults to ${r.default_exhausted}, not false.`);
}

console.log(
  "\n✓ SKU odometer: 1032 counts up, J9999 carries to K0000, Z9999 reports" +
    " exhaustion instead of wrapping, dates render without eating a counter," +
    " parse is the inverse of render, and the sequence table is read-only to clients.",
);

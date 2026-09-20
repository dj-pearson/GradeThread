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
//   node scripts/check-sku-sequences.mjs                     # docker container
//   node scripts/check-sku-sequences.mjs --container my_db_container
//   node scripts/check-sku-sequences.mjs --dsn "postgresql://postgres@/postgres?host=/tmp&port=55432"
//
// US-3419: the --dsn form exists because "a real Postgres" and "a Postgres in
// the Supabase CLI's Docker container" are not the same requirement, and this
// script only ever offered the second. In a Claude Code cloud session dockerd
// starts but no registry blob can be pulled, so `supabase db start` cannot
// boot -- while Postgres 16 is already installed on the box and the whole
// migration directory applies to it from zero (CLAUDE.md has the recipe).
// The proof was runnable there the entire time and nothing could ask for it.

import { existsSync } from "node:fs";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// .pathname is relative on Linux; fileURLToPath is the portable form.
const HERE = dirname(fileURLToPath(import.meta.url));

// US-2670: the invocation moved to scripts/lib/psql-target.mjs when a second
// and third script needed it. Two copies had already disagreed once.
const psql = psqlTarget();

/** Run one fixture and return the JSON object it printed. */
function runNamedFixture(name) {
  const path = join(HERE, "fixtures", name);
  if (!existsSync(path)) {
    console.error(`✗ fixture missing: ${path}`);
    process.exit(1);
  }
  const { ok, out } = runFixture(psql, path);
  if (!ok) {
    console.error(`✗ could not reach ${psql.how}.\n  ${psql.hint}\n  ${out.split("\n")[0]}`);
    process.exit(2);
  }
  const raw = out;
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

const r = runNamedFixture("sku-odometer.sql");

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

// ---------------------------------------------------------------------------
// Fixture 2: the BEFORE INSERT trigger (US-3415)
//
// CREATE TRIGGER succeeding says nothing about whether the trigger fires, which
// counter it reads, or whether it writes its advance back. The migration source
// reads as correct in all three failure modes.
// ---------------------------------------------------------------------------

const t = runNamedFixture("sku-assignment.sql");

console.log("");
console.log(`  plain issue            ${t.plain_sku}`);
console.log(`  supplied kept          ${t.supplied_sku}`);
console.log(`  letter carry           ${t.j9999_sku} -> ${t.k0000_sku}`);
console.log(`  at the end             ${t.last_sku}, exhausted=${t.exhausted_flag}`);
console.log(`  skipped a typed SKU    ${t.skip_first} -> ${t.skip_second} (past ${t.planted_sku})`);
console.log(`  yearly reset           ${t.reset_sku}`);
console.log(`  by a workspace member  ${t.member_sku}`);
console.log(`  20 bulk inserts        ${t.bulk_distinct} distinct of ${t.bulk_total}`);

// 0. Separate "no trigger" from "wrong trigger" before reading any SKU. A
// trigger keyed on auth.uid() instead of NEW.user_id produces NULL for every
// service-role insert, which is indistinguishable from an absent trigger unless
// this is asked first -- and that misdiagnosis sends the next reader hunting
// for a CREATE TRIGGER statement that is sitting right there in 00803.
if (t.trigger_installed !== true) {
  fail(
    "assign_sku_on_insert is not on public.inventory_items.\n" +
      "  Apply supabase/migrations/00803_assign_sku_trigger.sql.",
  );
}

// 1. It fires at all, and it writes the advance back.
if (t.plain_sku !== "1032") {
  fail(
    `the trigger did not issue the counter's value.\n` +
      `  expected "1032", got ${JSON.stringify(t.plain_sku)}` +
      (t.plain_sku === null
        ? `\n  The trigger IS installed, so it fired and bailed before rendering.\n` +
          `  The likeliest cause by far: the sequence lookup is keyed on\n` +
          `  auth.uid() rather than NEW.user_id. auth.uid() is NULL for a\n` +
          `  service-role insert and is the MEMBER's id for a workspace insert;\n` +
          `  neither owns a sequence row. The tenant is NEW.user_id.`
        : t.plain_sku === "1033"
          ? `\n  It advanced BEFORE issuing. counters holds the NEXT value, so\n` +
            `  render(counters) IS the SKU and the advance comes after.`
          : ""),
  );
}
if (!same(t.plain_counters, [1033])) {
  fail(
    `after issuing 1032 the counter reads ${JSON.stringify(t.plain_counters)}, expected [1033].` +
      (same(t.plain_counters, [1032])
        ? `\n  The advance was never written back, so the NEXT item gets 1032 too.`
        : ""),
  );
}

// 2. A supplied SKU is untouchable, and costs nothing.
if (t.supplied_sku !== "MINE-1") {
  fail(
    `the trigger overwrote a SKU the caller supplied.\n` +
      `  expected "MINE-1", got ${JSON.stringify(t.supplied_sku)}\n` +
      `  It must return NEW untouched whenever sku is non-blank.`,
  );
}
if (!same(t.counters_before_supplied, t.counters_after_supplied)) {
  fail(
    `a supplied SKU moved the counter, from ` +
      `${JSON.stringify(t.counters_before_supplied)} to ${JSON.stringify(t.counters_after_supplied)}.\n` +
      `  The bail-out has to happen BEFORE the claim, or every hand-typed SKU\n` +
      `  silently burns a generated one.`,
  );
}

// 3. The case this feature exists for, through the trigger this time.
if (t.j9999_sku !== "J9999" || t.k0000_sku !== "K0000") {
  fail(
    `the letter wheel did not carry through the trigger.\n` +
      `  expected J9999 then K0000, got ${JSON.stringify(t.j9999_sku)} then ` +
      `${JSON.stringify(t.k0000_sku)}` +
      (t.k0000_sku === "J0000"
        ? `\n  The number wheel rolled over but nothing carried left.`
        : t.k0000_sku === null
          ? `\n  NULL on the second insert means it read J9999 as the END.`
          : ""),
  );
}

// 4. Exhaustion flags itself, and does NOT fail the insert.
if (t.last_sku !== "Z9999") {
  fail(`the final value issued as ${JSON.stringify(t.last_sku)}, expected "Z9999".`);
}
if (t.exhausted_flag !== true) {
  fail(
    "issuing the last possible value did not set exhausted.\n" +
      "  Without the flag the next insert walks 1000 candidates before giving\n" +
      "  up, holding the sequence row lock the whole time.",
  );
}
if (t.after_exhaust_saved !== true) {
  fail(
    "an insert against an exhausted sequence did not save.\n" +
      "  The trigger must return NEW with a NULL sku. Raising here stops a\n" +
      "  seller dead, mid session, with an error they cannot diagnose.",
  );
}
if (t.after_exhaust_sku !== null) {
  fail(
    `an exhausted sequence still issued ${JSON.stringify(t.after_exhaust_sku)}.\n` +
      `  The exhausted flag is not gating, so SKUs are being reissued.`,
  );
}

// 5. The skip. This is what makes a hand-typed SKU safe.
if (t.planted_sku !== "J1235") {
  fail(
    `the fixture's planted SKU reads ${JSON.stringify(t.planted_sku)}; it should ` +
      `be untouched at "J1235".`,
  );
}
if (t.skip_first !== "J1234" || t.skip_second !== "J1236") {
  fail(
    `the generator did not walk past a hand-typed SKU.\n` +
      `  expected J1234 then J1236 either side of the planted J1235,\n` +
      `  got ${JSON.stringify(t.skip_first)} then ${JSON.stringify(t.skip_second)}` +
      (t.skip_second === "J1235"
        ? `\n  It reissued the planted value. In production the unique index\n` +
          `  rejects that save with a 23505 the seller cannot act on.`
        : ""),
  );
}

// 6. The yearly reset.
if (t.reset_sku !== `${t.expected_stamp}-00001`) {
  fail(
    `a rolled-over period did not restart at the floor.\n` +
      `  expected "${t.expected_stamp}-00001", got ${JSON.stringify(t.reset_sku)}\n` +
      `  The stored stamp was last year's and the counter was at 842.`,
  );
}
if (t.reset_stamp !== t.expected_stamp) {
  fail(
    `date_stamp reads ${JSON.stringify(t.reset_stamp)} after the reset, expected ` +
      `${JSON.stringify(t.expected_stamp)}. It would reset again on every insert.`,
  );
}

// 7. Off means off, and a tenant who never configured this is unaffected.
if (t.disabled_sku !== null) {
  fail(
    `numbering is disabled for that tenant and it still issued ` +
      `${JSON.stringify(t.disabled_sku)}.`,
  );
}
if (t.no_row_saved !== true) {
  fail("a tenant with no sequence row could not insert an item at all.");
}
if (t.no_row_sku !== null) {
  fail(`a tenant with NO sequence row got ${JSON.stringify(t.no_row_sku)}.`);
}

// 8. The tenant is the OWNER, not the actor. On a solo account those are the
// same person, so this is the only case that can tell the two apart.
if (t.member_sku !== "1033") {
  fail(
    `an insert by a workspace MEMBER drew from the wrong counter.\n` +
      `  expected "1033" from the OWNER's sequence, got ${JSON.stringify(t.member_sku)}` +
      (t.member_sku === null
        ? `\n  NULL means the trigger looked up auth.uid() -- the member -- who\n` +
          `  has no sequence row. inventory_items.user_id is the workspace OWNER.`
        : ""),
  );
}
if (!same(t.counters_after_member, [1034])) {
  fail(
    `the member's insert did not advance the OWNER's counter.\n` +
      `  expected [1034], got ${JSON.stringify(t.counters_after_member)}\n` +
      `  A member drawing the right number but leaving the counter behind\n` +
      `  hands the owner's next item the same SKU.`,
  );
}

// 9. Twenty inserts, twenty SKUs.
//
// This one does NOT stand alone, and it is worth saying so. Measured here on
// 2026-09-14: a trigger that never writes its advance back still produces 20
// distinct SKUs, because each insert re-renders the same stale candidate, finds
// the previous row already holding it, and walks past via the collision skip.
// The assertion that actually catches a missing write-back is plain_counters
// above. Deleting that one and keeping this would leave a guard that passes for
// the wrong reason.
if (t.bulk_total !== 20) {
  fail(`the bulk insert produced ${t.bulk_total} rows, expected 20.`);
}
if (t.bulk_distinct !== 20) {
  fail(
    `20 inserts produced ${t.bulk_distinct} DISTINCT SKUs.\n` +
      `  The trigger is reading the counter without writing the advance back,\n` +
      `  or advancing a copy it never persists.`,
  );
}

// ---------------------------------------------------------------------------
// Fixture 3: preview, seed and save (US-3416)
//
// Every rejection is asserted on its MESSAGE. The settings screen shows these
// strings verbatim, so a validator that refuses the right patterns while saying
// the wrong thing is still broken -- it just fails in front of the seller
// instead of in here.
// ---------------------------------------------------------------------------

const q = runNamedFixture("sku-rpcs.sql");

console.log("");
console.log(`  seed over 1..1031      next ${JSON.stringify(q.seed_plain_counters)} after ${q.seed_plain_matched} (${q.seed_plain_count} matched)`);
console.log(`  seed with no match     ${JSON.stringify(q.seed_nomatch_counters)}`);
console.log(`  preview from J1230     ${JSON.stringify(q.preview_letters)}`);
console.log(`  preview around J1234   ${JSON.stringify(q.preview_skips)}`);
console.log(`  saved counters         ${JSON.stringify(q.saved_counters)}, exhausted=${q.saved_exhausted}`);

// 1. THE headline: a seller whose SKUs run 1..1031 is told 1032.
if (!same(q.seed_plain_counters, [1032])) {
  fail(
    `the seed did not start after the highest existing SKU.\n` +
      `  expected [1032] over items numbered 1..1031, got ${JSON.stringify(q.seed_plain_counters)}` +
      (same(q.seed_plain_counters, [1031])
        ? `\n  Off by one: it returned the highest itself rather than the next.\n` +
          `  counters is the NEXT value to issue, so this has to be advanced once.`
        : same(q.seed_plain_counters, [1000]) || same(q.seed_plain_counters, [100])
          ? `\n  That looks like a TEXT comparison: '999' sorts above '1031' as a\n` +
            `  string. The ordering has to be on the parsed int[], not on the sku.`
          : ""),
  );
}
if (q.seed_plain_matched !== "1031") {
  fail(`the seed reported its highest match as ${JSON.stringify(q.seed_plain_matched)}, expected "1031".`);
}
// 1031 matches, and the two planted strings that do not fit must be absent.
if (String(q.seed_plain_count) !== "1031") {
  fail(
    `the seed counted ${q.seed_plain_count} matching SKUs, expected 1031.` +
      (String(q.seed_plain_count) === "1033"
        ? `\n  It counted 'hoodie-blue' and 'J1234' too. parse must return NULL\n` +
          `  for a string that does not fit, and the seed must drop those rows.`
        : ""),
  );
}

// 2. Nothing matching means start at the floor, not at zero and not at an error.
if (!same(q.seed_nomatch_counters, [7])) {
  fail(
    `a seed that matched nothing returned ${JSON.stringify(q.seed_nomatch_counters)}, expected [7].\n` +
      `  With no match it has to fall back to the pattern's own floor, and that\n` +
      `  pattern's number segment has min 7.`,
  );
}
if (q.seed_nomatch_matched !== null) {
  fail(`a seed that matched nothing still named ${JSON.stringify(q.seed_nomatch_matched)} as its match.`);
}
if (!same(q.seed_empty_counters, [1])) {
  fail(`a tenant with no items at all seeded to ${JSON.stringify(q.seed_empty_counters)}, expected [1].`);
}

// 3. Preview does not advance before its first value.
if (!same(q.preview_letters, ["J1230", "J1231", "J1232", "J1233", "J1235"])) {
  fail(
    `preview returned ${JSON.stringify(q.preview_letters)}.\n` +
      `  expected ["J1230","J1231","J1232","J1233","J1235"] -- five values from\n` +
      `  J1230, with the tenant's existing J1234 stepped over.` +
      (Array.isArray(q.preview_letters) && q.preview_letters[0] === "J1231"
        ? `\n  It advanced BEFORE the first value. counters is the NEXT value to\n` +
          `  issue, so element 0 is render(counters) with nothing in between.`
        : ""),
  );
}

// 4. And it steps over what the tenant already holds, so the seller sees what
// they will actually get rather than what an empty account would have got.
if (!same(q.preview_skips, ["J1232", "J1233", "J1235", "J1236"])) {
  fail(
    `preview did not step over an existing SKU.\n` +
      `  expected ["J1232","J1233","J1235","J1236"], got ${JSON.stringify(q.preview_skips)}` +
      (Array.isArray(q.preview_skips) && q.preview_skips.includes("J1234")
        ? `\n  J1234 is already on an item in that tenant. Showing it promises a\n` +
          `  number the trigger will not hand out.`
        : ""),
  );
}

// 5. The rejections, by their wording.
for (const [key, needle, what] of [
  ["err_no_counter", /at least one number or letter/i, "a pattern with nothing to count"],
  ["err_dupe_alpha", /cannot repeat a character/i, "an alphabet with a repeated character"],
  ["err_greedy", /has to be last/i, "an unpadded number in front of another number"],
  ["err_too_long", /capped at 50/i, "a pattern that can exceed 50 characters"],
  ["err_wrong_len", /part\(s\) but the pattern counts/i, "a counters array of the wrong length"],
  ["err_out_of_range", /outside what the pattern allows/i, "a counter beyond its segment's bounds"],
]) {
  const got = q[key];
  if (got === null || got === undefined) {
    fail(
      `save ACCEPTED ${what}.\n` +
        `  Every one of these produces SKUs that cannot be read back, reissued,\n` +
        `  or written to eBay at all.`,
    );
  }
  if (!needle.test(String(got))) {
    fail(
      `save rejected ${what}, but said:\n` +
        `    ${got}\n` +
        `  expected wording matching ${needle}. The settings screen shows this\n` +
        `  message verbatim, so the words are the contract.`,
    );
  }
}

// 6. A good save lands and clears exhausted.
if (q.saved_enabled !== true || !same(q.saved_counters, [1032])) {
  fail(
    `the save did not land: enabled=${q.saved_enabled}, counters=${JSON.stringify(q.saved_counters)}.\n` +
      `  expected enabled=true, counters=[1032].`,
  );
}
if (q.saved_exhausted !== false) {
  fail(
    "a successful save left exhausted set.\n" +
      "  Widening the pattern is the fix a seller is told to apply when the\n" +
      "  numbers run out, and saving is the only way a pattern gets wider. If\n" +
      "  the flag survives, the advice does not work.",
  );
}

// 7. Read and write floors are different, and both hold.
if (q.viewer_preview_err !== null) {
  fail(
    `a workspace VIEWER could not preview: ${q.viewer_preview_err}\n` +
      `  Reading is viewer and up, matching what workspaceMiddleware allows.`,
  );
}
if (q.viewer_save_err === null) {
  fail(
    "a workspace VIEWER was allowed to SAVE the SKU pattern.\n" +
      "  Changing the shape of everybody's SKUs is owner or admin.",
  );
}
if (!/owner or an admin/i.test(String(q.viewer_save_err))) {
  fail(`the viewer's refusal said: ${q.viewer_save_err}\n  expected it to name who CAN do it.`);
}
if (q.stranger_err === null) {
  fail(
    "somebody with no membership at all could read another tenant's SKU preview.\n" +
      "  flipdesk_sku_preview is SECURITY DEFINER, so it bypasses RLS and the\n" +
      "  access check inside it is the ONLY thing standing between tenants.",
  );
}

console.log(
  "\n✓ SKU odometer: 1032 counts up, J9999 carries to K0000, Z9999 reports" +
    " exhaustion instead of wrapping, dates render without eating a counter," +
    " parse is the inverse of render, and the sequence table is read-only to" +
    " clients." +
    "\n✓ SKU trigger: issues and advances, never overwrites a supplied SKU," +
    " walks past hand-typed ones, restarts on a new period, stays silent when" +
    " off, draws from the OWNER's counter, and flags exhaustion instead of" +
    " failing the insert." +
    "\n✓ SKU RPCs: a tenant numbered 1..1031 seeds to 1032 without touching a" +
    " row, preview shows what the trigger will actually hand out, six bad" +
    " patterns are refused in the words the screen displays, a good save clears" +
    " exhausted, and a viewer can read but not write.",
);

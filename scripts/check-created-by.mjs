#!/usr/bin/env node
// US-3023 -- prove created_by is actually stamped, actually left alone, and
// actually immutable.
//
// This exists because `CREATE TRIGGER` succeeding proves nothing. A trigger can
// install cleanly and never fire, fire and write the wrong thing, or be undone
// by the next UPDATE -- and a source scan reads all three as correct, because
// the CREATE statement is right there in the file. The whole feature is one
// column that either holds the truth or holds nothing, and there is no way to
// tell which from the outside.
//
// Usage:
//   node scripts/check-created-by.mjs
//   node scripts/check-created-by.mjs --container my_db_container

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "created-by-tracking.sql");

const args = process.argv.slice(2);
const containerAt = args.indexOf("--container");
const container =
  containerAt >= 0 ? args[containerAt + 1] : "supabase_db_gradethread";

if (!existsSync(FIXTURE)) {
  console.error(`✗ fixture missing: ${FIXTURE}`);
  process.exit(1);
}

let raw;
try {
  raw = execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A"],
    { input: readFileSync(FIXTURE, "utf8"), encoding: "utf8" },
  );
} catch (err) {
  console.error(
    `✗ could not reach Postgres in container "${container}".\n` +
      `  Start it with: docker start ${container}\n` +
      `  ${err.message?.split("\n")[0] ?? err}`,
  );
  process.exit(2);
}

const start = raw.lastIndexOf("{");
const end = raw.lastIndexOf("}");
if (start < 0 || end < start) {
  console.error("✗ no result object in the output. Raw tail:\n" + raw.slice(-800));
  process.exit(1);
}

let r;
try {
  r = JSON.parse(raw.slice(start, end + 1));
} catch (err) {
  console.error("✗ output was not JSON: " + err.message);
  process.exit(1);
}

const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

console.log(`  item at insert         ${r.item_stamped_by ?? "NULL"}`);
console.log(`  listing at insert      ${r.listing_stamped_by_at_insert ?? "NULL"}`);
console.log(`  item after update      ${r.item_after_update ?? "NULL"}`);
console.log(`  listing after update   ${r.listing_stamped_by ?? "NULL"}`);
console.log(`  job item created_by    ${r.job_item_created_by_is_null ? "NULL" : "SET"}`);
console.log(`  job listing created_by ${r.job_listing_created_by_is_null ? "NULL" : "SET"}`);
console.log(`  after service correct  ${r.service_role_correction_took ?? "NULL"}`);

// 1. The insert was stamped with the ACTOR, not the tenant. Those are different
// people in the fixture on purpose; a check that only asserts "not null" would
// pass against a trigger that wrote user_id.
//
// These read the value SNAPSHOTTED right after the insert, not the current one.
// Reading the current value conflates a broken insert trigger with a broken
// immutability guard, and reports the second as the first.
if (r.item_stamped_by !== r.member_uid) {
  fail(
    `the INSERT trigger did not stamp the acting member.\n` +
      `  expected ${r.member_uid}, got ${r.item_stamped_by ?? "NULL"}` +
      (r.item_stamped_by === r.owner_uid
        ? `\n  That is the WORKSPACE OWNER — the trigger is writing the tenant, not the actor.`
        : ""),
  );
}
if (r.listing_stamped_by_at_insert !== r.member_uid) {
  fail(
    `the INSERT trigger did not stamp a listing with the acting member.\n` +
      `  expected ${r.member_uid}, got ${r.listing_stamped_by_at_insert ?? "NULL"}\n` +
      `  listings already carry a BEFORE INSERT trigger; the two may be interfering.`,
  );
}

// 2. Background work stays anonymous, and does not error.
if (r.job_item_created_by_is_null !== true) {
  fail("a service-role insert was stamped. Background jobs must stay NULL.");
}
if (r.job_listing_created_by_is_null !== true) {
  fail("a service-role listing insert was stamped. Background jobs must stay NULL.");
}

// 3. The UPDATE could not rewrite it, in either direction. These compare the
// value AFTER the update against the one snapshotted at insert, so a failure
// here can only mean the immutability guard.
if (r.item_after_update !== r.item_stamped_by) {
  fail(
    `an authenticated UPDATE rewrote created_by.\n` +
      `  was ${r.item_stamped_by}, became ${r.item_after_update ?? "NULL"}\n` +
      `  The guard_created_by_immutable trigger is missing or not firing.`,
  );
}
if (r.listing_stamped_by !== r.listing_stamped_by_at_insert) {
  fail(
    `an authenticated UPDATE changed a listing's created_by.\n` +
      `  was ${r.listing_stamped_by_at_insert}, became ${r.listing_stamped_by ?? "NULL"}\n` +
      `  Nulling it out is the likelier real-world case: a client writing a\n` +
      `  whole row back with the field absent.`,
  );
}

// 4. ...but the rest of that same UPDATE still landed. A guard that silently
// swallowed the whole write would pass every check above while breaking saving.
if (r.item_title_did_change !== true) {
  fail(
    "the guard blocked the whole UPDATE, not just created_by.\n" +
      "  The title change in the same statement did not land.",
  );
}
if (r.listing_price_did_change !== true) {
  fail(
    "the guard blocked the whole listing UPDATE, not just created_by.\n" +
      "  The price change in the same statement did not land.",
  );
}

// 5. Service-role can still fix a row.
if (r.service_role_correction_took !== r.member_uid) {
  fail(
    `service_role could not correct created_by.\n` +
      `  expected ${r.member_uid}, got ${r.service_role_correction_took ?? "NULL"}`,
  );
}

console.log(
  "\n✓ created_by: stamped with the actor, NULL for jobs, immutable to clients," +
    " correctable by service_role, and the rest of the update still lands.",
);

#!/usr/bin/env node
// 00834 -- prove the FlipDesk Overview reads ONE workspace.
//
// flipdesk_overview_metrics is SECURITY INVOKER, and RLS admits every
// workspace the caller belongs to. Before 00834 it did not filter by owner, so
// a seller who was also a member of another workspace saw both tenants'
// numbers blended on /dashboard. 00834 also narrowed recentSales to completed
// sales, the rows the Sold tile counts.
//
// IT ASSERTS BOTH DIRECTIONS. A function that refused everyone would satisfy
// "the stranger is refused" on its own and blank the dashboard for every
// seller, so the owner, both members and the service role must all get their
// numbers.
//
// Usage:
//   node scripts/check-overview-owner-scope.mjs --dsn "postgresql://..."
//   node scripts/check-overview-owner-scope.mjs                  # docker
//
// Writes nothing: the fixture runs inside a transaction that rolls back.

import { join } from "node:path";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";

const psql = psqlTarget();
const { ok, out } = runFixture(
  psql,
  join(import.meta.dirname, "fixtures", "overview-owner-scope.sql"),
);
if (!ok || !/RESULT /.test(out)) {
  console.error(
    `✗ could not reach ${psql.how}, or it answered nothing.\n  ${psql.hint}\n  ` +
      (out.split("\n").find(Boolean) ?? "no output"),
  );
  process.exit(2);
}

const read = (name) => {
  const m = new RegExp(`RESULT ${name}=(\\S+)`).exec(out);
  return m ? m[1] : null;
};

// A owns three items: a completed $40 sale, a refunded $30 sale and an unsold
// one, and is a member of B's workspace. B owns one completed $50 sale. M is a
// member of both; S is a stranger. A read that forgets the owner answers
// total:4,sold:2,gross:90; one that forgets the sale status lists recent:2.
// [key, what the caller is, expected]
const A = "total:3,sold:1,gross:40,recent:1";
const B = "total:1,sold:1,gross:50,recent:1";
const EMPTY = "total:0,sold:0,gross:0,recent:0";
const CASES = [
  ["owner_a", "A reads A's workspace", A],
  ["owner_a_null", "A with no owner (an old client): A's own", A],
  ["a_in_b", "A switched into B's workspace", B],
  ["member_b", "M (member of both) reads B's workspace", B],
  ["member_a", "M reads A's workspace", A],
  ["member_null", "M with no owner: M's own, which is empty", EMPTY],
  ["stranger_a", "S names A's workspace", "REFUSED_42501"],
  ["stranger_null", "S with no owner: S's own, which is empty", EMPTY],
  ["anon_a", "anon names A's workspace", "REFUSED_42501"],
  ["anon_null", "anon with no owner", "REFUSED_42501"],
  ["service_role_a", "the service role names A's workspace", A],
  ["service_role_null", "the service role with no owner: nothing", EMPTY],
];

const failures = [];
for (const [key, label, want] of CASES) {
  const got = read(key);
  const pass = got === want;
  console.log(`  ${pass ? "✓" : "✗"} ${label.padEnd(46)} ${got ?? "(no result)"}`);
  if (!pass) failures.push(`${label}: got ${got ?? "nothing"}, expected ${want}`);
}

if (failures.length > 0) {
  console.error(
    `\n✗ ${failures.length} of ${CASES.length} case(s) failed:\n  - ${failures.join("\n  - ")}\n` +
      "  flipdesk_overview_metrics must count only the p_owner_id workspace (NULL =\n" +
      "  the caller's own), refuse a caller who is not its owner, a member of it, or\n" +
      "  the service role with 42501, and list only completed sales. That is 00834.",
  );
  process.exit(1);
}

console.log(
  `\n✓ ${CASES.length}/${CASES.length}: the FlipDesk Overview reads one workspace, ` +
    "a stranger and anon get 42501, the owner, members and the service role " +
    "still get their numbers, and recentSales lists completed sales only.",
);

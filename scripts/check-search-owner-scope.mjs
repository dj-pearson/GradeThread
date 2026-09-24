#!/usr/bin/env node
// 00835 -- prove flipdesk_search_v2 searches ONE workspace.
//
// flipdesk_search (v1) is SECURITY INVOKER with no owner predicate, and RLS
// admits every workspace the caller belongs to. It ranked across all of them
// and stopped at the limit before the web client dropped other workspaces'
// rows, so a small workspace's matches could be crowded out entirely by a big
// one. v2 filters by p_owner_id before it ranks and limits.
//
// IT ASSERTS BOTH DIRECTIONS. A function that refused everyone would satisfy
// "the stranger is refused" on its own and blank search for every seller, so
// the owner, the member and the service role must all get their rows. It also
// pins v1's answer, which the mobile apps still call and which must not move.
//
// Usage:
//   node scripts/check-search-owner-scope.mjs --dsn "postgresql://..."
//   node scripts/check-search-owner-scope.mjs                  # docker
//
// Writes nothing: the fixture runs inside a transaction that rolls back.

import { join } from "node:path";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";

const psql = psqlTarget();
const { ok, out } = runFixture(
  psql,
  join(import.meta.dirname, "fixtures", "search-owner-scope.sql"),
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

// A has 5 rows matching "jacket" (3 items, 1 listing, 1 sale). B has 62, all
// ranked above A's. M is a member of both; S is a stranger. Every call asks for
// 51 rows. A search that ranks before it filters answers M-in-A with B's 51
// rows, which the client then throws away, leaving nothing.
// [key, what the caller is, expected]
const A = "n:5,a:5,b:0";
const B_PAGE = "n:51,a:0,b:51";
const EMPTY = "n:0,a:0,b:0";
const REFUSED = "REFUSED_42501";
const CASES = [
  ["owner_a", "A searches A's workspace", A],
  ["owner_a_null", "A with no owner: A's own", A],
  ["owner_a_names_b", "A names B's workspace (not a member)", REFUSED],
  ["member_b", "M (member of both) searches B's workspace", B_PAGE],
  ["member_a", "M searches A's workspace despite B's 62", A],
  ["member_null", "M with no owner: M's own, which is empty", EMPTY],
  ["stranger_a", "S names A's workspace", REFUSED],
  ["stranger_null", "S with no owner: S's own, which is empty", EMPTY],
  ["anon_a", "anon names A's workspace", REFUSED],
  ["anon_null", "anon with no owner: nothing", EMPTY],
  ["service_role_a", "the service role names A's workspace", A],
  ["service_role_null", "the service role with no owner: nothing", EMPTY],
  // v1, unchanged: RLS-scoped, ranked across every workspace the caller reads.
  ["v1_owner_a", "v1 as A: A's rows (A reads only A)", A],
  ["v1_member", "v1 as M: B's rows crowd out A's, as before", B_PAGE],
  ["v1_stranger", "v1 as S: nothing", EMPTY],
];

const failures = [];
for (const [key, label, want] of CASES) {
  const got = read(key);
  const pass = got === want;
  console.log(`  ${pass ? "✓" : "✗"} ${label.padEnd(48)} ${got ?? "(no result)"}`);
  if (!pass) failures.push(`${label}: got ${got ?? "nothing"}, expected ${want}`);
}

if (failures.length > 0) {
  console.error(
    `\n✗ ${failures.length} of ${CASES.length} case(s) failed:\n  - ${failures.join("\n  - ")}\n` +
      "  flipdesk_search_v2 must return only the p_owner_id workspace's rows (NULL =\n" +
      "  the caller's own), filtered before the limit, and refuse a caller who is not\n" +
      "  its owner, a member of it, or the service role with 42501. flipdesk_search\n" +
      "  (v1) must be unchanged. That is 00835.",
  );
  process.exit(1);
}

console.log(
  `\n✓ ${CASES.length}/${CASES.length}: flipdesk_search_v2 searches one workspace ` +
    "before it limits, a stranger and anon get 42501, the owner, members and the " +
    "service role still get their rows, and v1 answers as it did.",
);

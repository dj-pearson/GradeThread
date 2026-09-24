#!/usr/bin/env node
// 00833 (INV-D1) -- prove the Inventory table reads ONE workspace.
//
// flipdesk_listing_page and inventory_status_counts are SECURITY INVOKER, and
// RLS admits every workspace the caller belongs to. Before 00833 neither
// filtered by owner, so a seller who was also a member of another workspace
// saw both tenants mixed in the table, the repeat-buyer star and the counts.
//
// IT ASSERTS BOTH DIRECTIONS. A function that refused everyone would satisfy
// "the stranger is refused" on its own and blank the table for every seller,
// so the owner, both members and the service role must all get their rows.
//
// Usage:
//   node scripts/check-inventory-owner-scope.mjs --dsn "postgresql://..."
//   node scripts/check-inventory-owner-scope.mjs                  # docker
//
// Writes nothing: the fixture runs inside a transaction that rolls back.

import { join } from "node:path";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";

const psql = psqlTarget();
const { ok, out } = runFixture(
  psql,
  join(import.meta.dirname, "fixtures", "inventory-owner-scope.sql"),
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

// A owns two items (one sold) and is a member of B's workspace. B owns one
// sold item. Both sales went to the same buyer, so a buyerCounts read that
// forgets the owner answers 2. M is a member of both; S is a stranger.
// [key, what the caller is, expected]
const CASES = [
  ["owner_a", "A reads A's workspace", "total:2,foreign:0,buyer:1"],
  ["owner_a_null", "A with no owner (an old client): A's own", "total:2,foreign:0,buyer:1"],
  ["a_in_b", "A switched into B's workspace", "total:1,foreign:0,buyer:1"],
  ["member_b", "M (member of both) reads B's workspace", "total:1,foreign:0,buyer:1"],
  ["member_a", "M reads A's workspace", "total:2,foreign:0,buyer:1"],
  ["member_null", "M with no owner: M's own, which is empty", "total:0,foreign:0,buyer:0"],
  ["stranger_a", "S names A's workspace", "REFUSED_42501"],
  ["anon_a", "anon names A's workspace", "REFUSED_42501"],
  ["service_role_a", "the service role names A's workspace", "total:2,foreign:0,buyer:1"],
  ["counts_owner_a", "tab counts: A in A's workspace", "sold:1,acquired:1"],
  ["counts_owner_a_null", "tab counts: A with no owner", "sold:1,acquired:1"],
  ["counts_member_b", "tab counts: M in B's workspace", "sold:1,acquired:0"],
  ["counts_stranger_a", "tab counts: S names A's workspace", "REFUSED_42501"],
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
      "  flipdesk_listing_page and inventory_status_counts must return only the\n" +
      "  p_owner_id workspace (NULL = the caller's own), and refuse a caller who is\n" +
      "  not its owner, a member of it, or the service role with 42501. That is 00833.",
  );
  process.exit(1);
}

console.log(
  `\n✓ ${CASES.length}/${CASES.length}: the Inventory table and its counts read one ` +
    "workspace, a stranger and anon get 42501, and the owner, members and the " +
    "service role still get their rows.",
);

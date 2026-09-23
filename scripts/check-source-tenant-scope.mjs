#!/usr/bin/env node
// 00824 -- prove get_or_create_source is tenant-scoped.
//
// The function is SECURITY DEFINER and the browser hands it p_user_id, so RLS
// on public.sources never sees the call. Before 00824 any signed-in account
// could plant a source in another seller's account, or probe that seller's
// source names and get their row id back.
//
// IT ASSERTS BOTH DIRECTIONS. A check that refused everyone would satisfy
// "the foreign call is refused" on its own and break intake for every seller,
// so the owner, a listing_manager member and the service role must all pass.
//
// Usage:
//   node scripts/check-source-tenant-scope.mjs --dsn "postgresql://..."
//   node scripts/check-source-tenant-scope.mjs                  # docker
//
// Writes nothing: the fixture runs inside a transaction that rolls back.

import { join } from "node:path";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";

const psql = psqlTarget();
const { ok, out } = runFixture(
  psql,
  join(import.meta.dirname, "fixtures", "source-tenant-scope.sql"),
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

// [label, what the caller is, expected]
const CASES = [
  ["foreign_create", "B creates a source in A's account", "REFUSED_42501"],
  ["foreign_probe", "B looks up one of A's source names", "REFUSED_42501"],
  ["own", "B creates a source in B's own account", "ALLOWED"],
  ["member", "A's listing_manager creates one for A", "ALLOWED"],
  ["viewer", "A's viewer creates one for A", "REFUSED_42501"],
  ["owner", "A finds A's own source", "ALLOWED"],
  ["service_role", "the edge (service role) creates one for A", "ALLOWED"],
  ["planted_rows", "rows B left in A's account", "0"],
];

const failures = [];
for (const [key, label, want] of CASES) {
  const got = read(key);
  const pass = got === want;
  console.log(`  ${pass ? "✓" : "✗"} ${label.padEnd(44)} ${got ?? "(no result)"}`);
  if (!pass) failures.push(`${label}: got ${got ?? "nothing"}, expected ${want}`);
}

if (failures.length > 0) {
  console.error(
    `\n✗ ${failures.length} case(s) failed:\n  - ${failures.join("\n  - ")}\n` +
      "  get_or_create_source must admit the service role, the account owner, and a\n" +
      "  listing_manager member, and refuse everyone else with 42501. That is 00824.",
  );
  process.exit(1);
}

console.log(
  "\n✓ get_or_create_source: a foreign account is refused with 42501, and the " +
    "owner, a listing_manager member and the service role still get through.",
);

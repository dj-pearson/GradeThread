#!/usr/bin/env node
// 00825 -- prove an API key owner cannot raise their own tier or quota.
//
// api-key-auth.ts trusts api_keys.rate_tier ('enterprise' is the top
// per-minute tier) and reads a NULL monthly_quota as unlimited. Before 00825
// a column-unlimited owner UPDATE policy and two INSERT policies let a
// signed-in client write both straight through PostgREST.
//
// IT ASSERTS BOTH DIRECTIONS. Dropping every policy on the table would refuse
// the writes too and break the key list, so the owner must still read and
// delete their own key, and the service role must still mint one.
//
// Usage:
//   node scripts/check-api-key-self-upgrade.mjs --dsn "postgresql://..."
//   node scripts/check-api-key-self-upgrade.mjs                  # docker
//
// Writes nothing: the fixture runs inside a transaction that rolls back.

import { join } from "node:path";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";

const psql = psqlTarget();
const { ok, out } = runFixture(
  psql,
  join(import.meta.dirname, "fixtures", "api-keys-self-upgrade.sql"),
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

// [label, what is being tried, expected]
const CASES = [
  ["owner_update_rows", "owner sets rate_tier/monthly_quota (rows changed)", "0"],
  ["owner_insert", "owner inserts an uncapped enterprise key", "REFUSED_42501"],
  ["admin_insert", "workspace admin inserts one for the owner", "REFUSED_42501"],
  ["owner_select_rows", "owner still reads own key", "1"],
  ["owner_delete_rows", "owner still deletes own key", "1"],
  ["service_insert", "service role (POST /api/keys) inserts", "ALLOWED"],
  ["key_after", "the capped key afterwards (tier/quota)", "null/100"],
];

const failures = [];
for (const [key, label, want] of CASES) {
  const got = read(key);
  const pass = got === want;
  console.log(`  ${pass ? "✓" : "✗"} ${label.padEnd(52)} ${got ?? "(no result)"}`);
  if (!pass) failures.push(`${label}: got ${got ?? "nothing"}, expected ${want}`);
}

if (failures.length > 0) {
  console.error(
    `\n✗ ${failures.length} case(s) failed:\n  - ${failures.join("\n  - ")}\n` +
      "  public.api_keys must have no client UPDATE or INSERT policy; keys are minted\n" +
      "  and changed only by the edge's service-role client. That is 00825.",
  );
  process.exit(1);
}

console.log(
  "\n✓ api_keys: a client cannot change its own tier or quota or mint a key; " +
    "the owner can still read and delete, and the service role still mints.",
);

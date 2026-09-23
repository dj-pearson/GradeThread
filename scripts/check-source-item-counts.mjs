#!/usr/bin/env node
// 00831 -- prove source_item_counts is tenant-scoped.
//
// The Sources page asks this function how many items link to each source
// instead of pulling every inventory row into the browser. It is SECURITY
// INVOKER and takes p_user_id from the browser, so inventory_items RLS is the
// tenant boundary. A stranger naming another seller's workspace must get no
// rows; the owner and a workspace viewer must get the real counts.
//
// Usage:
//   node scripts/check-source-item-counts.mjs --dsn "postgresql://..."
//   node scripts/check-source-item-counts.mjs                  # docker
//
// Writes nothing: the fixture runs inside a transaction that rolls back.

import { join } from "node:path";
import { psqlTarget, runFixture } from "./lib/psql-target.mjs";

const psql = psqlTarget();
const { ok, out } = runFixture(
  psql,
  join(import.meta.dirname, "fixtures", "source-item-counts.sql"),
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

const A_SOURCE = "5ce00000-0000-0000-0000-0000000a0831";
const B_SOURCE = "5ce00000-0000-0000-0000-0000000b0831";

// [label, what the caller is, expected]
const CASES = [
  ["owner", "A counts A's sources", `${A_SOURCE}:3`],
  ["member", "A's viewer counts A's sources", `${A_SOURCE}:3`],
  ["foreign", "B names A's workspace", "NONE"],
  ["own", "B counts B's sources", `${B_SOURCE}:2`],
  ["definer", "the function is SECURITY DEFINER", "f"],
  ["anon", "anon asks for A's workspace", "NONE"],
];

const failures = [];
for (const [key, label, want] of CASES) {
  const got = read(key);
  const pass = got === want;
  console.log(`  ${pass ? "✓" : "✗"} ${label.padEnd(36)} ${got ?? "(no result)"}`);
  if (!pass) failures.push(`${label}: got ${got ?? "nothing"}, expected ${want}`);
}

if (failures.length > 0) {
  console.error(
    `\n✗ ${failures.length} case(s) failed:\n  - ${failures.join("\n  - ")}\n` +
      "  source_item_counts must stay SECURITY INVOKER so inventory_items RLS\n" +
      "  decides what is counted. That is 00831.",
  );
  process.exit(1);
}

console.log(
  "\n✓ source_item_counts: a stranger naming another workspace gets no rows, and " +
    "the owner and a viewer member get the real counts.",
);

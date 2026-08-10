// US-2434 AC2/AC3: erase one email-keyed subject on request.
//
// WHY PER-ADDRESS AND NOT A BACKFILL. The story asks for a bulk re-run over
// everyone deleted before US-2005 shipped. That population cannot be
// identified — account_deletion_log stores no address, by design, and no
// planned table distinguishes an erased subject from a lead. See
// src/lib/email-residue-census.ts for the full argument and
// scripts/email-residue-census.ts for the counts.
//
// What remains available is the case that actually arises: a subject writes in
// asking whether they were forgotten. Then the address is known, from them, and
// there is no inference involved. This is that path.
//
// RUNS THE SAME PLAN, which is AC2 in one line: purgeEmailKeyedPii and
// EMAIL_PURGE_PLAN, the identical code the live deletion endpoint calls. A
// hand-written SQL script would drift from the plan the first time a table is
// added, and drifting is what US-2005 spent its effort preventing.
//
// IDEMPOTENT BY CONSTRUCTION (AC3): every operation is a delete-by-address or a
// null-out-by-address, so a second run over an already-purged address matches
// nothing and succeeds. An interrupted pass is resumed by running it again with
// the same arguments; there is no cursor to lose.
//
// ⚠ NOT AN ENDPOINT, and that is deliberate — the same call US-2433 made in
// third-party-pii-purge.ts. A route that erases rows on an unverified email
// claim is a deletion oracle: anyone could POST a stranger's address and
// destroy their newsletter history and consent record. Verification is the
// work, and it has not been designed. Until it is, this is operator-run.
//
//   deno run --allow-net --allow-env scripts/purge-email-subject.ts a@b.test
//   deno run --allow-net --allow-env scripts/purge-email-subject.ts a@b.test --apply

import { createClient } from "@supabase/supabase-js";
import {
  EMAIL_PURGE_PLAN,
  purgeEmailKeyedPii,
  PURGE_EXEMPT_TABLES,
} from "../src/lib/account-email-purge.ts";
import { normalizeAddress } from "../src/lib/email-residue-census.ts";

const args = Deno.args.filter((a) => !a.startsWith("--"));
const apply = Deno.args.includes("--apply");
const address = normalizeAddress(args[0]);

if (!address || !address.includes("@")) {
  console.error("usage: purge-email-subject.ts <email> [--apply]");
  Deno.exit(1);
}

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  Deno.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// Refuse an address that still belongs to a live account. Running the plan on
// one would delete a CURRENT customer's newsletter subscription and waitlist
// row without deleting their account — a half-erasure nobody asked for, and the
// easiest mistake to make from a support ticket. The account-deletion endpoint
// is the path for a live user.
{
  const { data, error } = await db
    .from("users")
    .select("id")
    .eq("email", address)
    .limit(1);
  if (error) {
    console.error(`live-account check failed: ${error.message}`);
    Deno.exit(1);
  }
  if ((data ?? []).length > 0) {
    console.error(
      "REFUSED: that address belongs to an account that still exists. Use the " +
        "account-deletion endpoint (POST /api/account/delete), which runs this " +
        "same purge as part of a complete erasure.",
    );
    Deno.exit(1);
  }
}

console.log(`subject: ${address}`);
console.log(`plan:    ${EMAIL_PURGE_PLAN.map((t) => t.table).join(", ")}`);
console.log(`exempt:  ${PURGE_EXEMPT_TABLES.join(", ")} (suppression must survive erasure)`);
console.log("");

if (!apply) {
  // A dry run COUNTS rather than describing, so the operator sees whether this
  // address is even present before authorizing a write.
  for (const target of EMAIL_PURGE_PLAN) {
    const { count, error } = await db
      .from(target.table)
      .select("*", { count: "exact", head: true })
      .eq(target.column, address);
    console.log(
      error
        ? `  ${target.table.padEnd(28)} unreadable: ${error.message}`
        : `  ${target.table.padEnd(28)} ${count ?? 0} row(s) would be ${target.mode}d`,
    );
  }
  console.log("\ndry run — pass --apply to write.");
  Deno.exit(0);
}

const result = await purgeEmailKeyedPii(address, {
  del: async (table, column, value) => {
    const { error } = await db.from(table).delete().eq(column, value);
    return { error: error ? { message: error.message } : null };
  },
  anonymize: async (table, column, value, clear) => {
    const patch: Record<string, null> = {};
    for (const c of clear) patch[c] = null;
    const { error } = await db.from(table).update(patch).eq(column, value);
    return { error: error ? { message: error.message } : null };
  },
  report: (message) => console.error(message),
});

// AC3 asks for a per-address log. This is it, and it is deliberately printed
// rather than written to a table: a durable record of "we erased this address"
// would re-store the address we just erased.
console.log(`purged: ${result.purged.join(", ") || "(none)"}`);
if (result.failed.length > 0) {
  console.log(`FAILED: ${result.failed.join(", ")} — re-run; the pass is idempotent.`);
  Deno.exit(1);
}
console.log("done.");

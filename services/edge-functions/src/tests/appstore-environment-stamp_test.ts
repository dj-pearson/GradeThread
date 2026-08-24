// US-2286: every consumable credit grant records which store environment
// verified it.
//
// 00559 marked the USER and the Play purchase table and deliberately left
// `appstore_processed_transactions` alone, because that table is written ONLY
// through the SECURITY DEFINER RPC and stamping it needed a signature change.
// 00609 is that change.
//
// WHY THE PER-TRANSACTION ROW MATTERS SEPARATELY. `users.billing_environment`
// says what the account's LAST purchase was. This table is what the AC5 audit
// reads — "which grants came from sandbox" — and every row written without it
// is unattributable forever, because Apple's receipt is not re-queryable from
// the database. The unattributable set grows with every sandbox purchase until
// this ships.
//
// EXECUTED, NOT INFERRED. The migration was run against the throwaway stack and
// the four claims below were proven with psql before this file was written:
// a six-argument call stamps `sandbox`; a FIVE-argument call — the current edge,
// after the migration but before the deploy — still resolves and leaves NULL;
// the CHECK refuses `staging`; and a duplicate delivery still no-ops without
// double-crediting. This file pins the source shape so those stay true.

import { assert } from "@std/assert";

const MIGRATIONS = new URL("../../../../supabase/migrations/", import.meta.url);
const SQL = Deno.readTextFileSync(
  new URL("00609_appstore_transaction_environment.sql", MIGRATIONS),
);
const ROUTE = Deno.readTextFileSync(new URL("../routes/appstore.ts", import.meta.url));

Deno.test("US-2286: the RPC stores the environment on the claim row", () => {
  // `[\s,(]` before the name, not a bare `environment\)`. Without it this
  // matched `p_environment)` on the VALUES line below, so deleting the column
  // from the insert list left this assertion green — caught by sabotage, not
  // by reading.
  assert(
    /INSERT INTO public\.appstore_processed_transactions[\s\S]{0,200}?[\s,(]environment\)/.test(SQL),
    "the insert does not name the environment column",
  );
  assert(
    /VALUES \([\s\S]{0,160}?p_environment\)/.test(SQL),
    "the environment parameter is declared but never stored",
  );
});

Deno.test("US-2286: the new parameter is DEFAULTED, so the current edge keeps working", () => {
  // The deploy-order safety argument. Migrations apply before the edge deploys,
  // so between the two there is a window where the OLD edge — five named
  // arguments — calls the NEW function. A non-defaulted parameter would make
  // every consumable purchase fail in that window.
  assert(
    /p_environment\s+text\s+DEFAULT\s+NULL/i.test(SQL),
    "p_environment must default, or the pre-deploy edge cannot call this",
  );
});

Deno.test("US-2286: it DROPs the old signature before creating the new one", () => {
  // Postgres identifies a function by its argument list, so adding a parameter
  // leaves BOTH versions live unless the old one is dropped — and the stale
  // 6-argument copy keeps answering, on a paid path.
  //
  // ⚠ THIS TEST USED TO ASSERT THE WRONG TOKEN (US-2837). It required the
  // absence of `CREATE OR REPLACE`, on the reasoning that OR REPLACE with a
  // changed signature IS the overload trap. That reasoning is right about OR
  // REPLACE *instead of* the drop and wrong about OR REPLACE *after* it, and
  // the difference is the whole point: the DROP is what prevents the overload,
  // not the spelling of the CREATE.
  //
  // MEASURED, not argued, from the realistic starting state — a database
  // holding the old 6-argument function:
  //   DROP + CREATE OR REPLACE, applied twice -> exit 0, exit 0, ONE signature
  //   the same file with the DROP removed      -> TWO signatures live
  // So the control reproduces the trap and the shipped form does not.
  //
  // Forbidding OR REPLACE also cost something real: without it a second run
  // raises "already exists with same argument types" and aborts the rest of the
  // file, which breaks US-1108 rule 1. 00609 was the only migration in 658 that
  // did, precisely because this test held it there.
  const drop = SQL.indexOf("DROP FUNCTION IF EXISTS public.grant_appstore_credits");
  const create = SQL.search(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.grant_appstore_credits/,
  );
  assert(drop > -1, "no DROP — an extra parameter would leave a second overload live");
  assert(create > drop, "the CREATE must follow the DROP");

  // The drop must name the OLD 6-argument signature. Dropping the new one would
  // be a no-op on a fresh database and would drop the function it just made on
  // a second run.
  assert(
    /DROP FUNCTION IF EXISTS public\.grant_appstore_credits\(\s*uuid\s*,\s*integer\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*text\s*\)/i
      .test(SQL),
    "the DROP must name the old 6-argument signature",
  );

  // And the create must be re-runnable, which is the half the old assertion
  // inverted. scripts/migrations-lint.mjs enforces this for every migration.
  assert(
    /CREATE OR REPLACE FUNCTION public\.grant_appstore_credits/.test(SQL),
    "the CREATE must be OR REPLACE, or a second run of this file aborts",
  );
});

Deno.test("US-2286: NULL and only the two real environments are allowed", () => {
  // Same three states as 00559: NULL means pre-marker and is NOT a claim that
  // the row was production.
  assert(/environment IS NULL/.test(SQL));
  assert(/environment IN \('production', 'sandbox'\)/.test(SQL));
});

Deno.test("US-2286: no REVOKE was smuggled in", () => {
  // Tightening this function's grants looks obviously right and is currently
  // UNSAFE: US-2403 found that a DENIED call from anon or authenticated
  // segfaults the backend on this Postgres image, which is why the bulk revoke
  // (00527) is parked as .BLOCKED. A revoke here would create that crash
  // surface on a route reachable with the public anon key.
  assert(
    !/REVOKE[\s\S]{0,80}grant_appstore_credits/i.test(SQL),
    "the permission question belongs to US-2282/US-2403, not to a column addition",
  );
});

Deno.test("US-2286: the route passes the verified environment through", () => {
  // The RPC can only stamp what it is given. `withVerifier` has always handed
  // this to its callback and the consumable path discarded it — the same
  // discard 00559 fixed for the user row and the reconciler.
  // 1200 rather than a tighter window because the argument carries a long
  // comment explaining the NULL choice below. Safe to widen here: both the
  // anchor and the target are unique strings in this file, so there is no
  // neighbour for it to reach into.
  assert(
    /grant_appstore_credits[\s\S]{0,1200}?p_environment: txn\.verifiedEnvironment/.test(ROUTE),
    "the route still drops the environment on the floor",
  );
  // NULL rather than a "sandbox" fallback, unlike reconcile.ts. There the
  // fallback keeps an unmarked transaction out of revenue; here NULL is the
  // honest value, and inventing one would put an unmeasured claim in an audit
  // table.
  assert(
    /p_environment: txn\.verifiedEnvironment \?\? null/.test(ROUTE),
    "do not default this to an environment nothing measured",
  );
});

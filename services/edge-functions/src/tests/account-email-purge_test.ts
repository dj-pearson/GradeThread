// US-2005 — GDPR erasure must reach EMAIL-keyed PII, not just user_id-keyed.
//
// The bug: account deletion relied entirely on the ON DELETE CASCADE from
// auth.users, which reaches only tables with an FK to the user. A whole class of
// tables keys PII by EMAIL ADDRESS instead and was never touched — including
// email_deliveries, which stores the full rendered `html` body of every critical
// message. The ON DELETE SET NULL tables were the sharpest: they severed the
// user_id link while PRESERVING the address, i.e. they kept exactly the
// identifier a data subject would cite in a complaint. The endpoint returned
// {deleted: true} the whole time.
//
// WHAT THIS TEST IS: a structural guard over the deletion route's source. The
// endpoint is a Hono handler over the service-role client with no injection
// seam, so a behavioural "assert no row matches the address" test needs a live
// DB and belongs in the db lane (that is AC3 and it stays open). What CAN be
// pinned here is the property that actually decays: that the purge step exists,
// covers each known email-keyed table, and does not regress to relying on the
// cascade alone. The bug class is "someone adds a table that stores an email",
// so the durable half of the guard is the inventory check at the bottom.

import { assert } from "@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../routes/account.ts", import.meta.url),
);

// US-2005 AC3 moved the purge PLAN into lib/account-email-purge.ts so the
// "nothing addressable survives" property could be driven against a fake store
// instead of needing a seeded database. This guard follows the indirection
// rather than being weakened to match the new shape.
//
// BOTH halves are required below, because either alone can hold while the
// property is gone: a plan naming every table that nothing calls, or a caller
// that calls a plan which has quietly lost a table.
const PLAN_SRC = await Deno.readTextFile(
  new URL("../lib/account-email-purge.ts", import.meta.url),
);

// Scope to the delete endpoint so an unrelated mention elsewhere in the file
// (e.g. the export handler reading the same tables) cannot satisfy these.
const DELETE_ROUTE = SRC.slice(SRC.indexOf('accountRoutes.post("/delete"'));

/**
 * Does the delete route actually QUERY this table?
 *
 * Deliberately not a substring check. These table names appear in this route's
 * explanatory comments, so `includes(table)` would pass on prose alone — a guard
 * satisfied by a comment describing the fix is worse than no guard, because it
 * reads as proof. Requires a real `.from("<table>")` call site.
 */
function routeQueries(table: string): boolean {
  // A QUOTED occurrence is the discriminator: the route's prose refers to these
  // tables bare (`including email_deliveries, which stores…`), while every code
  // reference — `.from("x")` or membership in the literal purge lists — quotes
  // them. Simple string containment rather than a regex, because the escaping
  // needed to embed a table name in a pattern is itself a place to be wrong.
  // Now satisfied by the PLAN, since that is where the table names live. The
  // delete route is separately required (below) to invoke the plan at all, so a
  // plan nobody runs still fails.
  return PLAN_SRC.includes(`"${table}"`);
}

Deno.test("deletion purges every known email-keyed PII table", () => {
  for (const table of [
    "email_deliveries",
    "marketing_send_log",
    "email_journey_step_sends",
    "newsletter_issue_recipients",
    "waitlist_entries",
    "email_subscribers",
    "email_consent_audit",
  ]) {
    assert(
      routeQueries(table),
      `account deletion no longer touches ${table}. It keys PII by email, so ` +
        `the auth.users cascade does NOT reach it — dropping it here silently ` +
        `re-opens the erasure gap while /delete still reports success.`,
    );
  }
});

Deno.test("the purge runs BEFORE the auth user is deleted", () => {
  // Ordering is load-bearing: after deleteUser the row that carries the address
  // (users.email) is gone, so the purge would have nothing to key on.
  const purgeAt = DELETE_ROUTE.indexOf("const purgeEmail");
  const deleteAt = DELETE_ROUTE.indexOf("auth.admin.deleteUser");
  assert(purgeAt !== -1, "the email-keyed purge step is missing entirely");
  assert(deleteAt !== -1, "the auth-user delete is missing");
  assert(
    purgeAt < deleteAt,
    "the email-keyed purge must run BEFORE auth.admin.deleteUser — afterwards " +
      "users.email is gone and there is nothing left to key the purge on.",
  );
});

Deno.test("email_suppressions is NOT purged (deliberate exception)", () => {
  // Deleting a suppression would make a bounced/complained address start
  // receiving mail again the moment it is forgotten — harming the very person
  // erasure protects. If this ever changes, it must be a conscious decision, so
  // fail loudly rather than let it drift in.
  assert(
    !/from\("email_suppressions"\)[\s\S]{0,80}?\.delete\(\)/.test(DELETE_ROUTE),
    "email_suppressions must survive erasure — deleting it would resubscribe a " +
      "bounced/complained address. Suppression is legitimate-interest retention.",
  );
});

Deno.test(
  "INVENTORY GUARD: every migration table with an email/recipient column is either purged or explicitly exempt",
  async () => {
    // The real bug class is additive: someone creates a new table that stores an
    // email, and erasure silently stops being complete. Rather than trusting the
    // list above to be maintained by hand, discover candidates from the schema.
    const migrationsDir = new URL("../../../../supabase/migrations/", import.meta.url);
    const files: string[] = [];
    for await (const e of Deno.readDir(migrationsDir)) {
      if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
    }

    // Tables that legitimately hold an address without being subject PII to erase.
    const EXEMPT = new Set<string>([
      // Suppression must outlive erasure — see the test above.
      "email_suppressions",
      // The cascade ROOT: users.email goes when the auth user is deleted, which
      // is the one case the FK chain genuinely does cover.
      "users",
      // Operator/config surfaces, not per-subject records.
      "email_templates",
      "email_journeys",
      "newsletter_issues",
    ]);

    const offenders: string[] = [];
    for (const name of files.sort()) {
      const sql = await Deno.readTextFile(new URL(name, migrationsDir));
      const re =
        /create table if not exists public\.([a-z0-9_]+)\s*\(([\s\S]*?)\n\)/gi;
      for (const m of sql.matchAll(re)) {
        const table = m[1];
        const body = m[2];
        if (EXEMPT.has(table)) continue;
        // Only care about a column that STORES an address (not an FK named
        // *_email_id, and not a boolean opt-in flag).
        const hasAddress =
          /^\s*(email|recipient|claimant_email)\s+text/im.test(body);
        if (!hasAddress) continue;
        // Keyed to the user by FK? Then the cascade already covers it —
        // FOR THE ACCOUNT HOLDER. See the US-2433 note under the assertion:
        // this `continue` is exactly where a third-party subject's data leaves
        // this guard's field of view, and that is correct for the question this
        // guard asks. It is not correct as a claim of full coverage, which is
        // why the failure message now says which question it answered.
        const cascades = /references\s+public\.users\s*\(\s*id\s*\)\s*on delete cascade/i
          .test(body);
        if (cascades) continue;
        if (!routeQueries(table)) offenders.push(`${table} (${name})`);
      }
    }

    assert(
      offenders.length === 0,
      "These tables store an email address, are NOT cascade-deleted with the " +
        "user, and are NOT handled by the deletion route — so a deleted user's " +
        "address survives in them:\n  " +
        offenders.join("\n  ") +
        "\n\nEither purge/anonymize them in account.ts step 3c, or add them to " +
        "EXEMPT here with a reason.",
    );
  },
);

// US-2433 AC4: say what this guard does NOT cover, so green is not misread.
//
// The guard above skips any table that cascades from public.users, and that is
// right for the question it asks — "does the ACCOUNT HOLDER's address survive
// their own deletion?" It is wrong as a claim of full PII coverage, because two
// tables cascade from the SELLER while holding a THIRD PARTY's identifiers:
// guarantee_claims (the buyer who filed a claim) and consignors (the person who
// gave a seller items to sell). Neither of those people has an account, so
// neither is reached by any account action.
//
// A guard whose scope is invisible is read as covering everything it did not
// fail on. This test makes the boundary an assertion instead of a hope: the
// third-party tables must be handled SOMEWHERE, and the only place they can be
// is the US-2433 plan.
Deno.test(
  "US-2433: the account-holder guard's blind spot is covered by the third-party plan",
  async () => {
    const { THIRD_PARTY_PURGE_PLAN } = await import("../lib/third-party-pii-purge.ts");
    const covered = new Set(THIRD_PARTY_PURGE_PLAN.map((t) => t.table));

    // Named literally rather than rediscovered from the schema. These two are
    // the KNOWN blind spot; a scan that re-derived them could drift to zero and
    // pass while covering nothing.
    for (const table of ["guarantee_claims", "consignors"]) {
      assert(
        covered.has(table),
        `${table} holds identifying data about someone who is NOT the account ` +
          "holder, and cascades from the seller — so the inventory guard above " +
          "skips it and no account deletion by that subject can exist. It must " +
          "appear in THIRD_PARTY_PURGE_PLAN (US-2433). If it was removed on " +
          "purpose, say why there, not by deleting this case.",
      );
    }
  },
);

Deno.test("US-2005: the delete route RUNS the purge plan, before the cascade", () => {
  // The other half of following the indirection. Without this, the plan above
  // could list every table in the schema and never execute — which is exactly
  // the "reads as coverage" failure the original gap had.
  const purgeAt = DELETE_ROUTE.indexOf("purgeEmailKeyedPii(");
  const cascadeAt = DELETE_ROUTE.indexOf("auth.admin.deleteUser");
  assert(purgeAt > -1, "the delete route no longer runs the email-keyed purge");
  assert(cascadeAt > -1, "the auth user deletion is gone or was renamed");
  assert(
    purgeAt < cascadeAt,
    "the purge runs AFTER the cascade — users.email is gone by then, so it " +
      "silently purges nothing while the endpoint still reports {deleted:true}",
  );
});

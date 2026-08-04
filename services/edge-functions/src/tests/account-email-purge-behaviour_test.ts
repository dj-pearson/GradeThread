// US-2005 AC3: after deletion, NO row anywhere matches the erased address.
//
// The AC asks for exactly that assertion, and it was recorded as needing a live
// database because the purge ran inline against the service-role client. The
// part that can be WRONG, though, is the plan and the sequence — not the
// client. So this drives the real purge over a fake store and asserts the
// property directly, which is the difference between "we call delete on some
// tables" and "nothing addressable survives".
//
// That distinction is the whole story. The endpoint already returned
// {deleted:true} while email_deliveries — which stores the full rendered `html`
// of every email we ever sent someone — kept the address and the bodies. It
// looked handled.
import { assert, assertEquals } from "@std/assert";

const {
  EMAIL_PURGE_PLAN,
  PURGE_EXEMPT_TABLES,
  purgeEmailKeyedPii,
} = await import("../lib/account-email-purge.ts");

const SUBJECT = "erase.me@example.com";
const BYSTANDER = "someone.else@example.com";

/** A tiny in-memory store: table -> rows. Enough to ask "does it still match?". */
function makeStore() {
  const rows = new Map<string, Array<Record<string, unknown>>>();
  const seed = (table: string, list: Array<Record<string, unknown>>) =>
    rows.set(table, list.map((r) => ({ ...r })));

  const io = {
    del: (table: string, column: string, value: string) => {
      const list = rows.get(table) ?? [];
      rows.set(table, list.filter((r) => r[column] !== value));
      return Promise.resolve({ error: null });
    },
    anonymize: (
      table: string,
      column: string,
      value: string,
      clear: readonly string[],
    ) => {
      for (const r of rows.get(table) ?? []) {
        if (r[column] === value) for (const c of clear) r[c] = null;
      }
      return Promise.resolve({ error: null });
    },
    report: () => {},
  };

  /** Every value anywhere in the store, for the "nothing matches" sweep. */
  const allValues = () =>
    [...rows.values()].flatMap((list) => list.flatMap((r) => Object.values(r)));

  return { rows, seed, io, allValues };
}

/**
 * Seed one row for the subject and one for a bystander in every planned table.
 *
 * The extra columns MIRROR THE REAL SCHEMA rather than being sprayed on every
 * table, and that turned out to matter: the first version gave every table an
 * `html` column, so the "no value anywhere still contains the address" sweep
 * failed on email_consent_audit — a table that is ANONYMIZED, not deleted, and
 * has no html column in reality. The test was reporting a leak it had invented.
 * A fixture that does not match the schema makes a guard assert the wrong thing
 * in whichever direction the invention happens to point.
 */
function seedFromPlan(store: ReturnType<typeof makeStore>) {
  for (const t of EMAIL_PURGE_PLAN) {
    const extra = (addr: string): Record<string, unknown> =>
      t.table === "email_deliveries"
        // The column that makes this a severity: the full rendered body.
        ? { html: `<p>hi ${addr}</p>`, subject: "Your grade is ready" }
        : t.table === "email_consent_audit"
        ? { ip: "203.0.113.9" }
        : {};
    store.seed(t.table, [
      { [t.column]: SUBJECT, ...extra(SUBJECT) },
      { [t.column]: BYSTANDER, ...extra(BYSTANDER) },
    ]);
  }
}

Deno.test("US-2005 AC3: no row matches the erased address afterwards", async () => {
  const store = makeStore();
  seedFromPlan(store);
  // The exempt table too — it must SURVIVE, so it is seeded and checked apart.
  store.seed("email_suppressions", [{ email: SUBJECT, reason: "bounce" }]);

  const result = await purgeEmailKeyedPii(SUBJECT, store.io);
  assertEquals(result.failed, [], "a planned table failed to purge");
  assertEquals(result.purged.length, EMAIL_PURGE_PLAN.length);

  // THE ASSERTION THE AC ASKS FOR, swept over every planned table at once
  // rather than named table by table — the bug class is "someone adds a table
  // keyed by email", so a hand-written list would decay the same way the
  // original gap formed.
  for (const t of EMAIL_PURGE_PLAN) {
    const remaining = (store.rows.get(t.table) ?? []).filter(
      (r) => r[t.column] === SUBJECT,
    );
    assertEquals(
      remaining,
      [],
      `${t.table}.${t.column} still matches the erased address`,
    );
  }
});

Deno.test("US-2005 AC3: the rendered email BODIES go with it", async () => {
  // email_deliveries is the one that makes this a severity rather than a tidy-up
  // — `html` is the full rendered body of every critical message. Deleting the
  // row is what removes it; nulling the address alone would leave the content.
  const store = makeStore();
  seedFromPlan(store);
  await purgeEmailKeyedPii(SUBJECT, store.io);

  const leaked = store
    .allValues()
    .filter((v) => typeof v === "string" && v.includes(SUBJECT));
  assertEquals(
    leaked,
    [],
    "the address still appears somewhere in the store — most likely inside a " +
      "retained email body rather than in the address column",
  );
});

Deno.test("US-2005: a bystander's data is untouched", async () => {
  // A purge that over-reaches is its own incident. Scoping is asserted, not
  // assumed, because `.eq()` on the wrong column would silently take everyone.
  const store = makeStore();
  seedFromPlan(store);
  await purgeEmailKeyedPii(SUBJECT, store.io);

  for (const t of EMAIL_PURGE_PLAN) {
    const survivors = (store.rows.get(t.table) ?? []).filter(
      (r) => r[t.column] === BYSTANDER,
    );
    assertEquals(survivors.length, 1, `${t.table} lost an unrelated row`);
  }
});

Deno.test("US-2005 AC2: email_suppressions SURVIVES the erasure", async () => {
  // Deliberate exception. Forgetting a bounced or complained address means it
  // starts receiving mail again — harming the person the erasure protects.
  const store = makeStore();
  seedFromPlan(store);
  store.seed("email_suppressions", [{ email: SUBJECT, reason: "bounce" }]);

  await purgeEmailKeyedPii(SUBJECT, store.io);

  assertEquals(
    (store.rows.get("email_suppressions") ?? []).length,
    1,
    "the suppression row was erased — this address will start receiving mail again",
  );
  assert(
    PURGE_EXEMPT_TABLES.includes("email_suppressions"),
    "email_suppressions is no longer declared exempt",
  );
  assert(
    !EMAIL_PURGE_PLAN.some((t) => t.table === "email_suppressions"),
    "email_suppressions was added to the purge plan",
  );
});

Deno.test("US-2005: the consent audit is ANONYMIZED, not deleted", async () => {
  // The row proves WHEN a consent action happened, which we may need to defend.
  // That meaning survives the subject once the identifiers are gone — but only
  // if both identifying columns go, not just the address.
  const store = makeStore();
  seedFromPlan(store);
  await purgeEmailKeyedPii(SUBJECT, store.io);

  const rows = store.rows.get("email_consent_audit") ?? [];
  assertEquals(rows.length, 2, "the consent row was deleted rather than anonymized");
  const subjectRow = rows.find((r) => r.email === null) ?? rows[0]!;
  assertEquals(subjectRow.email, null, "the address survived anonymization");
  assertEquals(subjectRow.ip, null, "the IP survived anonymization — also an identifier");
});

Deno.test("US-2005: one failing table does not abandon the rest", async () => {
  // Best-effort per table, deliberately. A failure that stopped the loop would
  // leave MORE PII behind than one that is logged and stepped over, and the
  // caller has already committed to deleting the account.
  const store = makeStore();
  seedFromPlan(store);
  const reported: string[] = [];
  const io = {
    ...store.io,
    del: (table: string, column: string, value: string) =>
      table === "marketing_send_log"
        ? Promise.resolve({ error: { message: "permission denied" } })
        : store.io.del(table, column, value),
    report: (m: string) => reported.push(m),
  };

  const result = await purgeEmailKeyedPii(SUBJECT, io);
  assertEquals(result.failed, ["marketing_send_log"]);
  assert(reported.some((m) => m.includes("marketing_send_log")), "the failure was silent");
  // Everything after the failing table still ran.
  for (const t of EMAIL_PURGE_PLAN) {
    if (t.table === "marketing_send_log") continue;
    const remaining = (store.rows.get(t.table) ?? []).filter(
      (r) => r[t.column] === SUBJECT,
    );
    assertEquals(remaining, [], `${t.table} was skipped after an earlier failure`);
  }
});

Deno.test("US-2005: a THROWING table is caught, not propagated", async () => {
  // The endpoint has already deleted other data by this point. Throwing here
  // would abort erasure partway with no record of what was left behind.
  const store = makeStore();
  seedFromPlan(store);
  const io = {
    ...store.io,
    del: (table: string, column: string, value: string) => {
      if (table === "email_deliveries") throw new Error("socket hang up");
      return store.io.del(table, column, value);
    },
  };
  const result = await purgeEmailKeyedPii(SUBJECT, io);
  assertEquals(result.failed, ["email_deliveries"]);
  assert(result.purged.length > 0, "nothing else was purged after the throw");
});

Deno.test("US-2005: a blank address purges NOTHING", async () => {
  // `.eq(column, "")` would match every row whose address column is empty
  // string — a mass deletion triggered by a user row with no email.
  const store = makeStore();
  seedFromPlan(store);
  const before = [...store.rows.values()].reduce((n, l) => n + l.length, 0);

  const result = await purgeEmailKeyedPii("   ", store.io);
  assertEquals(result.purged, []);
  assertEquals(result.failed, []);
  assertEquals(
    [...store.rows.values()].reduce((n, l) => n + l.length, 0),
    before,
    "a blank address deleted rows",
  );
});

Deno.test("US-2005: the handler runs the purge BEFORE the cascade", () => {
  // Ordering is load-bearing and lives in the caller: after
  // auth.admin.deleteUser the cascade has removed users.email, and there is
  // nothing left to key the purge on. Reversing these two is a silent no-op
  // that still reports {deleted:true}.
  const src = Deno.readTextFileSync(
    new URL("../routes/account.ts", import.meta.url),
  );
  const purgeAt = src.indexOf("purgeEmailKeyedPii(");
  const deleteAt = src.indexOf("auth.admin.deleteUser");
  assert(purgeAt > -1, "the email-keyed purge is gone from the delete handler");
  assert(deleteAt > -1, "the auth user deletion is gone or was renamed");
  assert(
    purgeAt < deleteAt,
    "the purge now runs AFTER the cascade, so users.email is already gone and " +
      "it silently purges nothing",
  );
});

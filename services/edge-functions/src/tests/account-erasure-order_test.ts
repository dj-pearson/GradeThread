// US-2562 AC5: the ORDER is the story, so the order is what gets pinned.
//
// financial-retention_test.ts proves the sequence behaves correctly given its
// two effects. It cannot prove that routes/account.ts actually calls that
// sequence, or that it calls it before the irreversible steps — and a retention
// step that runs after the storage purge is worse than none, because a refusal
// then leaves a half-erased account whose photos are gone and whose PII is not.
//
// Those are source-level facts about one handler, so this reads the source. Same
// idiom as the direct-write and lockstep guards elsewhere in the suite: a
// property that lives in the arrangement of a file, asserted against the file.

import { assert, assertEquals } from "@std/assert";

const ACCOUNT_ROUTE = new URL("../routes/account.ts", import.meta.url);

async function accountSource(): Promise<string> {
  return await Deno.readTextFile(ACCOUNT_ROUTE);
}

/** Index of `needle`, asserting it appears exactly once. */
function soleIndex(src: string, needle: string, label: string): number {
  const first = src.indexOf(needle);
  assert(first !== -1, `${label}: not found in routes/account.ts (${needle})`);
  const second = src.indexOf(needle, first + needle.length);
  assertEquals(
    second,
    -1,
    `${label}: expected exactly one occurrence of ${needle}, found more. ` +
      `A second call site means this guard is checking the wrong one.`,
  );
  return first;
}

Deno.test("retention runs BEFORE the auth user is deleted", async () => {
  const src = await accountSource();
  const retain = soleIndex(src, "retainFinancialRecords(", "retention call");
  const erase = soleIndex(src, "auth.admin.deleteUser(", "auth user deletion");

  assert(
    retain < erase,
    "retainFinancialRecords must be called before auth.admin.deleteUser — the " +
      "redaction it performs is the only thing stopping 00595 from turning an " +
      "erasure into a retention of customer email and billing address.",
  );
});

Deno.test("retention runs BEFORE any destructive step, not just before the delete", async () => {
  const src = await accountSource();
  const retain = soleIndex(src, "retainFinancialRecords(", "retention call");

  // The two irreversible things that happen ahead of the cascade. Both are
  // matched on their call text rather than on the numbered comments, which are
  // prose and get renumbered.
  // US-2649: the sweep is now a loop over the shared collector's buckets, so
  // there is no single bucket name to anchor on. This guard said "this guard is
  // stale" if it could not find its anchor, and that is exactly what it did
  // when the refactor landed — the right behaviour, and the reason the anchor
  // moved rather than the assertion being dropped.
  const storagePurge = src.indexOf("await removeAll(bucket, objectPaths)");
  const stripeDelete = src.indexOf("stripe.customers.del(");

  assert(storagePurge !== -1, "storage purge call not found — this guard is stale");
  assert(stripeDelete !== -1, "Stripe customer delete not found — this guard is stale");

  assert(
    retain < storagePurge,
    "retainFinancialRecords must run before the storage purge. It can REFUSE " +
      "the erasure, and refusing is only safe while the account is whole.",
  );
  assert(
    retain < stripeDelete,
    "retainFinancialRecords must run before the Stripe customer is deleted, " +
      "for the same reason.",
  );
});

Deno.test("a refused retention returns without erasing", async () => {
  const src = await accountSource();
  const retain = src.indexOf("retainFinancialRecords(");
  const guard = src.indexOf("if (!retention.ok)", retain);
  const erase = src.indexOf("auth.admin.deleteUser(");

  assert(
    guard !== -1 && guard < erase,
    "the `if (!retention.ok)` early return must sit between the retention call " +
      "and the deletion. Without it the refusal is computed and ignored.",
  );
  assertEquals(
    /retention_precondition_failed/.test(src),
    true,
    "the refusal should answer a machine-readable code so the client can tell " +
      "'nothing was deleted' from a generic 503.",
  );
});

Deno.test("the deletion log records the retention as numbers", async () => {
  const src = await accountSource();
  for (const field of [
    "stripe_customer_id:",
    "ledger_rows_retained:",
    "subscription_events_redacted:",
  ]) {
    assert(
      src.includes(field),
      `account_deletion_log insert must set ${field} — US-2562 AC3 is that the ` +
        `retention is provable from the log, not asserted in a comment.`,
    );
  }
});

Deno.test("there is still exactly ONE auth user deletion in the edge service", async () => {
  // AC4. A second call site added later would bypass every guard above, and the
  // failure would be silent: that path would simply erase without redacting.
  const hits: string[] = [];
  for await (
    const entry of Deno.readDir(new URL("../routes/", import.meta.url))
  ) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = await Deno.readTextFile(
      new URL(`../routes/${entry.name}`, import.meta.url),
    );
    if (src.includes("auth.admin.deleteUser(")) hits.push(`routes/${entry.name}`);
  }
  for await (const entry of Deno.readDir(new URL("../lib/", import.meta.url))) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = await Deno.readTextFile(
      new URL(`../lib/${entry.name}`, import.meta.url),
    );
    // account-email-purge.ts names it in a comment; match the CALL only.
    if (/[^/*\s]\s*auth\.admin\.deleteUser\(/.test(src)) hits.push(`lib/${entry.name}`);
  }

  assertEquals(
    hits,
    ["routes/account.ts"],
    "auth.admin.deleteUser must have exactly one call site. A new one needs the " +
      "same retention + redaction sequence, or it erases financial PII silently.",
  );
});

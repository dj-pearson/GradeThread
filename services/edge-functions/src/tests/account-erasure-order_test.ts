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

// ── US-2651: the ADMIN erasure branch runs the same two steps, in the same order ──
//
// The self-serve path has had guards on this ordering for a while. The admin
// compliance ANONYMIZE branch — the FORMAL path, used for a written erasure
// request — ran neither step at all.
//
// It asserted the outcome instead. Its own comment says financial and audit
// records "hold no direct PII once the user row + storage are anonymized". That
// is only true because retainFinancialRecords strips
// flipdesk_subscription_events.raw_payload, the verbatim Stripe object carrying
// customer email and billing address. Nothing stripped it here, so the formal
// erasure retained exactly the PII it claimed not to.
//
// And purgeEmailKeyedPii never ran, so every table keyed by ADDRESS rather than
// by user id — email_deliveries among them, which stores the full rendered html
// of every critical message we sent — stayed queryable after an erasure that
// reported success.

async function adminComplianceSource(): Promise<string> {
  return await Deno.readTextFile(
    new URL("../routes/admin-compliance.ts", import.meta.url),
  );
}

Deno.test("US-2651: the admin branch redacts financial PII before anything destructive", async () => {
  const src = await adminComplianceSource();
  const retain = src.indexOf("retainFinancialRecords(");
  assert(
    retain > -1,
    "the admin erasure branch does not call retainFinancialRecords, so the " +
      "Stripe payload it retains still carries customer email and billing address",
  );
  const storagePurge = src.indexOf("await removeAll(bucket, objectPaths)");
  const anonymize = src.indexOf("anonEmail");
  assert(storagePurge > -1 && anonymize > -1, "this guard is stale — anchors moved");
  assert(
    retain < storagePurge,
    "retainFinancialRecords must run before the storage purge: it can REFUSE, " +
      "and refusing is only safe while the account is whole",
  );
  assert(
    retain < anonymize,
    "retainFinancialRecords must run before the users row is anonymized",
  );
});

Deno.test("US-2651: a refusal aborts the admin erasure rather than continuing", async () => {
  const src = await adminComplianceSource();
  assert(
    /if \(!retention\.ok\)/.test(src),
    "the admin branch ignores a retention refusal",
  );
  const refuse = src.indexOf("if (!retention.ok)");
  const storagePurge = src.indexOf("await removeAll(bucket, objectPaths)");
  assert(
    refuse < storagePurge,
    "the refusal must be handled before anything is destroyed",
  );
});

Deno.test("US-2651: the admin branch purges email-keyed PII while the address still exists", async () => {
  const src = await adminComplianceSource();
  const purge = src.indexOf("purgeEmailKeyedPii(");
  assert(
    purge > -1,
    "the admin erasure branch never purges email-keyed tables, so the address " +
      "stays queryable in email_deliveries and friends",
  );
  // account-email-purge.ts says the ordering is load-bearing: after the users
  // row is anonymized there is no address left to key the purge on.
  const anonymize = src.indexOf("anonEmail");
  assert(anonymize > -1, "this guard is stale — the anonymize step moved");
  assert(
    purge < anonymize,
    "purgeEmailKeyedPii must run BEFORE users.email is overwritten, or it has " +
      "nothing to key on",
  );
});

// ── US-2652: what the ANONYMIZE path cannot inherit from the cascade ──────────
//
// Found by diffing the two handlers operation by operation instead of one leak
// at a time. Two differences were defects rather than decisions, and both share
// a cause: the self-serve path gets them free from the FK cascade, and this
// branch keeps the users row on purpose so the cascade never fires.
//
//   owner_nodes — linked_user_id is ON DELETE SET NULL (00256). Deleting the
//   users row severs the passport linkage; anonymizing it does not. So a hop the
//   person opted to REVEAL kept resolving to an account after an erasure that
//   reported success, on a PUBLIC surface.
//
//   the Stripe customer — name, email and billing address held at a PROCESSOR.
//   account.ts deletes it; this branch did not, so it survived an erasure that
//   said it was done. Stripe keeps charges and invoices against a deleted
//   customer, so the financial record this branch deliberately retains is
//   unaffected.

Deno.test("US-2652: the admin branch severs the passport linkage explicitly", async () => {
  const src = await adminComplianceSource();
  assert(
    /\.from\("owner_nodes"\)[\s\S]{0,220}?identity_revealed: false/.test(src),
    "the admin erasure never clears owner_nodes.identity_revealed. The FK that " +
      "does it for the self-serve path is ON DELETE SET NULL, and this branch " +
      "keeps the users row, so nothing fires",
  );
  assert(
    /\.from\("owner_nodes"\)[\s\S]{0,260}?linked_user_id: null/.test(src),
    "the account linkage itself is never cleared",
  );
});

Deno.test("US-2652: the admin branch deletes the Stripe customer", async () => {
  const src = await adminComplianceSource();
  assert(
    /stripe\.customers\.del\(/.test(src),
    "the admin erasure leaves the Stripe customer — the person's name, email " +
      "and billing address — at the processor after reporting the erasure done",
  );
  // Via the shared factory, not a fourth copy of it. Four hand-rolled Stripe
  // clients is how one of them ends up on a different API version.
  assert(
    /from "\.\.\/lib\/stripe-client\.ts"/.test(src),
    "admin-compliance builds its own Stripe client instead of using lib/stripe-client.ts",
  );
});

Deno.test("US-2652: both teardowns run before the users row is anonymized", async () => {
  // Ordering is not cosmetic here. Step 3 overwrites users.email and blanks the
  // profile; the passport teardown keys on linked_user_id (still fine) but the
  // Stripe id is read from the row, so both belong ahead of it for the same
  // reason the email purge does.
  const src = await adminComplianceSource();
  const passport = src.indexOf('.from("owner_nodes")');
  const stripe = src.indexOf("stripe.customers.del(");
  const anonymize = src.indexOf("anonEmail");
  assert(passport > -1 && stripe > -1 && anonymize > -1, "this guard is stale — anchors moved");
  assert(passport < anonymize, "the passport teardown must precede the anonymize");
  assert(stripe < anonymize, "the Stripe delete must precede the anonymize");
});

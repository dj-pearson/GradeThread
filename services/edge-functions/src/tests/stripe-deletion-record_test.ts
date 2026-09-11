// US-3404: the erasure record has to say what the Stripe teardown actually did.
//
// THE DEFECT THIS FILE REPRODUCES. routes/admin-compliance.ts computed
// `stripeDeleted`, discarded it with `void stripeDeleted;`, and wrote the
// literal `false` into account_deletion_log. That is the FORMAL erasure path,
// the one a written request goes through and the one whose record is shown to
// whoever asked, and it reported that the Stripe customer survived whether it
// survived or not.
//
// THE DIRECTION IS THE ONLY THING THAT MADE IT LESS BAD THAN US-3398'S. That
// one lied optimistically. This one lied pessimistically, so nobody was falsely
// reassured -- and a regulator asking "was my payment record removed" got a no
// that means nothing, which is the answer you cannot correct later.
//
// SO ASSERTING THAT THE FIELD IS WRITTEN PROVES NOTHING. It was always written.
// Every test below DRIVES a real deletion attempt through the real helper -- one
// that succeeds, one that throws -- and asserts the two rows DIFFER.
//
// The last four tests read the two route files, because "no route writes this
// column by hand" is a property of the arrangement of a file, which is only
// checkable at the source. Same idiom as storage-purge-record_test.ts and
// account-erasure-order_test.ts.

import "./_env.ts";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  deleteStripeCustomerForRecord,
  MAX_STRIPE_ERROR_CHARS,
  type StripeCustomerDeleter,
  type StripeDeleteLogFields,
} from "../routes/account.ts";

const CUSTOMER = "cus_QaTestCustomer0001";

/** A Stripe whose customers.del resolves, recording what it was asked to kill. */
function deletingStripe(seen: string[]): StripeCustomerDeleter {
  return {
    customers: {
      del: (id: string) => {
        seen.push(id);
        return Promise.resolve({ id, deleted: true });
      },
    },
  };
}

/** A Stripe whose customers.del throws, the way the real SDK reports a failure. */
function refusingStripe(message: string): StripeCustomerDeleter {
  return {
    customers: {
      del: () => Promise.reject(new Error(message)),
    },
  };
}

function silent(): (m: string) => void {
  return () => {};
}

// ── AC1 + AC3: drive both outcomes and prove the rows are not the same ───────

Deno.test("US-3404: a Stripe deletion that SUCCEEDS is recorded as a deletion", async () => {
  const seen: string[] = [];
  const row = await deleteStripeCustomerForRecord(CUSTOMER, deletingStripe(seen), silent());

  assertEquals(seen, [CUSTOMER], "the customer we were handed is the one deleted");
  assertEquals(
    row.stripe_deleted,
    true,
    "the admin path wrote false here for every erasure from 2026-08-16 onward, " +
      "including the ones where the customer really was removed",
  );
  assertEquals(row.stripe_delete_status, "deleted");
  assertEquals(row.stripe_delete_error, null);
});

Deno.test("US-3404: a Stripe deletion that FAILS is recorded as a failure, not as a no-op", async () => {
  const row = await deleteStripeCustomerForRecord(
    CUSTOMER,
    refusingStripe("Request rate limit exceeded"),
    silent(),
  );

  assertEquals(row.stripe_deleted, false);
  assertEquals(row.stripe_delete_status, "failed");
  assert(
    /rate limit/i.test(row.stripe_delete_error ?? ""),
    "the reason Stripe gave has to reach the row, or the operator is back to " +
      "grepping a rotated container log: " + row.stripe_delete_error,
  );
});

Deno.test("US-3404: the success row and the failure row DIFFER", async () => {
  // The whole story in one assertion. Before this change both of these were
  // `{ stripe_deleted: false }` on the admin path, so the column could not
  // distinguish the two events it exists to distinguish.
  const ok = await deleteStripeCustomerForRecord(CUSTOMER, deletingStripe([]), silent());
  const bad = await deleteStripeCustomerForRecord(
    CUSTOMER,
    refusingStripe("No such customer"),
    silent(),
  );

  assertNotEquals(
    JSON.stringify(ok),
    JSON.stringify(bad),
    "a deletion that worked and one that failed must not write the same row",
  );
  assertNotEquals(ok.stripe_deleted, bad.stripe_deleted);
  assertNotEquals(ok.stripe_delete_status, bad.stripe_delete_status);
});

// ── The other two falses a single boolean used to swallow ────────────────────

Deno.test("US-3404: no Stripe customer is 'no_customer', not a failed deletion", async () => {
  // An account that never paid is fully erased. A record that reported this
  // identically to a refused API call would make every clean erasure look like
  // an incident, and the status column would be ignored inside a month.
  for (const absent of [null, undefined, "", "   "]) {
    const row = await deleteStripeCustomerForRecord(absent, deletingStripe([]), silent());
    assertEquals(row.stripe_delete_status, "no_customer", `for ${JSON.stringify(absent)}`);
    assertEquals(row.stripe_deleted, false);
    assertEquals(row.stripe_delete_error, null);
  }
});

Deno.test("US-3404: a container with no Stripe key records 'not_attempted' and says so", async () => {
  // The case the old false hid best. No STRIPE_SECRET_KEY means the account is
  // erased and the customer is left standing at the processor, and the row read
  // exactly like a customer that never existed.
  const said: string[] = [];
  const row = await deleteStripeCustomerForRecord(CUSTOMER, null, (m) => said.push(m));

  assertEquals(row.stripe_delete_status, "not_attempted");
  assertEquals(row.stripe_deleted, false);
  assert(
    /not configured/i.test(row.stripe_delete_error ?? ""),
    "the row must say WHY nothing was attempted: " + row.stripe_delete_error,
  );
  assertEquals(said.length, 1, "and it stays loud in the container log too");
});

Deno.test("US-3404: all four outcomes are distinguishable from each other", async () => {
  const rows: StripeDeleteLogFields[] = [
    await deleteStripeCustomerForRecord(CUSTOMER, deletingStripe([]), silent()),
    await deleteStripeCustomerForRecord(CUSTOMER, refusingStripe("boom"), silent()),
    await deleteStripeCustomerForRecord(null, deletingStripe([]), silent()),
    await deleteStripeCustomerForRecord(CUSTOMER, null, silent()),
  ];
  const statuses = rows.map((r) => r.stripe_delete_status);
  assertEquals(statuses, ["deleted", "failed", "no_customer", "not_attempted"]);
  assertEquals(new Set(statuses).size, 4, "a status that duplicates another is a status that lies");
});

// ── The record must not become a PII leak or an unbounded blob ───────────────

Deno.test("US-3404: an email in a vendor error never reaches the row", async () => {
  // 00064 is explicit that this table holds no email, name or address. Stripe's
  // customers.del errors normally name only the customer id, which is already
  // its own column (US-2562) -- but "normally" is not a guarantee about someone
  // else's error strings, and the guarantee is ours to keep.
  const said: string[] = [];
  const row = await deleteStripeCustomerForRecord(
    CUSTOMER,
    refusingStripe("Customer jane.doe+tag@example.co.uk could not be deleted"),
    (m) => said.push(m),
  );

  assertEquals(row.stripe_delete_status, "failed");
  assertEquals(
    /@/.test(row.stripe_delete_error ?? ""),
    false,
    "an address reached the compliance row: " + row.stripe_delete_error,
  );
  assert(row.stripe_delete_error?.includes("[redacted-email]"), row.stripe_delete_error ?? "");
  assert(
    row.stripe_delete_error?.includes("could not be deleted"),
    "the rest of the reason must survive the redaction",
  );
});

Deno.test("US-3404: a huge vendor error is capped rather than written whole", async () => {
  const row = await deleteStripeCustomerForRecord(
    CUSTOMER,
    refusingStripe("x".repeat(5000)),
    silent(),
  );
  assertEquals(row.stripe_delete_error?.length, MAX_STRIPE_ERROR_CHARS);
  assert(row.stripe_delete_error?.endsWith("..."), "a truncated reason must look truncated");
});

Deno.test("US-3404: the helper never throws, so a Stripe outage cannot half-erase a person", async () => {
  // Best-effort is the pre-existing behaviour and it stays. A throw here would
  // abandon the erasure between the storage purge and the anonymize, which is
  // the worst place to stop.
  const thrower: StripeCustomerDeleter = {
    customers: {
      del: () => {
        throw new Error("socket hang up");
      },
    },
  };
  const row = await deleteStripeCustomerForRecord(CUSTOMER, thrower, silent());
  assertEquals(row.stripe_delete_status, "failed");
});

// ── AC4 + the ratchet: no route may write the claim as a literal again ───────

const ROUTES = new URL("../routes/", import.meta.url);

async function routeSource(file: string): Promise<string> {
  return await Deno.readTextFile(new URL(file, ROUTES));
}

/**
 * Source with whole-line `//` comments dropped.
 *
 * Both routes now explain in a comment what they used to write, and a guard
 * that counted those would fire on its own documentation. Self-checked below,
 * because a stripper that quietly strips nothing is the classic way a source
 * scan passes against broken code.
 */
function codeOnly(src: string): string {
  return src
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

Deno.test("US-3404: the comment filter strips comments and keeps code", () => {
  const sample = "// stripe_deleted: false\nconst a = 1;\r\n  // stripe_deleted: true\n";
  const out = codeOnly(sample);
  assertEquals(/stripe_deleted/.test(out), false, "the stripper is a no-op");
  assert(out.includes("const a = 1;"), "the stripper ate code");
});

/** The one function allowed to decide what `stripe_deleted` says. */
const PRODUCER = "export async function deleteStripeCustomerForRecord(";

Deno.test("US-3404: no edge route writes stripe_deleted as a literal", async () => {
  // The ratchet, copied from US-3398, with one difference forced by this
  // story's scope fence: US-3398's producer lives in lib/, so "zero literals in
  // routes/" was the whole rule. This producer had to live in a ROUTE file, so
  // the rule is "every literal is inside the producer". Move it to
  // lib/account-stripe-record.ts and the exemption below simply stops being
  // needed -- the guard does not weaken, it just has nothing left to exempt.
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(ROUTES)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = codeOnly(await routeSource(entry.name));
    const start = src.indexOf(PRODUCER);
    // `\n}\n` at column zero is the end of a top-level function in this file.
    const end = start === -1 ? -1 : src.indexOf("\n}\n", start);
    if (start !== -1) {
      assert(end !== -1, `${entry.name}: could not find the end of the producer -- this guard is stale`);
    }
    for (const m of src.matchAll(/stripe_deleted\s*:\s*(true|false)\b/g)) {
      const at = m.index ?? -1;
      if (start !== -1 && at > start && at < end) continue;
      offenders.push(`${entry.name}@${at}`);
    }
  }
  assertEquals(
    offenders,
    [],
    "these routes set account_deletion_log.stripe_deleted to a literal outside " +
      "deleteStripeCustomerForRecord. Spread what that function returned " +
      "instead, so the value is what Stripe did rather than what the author " +
      "assumed: " + offenders.join(", "),
  );
});

Deno.test("US-3404: the literal-ratchet actually fires on the shape it exists to catch", async () => {
  // A source scan that exempts a region is one typo away from exempting the
  // whole file, and an exemption nobody exercises is how a guard stops
  // guarding. So the exemption gets driven: a literal moved OUTSIDE the
  // producer must be caught.
  const src = codeOnly(await routeSource("account.ts"));
  const start = src.indexOf(PRODUCER);
  const end = src.indexOf("\n}\n", start);
  assert(start !== -1 && end !== -1, "producer not found -- this guard is stale");

  const sabotaged = src.slice(0, start) + "stripe_deleted: false,\n" + src.slice(start);
  const caught = [...sabotaged.matchAll(/stripe_deleted\s*:\s*(true|false)\b/g)].filter((m) => {
    const at = m.index ?? -1;
    const s = sabotaged.indexOf(PRODUCER);
    return !(at > s && at < sabotaged.indexOf("\n}\n", s));
  });
  assertEquals(caught.length, 1, "a literal outside the producer is not caught by the ratchet");
});

Deno.test("US-3404: no edge route discards the Stripe deletion result", async () => {
  // `void stripeDeleted;` is what made this bug invisible: the value was
  // computed, so every reviewer saw a handled result, and then it was thrown
  // away one line later. A `void` on anything Stripe-shaped in a route is the
  // shape to refuse outright.
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(ROUTES)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const src = codeOnly(await routeSource(entry.name));
    if (/\bvoid\s+\w*[Ss]tripe\w*\s*;/.test(src)) offenders.push(entry.name);
  }
  assertEquals(
    offenders,
    [],
    "a computed Stripe result is discarded with `void` in: " + offenders.join(", "),
  );
});

Deno.test("US-3404: both erasure routes record the Stripe teardown they actually ran", async () => {
  for (const file of ["account.ts", "admin-compliance.ts"]) {
    const src = codeOnly(await routeSource(file));
    assert(
      src.includes("deleteStripeCustomerForRecord("),
      `${file}: no shared Stripe record. The account_deletion_log insert would ` +
        `be claiming an outcome nobody measured.`,
    );
    assert(
      src.includes("...stripeRecord,"),
      `${file}: the deletion-log insert does not carry the Stripe record.`,
    );
  }
});

Deno.test("US-3404: the admin audit line stops calling a count of FOUND objects purged", async () => {
  // The second, smaller lie in the same handler. `storage_objects_purged` was
  // the size of the collector's list -- every refused listing and every failed
  // remove above it still landed in that number.
  const src = codeOnly(await routeSource("admin-compliance.ts"));
  assertEquals(
    /storage_objects_purged/.test(src),
    false,
    "storage_objects_purged is back. It counts intentions, not removals.",
  );
  assert(src.includes("storage_objects_found:"), "the found count must still be recorded, named honestly");
  assert(
    src.includes("storage_objects_removed: purgeRecord.storage_objects_removed"),
    "the removed count must come from the purge recorder, not from the list length",
  );
});

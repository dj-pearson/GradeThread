// US-2562: the financial record survives account erasure.
//
// Two properties are worth a test here and they are not the same property:
//
//   1. The COUNTS reach the deletion log, so the retention is provable.
//   2. A REDACTION failure REFUSES the erasure, while a COUNT failure does not.
//
// (2) is the branch that only exists in a live database in the handler, which is
// why the sequence was extracted at all. Getting it backwards in either
// direction is a real bug: refusing on a count failure blocks a data subject's
// erasure right over an audit field, and proceeding on a redaction failure
// leaves customer email and billing address in
// flipdesk_subscription_events.raw_payload on rows that 00595 stopped cascading
// away — which would make the migration a silent retention rather than a fix.

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type FinancialRetentionIO,
  retainFinancialRecords,
} from "../lib/financial-retention.ts";

function io(overrides: Partial<FinancialRetentionIO> = {}): {
  deps: FinancialRetentionIO;
  calls: string[];
  reports: string[];
} {
  const calls: string[] = [];
  const reports: string[] = [];
  const deps: FinancialRetentionIO = {
    countLedgerRows: (id) => {
      calls.push(`count:${id}`);
      return Promise.resolve({ count: 7, error: null });
    },
    redactSubscriptionEvents: (id) => {
      calls.push(`redact:${id}`);
      return Promise.resolve({ redacted: 3, error: null });
    },
    report: (message) => {
      reports.push(message);
    },
    ...overrides,
  };
  return { deps, calls, reports };
}

Deno.test("the happy path returns both counts for the deletion log", async () => {
  const { deps, calls } = io();
  const result = await retainFinancialRecords("user-1", deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.ledgerRowsRetained, 7);
  assertEquals(result.subscriptionEventsRedacted, 3);
  // Order matters for a different reason than you'd guess: the count has to be
  // taken while the account still scopes the query, and redaction is the step
  // that gates erasure. Counting after a refusal would be wasted work on a path
  // that is about to abort.
  assertEquals(calls, ["count:user-1", "redact:user-1"]);
});

Deno.test("a COUNT failure proceeds with a null count — erasure is not blocked", async () => {
  const { deps, calls, reports } = io({
    countLedgerRows: (id) => {
      calls.push(`count:${id}`);
      return Promise.resolve({ count: null, error: "connection reset" });
    },
  });
  const result = await retainFinancialRecords("user-2", deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  // Null, NOT zero. Zero would read as "this account never transacted", which is
  // a different and false claim about the retained rows.
  assertEquals(result.ledgerRowsRetained, null);
  assertEquals(result.subscriptionEventsRedacted, 3);
  assertEquals(calls, ["count:user-2", "redact:user-2"]);
  assertEquals(reports.length, 1);
  assertStringIncludes(reports[0]!, "ledger count failed");
});

Deno.test("a COUNT that THROWS is reported and still proceeds", async () => {
  // supabase-js resolves with { error } for a refused read but can still throw
  // on a transport failure. An unreported throw here is indistinguishable from a
  // zero-row account, which is the quiet half of this failure.
  const { deps, reports } = io({
    countLedgerRows: () => Promise.reject(new Error("socket hang up")),
  });
  const result = await retainFinancialRecords("user-3", deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.ledgerRowsRetained, null);
  assertEquals(reports.length, 1);
  assertStringIncludes(reports[0]!, "ledger count threw");
});

Deno.test("a REDACTION failure REFUSES the erasure", async () => {
  const { deps, reports } = io({
    redactSubscriptionEvents: () =>
      Promise.resolve({ redacted: null, error: "permission denied for function" }),
  });
  const result = await retainFinancialRecords("user-4", deps);

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.reason, "redaction failed");
  assertStringIncludes(result.reason, "permission denied");
  assertEquals(reports.length, 1);
  assertStringIncludes(reports[0]!, "refusing to erase");
});

Deno.test("a REDACTION that THROWS also refuses", async () => {
  const { deps, reports } = io({
    redactSubscriptionEvents: () => Promise.reject(new Error("socket hang up")),
  });
  const result = await retainFinancialRecords("user-5", deps);

  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.reason, "redaction threw");
  assertStringIncludes(result.reason, "socket hang up");
  assertEquals(reports.length, 1);
});

Deno.test("a successful redaction that reports no number logs zero, not null", async () => {
  // The RPC returning something non-numeric is a shape problem, not a failure —
  // the redaction ran. Recording zero keeps the log column an integer; recording
  // null would make "the redaction failed" and "the RPC answered oddly"
  // indistinguishable in the audit row.
  const { deps } = io({
    redactSubscriptionEvents: () => Promise.resolve({ redacted: null, error: null }),
  });
  const result = await retainFinancialRecords("user-6", deps);

  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.subscriptionEventsRedacted, 0);
});

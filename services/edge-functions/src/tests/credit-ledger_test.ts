// US-892: credit-ledger invariant — the running cumulative sum of `delta`
// (oldest-first, from a zero starting balance) must equal `balance_after` on
// every row that records one. Zero-delta audit rows carry NULL and are skipped
// (but still contribute their zero delta to the running sum).
//
// Pure tests over findLedgerInvariantViolation() — the same helper the admin
// ledger endpoint uses for its defense-in-depth consistency flag.

import { assert, assertEquals } from "@std/assert";
import {
  findLedgerInvariantViolation,
  isLedgerConsistent,
  type LedgerRowLike,
} from "../lib/credit-ledger.ts";

Deno.test("consistent ledger: running delta sum equals balance_after on every row", () => {
  // grant +10 → debit -1 → debit -1 → admin grant +5 → correction -3
  const rows: LedgerRowLike[] = [
    { delta: 10, balance_after: 10 },
    { delta: -1, balance_after: 9 },
    { delta: -1, balance_after: 8 },
    { delta: 5, balance_after: 13 },
    { delta: -3, balance_after: 10 },
  ];
  assertEquals(findLedgerInvariantViolation(rows), null);
  assert(isLedgerConsistent(rows));
});

Deno.test("zero-delta audit rows (NULL balance_after) don't break the invariant", () => {
  const rows: LedgerRowLike[] = [
    { delta: 10, balance_after: 10 },
    { delta: 0, balance_after: null }, // included_grant audit row
    { delta: -2, balance_after: 8 },
    { delta: 0, balance_after: null }, // included refund audit row
    { delta: -8, balance_after: 0 },
  ];
  assertEquals(findLedgerInvariantViolation(rows), null);
});

Deno.test("drift is detected and the first offending row is reported", () => {
  const rows: LedgerRowLike[] = [
    { delta: 10, balance_after: 10 },
    { delta: -1, balance_after: 9 },
    { delta: -1, balance_after: 7 }, // WRONG: should be 8
    { delta: 5, balance_after: 12 },
  ];
  const v = findLedgerInvariantViolation(rows);
  assert(v !== null);
  assertEquals(v?.index, 2);
  assertEquals(v?.expected, 8);
  assertEquals(v?.actual, 7);
  assert(!isLedgerConsistent(rows));
});

Deno.test("empty ledger is trivially consistent", () => {
  assertEquals(findLedgerInvariantViolation([]), null);
});

Deno.test("a single grant from zero balance is consistent", () => {
  assertEquals(findLedgerInvariantViolation([{ delta: 4, balance_after: 4 }]), null);
});

Deno.test("a first row whose balance_after != its own delta is a violation", () => {
  // The ledger must start from a zero balance, so the first balance-recording
  // row's balance_after must equal its delta.
  const v = findLedgerInvariantViolation([{ delta: 4, balance_after: 5 }]);
  assert(v !== null);
  assertEquals(v?.index, 0);
  assertEquals(v?.expected, 4);
});

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildDocument,
  centsToAmount,
  docNumberFor,
  hashPayload,
  isBlocked,
  qboErrorText,
  unmappedCodes,
  type AccountMap,
  type PendingDocument,
} from "../lib/qbo-documents.ts";

// US-2998.

const MAP: AccountMap = {
  sales_revenue: "1",
  shipping_income: "2",
  platform_fees: "3",
  shipping_postage: "4",
  purchases: "5",
  cogs_other: "6",
  supplies: "7",
  cash_payout: "8",
};

/** A sale exactly as qbo_pending_documents groups it. */
function sale(over: Partial<PendingDocument> = {}): PendingDocument {
  return {
    object_kind: "sales_receipt",
    source_id: "11111111-2222-4333-8444-555555555555",
    doc_date: "2025-03-01",
    memo: "A jacket",
    currency: "USD",
    total_cents: 18000 + 1299 - 2862 - 985 - 4200,
    excluded_tax_cents: 1487,
    lines: [
      { account_code: "sales_revenue", amount_cents: 18000, memo: "A jacket", detail: "price" },
      { account_code: "shipping_income", amount_cents: 1299, memo: null, detail: "shipping" },
      { account_code: "platform_fees", amount_cents: -2862, memo: "Fees", detail: "fees" },
      { account_code: "shipping_postage", amount_cents: -985, memo: "Label", detail: "label" },
      { account_code: "purchases", amount_cents: -4200, memo: "Cost of a jacket", detail: "cogs" },
    ],
    ...over,
  };
}

function expense(over: Partial<PendingDocument> = {}): PendingDocument {
  return {
    object_kind: "purchase",
    source_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    doc_date: "2025-06-02",
    memo: "Big supply order",
    currency: "USD",
    total_cents: -12000,
    excluded_tax_cents: 0,
    lines: [
      { account_code: "supplies", amount_cents: -12000, memo: "Big supply order", detail: "expense" },
    ],
    ...over,
  };
}

function payout(over: Partial<PendingDocument> = {}): PendingDocument {
  return {
    object_kind: "deposit",
    source_id: "ffffffff-1111-4222-8333-444444444444",
    doc_date: "2025-08-01",
    memo: "Payout ORDER-1",
    currency: "USD",
    total_cents: 24500,
    excluded_tax_cents: 0,
    lines: [
      { account_code: "cash_payout", amount_cents: 24500, memo: "Payout ORDER-1", detail: "payout" },
    ],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// AC5 — the same push twice makes ONE object.
// ---------------------------------------------------------------------------

Deno.test("the doc number is stable across runs and unique per source", () => {
  const a = docNumberFor("sales_receipt", "11111111-2222-4333-8444-555555555555");
  const b = docNumberFor("sales_receipt", "11111111-2222-4333-8444-555555555555");
  assertEquals(a, b, "the same source must always compute the same number");
  const other = docNumberFor("sales_receipt", "99999999-2222-4333-8444-555555555555");
  assert(a !== other, "different sources must not collide");
  // A kind is part of it: a sale and an expense could otherwise share a number.
  assert(a !== docNumberFor("purchase", "11111111-2222-4333-8444-555555555555"));
  // QuickBooks caps DocNumber at 21 characters and silently truncates past it,
  // which would turn "unique" into "sometimes".
  assert(a.length <= 21, `DocNumber must fit in 21 chars, got ${a.length}`);
});

Deno.test("building the same document twice yields the same payload and hash", () => {
  // This is the property the whole of AC5 rests on: the syncer skips when the
  // hash is unchanged, so a hash that moved on its own would push duplicates
  // for ever.
  const first = buildDocument(sale(), MAP, { origin: "test" });
  const second = buildDocument(sale(), MAP, { origin: "test" });
  assert(!isBlocked(first) && !isBlocked(second));
  assertEquals(first.payloadHash, second.payloadHash);
  assertEquals(first.docNumber, second.docNumber);
  assertEquals(JSON.stringify(first.payload), JSON.stringify(second.payload));
});

Deno.test("the hash ignores key order but not values", () => {
  assertEquals(hashPayload({ a: 1, b: 2 }), hashPayload({ b: 2, a: 1 }));
  assert(hashPayload({ a: 1 }) !== hashPayload({ a: 2 }));
  // And a nested reorder, which is where a naive JSON.stringify hash breaks.
  assertEquals(
    hashPayload({ x: { p: 1, q: 2 } }),
    hashPayload({ x: { q: 2, p: 1 } }),
  );
});

Deno.test("a changed amount changes the hash, so an edit is pushed", () => {
  const before = buildDocument(sale(), MAP);
  const after = buildDocument(
    sale({
      lines: [
        { account_code: "sales_revenue", amount_cents: 19000, memo: "A jacket", detail: "price" },
      ],
    }),
    MAP,
  );
  assert(!isBlocked(before) && !isBlocked(after));
  assert(before.payloadHash !== after.payloadHash);
  // But it is still the SAME document, so it updates rather than duplicating.
  assertEquals(before.docNumber, after.docNumber);
});

// ---------------------------------------------------------------------------
// AC1 and AC4 — the shape of a sale.
// ---------------------------------------------------------------------------

Deno.test("a sale carries fees, the label and cost of goods as their own lines", () => {
  const built = buildDocument(sale(), MAP);
  assert(!isBlocked(built));
  const lines = built.payload.Line as { Amount: number; SalesItemLineDetail: { ItemAccountRef: { value: string } } }[];
  assertEquals(lines.length, 5, "one line per non-zero ledger entry");
  const byAccount = new Map(
    lines.map((l) => [l.SalesItemLineDetail.ItemAccountRef.value, l.Amount]),
  );
  assertEquals(byAccount.get("1"), 180);
  assertEquals(byAccount.get("2"), 12.99);
  // Costs are NEGATIVE on the receipt. That is what makes it net to what
  // actually arrived, which is what lets the deposit reconcile.
  assertEquals(byAccount.get("3"), -28.62);
  assertEquals(byAccount.get("4"), -9.85);
  assertEquals(byAccount.get("5"), -42);
});

Deno.test("cost of goods rides on the sale, not on the purchase", () => {
  // AC4. If COGS were pushed at purchase time, gross profit in QuickBooks would
  // move a month before gross profit here and the two would never agree.
  const built = buildDocument(sale(), MAP);
  assert(!isBlocked(built));
  const lines = built.payload.Line as { SalesItemLineDetail: { ItemAccountRef: { value: string } } }[];
  assert(
    lines.some((l) => l.SalesItemLineDetail.ItemAccountRef.value === "5"),
    "the purchases account must appear on the SALE document",
  );
});

Deno.test("the receipt total is what actually arrived", () => {
  const built = buildDocument(sale(), MAP);
  assert(!isBlocked(built));
  const lines = built.payload.Line as { Amount: number }[];
  const total = lines.reduce((s, l) => s + Math.round(l.Amount * 100), 0);
  assertEquals(total, sale().total_cents);
});

Deno.test("facilitator sales tax is excluded from the total and named in the note", () => {
  // It was never the seller's money, so booking it as income would overstate
  // revenue. But an accountant looking at a $180 receipt against a 1099-K
  // showing $194.87 needs to know the gap is tax and not a missing sale.
  const built = buildDocument(sale(), MAP);
  assert(!isBlocked(built));
  const note = built.payload.PrivateNote as string;
  assert(note.includes("14.87"), `note should name the tax: ${note}`);
  assert(/1099-K/.test(note));
  const lines = built.payload.Line as { SalesItemLineDetail?: unknown }[];
  assertEquals(lines.length, 5, "the tax must not become a line");
});

Deno.test("a sale with no tax says nothing about tax", () => {
  // A note that mentions tax on every document trains the reader to skip it.
  const built = buildDocument(sale({ excluded_tax_cents: 0 }), MAP);
  assert(!isBlocked(built));
  assert(!/sales tax/i.test(built.payload.PrivateNote as string));
});

// ---------------------------------------------------------------------------
// AC2 and AC3 — expenses and payouts.
// ---------------------------------------------------------------------------

Deno.test("an expense pushes positive against its mapped account", () => {
  const built = buildDocument(expense(), MAP);
  assert(!isBlocked(built));
  assertEquals(built.entity, "purchase");
  const lines = built.payload.Line as {
    Amount: number;
    AccountBasedExpenseLineDetail: { AccountRef: { value: string } };
  }[];
  // The ledger stores an expense negative; a Purchase is positive, because the
  // document type already carries the direction. Sending -120 would book a
  // refund of $120, which is the same number pointing the wrong way.
  assertEquals(lines[0]?.Amount, 120);
  assertEquals(lines[0]?.AccountBasedExpenseLineDetail.AccountRef.value, "7");
});

Deno.test("a deposit names the sales it paid for", () => {
  const built = buildDocument(payout(), MAP, {
    bankAccountId: "8",
    payoutSales: [
      { sale_id: "s1", sale_date: "2025-07-01", title: "A jacket" },
      { sale_id: "s2", sale_date: "2025-07-02", title: "A shirt" },
    ],
  });
  assert(!isBlocked(built));
  const note = built.payload.PrivateNote as string;
  assert(note.includes("Covers 2 sales"), note);
  assert(note.includes("A jacket") && note.includes("A shirt"));
  assertEquals(
    (built.payload.DepositToAccountRef as { value: string }).value,
    "8",
  );
});

Deno.test("a deposit with no linked sales says so rather than staying silent", () => {
  // A bare deposit with an empty note reads as a bug. "No sales are linked yet"
  // reads as a thing to go and fix.
  const built = buildDocument(payout(), MAP, { bankAccountId: "8" });
  assert(!isBlocked(built));
  assert(/No sales are linked/.test(built.payload.PrivateNote as string));
});

Deno.test("a deposit without a bank account is blocked, not guessed", () => {
  const built = buildDocument(payout(), MAP, {});
  assert(isBlocked(built));
  assert(/bank account/i.test(built.reason));
});

// ---------------------------------------------------------------------------
// Blocking, and the AC4 of US-2997 that it inherits.
// ---------------------------------------------------------------------------

Deno.test("an unmapped account blocks ITS document and names the account", () => {
  const partial: AccountMap = { ...MAP };
  delete partial.platform_fees;
  const built = buildDocument(sale(), partial);
  assert(isBlocked(built));
  assertEquals(built.unmappedCodes, ["platform_fees"]);
  assert(/everything else still syncs/i.test(built.reason));
});

Deno.test("a zero-amount line does not demand a mapping", () => {
  // It would contribute nothing to the document, so blocking on it would stop a
  // sale over a line that was never going to appear.
  const doc = sale({
    lines: [
      { account_code: "sales_revenue", amount_cents: 18000, memo: null, detail: "price" },
      { account_code: "meals", amount_cents: 0, memo: null, detail: "nothing" },
    ],
  });
  assertEquals(unmappedCodes(doc, MAP), []);
  assert(!isBlocked(buildDocument(doc, MAP)));
});

Deno.test("a zero line is not sent either", () => {
  const built = buildDocument(
    sale({
      lines: [
        { account_code: "sales_revenue", amount_cents: 18000, memo: null, detail: "price" },
        { account_code: "shipping_income", amount_cents: 0, memo: null, detail: "shipping" },
      ],
    }),
    MAP,
  );
  assert(!isBlocked(built));
  assertEquals((built.payload.Line as unknown[]).length, 1);
});

// ---------------------------------------------------------------------------
// Money, and the error text.
// ---------------------------------------------------------------------------

Deno.test("cents convert without float drift", () => {
  assertEquals(centsToAmount(1), 0.01);
  assertEquals(centsToAmount(100), 1);
  assertEquals(centsToAmount(-2862), -28.62);
  assertEquals(centsToAmount(0), 0);
  // The one that catches a naive cents/100: 0.1 + 0.2 arithmetic never happens
  // here because the string is built from integer division.
  assertEquals(centsToAmount(1005), 10.05);
  assertEquals(centsToAmount(999999999), 9999999.99);
});

Deno.test("the QBO error text keeps the sentence that helps", () => {
  // AC6. Detail names the offending value; the envelope around it does not.
  const body = JSON.stringify({
    Fault: {
      Error: [{
        Message: "Invalid Reference Id",
        Detail: "Accounts element id 99 not found",
        code: "610",
      }],
    },
  });
  const text = qboErrorText(400, body);
  assert(text.includes("Accounts element id 99 not found"), text);
  assert(text.includes("Invalid Reference Id"));
});

Deno.test("a non-JSON error still says something useful", () => {
  const text = qboErrorText(502, "<html><body>Bad Gateway</body></html>");
  assert(text.includes("502"));
  assert(text.includes("Bad Gateway"));
});

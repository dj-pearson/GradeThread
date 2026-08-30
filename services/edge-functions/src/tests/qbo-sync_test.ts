import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { pushDocuments, type PushDeps, type QboRef, type SyncLogRow } from "../lib/qbo-sync.ts";
import type { AccountMap, PendingDocument, QboObjectKind } from "../lib/qbo-documents.ts";

// US-2998 AC5 — "proven by a test that runs the same push twice against a mock
// and asserts one object". This is that test, plus the four ways the property
// can be broken that are not obvious from reading the code.

const MAP: AccountMap = {
  sales_revenue: "1",
  platform_fees: "3",
  supplies: "7",
  cash_payout: "8",
};

/** An in-memory QuickBooks. Counts every write, which is the whole point. */
class FakeQbo {
  objects = new Map<string, { entity: string; payload: Record<string, unknown>; syncToken: number }>();
  creates = 0;
  updates = 0;
  finds = 0;
  failNext: string | null = null;
  private nextId = 1;

  // deno-lint-ignore require-await
  async find(entity: string, docNumber: string): Promise<QboRef | null> {
    this.finds++;
    for (const [id, o] of this.objects) {
      if (o.entity === entity && o.payload.DocNumber === docNumber) {
        return { id, syncToken: String(o.syncToken) };
      }
    }
    return null;
  }

  // deno-lint-ignore require-await
  async create(entity: string, payload: Record<string, unknown>): Promise<QboRef> {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      throw new Error(msg);
    }
    this.creates++;
    const id = String(this.nextId++);
    this.objects.set(id, { entity, payload, syncToken: 0 });
    return { id, syncToken: "0" };
  }

  // deno-lint-ignore require-await
  async update(
    entity: string,
    payload: Record<string, unknown>,
    ref: QboRef,
  ): Promise<QboRef> {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      throw new Error(msg);
    }
    this.updates++;
    const cur = this.objects.get(ref.id);
    const token = (cur?.syncToken ?? 0) + 1;
    this.objects.set(ref.id, { entity, payload, syncToken: token });
    return { id: ref.id, syncToken: String(token) };
  }
}

class FakeLog {
  rows = new Map<string, SyncLogRow & { error_text: string | null }>();
  private key(kind: QboObjectKind, sourceId: string) {
    return `${kind}:${sourceId}`;
  }
  // deno-lint-ignore require-await
  async get(kind: QboObjectKind, sourceId: string) {
    return this.rows.get(this.key(kind, sourceId)) ?? null;
  }
  // deno-lint-ignore require-await
  async put(row: SyncLogRow & { error_text: string | null }) {
    this.rows.set(this.key(row.object_kind, row.source_id), { ...row });
  }
}

function sale(id = "11111111-2222-4333-8444-555555555555"): PendingDocument {
  return {
    object_kind: "sales_receipt",
    source_id: id,
    doc_date: "2025-03-01",
    memo: "A jacket",
    currency: "USD",
    total_cents: 15138,
    excluded_tax_cents: 0,
    lines: [
      { account_code: "sales_revenue", amount_cents: 18000, memo: "A jacket", detail: "price" },
      { account_code: "platform_fees", amount_cents: -2862, memo: "Fees", detail: "fees" },
    ],
  };
}

function deps(qbo: FakeQbo, log: FakeLog, over: Partial<PushDeps> = {}): PushDeps {
  return { transport: qbo, log, map: MAP, ...over };
}

Deno.test("AC5: the same push run twice creates ONE object", async () => {
  const qbo = new FakeQbo();
  const log = new FakeLog();

  const first = await pushDocuments([sale()], deps(qbo, log));
  assertEquals(first.created, 1);

  const second = await pushDocuments([sale()], deps(qbo, log));

  assertEquals(qbo.objects.size, 1, "a second run must not add an object");
  assertEquals(qbo.creates, 1, "create must be called exactly once");
  assertEquals(second.created, 0);
  assertEquals(second.skipped, 1, "unchanged means skip, not re-push");
  assertEquals(qbo.updates, 0, "an unchanged document must not even be updated");
});

Deno.test("a changed document updates in place rather than duplicating", async () => {
  const qbo = new FakeQbo();
  const log = new FakeLog();
  await pushDocuments([sale()], deps(qbo, log));

  const edited = sale();
  edited.lines[0]!.amount_cents = 19000;
  const res = await pushDocuments([edited], deps(qbo, log));

  assertEquals(qbo.objects.size, 1);
  assertEquals(res.updated, 1);
  assertEquals(qbo.creates, 1);
  // And the sync token advanced, which QuickBooks requires on the next write.
  assertEquals(log.rows.get("sales_receipt:" + sale().source_id)?.qbo_sync_token, "1");
});

Deno.test("a lost log finds the existing document instead of duplicating it", async () => {
  // The restored-backup case, and the one a log-only design gets wrong. The
  // document is in QuickBooks; our record of it is not.
  const qbo = new FakeQbo();
  const log = new FakeLog();
  await pushDocuments([sale()], deps(qbo, log));
  assertEquals(qbo.objects.size, 1);

  log.rows.clear();
  const res = await pushDocuments([sale()], deps(qbo, log));

  assertEquals(qbo.objects.size, 1, "the document must be found, not recreated");
  assertEquals(qbo.creates, 1);
  assertEquals(res.updated, 1);
});

Deno.test("a failed push keeps the id, so the retry does not duplicate", async () => {
  const qbo = new FakeQbo();
  const log = new FakeLog();
  await pushDocuments([sale()], deps(qbo, log));

  const edited = sale();
  edited.lines[0]!.amount_cents = 19000;
  qbo.failNext = "QuickBooks returned 503";
  const failed = await pushDocuments([edited], deps(qbo, log));
  assertEquals(failed.failed, 1);
  assertEquals(failed.entries[0]?.error, "QuickBooks returned 503");

  // The row still carries the QuickBooks id. Clearing it on failure is how one
  // bad night becomes permanent duplication.
  const row = log.rows.get("sales_receipt:" + sale().source_id);
  assertEquals(row?.status, "failed");
  assert(row?.qbo_id, "the id must survive a failure");

  const retry = await pushDocuments([edited], deps(qbo, log));
  assertEquals(retry.updated, 1);
  assertEquals(qbo.objects.size, 1);
  assertEquals(qbo.creates, 1);
});

Deno.test("a blocked document is recorded with its reason and nothing is sent", async () => {
  const qbo = new FakeQbo();
  const log = new FakeLog();
  const partial: AccountMap = { sales_revenue: "1" };
  const res = await pushDocuments([sale()], deps(qbo, log, { map: partial }));

  assertEquals(res.blocked, 1);
  assertEquals(qbo.creates, 0);
  const row = log.rows.get("sales_receipt:" + sale().source_id);
  assertEquals(row?.status, "blocked");
  // AC6: the row says WHICH account is holding it up, not just that it stopped.
  assert(/platform_fees|lined up/i.test(row?.error_text ?? ""), row?.error_text ?? "");
});

Deno.test("one failure does not stop the documents behind it", async () => {
  // A run that abandons everything after the first bad document turns one
  // rejected sale into a year of missing books.
  const qbo = new FakeQbo();
  const log = new FakeLog();
  qbo.failNext = "boom";
  const res = await pushDocuments(
    [sale("aaaaaaaa-1111-4111-8111-111111111111"), sale("bbbbbbbb-2222-4222-8222-222222222222")],
    deps(qbo, log),
  );
  assertEquals(res.failed, 1);
  assertEquals(res.created, 1);
});

Deno.test("a receipt is attached after the expense exists, and never fails it", async () => {
  const qbo = new FakeQbo();
  const log = new FakeLog();
  let attachCalls = 0;
  const expense: PendingDocument = {
    object_kind: "purchase",
    source_id: "cccccccc-3333-4333-8333-333333333333",
    doc_date: "2025-06-02",
    memo: "Supplies",
    currency: "USD",
    total_cents: -12000,
    excluded_tax_cents: 0,
    lines: [{ account_code: "supplies", amount_cents: -12000, memo: "Supplies", detail: "expense" }],
  };

  const res = await pushDocuments([expense], {
    ...deps(qbo, log),
    hasReceipt: () => Promise.resolve(true),
    transport: Object.assign(qbo, {
      attachReceipt: () => {
        attachCalls++;
        throw new Error("the image was too large");
      },
    }),
  });

  assertEquals(attachCalls, 1);
  // The expense still landed. An expense in QuickBooks without its receipt is a
  // correct expense; a push that aborts on an image is a lost one.
  assertEquals(res.created, 1);
  assertEquals(res.failed, 0);
  assertEquals(res.attached, 0);
});

Deno.test("a deposit asks for its sales exactly once, and only for deposits", async () => {
  const qbo = new FakeQbo();
  const log = new FakeLog();
  let asked = 0;
  const payout: PendingDocument = {
    object_kind: "deposit",
    source_id: "dddddddd-4444-4444-8444-444444444444",
    doc_date: "2025-08-01",
    memo: "Payout",
    currency: "USD",
    total_cents: 24500,
    excluded_tax_cents: 0,
    lines: [{ account_code: "cash_payout", amount_cents: 24500, memo: "Payout", detail: "payout" }],
  };

  await pushDocuments([sale(), payout], {
    ...deps(qbo, log),
    bankAccountId: "8",
    payoutSales: () => {
      asked++;
      return Promise.resolve([{ sale_id: "s1", sale_date: "2025-07-01", title: "A jacket" }]);
    },
  });

  assertEquals(asked, 1, "the sale must not trigger a payout lookup");
  assertEquals(qbo.creates, 2);
});

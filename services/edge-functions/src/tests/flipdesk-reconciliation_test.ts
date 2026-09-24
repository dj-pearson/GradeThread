// Money M10: the auto-match sweep covers EVERY unreconciled payout, never
// offers a refunded or already-linked sale, and reports a failed read as an
// error rather than as "no match".
//
// The sweep's reads and write are injected (ReconcileSweepDeps) because
// supabaseAdmin is a Proxy that cannot be stubbed; the candidate filters, which
// live in the SQL, are pinned by a source guard below.
import "./_env.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  reconcilePayoutsForOwner,
  type ReconcileSweepDeps,
} from "../routes/flipdesk-reconciliation.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";

function payouts(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${String(i).padStart(4, "0")}`,
    user_id: OWNER,
    payout_date: "2026-09-01",
    amount: 10 + i,
    reconciled: false,
    sale_id: null,
    raw_payload: { payoutid: `PO-${i}` },
    created_at: "2026-09-01T00:00:00Z",
  }));
}

function sale(id: string, payoutRef: string | null) {
  return {
    id,
    inventory_item_id: `item-${id}`,
    sale_price: 20,
    sale_date: "2026-09-01",
    payout_amount: 15,
    payout_reference: payoutRef,
    platform_fees: 3,
    shipping_collected: 0,
    shipping_cost: 0,
    payment_processing_fees: 0,
    inventory_items: { user_id: OWNER, title: "Shirt" },
  };
}

function deps(
  rows: ReturnType<typeof payouts>,
  over: Partial<ReconcileSweepDeps> = {},
): ReconcileSweepDeps & { batches: number; links: string[] } {
  const d = {
    batches: 0,
    links: [] as string[],
    countUnreconciled: () => Promise.resolve(rows.length),
    loadPayoutBatch: (userId: string, afterId: string | null, limit: number) => {
      assertEquals(userId, OWNER);
      d.batches++;
      const start = afterId ? rows.findIndex((r) => r.id === afterId) + 1 : 0;
      return Promise.resolve(rows.slice(start, start + limit));
    },
    loadCandidateSales: () => Promise.resolve([]),
    link: (a: { payoutImportId: string }) => {
      d.links.push(a.payoutImportId);
      return Promise.resolve({ ok: true, rpcError: null });
    },
    now: () => 0,
    ...over,
  };
  return d as unknown as ReconcileSweepDeps & { batches: number; links: string[] };
}

Deno.test("M10: all 250 unreconciled payouts are scanned, in keyset batches", async () => {
  const rows = payouts(250);
  const d = deps(rows);
  const out = await reconcilePayoutsForOwner(OWNER, d);
  assertEquals(out.scanned, 250);
  assertEquals(out.total, 250);
  assertEquals(out.no_candidates, 250);
  assertEquals(out.errors, 0);
  assertEquals(d.batches, 3);
});

Deno.test("M10: a failed candidate read is counted as errors, not no_candidates", async () => {
  const d = deps(payouts(5), {
    loadCandidateSales: () => Promise.reject(new Error("statement timeout")),
  });
  const out = await reconcilePayoutsForOwner(OWNER, d);
  assertEquals(out.errors, 5);
  assertEquals(out.no_candidates, 0);
  assertEquals(out.scanned, 5);
});

Deno.test("M10: a failed payout read throws, so /run answers 500", async () => {
  const d = deps(payouts(3), {
    loadPayoutBatch: () => Promise.reject(new Error("db down")),
  });
  await assertRejects(() => reconcilePayoutsForOwner(OWNER, d));
});

Deno.test("M10: a link RPC error is counted, a conflict stays ambiguous", async () => {
  const rows = payouts(2);
  const d = deps(rows, {
    loadCandidateSales: () =>
      Promise.resolve([sale("s0", "PO-0"), sale("s1", "PO-1")] as never),
    link: (a) =>
      Promise.resolve(
        a.payoutImportId === rows[0]!.id
          ? { ok: false, rpcError: { message: "boom" } }
          : { ok: false, rpcError: null },
      ),
  });
  const out = await reconcilePayoutsForOwner(OWNER, d);
  assertEquals(out.errors, 1);
  assertEquals(out.ambiguous, 1);
  assertEquals(out.auto_matched, 0);
});

Deno.test("M10: an exact payout-id match is linked", async () => {
  const d = deps(payouts(1), {
    loadCandidateSales: () => Promise.resolve([sale("s0", "PO-0")] as never),
  });
  const out = await reconcilePayoutsForOwner(OWNER, d);
  assertEquals(out.auto_matched, 1);
  assertEquals(d.links, ["p0000"]);
});

Deno.test("M10: the sweep stops at its time budget and says how far it got", async () => {
  let t = 0;
  const d = deps(payouts(250), {
    // Each batch read costs 15s of wall clock against a 20s budget.
    now: () => t,
    loadPayoutBatch: (_u, afterId, limit) => {
      t += 15_000;
      const rows = payouts(250);
      const start = afterId ? rows.findIndex((r) => r.id === afterId) + 1 : 0;
      return Promise.resolve(rows.slice(start, start + limit));
    },
  });
  const out = await reconcilePayoutsForOwner(OWNER, d);
  assert(out.scanned < out.total, `scanned ${out.scanned} of ${out.total}`);
  assertEquals(out.total, 250);
});

Deno.test("M10: candidate sales are completed, unlinked and owner-scoped (source guard)", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-reconciliation.ts", import.meta.url),
  );
  const start = src.indexOf("async function loadCandidateSales(");
  const end = src.indexOf("function scoreCandidate(", start);
  const fn = src.slice(start, end);
  assert(start > 0 && end > start, "loadCandidateSales moved; re-point this guard");
  // Window read: owner, completed, not already linked, paged.
  assert(fn.includes('.eq("inventory_items.user_id", userId)'));
  assert(fn.includes('.eq("status", "completed")'), "refunded sales must not be candidates");
  assert(
    fn.includes('.is("payout_reference", null)'),
    "a sale already linked to a payout must not be a window candidate",
  );
  assert(fn.includes("fetchAllPages"), "the window read must be paged");
});

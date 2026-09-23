// money.md action 1: books screens and the tax packet read a stale ledger.
//
// ensureLedgerBuilt() used to rebuild only when ledger_entries was empty, so a
// sale recorded after the first build never reached the P&L, the Money
// overview, the estimated-tax cards or the accountant packet. These tests pin
// the freshness rule against a fake client that answers each table's
// "newest row" read, and a source scan that keeps the invalidation list in
// step with the screens that read the ledger.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-4111-8111-111111111111";

interface Read {
  table: string;
  filters: [string, string, string][];
}

let reads: Read[] = [];
let ledgerCount = 0;
let newest: Record<string, string | null> = {};
const rpc = vi.fn();

function builder(table: string) {
  const read: Read = { table, filters: [] };
  reads.push(read);
  const b = {
    select: () => b,
    eq: (col: string, v: string) => {
      read.filters.push(["eq", col, v]);
      return b;
    },
    neq: (col: string, v: string) => {
      read.filters.push(["neq", col, v]);
      return b;
    },
    order: () => b,
    limit: async () => {
      const stamp = newest[table] ?? null;
      const col = table === "ledger_entries" ? "created_at" : "updated_at";
      return { data: stamp ? [{ [col]: stamp }] : [], error: null };
    },
    // The head:true count read awaits the builder itself.
    then: (resolve: (v: unknown) => unknown) =>
      resolve({ count: ledgerCount, error: null }),
  };
  return b;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: (...a: unknown[]) => rpc(...a),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: USER } } } }),
    },
  },
}));

const { ensureLedgerBuilt, invalidateLedgerQueries, LEDGER_QUERY_KEYS } =
  await import("@/lib/ledger");

const BUILT = "2026-09-01T12:00:00Z";
const BEFORE = "2026-09-01T11:00:00Z";
const AFTER = "2026-09-02T09:00:00Z";

beforeEach(() => {
  reads = [];
  ledgerCount = 40;
  newest = {
    ledger_entries: BUILT,
    sales: BEFORE,
    flipdesk_expenses: BEFORE,
    mileage_trips: null,
    home_office_years: null,
    shipments: BEFORE,
    ebay_payouts: null,
  };
  rpc.mockReset();
  rpc.mockResolvedValue({ data: 41, error: null });
});

afterEach(() => vi.clearAllMocks());

describe("ensureLedgerBuilt", () => {
  it("builds an empty ledger", async () => {
    ledgerCount = 0;
    expect(await ensureLedgerBuilt()).toBe(41);
    expect(rpc).toHaveBeenCalledWith("rebuild_my_ledger");
  });

  it("leaves a ledger alone when nothing changed after the last build", async () => {
    expect(await ensureLedgerBuilt()).toBe(40);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rebuilds when a sale is recorded after the first build", async () => {
    newest.sales = AFTER;
    expect(await ensureLedgerBuilt()).toBe(41);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("rebuild_my_ledger");
  });

  it.each([
    "flipdesk_expenses",
    "mileage_trips",
    "home_office_years",
    "shipments",
    "ebay_payouts",
  ])("rebuilds when %s changed after the last build", async (table) => {
    newest[table] = AFTER;
    await ensureLedgerBuilt();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the ledger holds only hand adjustments but inputs exist", async () => {
    newest.ledger_entries = null;
    await ensureLedgerBuilt();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("dates the build from derived rows only, never from adjustments", async () => {
    await ensureLedgerBuilt();
    const ledger = reads.find(
      (r) => r.table === "ledger_entries" && r.filters.length > 0,
    );
    expect(ledger?.filters).toContainEqual(["neq", "source_kind", "adjustment"]);
  });

  it("reads only the seller's own inputs, not a workspace owner's", async () => {
    await ensureLedgerBuilt();
    for (const t of [
      "sales",
      "flipdesk_expenses",
      "mileage_trips",
      "home_office_years",
      "ebay_payouts",
    ]) {
      const r = reads.find((x) => x.table === t);
      expect(r?.filters, t).toContainEqual(["eq", "user_id", USER]);
    }
    const ship = reads.find((x) => x.table === "shipments");
    expect(ship?.filters).toContainEqual(["eq", "sales.user_id", USER]);
  });

  it("shares one check between concurrent callers", async () => {
    newest.sales = AFTER;
    await Promise.all([ensureLedgerBuilt(), ensureLedgerBuilt()]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("invalidateLedgerQueries", () => {
  it("invalidates every ledger-derived key", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    await invalidateLedgerQueries({ invalidateQueries });
    const keys = invalidateQueries.mock.calls.map((c) => c[0].queryKey[0]);
    expect(keys.sort()).toEqual([...LEDGER_QUERY_KEYS].sort());
  });
});

// Every useQuery whose queryFn reads fetchLedgerEntries has to be on the list,
// or a rebuild leaves that screen on the old books for its staleTime.
describe("LEDGER_QUERY_KEYS covers every ledger reader", () => {
  const SRC = join(__dirname, "..");
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return files(p);
      return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
    });
  }

  it("finds the readers and lists each one", () => {
    const found = new Set<string>();
    for (const f of files(SRC)) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("fetchLedgerEntries(")) continue;
      const parts = src.split(/queryKey:\s*\[/).slice(1);
      for (const part of parts) {
        const key = /^"([^"]+)"/.exec(part)?.[1];
        const body = part.split(/\n\s*\}\);/)[0] ?? "";
        if (key && body.includes("fetchLedgerEntries(")) found.add(key);
      }
    }
    // The scan must see the screens it was written against, or it is passing
    // because it stopped reading them.
    expect(found.size).toBeGreaterThanOrEqual(4);
    for (const key of found) {
      expect(LEDGER_QUERY_KEYS as readonly string[], key).toContain(key);
    }
  });

  it("the tax packet always rebuilds before it reads the ledger", () => {
    // It is the export a seller hands an accountant, so it does not trust the
    // freshness check: a deletion is invisible to that check.
    const src = readFileSync(
      join(SRC, "components", "finances", "tax-packet-card.tsx"),
      "utf8",
    );
    const gather = src.slice(src.indexOf("async function gather("));
    const rebuild = gather.indexOf("await rebuildMyLedger()");
    const read = gather.indexOf("fetchLedgerEntries(");
    expect(rebuild).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(rebuild);
    expect(gather.slice(0, read)).not.toContain("ensureLedgerBuilt(");
  });

  it("rebuild callers invalidate through the shared helper", () => {
    for (const f of files(SRC)) {
      if (f.endsWith(join("lib", "ledger.ts"))) continue;
      const src = readFileSync(f, "utf8");
      if (!src.includes("rebuildMyLedger(")) continue;
      expect(src, f).toContain("invalidateLedgerQueries(");
    }
  });
});

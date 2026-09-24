// A recording stand-in for the supabase client, for the post-sale outcome
// tests. It answers only the chain shapes lib/post-sale-outcome.ts and
// lib/post-sale-store.ts use, and records every call so a test can assert on
// WHICH rows a write would have touched.

export interface RecordedCall {
  table: string;
  op: "select" | "update";
  patch?: Record<string, unknown>;
  eq: Record<string, unknown>;
  in: Record<string, unknown[]>;
}

export interface FakeRows {
  sales?: Array<Record<string, unknown>>;
  marketplace_post_sale_cases?: Array<Record<string, unknown>>;
  listings?: Array<Record<string, unknown>>;
  inventory_items?: Array<Record<string, unknown>>;
}

export function fakeOutcomeDb(rows: FakeRows) {
  const calls: RecordedCall[] = [];
  const tables = rows as Record<string, Array<Record<string, unknown>>>;

  function matches(row: Record<string, unknown>, call: RecordedCall): boolean {
    for (const [k, v] of Object.entries(call.eq)) if (row[k] !== v) return false;
    for (const [k, vs] of Object.entries(call.in)) if (!vs.includes(row[k])) return false;
    return true;
  }

  function builder(table: string) {
    const call: RecordedCall = { table, op: "select", eq: {}, in: {} };
    let recorded = false;
    const record = () => {
      if (!recorded) calls.push(call);
      recorded = true;
    };
    const run = () => {
      record();
      const hit = (tables[table] ?? []).filter((r) => matches(r, call));
      if (call.op === "update") {
        for (const r of hit) Object.assign(r, call.patch);
      }
      return hit;
    };
    const b = {
      select(_cols?: string) {
        return b;
      },
      update(patch: Record<string, unknown>) {
        call.op = "update";
        call.patch = patch;
        return b;
      },
      eq(col: string, v: unknown) {
        call.eq[col] = v;
        return b;
      },
      limit(_n: number) {
        return b;
      },
      in(col: string, vs: unknown[]) {
        call.in[col] = vs;
        return b;
      },
      maybeSingle() {
        const hit = run();
        return Promise.resolve({ data: hit[0] ?? null, error: null });
      },
      then(resolve: (v: { data: unknown; error: null }) => unknown) {
        return Promise.resolve({ data: run(), error: null }).then(resolve);
      },
    };
    return b;
  }

  return {
    calls,
    db: { from: (table: string) => builder(table) } as never,
  };
}

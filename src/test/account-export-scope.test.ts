// ACC-3: a workspace member's export must hold only rows they own. The mocked
// client below plays RLS as it really is for a member: it returns the owner's
// rows too unless the query itself filters by user_id.
import { describe, expect, it, vi } from "vitest";

const ME = "member-1";
const OWNER = "owner-1";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  submissions: [
    { id: "s-me", user_id: ME },
    { id: "s-owner", user_id: OWNER },
  ],
  grade_reports: [
    { id: "g-me", submission_id: "s-me" },
    { id: "g-owner", submission_id: "s-owner" },
  ],
  submission_images: [
    { id: "i-me", submission_id: "s-me", storage_path: "me/a.jpg" },
    { id: "i-owner", submission_id: "s-owner", storage_path: "owner/b.jpg" },
  ],
  inventory_items: [
    { id: "inv-me", user_id: ME, acquired_price: 5 },
    { id: "inv-owner", user_id: OWNER, acquired_price: 500 },
  ],
  sales: [
    { id: "sale-me", user_id: ME, sale_price: 20, platform_fees: 2, inventory_item_id: "inv-me" },
    { id: "sale-owner", user_id: OWNER, sale_price: 900, platform_fees: 90, inventory_item_id: "inv-owner" },
  ],
};

const eqCalls: Array<[string, string, string]> = [];

function query(table: string) {
  let rows = tables[table] ?? [];
  const q = {
    select: () => q,
    eq: (col: string, val: string) => {
      eqCalls.push([table, col, val]);
      rows = rows.filter((r) => r[col] === val);
      return q;
    },
    order: () => q,
    range: async (from: number, to: number) => ({
      data: rows.slice(from, to + 1),
      error: null,
    }),
    maybeSingle: async () => ({ data: { id: ME, email: "m@example.com" }, error: null }),
  };
  return q;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => query(t),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: ME } } } }),
    },
  },
}));
vi.mock("@/lib/shipping-profile", () => ({
  fetchShippingProfile: async () => null,
}));

let zipped: Array<{ name: string; data: Uint8Array }> = [];
vi.mock("@/lib/zip", () => ({
  createZip: (files: Array<{ name: string; data: Uint8Array }>) => {
    zipped = files;
    return new Blob(["zip"]);
  },
}));

import { buildAccountExport } from "@/lib/account-export";

function file(name: string): unknown {
  const f = zipped.find((z) => z.name === name);
  if (!f) throw new Error(`${name} not in archive`);
  return JSON.parse(new TextDecoder().decode(f.data));
}

describe("buildAccountExport scopes every read to the caller", () => {
  it("filters inventory_items and sales by user_id and drops the owner's rows", async () => {
    await buildAccountExport(() => {});
    expect(eqCalls).toContainEqual(["inventory_items", "user_id", ME]);
    expect(eqCalls).toContainEqual(["sales", "user_id", ME]);
    expect(eqCalls).toContainEqual(["workspace_members", "member_id", ME]);

    const names = zipped.map((z) => z.name);
    const inv = names.find((n) => n.startsWith("inventory"))!;
    const sales = names.find((n) => n.startsWith("sales"))!;
    expect((file(inv) as Row[]).map((r) => r.id)).toEqual(["inv-me"]);
    expect((file(sales) as Row[]).map((r) => r.id)).toEqual(["sale-me"]);
    expect((file("grade_reports.json") as Row[]).map((r) => r.id)).toEqual(["g-me"]);
    const subs = file("submissions.json") as Array<Row & { image_paths: string[] }>;
    expect(subs.map((r) => r.id)).toEqual(["s-me"]);
    expect(subs[0]?.image_paths).toEqual(["me/a.jpg"]);

    const summary = file("financial_summary.json") as {
      sales: { total_revenue: number };
    };
    expect(summary.sales.total_revenue).toBe(20);
  });
});

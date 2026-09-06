// US-2168 AC5: the SQL port of the listings row-selection must return exactly
// what the client-side pipeline returned.
//
// WHY THIS TEST EXISTS IN THIS SHAPE. AC5 asks for parity "against the current
// client-side behaviour so the migration can't silently change what a tab
// shows". US-2178 built `selectListingRows` as a callable function specifically
// so that this comparison would be possible — its header says so. A parity test
// written after the port, against fixtures invented for the port, would only
// prove the new implementation agrees with itself.
//
// So both sides are run over THE SAME ROWS, and the rows come from the database:
// the corpus is inserted, then read back out of `items_full`, and those exact
// row objects are fed to the TypeScript. There is no second hand-maintained
// representation of a row that could drift from the view.
//
// The SQL side runs as the `authenticated` role with a JWT claim, not as
// `postgres`. That is deliberate: `flipdesk_listing_page` is SECURITY INVOKER and
// relies entirely on `items_full`'s `security_invoker = on` for tenant scoping,
// so running it as a superuser would bypass the very thing that makes it safe
// and would also pull in any other rows on the machine.
//
// REQUIRES A DATABASE, so it skips by default. Run it with:
//   LISTING_PARITY_DB=1 npx vitest run src/test/listing-page-sql-parity.test.ts
// against the local Supabase stack (`npx supabase start`).

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  selectListingRows,
  type SortPreset,
  type SoldFilter,
} from "@/pages/flipdesk/listings-filter";
import { TABS, type UnlistedFilter } from "@/pages/flipdesk/inventory-tabs";
import type { FilterQuery } from "@/lib/item-filter";
import type { ItemFullRow } from "@/types/database";

const ENABLED = process.env.LISTING_PARITY_DB === "1";
const CONTAINER = process.env.PARITY_PG_CONTAINER ?? "supabase_db_gradethread";
const USER_ID = "9f000000-0000-4000-8000-00000000beef";

function psql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec", "-i", CONTAINER,
      "psql", "-U", "postgres", "-d", "postgres",
      "-t", "-A", "-v", "ON_ERROR_STOP=1", "-f", "-",
    ],
    { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

/**
 * Run one statement AS THE TENANT, so RLS is the thing doing the scoping.
 *
 * The role switch and the claim-setting each emit their own line, so only the
 * LAST non-empty line is the answer. Taking the whole buffer parses `SET` as
 * JSON and fails in a way that looks like a SQL bug rather than a framing one.
 */
function asTenant(sql: string): string {
  const out = psql(
    `set role authenticated;\n` +
      `select set_config('request.jwt.claims', '{"sub":"${USER_ID}","role":"authenticated"}', false);\n` +
      sql,
  );
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/**
 * The corpus. Deliberately awkward: mixed case and numeric-suffixed brands (to
 * exercise the natural/case-insensitive collation), NULLs in every sorted
 * column (to exercise NULLS LAST in both directions), refunded and cancelled
 * sales (the US-1451 exclusion), empty strings (which JS's .filter(Boolean)
 * drops and concat_ws would not), and comps arrays that are absent, empty,
 * non-numeric and mixed.
 *
 * created_at values are distinct on purpose: ties there would make the
 * comparison depend on an ordering neither implementation promises.
 */
function corpusSql(): string {
  const rows: string[] = [];
  const q = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);
  const n = (v: number | null) => (v === null ? "null" : String(v));

  const statuses = [
    "sourced", "acquired", "cataloged", "measured", "photographed",
    "grading", "graded", "comped", "drafted", "listed", "sold",
    "shipped", "returned", "archived",
  ];
  const brands = ["Nike", "nike", "Adidas", "item9", "item10", "Item2", "", null];
  // US-3122: who bought it. Mixed case, an empty string and NULLs, because the
  // filter's isnull/notnull split and the sort's NULLS LAST both key on exactly
  // those, and a corpus of one name per row would prove neither.
  const sourcers = ["Dan", "dan", "Sam", "Alex Q", "", null];
  // `comp_set` is NOT NULL, so the "no comps" cases are JSON null and a JSON
  // object rather than SQL NULL — both are non-arrays, which is the branch that
  // matters to Array.isArray() on one side and jsonb_typeof() on the other.
  const comps = [
    "null", "[]", '[{"price": 10}]', '[{"price": "25.5"}]',
    '[{"price": 10},{"price": 99}]', '[{"price": "abc"}]', '{"not":"an array"}',
  ];

  let i = 0;
  for (const status of statuses) {
    for (let k = 0; k < 4; k++) {
      i++;
      const brand = brands[i % brands.length]!;
      const comp = comps[i % comps.length]!;
      rows.push(`(
        '${USER_ID}',
        ${q(`SKU-${i}`)},
        ${q(i % 5 === 0 ? null : `Bin ${i % 3}`)},
        ${q(`Vintage Piece ${i}`)},
        ${q(brand)},
        ${q(i % 4 === 0 ? null : `Style${i % 7}`)},
        ${q(i % 6 === 0 ? null : ["S", "M", "L", "XL"][i % 4]!)},
        ${q(i % 5 === 0 ? null : ["red", "Blue", "green"][i % 3]!)},
        ${q(i % 7 === 0 ? null : `Bin-${i % 4}`)},
        ${q(sourcers[i % sourcers.length]!)},
        '${comp}'::jsonb,
        ${n(i % 3 === 0 ? null : i * 1.5)},
        ${n(i % 4 === 0 ? null : i * 4)},
        ${n(i % 5 === 0 ? null : (i % 10) + 0.5)},
        '${status}',
        now() - interval '${i} days' - interval '3 hours',
        now() - interval '${(i * 2) % 40} days' - interval '5 hours'
      )`);
    }
  }

  return `
    delete from public.sales where user_id = '${USER_ID}';
    delete from public.listings where inventory_item_id in (select id from public.inventory_items where user_id = '${USER_ID}');
    delete from public.inventory_items where user_id = '${USER_ID}';
    delete from public.users where id = '${USER_ID}';
    delete from auth.users where id = '${USER_ID}';

    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at)
    values ('${USER_ID}', '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', 'parity@test.local', 'x', now());

    insert into public.inventory_items
      (user_id, sku, container, title, brand, style, size, color, location_bin,
       sourced_by, comp_set, acquired_price, target_price, grade_value, status,
       created_at, updated_at)
    values ${rows.join(",")};

    -- Sales for every sold/shipped/returned item, cycling the states the Sold
    -- tab and its payout filters key on.
    -- buyer_id cycles over THREE buyers across more than three sales, so some
    -- buyers genuinely repeat. Without that the repeat-buyer assertion below
    -- compares two empty sets and passes without testing anything.
    insert into public.sales
      (inventory_item_id, user_id, sale_price, sale_date, sold_at, status,
       platform_fees, payment_processing_fees, payout_amount, buyer_id)
    select i.id, '${USER_ID}',
           100 + (row_number() over (order by i.sku)),
           now() - ((row_number() over (order by i.sku)) * interval '5 days'),
           now() - ((row_number() over (order by i.sku)) * interval '5 days'),
           (array['completed','refunded','cancelled','completed'])[1 + (row_number() over (order by i.sku))::int % 4],
           (array[5, 40, 0, 2])[1 + (row_number() over (order by i.sku))::int % 4],
           0,
           (array[90, 0, 50, null])[1 + (row_number() over (order by i.sku))::int % 4],
           (array['buyer-alpha','buyer-beta','buyer-gamma'])[1 + (row_number() over (order by i.sku))::int % 3]
    from public.inventory_items i
    where i.user_id = '${USER_ID}' and i.status in ('sold','shipped','returned');

    insert into public.listings
      (inventory_item_id, platform, listing_status, listing_price, listed_at)
    select i.id, 'ebay', 'active',
           50 + (row_number() over (order by i.sku)),
           now() - ((row_number() over (order by i.sku)) * interval '2 days')
    from public.inventory_items i
    where i.user_id = '${USER_ID}' and i.status in ('listed','sold');
  `;
}

const EMPTY_FILTER: FilterQuery = { combinator: "and", rules: [] };

interface Case {
  name: string;
  tab: string;
  search?: string;
  soldFilter?: SoldFilter;
  unlistedFilter?: UnlistedFilter;
  filter?: FilterQuery;
  columnSort?: { field: string; dir: "asc" | "desc" } | null;
  sortPreset?: SortPreset;
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const t of TABS) out.push({ name: `tab ${t.id}`, tab: t.id });

  for (const preset of ["listability", "oldest", "best_roi", "highest_comp"] as SortPreset[]) {
    out.push({ name: `unlisted preset ${preset}`, tab: "unlisted", sortPreset: preset });
  }

  // 00721: the Unlisted tab's chip, applied in SQL like the Sold window.
  for (const uf of ["all", "needs_draft", "ready", "needs_review"] as UnlistedFilter[]) {
    out.push({ name: `unlisted filter ${uf}`, tab: "unlisted", unlistedFilter: uf });
  }

  // Column sorts across every type the comparator treats differently.
  for (
    const field of [
      "brand", "item_title", "size", "status", "purchase_price",
      "target_price", "grade_value", "created_at", "updated_at",
      "sale_date", "list_price", "item_number", "sourced_by",
    ]
  ) {
    for (const dir of ["asc", "desc"] as const) {
      out.push({ name: `sort ${field} ${dir}`, tab: "all", columnSort: { field, dir } });
    }
  }

  for (const search of ["nike", "NIKE", "vintage piece 1", "item1", "zzz", "50%"]) {
    out.push({ name: `search "${search}"`, tab: "all", search });
  }

  for (const sf of ["all", "awaiting_payout", "discrepancy", "d7", "d30"] as SoldFilter[]) {
    out.push({ name: `sold filter ${sf}`, tab: "sold", soldFilter: sf });
  }

  const rule = (field: string, op: string, value: string) => ({
    id: "r1", field, op, value,
  }) as unknown as FilterQuery["rules"][number];

  const filters: Array<[string, FilterQuery]> = [
    ["brand eq nike", { combinator: "and", rules: [rule("brand", "eq", "nike")] }],
    ["brand contains ke", { combinator: "and", rules: [rule("brand", "contains", "ke")] }],
    ["brand isnull", { combinator: "and", rules: [rule("brand", "isnull", "")] }],
    ["brand notnull", { combinator: "and", rules: [rule("brand", "notnull", "")] }],
    ["brand in list", { combinator: "and", rules: [rule("brand", "in", "nike, adidas")] }],
    ["brand nin list", { combinator: "and", rules: [rule("brand", "nin", "nike, adidas")] }],
    ["cost gt 20", { combinator: "and", rules: [rule("cost", "gt", "20")] }],
    ["cost lte 20", { combinator: "and", rules: [rule("cost", "lte", "20")] }],
    ["grade gte 5", { combinator: "and", rules: [rule("grade", "gte", "5")] }],
    ["size eq m", { combinator: "and", rules: [rule("size", "eq", "M")] }],
    // US-3122. `sourced_by` is the field the SQL learned in 00728; before it,
    // every one of these returned the empty set on the SQL side while the
    // TypeScript returned rows, which is the failure this case exists to catch.
    ["sourced_by eq dan", { combinator: "and", rules: [rule("sourced_by", "eq", "dan")] }],
    ["sourced_by contains a", { combinator: "and", rules: [rule("sourced_by", "contains", "a")] }],
    ["sourced_by in list", { combinator: "and", rules: [rule("sourced_by", "in", "dan, sam")] }],
    ["sourced_by nin list", { combinator: "and", rules: [rule("sourced_by", "nin", "dan, sam")] }],
    ["sourced_by isnull", { combinator: "and", rules: [rule("sourced_by", "isnull", "")] }],
    ["sourced_by notnull", { combinator: "and", rules: [rule("sourced_by", "notnull", "")] }],
    ["photo_state incomplete", { combinator: "and", rules: [rule("photo_state", "eq", "incomplete")] }],
    ["status eq listed", { combinator: "and", rules: [rule("status", "eq", "listed")] }],
    ["days_in_status gt 5", { combinator: "and", rules: [rule("days_in_status", "gt", "5")] }],
    // A numeric op on a TEXT field: always false in evalRule, so always empty.
    ["brand gt 5 (nonsense)", { combinator: "and", rules: [rule("brand", "gt", "5")] }],
    ["created_at lt date", { combinator: "and", rules: [rule("created_at", "lt", "2026-07-01")] }],
    ["created_at gte date", { combinator: "and", rules: [rule("created_at", "gte", "2026-07-01")] }],
    [
      "AND of two",
      {
        combinator: "and",
        rules: [rule("brand", "notnull", ""), rule("cost", "gt", "10")],
      },
    ],
    [
      "OR of two",
      {
        combinator: "or",
        rules: [rule("brand", "eq", "nike"), rule("size", "eq", "L")],
      },
    ],
  ];
  for (const [name, filter] of filters) {
    out.push({ name: `filter ${name}`, tab: "all", filter });
  }
  return out;
}

describe.skipIf(!ENABLED)("listings row selection: SQL matches the client (US-2168 AC5)", () => {
  let rows: ItemFullRow[] = [];
  let dbNow = 0;

  beforeAll(() => {
    psql(corpusSql());
    const json = asTenant(
      `select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at desc), '[]'::jsonb)
         from public.items_full f;`,
    ).trim();
    rows = JSON.parse(json) as ItemFullRow[];
    dbNow = new Date(psql("select now();").trim()).getTime();
  }, 120_000);

  it("seeded a corpus worth comparing against", () => {
    // Guards the guard: every assertion below passes vacuously on an empty set.
    expect(rows.length).toBeGreaterThan(50);
  });

  it.each(cases())("$name", (c) => {
    const tab = TABS.find((t) => t.id === c.tab)!;
    const expected = selectListingRows(rows, {
      tab,
      search: c.search ?? "",
      soldFilter: c.soldFilter ?? "all",
      unlistedFilter: c.unlistedFilter ?? "all",
      filterQuery: c.filter ?? EMPTY_FILTER,
      columnSort: (c.columnSort ?? null) as never,
      sortPreset: c.sortPreset ?? "listability",
      now: dbNow,
    }).map((r) => r.id);

    const ytdStart = new Date(new Date(dbNow).getFullYear(), 0, 1).toISOString();
    const raw = asTenant(
      `select public.flipdesk_listing_page(
         ${lit(c.tab)}, ${lit(c.search ?? "")}, ${lit(c.soldFilter ?? "all")},
         ${lit(JSON.stringify(c.filter ?? EMPTY_FILTER))}::jsonb,
         ${c.columnSort ? `${lit(JSON.stringify(c.columnSort))}::jsonb` : "null"},
         ${lit(c.sortPreset ?? "listability")},
         ${lit(ytdStart)}::timestamptz,
         1000, 0, null, ${lit(c.unlistedFilter ?? "all")});`,
    ).trim();
    const page = JSON.parse(raw) as { total: number; rows: ItemFullRow[] };
    const actual = page.rows.map((r) => r.id);

    // Same rows, in the same order. Order is half the contract: a tab that
    // shows the right set in the wrong order is still a changed page.
    expect(actual).toEqual(expected);
    // And `total` is what the pager renders, so it has to match the set size
    // rather than the page size.
    expect(page.total).toBe(expected.length);
  });

  // Both of these are numbers the page derives from the WHOLE set today, so
  // both are exactly what a naive server-side swap would quietly turn into
  // per-page numbers — right-looking, smaller, and attributable to nothing.
  it.each(["all", "awaiting_payout", "discrepancy", "d7", "d30"] as SoldFilter[])(
    "soldAgg matches the client strip for sold filter %s",
    (soldFilter) => {
      const tab = TABS.find((t) => t.id === "sold")!;
      const filtered = selectListingRows(rows, {
        tab,
        search: "",
        soldFilter,
        unlistedFilter: "all",
        filterQuery: EMPTY_FILTER,
        columnSort: null,
        sortPreset: "listability",
        now: dbNow,
      });
      // The client's own arithmetic, copied from listings.tsx's soldAgg memo.
      let gross = 0, net = 0, marginSum = 0, marginN = 0;
      for (const it of filtered) {
        gross += it.sale_price ?? 0;
        net += it.net_profit ?? 0;
        if (it.sale_price != null && it.sale_price > 0 && it.net_profit != null) {
          marginSum += (it.net_profit / it.sale_price) * 100;
          marginN += 1;
        }
      }

      const raw = asTenant(
        `select public.flipdesk_listing_page('sold', '', ${lit(soldFilter)},
           '{"combinator":"and","rules":[]}'::jsonb, null, 'listability', null, 5, 0);`,
      ).trim();
      const agg = (JSON.parse(raw) as {
        soldAgg: { count: number; gross: number; net: number; avgMargin: number | null };
      }).soldAgg;

      // Over `base`, i.e. the filtered set — NOT the 5-row page requested above.
      expect(agg.count).toBe(filtered.length);
      expect(Number(agg.gross)).toBeCloseTo(gross, 6);
      expect(Number(agg.net)).toBeCloseTo(net, 6);
      if (marginN === 0) {
        expect(agg.avgMargin).toBeNull();
      } else {
        expect(Number(agg.avgMargin)).toBeCloseTo(marginSum / marginN, 6);
      }
    },
  );

  it("buyerCounts counts a buyer across the account, not the page", () => {
    const raw = asTenant(
      `select public.flipdesk_listing_page('sold', '', 'all',
         '{"combinator":"and","rules":[]}'::jsonb, null, 'listability', null, 3, 0);`,
    ).trim();
    const page = JSON.parse(raw) as {
      rows: ItemFullRow[];
      buyerCounts: Record<string, number>;
    };

    // The client's version: count every row with this buyer, over everything.
    const expected = new Map<string, number>();
    for (const it of rows) {
      if (it.buyer_id) expected.set(it.buyer_id, (expected.get(it.buyer_id) ?? 0) + 1);
    }

    const pageBuyers = [...new Set(page.rows.map((r) => r.buyer_id).filter(Boolean))];
    // Guards the guard: with no buyers seeded both sides are empty and this
    // whole test asserts nothing.
    expect(pageBuyers.length).toBeGreaterThan(0);
    expect(Object.keys(page.buyerCounts).sort()).toEqual([...pageBuyers].sort() as string[]);
    for (const b of pageBuyers) {
      expect(Number(page.buyerCounts[b as string])).toBe(expected.get(b as string));
    }
  });

  it("paginates without dropping or repeating a row", () => {
    // The reason the sort needs a strict total order. With a non-unique ORDER BY
    // the planner may order ties differently per call, and a row can appear on
    // two pages while another appears on none — a bug that only shows up once
    // the seller clicks to page 2.
    const tab = TABS.find((t) => t.id === "all")!;
    const all = selectListingRows(rows, {
      tab,
      search: "",
      soldFilter: "all",
      unlistedFilter: "all",
      filterQuery: EMPTY_FILTER,
      columnSort: null,
      sortPreset: "listability",
      now: dbNow,
    }).map((r) => r.id);

    const paged: string[] = [];
    for (let offset = 0; offset < all.length; offset += 7) {
      const raw = asTenant(
        `select public.flipdesk_listing_page('all', '', 'all',
           '{"combinator":"and","rules":[]}'::jsonb, null, 'listability', null, 7, ${offset});`,
      ).trim();
      const page = JSON.parse(raw) as { rows: ItemFullRow[] };
      paged.push(...page.rows.map((r) => r.id));
    }
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(paged.length);
  });
});

function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

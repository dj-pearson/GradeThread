// Worth My Time: buildPlan and planToSessionTasks, driven end to end over a
// fake Supabase client. The page suite mocks buildPlan away, so this is where
// what the pipeline actually hands the page is held.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Recorded {
  table: string;
  calls: Array<[string, unknown[]]>;
}
const reads: Recorded[] = [];
let tables: Record<string, unknown[]> = {};
let failTable: string | null = null;
let authState: { activeWorkspaceOwnerId: string | null; user: { id: string } | null } = {
  activeWorkspaceOwnerId: null,
  user: { id: "owner-1" },
};

/** A chainable, awaitable stand-in for a supabase-js query builder. */
function builder(table: string) {
  const rec: Recorded = { table, calls: [] };
  reads.push(rec);
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "not", "in", "order", "limit", "gte", "lte"]) {
    b[m] = (...args: unknown[]) => {
      rec.calls.push([m, args]);
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) =>
    resolve(
      failTable === table
        ? { data: null, error: { message: `${table} failed` } }
        : { data: tables[table] ?? [], error: null },
    );
  return b;
}

vi.mock("@/lib/supabase", () => ({ supabase: { from: (t: string) => builder(t) } }));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => authState },
}));
vi.mock("@/lib/auth-token", () => ({
  getFreshAccessToken: () => Promise.resolve("token"),
}));
vi.mock("@/lib/edge-api", () => ({ edgeApiUrl: () => "https://edge.test" }));

const { buildPlan, planToSessionTasks } = await import("@/hooks/use-planner");

const NOW = "2026-09-21T12:00:00.000Z";

function item(over: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    item_title: "Carhartt Detroit jacket",
    status: "measured",
    measurements: { chest: 22 },
    has_required_photos: false,
    target_price: 50,
    listing_id: null,
    grade_value: null,
    location_bin: "A-14",
    container: null,
    listing_platform: "ebay",
    sale_status: null,
    sale_cancelled_at: null,
    sale_date: null,
    purchase_price: 5,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-02T00:00:00.000Z",
    ...over,
  };
}

function book(overrides: unknown[] = [], suppressions: unknown[] = []) {
  return { overrides, suppressions, now: NOW } as never;
}

const BASE = {
  budgetMinutes: 60,
  workContext: "home" as const,
  availableTools: ["camera", "measuring_tape", "steamer", "packing_supplies"],
  hourlyTargetCents: null,
  now: NOW,
};

beforeEach(() => {
  reads.length = 0;
  tables = { items_full: [item()] };
  failTable = null;
  authState = { activeWorkspaceOwnerId: null, user: { id: "owner-1" } };
});

describe("one resolved duration per task (WMT-04)", () => {
  it("rows plus their setup add up to the headline minutes", async () => {
    tables.items_full = [
      item(),
      item({ id: "item-2", measurements: null, status: "cataloged" }),
    ];
    const built = await buildPlan({ ...BASE, book: book() });
    expect(built.plan.tasks.length).toBeGreaterThan(0);
    const sum = built.plan.tasks.reduce(
      (s, t) => s + t.activeMinutes + t.overheadMinutes,
      0,
    );
    expect(sum).toBe(built.plan.plannedMinutes);
  });

  it("a 25-minute photograph override moves the plan, the row and the session snapshot", async () => {
    const before = await buildPlan({ ...BASE, book: book() });
    const after = await buildPlan({
      ...BASE,
      book: book([{
        inventoryItemId: "item-1",
        actionKey: "photograph",
        kind: "task_minutes",
        value: { amount: 25, lowCents: null, highCents: null },
        originalValue: null,
        source: "seller",
        updatedAt: NOW,
      }]),
    });
    const r = after.ranked.find((x) => x.key === "item-1:photograph")!;
    expect(r.duration?.typical).toBe(25);
    expect(r.duration?.source).toBe("seller");
    const row = after.plan.tasks.find((t) => t.key === "item-1:photograph")!;
    // The scheduler charges the HIGH end of the SAME resolved estimate.
    expect(row.activeMinutes).toBe(r.duration!.high);
    expect(after.plan.plannedMinutes).not.toBe(before.plan.plannedMinutes);
    const sent = planToSessionTasks(after).find((t) => t.action_key === "photograph")!;
    expect(sent.estimate_minutes).toBe(25);
  });
});

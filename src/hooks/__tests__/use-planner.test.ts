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

describe("the value snapshot travels with the task (WMT-05)", () => {
  it("the session records WHERE the price came from, in a source the scorecard knows", async () => {
    const { EVIDENCE_SOURCES } = await import("@/lib/work-value");
    const built = await buildPlan({ ...BASE, book: book() });
    const sent = planToSessionTasks(built);
    expect(sent.length).toBeGreaterThan(0);
    for (const t of sent) {
      expect(t.estimate_source).toBe("seller_estimate");
      expect(EVIDENCE_SOURCES as readonly unknown[]).toContain(t.estimate_source);
    }
  });

  it("divides by the whole chain: the ranked task carries every step left", async () => {
    const built = await buildPlan({ ...BASE, book: book() });
    const c = built.candidates.find((x) => x.key === "item-1:photograph")!;
    // Measured, target price set, no draft yet: photograph, then the draft,
    // then publish.
    expect(c.remainingActions).toEqual(["photograph", "draft_review", "publish"]);
  });
});

describe("tool-gated work is counted, and a paid parcel always shows (WMT-06)", () => {
  it("camera-only: the measure jobs are counted, and the sold parcel is in the plan, flagged", async () => {
    tables.items_full = [
      item({ id: "m1", measurements: null, status: "cataloged" }),
      item({ id: "m2", measurements: null, status: "cataloged" }),
      item({ id: "sold", status: "sold", sale_date: "2026-09-20T00:00:00.000Z" }),
    ];
    const built = await buildPlan({ ...BASE, availableTools: ["camera"], book: book() });
    expect(built.gated.map((g) => g.itemId)).toEqual(["m1", "m2"]);
    expect(built.gated.every((g) => g.missing.includes("measuring_tape"))).toBe(true);
    const parcel = built.ranked.find((r) => r.key === "sold:pack_ship");
    expect(parcel).toBeTruthy();
    expect(parcel!.conflict?.kind).toBe("tools_missing");
    expect(built.plan.tasks.some((t) => t.key === "sold:pack_ship")).toBe(true);
  });
});

describe("the plan read (WMT-07)", () => {
  it("reads only rows that can be work, oldest first", async () => {
    await buildPlan({ ...BASE, book: book() });
    const read = reads.find((r) => r.table === "items_full")!;
    const not = read.calls.find(([m]) => m === "not")!;
    expect(not[1][0]).toBe("status");
    expect(not[1][1]).toBe("in");
    const list = String(not[1][2]);
    for (const s of ["listed", "archived", "completed", "shipped", "returned"]) {
      expect(list).toContain(s);
    }
    expect(list).not.toContain("sourced");
    expect(read.calls.find(([m]) => m === "order")![1]).toEqual([
      "updated_at",
      { ascending: true },
    ]);
    expect(read.calls.find(([m]) => m === "eq")![1]).toEqual(["user_id", "owner-1"]);
  });

  it("a signed-out seller is told so, not shown an empty stock", async () => {
    authState = { activeWorkspaceOwnerId: null, user: null };
    await expect(buildPlan({ ...BASE, book: book() })).rejects.toThrow("You must be signed in.");
    expect(reads.length).toBe(0);
  });

  it("a failed corrections read REFUSES the build rather than un-dismissing jobs", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", () =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "down" }),
      } as unknown as Response));
    try {
      await expect(buildPlan({ ...BASE }, qc)).rejects.toThrow("down");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("with a query client, the corrections are read fresh and used", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(String(url));
      const body = String(url).includes("/overrides")
        ? {
          overrides: [],
          suppressions: [{
            id: "s", inventory_item_id: "item-1", action_key: null, kind: "dismiss",
            session_id: null, until: null, created_at: NOW,
          }],
          now: NOW,
        }
        : { observations: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
    });
    try {
      const built = await buildPlan({ ...BASE }, qc);
      expect(urls.some((u) => u.endsWith("/api/flipdesk/planner/overrides"))).toBe(true);
      expect(built.suppressed).toEqual([
        { itemId: "item-1", actionKey: "photograph", reason: "dismiss" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

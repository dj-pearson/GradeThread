// US-1869: Inventory Equity — per-item liquidation value + tenant aggregate.
//
// Shows the reseller the estimated liquidation value of their GRADED inventory
// (the capital on their racks). Phase-1 DISPLAY-ONLY (US-1868 scope fence — no
// lending). The conservative valuation MATH lives in the pure lib/inventory-
// equity.ts; this route is the tenant-scoped I/O shell.
//
// Tenancy (US-268): every read is scoped to the caller's OWN tenant
// (inventory_items / sales / listings all filtered by user_id =
// workspaceOwnerId). No cross-tenant rows are read; no id flows from the body.
//
// Cost (AC2): composes ONLY cached per-item comps (inventory_items.comp_set) —
// ZERO new eBay Browse / AI calls. Personal sell-through velocity is derived
// from the seller's own realized sales. Mounted at /api/flipdesk/equity,
// inheriting authMiddleware + workspaceMiddleware.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireFlipdesk } from "../lib/plan-gate.ts";
import { isFeatureEnabled } from "../lib/feature-flags.ts";
import {
  aggregateEquity,
  type EquityItem,
  liquidationValue,
  marketMedianFromComps,
} from "../lib/inventory-equity.ts";

// Minimal shape of one cached comp in inventory_items.comp_set (the edge project
// can't import the frontend types).
interface ItemComp {
  price?: number;
  source?: string;
}

export const flipdeskEquityRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

const MS_PER_DAY = 86_400_000;
const INVENTORY_CAP = 5000;
const SALES_CAP = 1000;
// Unsold inventory = held capital. Sold/shipped/completed/archived are realized,
// not equity on the racks.
const REALIZED_STATUSES = "(sold,shipped,completed,archived)";

function toNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number.parseFloat(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

// Count-based confidence in a cached comp median (mirrors condition-value's
// generosity: 3 comps → ~0.45, 13+ → 0.95).
function compConfidence(count: number): number {
  return Math.max(0, Math.min(0.95, 0.3 + count * 0.05));
}

interface ItemRow {
  id: string;
  title: string | null;
  brand: string | null;
  item_category: string | null;
  garment_category: string | null;
  grade_value: number | null;
  comp_set: ItemComp[] | null;
  created_at: string;
}

// The seller's OWN median days-to-sell (listed_at → sold), or null when they
// have no realized listed→sold history yet. Tenant-scoped.
async function personalSellThroughDays(owner: string): Promise<number | null> {
  const { data: salesRaw } = await supabaseAdmin
    .from("sales")
    .select("inventory_item_id, sale_date, sold_at")
    .eq("user_id", owner)
    .order("sale_date", { ascending: false })
    .limit(SALES_CAP);
  const sales = (salesRaw ?? []) as Array<
    { inventory_item_id: string; sale_date: string | null; sold_at: string | null }
  >;
  const itemIds = [...new Set(sales.map((s) => s.inventory_item_id).filter(Boolean))];
  if (itemIds.length === 0) return null;

  const { data: listingsRaw } = await supabaseAdmin
    .from("listings")
    .select("inventory_item_id, listed_at")
    .eq("user_id", owner)
    .in("inventory_item_id", itemIds);
  const listedByItem = new Map<string, number>();
  for (const l of (listingsRaw ?? []) as Array<{ inventory_item_id: string; listed_at: string | null }>) {
    const t = l.listed_at ? Date.parse(l.listed_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const prev = listedByItem.get(l.inventory_item_id);
    if (prev == null || t < prev) listedByItem.set(l.inventory_item_id, t);
  }

  const days: number[] = [];
  for (const s of sales) {
    const soldAt = s.sold_at ?? s.sale_date;
    const listedMs = listedByItem.get(s.inventory_item_id);
    if (!soldAt || listedMs == null) continue;
    const soldMs = Date.parse(soldAt);
    if (!Number.isFinite(soldMs) || soldMs < listedMs) continue;
    days.push(Math.round((soldMs - listedMs) / MS_PER_DAY));
  }
  return median(days);
}

// Compute the full equity picture for one owner from CACHED comps (zero eBay/AI
// calls). Tenant-scoped by `owner`. Shared by the GET route and the nightly
// snapshot job (US-1870) so both agree exactly.
export async function computeEquityForOwner(owner: string) {
  const nowMs = Date.now();
  const [velocity, { data: itemsRaw }, { data: listingsRaw }] = await Promise.all([
    personalSellThroughDays(owner),
    supabaseAdmin
      .from("inventory_items")
      .select("id, title, brand, item_category, garment_category, grade_value, comp_set, created_at")
      .eq("user_id", owner)
      .not("status", "in", REALIZED_STATUSES)
      .limit(INVENTORY_CAP),
    supabaseAdmin
      .from("listings")
      .select("inventory_item_id, listed_at")
      .eq("user_id", owner)
      // US-2029: bound it. The inventory read beside it has always been capped
      // at INVENTORY_CAP, but this one pulled the owner's ENTIRE listing
      // history — including every long-since-sold listing — on a path the
      // nightly snapshot runs for every seller. It only feeds a
      // listed_at lookup for CURRENT inventory, so the same cap is the right
      // bound: a listing with no matching unsold item contributes nothing.
      .limit(INVENTORY_CAP),
  ]);

  const items = (itemsRaw ?? []) as ItemRow[];
  // Earliest listed_at per item → the staleness clock start.
  const listedByItem = new Map<string, number>();
  for (const l of (listingsRaw ?? []) as Array<{ inventory_item_id: string; listed_at: string | null }>) {
    const t = l.listed_at ? Date.parse(l.listed_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const prev = listedByItem.get(l.inventory_item_id);
    if (prev == null || t < prev) listedByItem.set(l.inventory_item_id, t);
  }

  const perItem = items.map((it) => {
    const comps = (it.comp_set ?? [])
      .map((c) => ({ cents: Math.round((toNum(c.price) ?? 0) * 100) }))
      .filter((c) => c.cents > 0);
    const marketMedianCents = marketMedianFromComps(comps);
    const grade = toNum(it.grade_value);
    const listedMs = listedByItem.get(it.id) ?? Date.parse(it.created_at);
    const daysListed = Number.isFinite(listedMs)
      ? Math.max(0, Math.round((nowMs - listedMs) / MS_PER_DAY))
      : null;
    const liquidation = liquidationValue({
      marketMedianCents,
      marketConfidence: compConfidence(comps.length),
      gradeValue: grade != null && grade >= 0 && grade <= 10 ? grade : null,
      personalSellThroughDays: velocity,
      daysListed,
    });
    const category = (it.item_category ?? it.garment_category ?? "").trim() || null;
    const brand = (it.brand ?? "").trim() || null;
    return {
      id: it.id,
      title: it.title,
      category,
      brand,
      gradeValue: grade,
      valued: liquidation.valued,
      reason: liquidation.reason ?? null,
      liquidationCents: liquidation.liquidationCents,
      lowCents: liquidation.lowCents,
      highCents: liquidation.highCents,
      confidence: liquidation.confidence,
    };
  });

  const aggregate = aggregateEquity(
    perItem.map((p): EquityItem => ({
      liquidation: {
        valued: p.valued,
        reason: p.reason ?? undefined,
        liquidationCents: p.liquidationCents,
        lowCents: p.lowCents,
        highCents: p.highCents,
        confidence: p.confidence,
      },
      category: p.category,
      brand: p.brand,
      gradeValue: p.gradeValue,
    })),
  );

  return { currency: "USD", personalSellThroughDays: velocity, aggregate, items: perItem };
}

flipdeskEquityRoutes.get("/", async (c) => {
  const owner = c.get("workspaceOwnerId") ?? c.get("userId");

  const gate = await requireFlipdesk(c, { userId: owner });
  if (gate) return gate;
  if (!(await isFeatureEnabled("inventory_equity"))) {
    return c.json({ error: "Inventory Equity is not enabled." }, 404);
  }

  return c.json(await computeEquityForOwner(owner));
});

// US-1870: equity-over-time trend — the caller's own daily snapshots (newest
// first), written by the nightly job. Tenant-scoped.
flipdeskEquityRoutes.get("/trend", async (c) => {
  const owner = c.get("workspaceOwnerId") ?? c.get("userId");
  const gate = await requireFlipdesk(c, { userId: owner });
  if (gate) return gate;

  const { data } = await supabaseAdmin
    .from("inventory_equity_snapshots")
    .select("snapshot_date, total_equity_cents, total_low_cents, total_high_cents, valued_count, unvalued_count")
    .eq("user_id", owner)
    .order("snapshot_date", { ascending: false })
    .limit(120);

  const points = ((data ?? []) as Array<{
    snapshot_date: string;
    total_equity_cents: number;
    total_low_cents: number;
    total_high_cents: number;
    valued_count: number;
    unvalued_count: number;
  }>).reverse(); // oldest→newest for charting
  return c.json({ currency: "USD", points });
});

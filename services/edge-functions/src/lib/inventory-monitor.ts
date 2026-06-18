// Inventory low-stock / stockout monitoring (US-1056).
//
// A listing's available quantity falling to (or below) a configurable threshold
// — or to zero — should tell the seller so they can replenish or relist before
// the listing goes dark. The threshold lives in the system_settings registry
// (00207/00208) so operators retune it deploy-free.
//
// The decision is split into pure functions (no DB) so the crossing logic is
// trivially unit-testable, with one async emitter that reads the threshold and
// fires the notification. Alerts fire only on a DOWNWARD crossing into a worse
// level — a steady-state sync that re-reports the same low quantity never
// re-notifies.

import { getSetting } from "./system-settings.ts";
import { notifyUser } from "./notify.ts";

export const LOW_STOCK_THRESHOLD_SETTING_KEY = "inventory_low_stock_threshold";
// Warn when only the last unit remains; a quantity of 0 is a stockout.
export const DEFAULT_LOW_STOCK_THRESHOLD = 1;

export type StockLevel = "ok" | "low_stock" | "stockout";

// Severity ranking so a crossing is only "down" when the new level is worse.
const RANK: Record<StockLevel, number> = { ok: 0, low_stock: 1, stockout: 2 };

/** Classify a single quantity against the threshold. */
export function classifyStockLevel(
  quantity: number,
  threshold: number,
): StockLevel {
  if (!Number.isFinite(quantity) || quantity <= 0) return "stockout";
  if (quantity <= threshold) return "low_stock";
  return "ok";
}

/**
 * The alert to emit for a quantity change, or null when nothing should fire.
 * Returns a level only when `newQty` lands in a worse level than `prevQty`
 * (prevQty null ⇒ treat as a fresh observation, so any non-ok level alerts).
 */
export function stockTransition(
  prevQty: number | null,
  newQty: number,
  threshold: number,
): "low_stock" | "stockout" | null {
  const next = classifyStockLevel(newQty, threshold);
  if (next === "ok") return null;
  const prev = prevQty == null ? "ok" : classifyStockLevel(prevQty, threshold);
  if (RANK[next] <= RANK[prev]) return null;
  return next;
}

/** Read + sanitize the configured low-stock threshold (non-negative integer). */
export async function getLowStockThreshold(): Promise<number> {
  const raw = await getSetting<number>(
    LOW_STOCK_THRESHOLD_SETTING_KEY,
    DEFAULT_LOW_STOCK_THRESHOLD,
  );
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0
    ? Math.trunc(n)
    : DEFAULT_LOW_STOCK_THRESHOLD;
}

export interface StockEvent {
  /** Already ownership-resolved owner id (workspace owner for shared tenants). */
  userId: string;
  listingId: string;
  /** Linked inventory item, for a deep link when present. */
  itemId?: string | null;
  /** Listing title, for the message. */
  title?: string | null;
  prevQty: number | null;
  newQty: number;
}

/**
 * Emit a `low_stock` notification when a listing crosses down into low-stock /
 * stockout. Reads the threshold from system_settings (cached) unless one is
 * supplied (callers processing a batch pass it once to avoid re-reading).
 * Returns the level emitted, or null when nothing fired. Best-effort — never
 * throws, so a notification problem can't break the sync that triggered it.
 */
export async function notifyStockLevel(
  ev: StockEvent,
  threshold?: number,
): Promise<"low_stock" | "stockout" | null> {
  try {
    const t = threshold ?? (await getLowStockThreshold());
    const transition = stockTransition(ev.prevQty, ev.newQty, t);
    if (!transition) return null;

    const name = ev.title?.trim() || "An item";
    const link = ev.itemId
      ? `/dashboard/flipdesk/items/${ev.itemId}`
      : "/dashboard/flipdesk/pipeline";
    const { title, message } =
      transition === "stockout"
        ? {
            title: "Out of stock",
            message: `${name} is out of stock on its marketplace — relist to keep selling.`,
          }
        : {
            title: "Low stock",
            message: `${name} is running low — ${ev.newQty} left.`,
          };

    await notifyUser(ev.userId, { type: "low_stock", title, message, link });
    return transition;
  } catch (err) {
    console.error(
      `[inventory-monitor] notify failed for listing ${ev.listingId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

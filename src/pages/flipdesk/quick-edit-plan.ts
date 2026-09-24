// US-3467: what the Inventory quick-edit panel has to write, worked out before
// anything is sent.
//
// The panel edits seven fields that live in three places, and each place has
// its own save path with its own side effects:
//
// - title, asking price, cost, bin and notes are plain inventory_items
//   columns, written together in one update;
// - status goes through updateItemStatus, which also moves the listing row
//   back to draft when the seller re-drafts an item;
// - the listed price goes through updateListingPrice, which pushes to the
//   marketplace and only writes our row when the marketplace accepted it.
//
// Only fields that actually changed are sent. Sending an unchanged listed price
// would re-push it to eBay on every save.
import type { ItemFullRow, ItemStatus } from "@/types/database";

export interface QuickEditForm {
  title: string;
  status: ItemStatus;
  listPrice: string;
  targetPrice: string;
  cost: string;
  bin: string;
  notes: string;
}

export interface QuickEditPlan {
  /** User-facing reasons nothing may be saved yet. Empty when the form is valid. */
  errors: string[];
  /** inventory_items columns to write in one update. */
  base: Record<string, string | number | null>;
  /** The same change under items_full's names, for the optimistic cache patch. */
  view: Partial<ItemFullRow>;
  /** Set only when the status changed. */
  status: ItemStatus | null;
  /** Set only when the listed price changed on an item that has a listing. */
  listPrice: number | null;
  /** True when at least one field would be written. */
  changed: boolean;
  /**
   * INV-9: things worth a second look that do not block a save, e.g. a live
   * price dropping by more than 40% or below cost.
   */
  warnings: string[];
  /**
   * INV-9: a LIVE listing's price changes. Stepping to the next row with j/k
   * must not push that silently; the seller presses Save.
   */
  needsExplicitSave: boolean;
  /**
   * INV-9: the chosen status records a sale (Sold / Shipped / Completed). That
   * goes through Record Sale, which writes the sale row, not a bare status.
   */
  recordsSale: boolean;
}

/** Statuses that mean a sale happened. Setting them needs a sale record. */
export const SALE_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  "sold",
  "shipped",
  "completed",
] as ItemStatus[]);

/** INV-9: a live price cut past this fraction asks for a second look. */
export const BIG_DROP_FRACTION = 0.4;

export function formFromItem(it: ItemFullRow): QuickEditForm {
  return {
    title: it.item_title ?? "",
    status: it.status,
    listPrice: moneyText(it.list_price),
    targetPrice: moneyText(it.target_price),
    cost: moneyText(it.purchase_price),
    bin: it.location_bin ?? "",
    notes: it.notes ?? "",
  };
}

function moneyText(n: number | null | undefined): string {
  return n == null ? "" : String(n);
}

/** Blank is null. Anything else must be a finite, non-negative number. */
function parseMoney(raw: string): { ok: true; value: number | null } | { ok: false } {
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: Math.round(n * 100) / 100 };
}

function textOrNull(raw: string): string | null {
  const t = raw.trim();
  return t === "" ? null : t;
}

export function planQuickEdit(it: ItemFullRow, form: QuickEditForm): QuickEditPlan {
  const errors: string[] = [];
  const base: Record<string, string | number | null> = {};
  const view: Partial<ItemFullRow> = {};

  const title = form.title.trim();
  if (title === "") {
    errors.push("Title can't be blank.");
  } else if (title !== (it.item_title ?? "").trim()) {
    base.title = title;
    view.item_title = title;
  }

  const money: Array<{
    raw: string;
    label: string;
    current: number | null | undefined;
    column: string;
    viewKey: "target_price" | "purchase_price";
  }> = [
    { raw: form.targetPrice, label: "Asking price", current: it.target_price, column: "target_price", viewKey: "target_price" },
    { raw: form.cost, label: "Cost", current: it.purchase_price, column: "acquired_price", viewKey: "purchase_price" },
  ];
  for (const m of money) {
    const p = parseMoney(m.raw);
    if (!p.ok) {
      errors.push(`${m.label} must be a number, 0 or more.`);
      continue;
    }
    if (p.value !== (m.current ?? null)) {
      base[m.column] = p.value;
      view[m.viewKey] = p.value;
    }
  }

  const bin = textOrNull(form.bin);
  if (bin !== (it.location_bin ?? null)) {
    base.location_bin = bin;
    view.location_bin = bin;
  }

  const notes = textOrNull(form.notes);
  if (notes !== (it.notes ?? null)) {
    base.condition_notes = notes;
    view.notes = notes;
  }

  const status = form.status !== it.status ? form.status : null;

  const warnings: string[] = [];
  let listPrice: number | null = null;
  if (it.listing_id) {
    const p = parseMoney(form.listPrice);
    if (!p.ok) {
      errors.push("Listed price must be a number, 0 or more.");
    } else if (p.value === null) {
      // A listing always has a price. Clearing the box is not "no price".
      if (it.list_price != null) errors.push("Listed price can't be blank.");
    } else if (p.value !== (it.list_price ?? null)) {
      listPrice = p.value;
    }
  }

  // INV-9: the seller's own floor is a hard stop, the same rule the bulk
  // markdown applies. A typo like 4.99 for 49.99 must not go live.
  const floor = it.floor_price ?? null;
  if (listPrice != null && floor != null && listPrice < floor) {
    errors.push(`Listed price is below your floor of $${floor.toFixed(2)}.`);
  }
  const live = it.listing_status === "active";
  if (listPrice != null && live) {
    const current = it.list_price ?? null;
    if (current != null && current > 0 && listPrice < current * (1 - BIG_DROP_FRACTION)) {
      warnings.push(
        `That cuts the live price by ${Math.round((1 - listPrice / current) * 100)}%.`,
      );
    }
    const cost = it.purchase_price ?? null;
    if (cost != null && listPrice < cost) {
      warnings.push(`That is below what you paid ($${cost.toFixed(2)}).`);
    }
  }

  return {
    errors,
    base,
    view,
    status,
    listPrice,
    changed: Object.keys(base).length > 0 || status !== null || listPrice !== null,
    warnings,
    needsExplicitSave: live && listPrice != null,
    recordsSale: status != null && SALE_STATUSES.has(status),
  };
}

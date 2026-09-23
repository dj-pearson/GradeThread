import { Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { NextActionBadge } from "@/components/flipdesk/next-action-badge";
import { cn } from "@/lib/utils";
import { itemDisplayTitle, itemRowLabel } from "@/lib/item-row-label";
import { estimateListingProfit } from "@/lib/listing-profit";
import { estimateParcel } from "@/lib/parcel-estimate";
import { estimatePostage } from "@/lib/shipping-rates";
import type { ItemFullRow } from "@/types/database";

// INV-10: to the cent. A live $24.99 read as "$25" on a phone and as $24.99
// on the marketplace, and the card is where a seller checks the price.
function money(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null;
  return `$${n.toFixed(2)}`;
}

// Mobile-friendly card list for the inventory/listings tables — rendered
// below the md breakpoint in place of the horizontal-scroll table. Each card
// carries the fields a reseller triages on (title, SKU, status, price, next
// action, grade) and taps through to the same item detail the table row does.
//
// US-961: on selectable tabs each card also renders a selection checkbox (wired
// to the same shared `selected` Set the desktop table + sticky action bar use)
// and a quick-edit pencil that opens the per-card quick-edit drawer. The
// checkbox + pencil sit OUTSIDE the main tap target (separate buttons) so the
// card body still opens the full detail dialog.
export function ItemCardList({
  items,
  onOpen,
  selectable = false,
  selectedIds,
  onToggleSelect,
  onQuickEdit,
  showSourcer = false,
}: {
  items: ItemFullRow[];
  onOpen: (item: ItemFullRow) => void;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onQuickEdit?: (item: ItemFullRow) => void;
  /**
   * US-3122: show who sourced the item. The caller turns this on while the
   * list is ORDERED by `sourced_by`, so the ordering is legible on a phone
   * too; off, the card carries the same fields it always did.
   */
  showSourcer?: boolean;
}) {
  return (
    <ul className="divide-y">
      {items.map((it) => {
        // Cost is NOT a price fallback here (it used to be): showing what you
        // paid in the slot where the asking price goes reads as the asking
        // price. It gets its own labelled line below instead.
        // INV-10: the whole row, so an untitled draft is named by its listing
        // title or SKU rather than by a slice of its UUID.
        const rowLabel = itemRowLabel(it);
        // INV-10: a LIVE listing shows the price buyers see; anything else
        // shows the asking price. Each is labelled so the two never blur.
        const live = it.listing_status === "active" && it.list_price != null;
        const shownPrice = live ? it.list_price : (it.target_price ?? it.list_price);
        const price = money(shownPrice);
        const priceLabel = live ? "Listed" : "Asking";
        const cost = it.purchase_price;
        const askingPrice = shownPrice;
        // US-2790: postage was absent here too, so the profit shown per card
        // read higher than the sale would. The prediction comes from the
        // garment's own record via items_full (migration 00650).
        //
        // `it.category` is deliberately NOT used: it is
        // coalesce(item_category, garment_category), so it carries a
        // merchandising value whenever one is set, and estimateParcel would
        // fall through to the `other` base weight while still reporting the
        // number as category-derived.
        const parcel = estimateParcel({
          garmentCategory: it.garment_category,
          material: it.material,
          measurements: it.measurements,
          size: it.size,
        });
        const postage = estimatePostage(parcel.billableWeightOz);
        const est =
          askingPrice != null && askingPrice > 0
            ? estimateListingProfit({
                price: askingPrice,
                costBasis: cost,
                // null above the heaviest sourced band, which reproduces the
                // old figure rather than inventing a price.
                shippingCost: postage?.priceUsd ?? null,
              })
            : null;
        const sub = [it.brand, it.style, it.size].filter(Boolean).join(" · ");
        const isSel = selectedIds?.has(it.id) ?? false;
        return (
          <li
            key={it.id}
            className={cn(
              "flex items-stretch gap-1",
              isSel && "bg-brand-navy/5",
            )}
          >
            {selectable && (
              <label className="flex shrink-0 cursor-pointer items-center pl-4">
                <input
                  type="checkbox"
                  checked={isSel}
                  onChange={() => onToggleSelect?.(it.id)}
                  className="h-4 w-4 cursor-pointer"
                  aria-label={`Select ${rowLabel}`}
                />
              </label>
            )}
            <button
              type="button"
              onClick={() => onOpen(it)}
              className="flex min-w-0 flex-1 flex-col gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {itemDisplayTitle(it) || "Untitled item"}
                  </div>
                  {sub && (
                    <div className="truncate text-xs text-muted-foreground">
                      {sub}
                    </div>
                  )}
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    SKU {it.item_number ?? "—"}
                    {showSourcer &&
                      ` · Sourced by ${it.sourced_by?.trim() || "nobody yet"}`}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={it.status} />
                  {price && (
                    <span className="text-sm tabular-nums">
                      <span className="font-mono">{price}</span>{" "}
                      <span className="text-[11px] text-muted-foreground">{priceLabel}</span>
                    </span>
                  )}
                </div>
              </div>
              {(cost != null || est != null) && (
                <div className="flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
                  <span>
                    Cost{" "}
                    <span className="font-mono text-foreground">
                      {money(cost) ?? "—"}
                    </span>
                  </span>
                  {est && (
                    <span>
                      Est. return{" "}
                      <span
                        className={cn(
                          "font-mono",
                          est.net < 0
                            ? "text-destructive"
                            : "text-emerald-700 dark:text-emerald-400",
                        )}
                      >
                        {money(est.net)}
                      </span>{" "}
                      {est.marginPct.toFixed(0)}%
                      {cost == null && " max"}
                    </span>
                  )}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <NextActionBadge item={it} />
                {it.grade_value != null && (
                  <Badge variant="secondary" className="text-[10px]">
                    {Number(it.grade_value).toFixed(1)}
                  </Badge>
                )}
              </div>
            </button>
            {onQuickEdit && (
              <button
                type="button"
                onClick={() => onQuickEdit(it)}
                className="flex shrink-0 items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={`Quick edit ${rowLabel}`}
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

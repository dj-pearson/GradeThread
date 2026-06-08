import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { NextActionBadge } from "@/components/flipdesk/next-action-badge";
import type { ItemFullRow } from "@/types/database";

function money(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null;
  return `$${n.toFixed(0)}`;
}

// Mobile-friendly card list for the inventory/listings tables — rendered
// below the md breakpoint in place of the horizontal-scroll table. Each card
// carries the fields a reseller triages on (title, SKU, status, price, next
// action, grade) and taps through to the same item detail the table row does.
export function ItemCardList({
  items,
  onOpen,
}: {
  items: ItemFullRow[];
  onOpen: (item: ItemFullRow) => void;
}) {
  return (
    <ul className="divide-y">
      {items.map((it) => {
        const price =
          money(it.target_price) ??
          money(it.list_price) ??
          money(it.purchase_price);
        const sub = [it.brand, it.style, it.size].filter(Boolean).join(" · ");
        return (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => onOpen(it)}
              className="flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {it.item_title || "Untitled item"}
                  </div>
                  {sub && (
                    <div className="truncate text-xs text-muted-foreground">
                      {sub}
                    </div>
                  )}
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    SKU {it.item_number ?? "—"}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={it.status} />
                  {price && (
                    <span className="font-mono text-sm tabular-nums">
                      {price}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <NextActionBadge item={it} />
                {it.grade_value != null && (
                  <Badge variant="secondary" className="text-[10px]">
                    {Number(it.grade_value).toFixed(1)}
                  </Badge>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

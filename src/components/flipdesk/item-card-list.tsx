import { Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { NextActionBadge } from "@/components/flipdesk/next-action-badge";
import { cn } from "@/lib/utils";
import type { ItemFullRow } from "@/types/database";

function money(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null;
  return `$${n.toFixed(0)}`;
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
}: {
  items: ItemFullRow[];
  onOpen: (item: ItemFullRow) => void;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onQuickEdit?: (item: ItemFullRow) => void;
}) {
  return (
    <ul className="divide-y">
      {items.map((it) => {
        const price =
          money(it.target_price) ??
          money(it.list_price) ??
          money(it.purchase_price);
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
                  aria-label="Select item"
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
            {onQuickEdit && (
              <button
                type="button"
                onClick={() => onQuickEdit(it)}
                className="flex shrink-0 items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Quick edit"
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

import { memo } from "react";
import { Copy, CornerDownLeft, Package } from "lucide-react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/ui/status-badge";
import { GradeChip } from "@/components/flipdesk/grade-chip";
import { SnippetText } from "@/components/flipdesk/snippet-text";
import { itemRowLabel } from "@/lib/item-row-label";
import type { ItemListRow } from "@/lib/item-list-columns";
import type { HitGroup } from "@/lib/flipdesk-search";
import { cn } from "@/lib/utils";

// D1: one search result per garment, carrying what a reseller needs to act
// without clicking in: where it is (SKU, bin), where it stands (status, grade)
// and what it is worth (asking, listed or sold price).
//
// The row is a listbox OPTION, so it holds no link or button of its own: an
// option's children are presentational, and a focusable child inside one is an
// axe nested-interactive failure. The option opens on click; the copy-SKU
// button sits beside it, outside the option.

function money(n: number | null | undefined): string | null {
  if (n == null || Number.isNaN(n)) return null;
  return `$${n.toFixed(2)}`;
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Listed (live price), Sold (what it went for) or Asking, as the card list does. */
function priceLine(it: ItemListRow): string | null {
  if (it.status === "sold" && it.sale_price != null) {
    return `Sold ${money(it.sale_price)}`;
  }
  const live = it.listing_status === "active" && it.list_price != null;
  const price = live ? it.list_price : (it.target_price ?? it.list_price);
  const shown = money(price);
  if (!shown) return null;
  return `${live ? "Listed" : "Asking"} ${shown}`;
}

const MATCH_LABEL: Record<string, string> = {
  item: "item",
  listing: "listing",
  sale: "sale",
};

export interface SearchResultRowProps {
  index: number;
  group: HitGroup;
  item: ItemListRow | undefined;
  cover: string | undefined;
  active: boolean;
  // Stable callbacks taking the index, so memo can skip unchanged rows.
  onOpen: (group: HitGroup, e: React.MouseEvent | React.KeyboardEvent) => void;
  onHover: (index: number) => void;
  registerRow: (index: number, el: HTMLLIElement | null) => void;
}

export const SearchResultRow = memo(function SearchResultRow({
  index,
  group,
  item,
  cover,
  active,
  onOpen,
  onHover,
  registerRow,
}: SearchResultRowProps) {
  const { best, sale, matchedIn } = group;
  const title = item ? itemRowLabel(item) : best.title || "Untitled";
  const sku = item?.item_number?.trim() || null;
  const bin = item?.location_bin?.trim() || null;
  const price = item ? priceLine(item) : null;
  const otherMatches = matchedIn.filter((t) => t !== "item");

  const saleLine =
    sale && item
      ? [
          `Sold to ${sale.title || "a buyer"}`,
          money(item.sale_price),
          shortDate(item.sale_date),
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  async function copySku() {
    if (!sku) return;
    try {
      await navigator.clipboard.writeText(sku);
      toast.success(`Copied SKU ${sku}`);
    } catch {
      toast.error("Could not copy the SKU. Select it and copy it by hand.");
    }
  }

  return (
    <li
      ref={(el) => registerRow(index, el)}
      role="none"
      className="flex items-stretch"
    >
      <div
        id={`search-hit-${index}`}
        role="option"
        aria-selected={active}
        // Keyboard users drive the list from the field (aria-activedescendant);
        // this only covers an option that was clicked into focus.
        tabIndex={-1}
        onClick={(e) => onOpen(group, e)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen(group, e);
        }}
        onMouseMove={() => onHover(index)}
        className={cn(
          "group flex min-w-0 flex-1 cursor-pointer items-start gap-3 px-3 py-3",
          active && "bg-muted ring-1 ring-inset ring-primary/40",
        )}
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            width={48}
            height={48}
            loading="lazy"
            decoding="async"
            className="h-12 w-12 flex-shrink-0 rounded-md object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-md bg-muted"
          >
            <Package className="h-5 w-5 text-muted-foreground" />
          </span>
        )}
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{title}</span>
            {best.matchKind === "sku" && (
              <span className="rounded-full border border-primary/40 px-1.5 text-[11px] font-medium text-primary">
                Exact SKU
              </span>
            )}
            {best.matchKind === "bin" && bin && (
              <span className="rounded-full border border-primary/40 px-1.5 text-[11px] font-medium text-primary">
                In bin {bin}
              </span>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {sku && (
              <span>
                SKU <span className="font-mono text-foreground">{sku}</span>
              </span>
            )}
            {sku && bin && <span aria-hidden="true">·</span>}
            {bin && <span>Bin {bin}</span>}
            {item && <StatusBadge status={item.status} />}
            {item?.grade_value != null && <GradeChip grade={item.grade_value} />}
            {price && <span className="tabular-nums text-foreground">{price}</span>}
          </span>
          {saleLine && <span className="block text-xs">{saleLine}</span>}
          <SnippetText
            segments={best.segments}
            className="block text-xs text-muted-foreground"
          />
          {otherMatches.length > 0 && (
            <span className="block text-[11px] text-muted-foreground">
              Matched in {otherMatches.map((t) => MATCH_LABEL[t]).join(", ")}
            </span>
          )}
        </span>
        <CornerDownLeft
          aria-hidden="true"
          className={cn(
            "mt-1 hidden h-3 w-3 flex-shrink-0 text-muted-foreground md:block",
            active ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
      {sku && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => void copySku()}
          aria-label={`Copy SKU ${sku}`}
          title="Copy SKU"
          className="flex w-10 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <Copy className="h-4 w-4" />
        </button>
      )}
    </li>
  );
});

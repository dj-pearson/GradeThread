// US-3297: the pieces both negotiation tables need.
//
// Offers and messages are two different jobs with two different column sets, so
// they are two components — but the sort affordance, the pager and the filter
// box have to behave identically or the second table teaches the seller that
// the first one lied. Sharing them is cheaper than keeping two copies honest.

import type { ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, ChevronUp, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { SortDir } from "@/pages/flipdesk/offers-sort";

/**
 * A sortable column header.
 *
 * Same shape as the listings table's, deliberately — a seller who has learned
 * that a header with two faint chevrons is clickable should not have to learn
 * it twice. `aria-sort` is on the `th` rather than the button because that is
 * where a screen reader looks for it.
 */
export function SortHeader<F extends string>({
  field,
  children,
  align = "left",
  sort,
  onSort,
  className,
}: {
  field: F;
  children: ReactNode;
  align?: "left" | "right";
  sort: { field: F; dir: SortDir };
  onSort: (field: F) => void;
  className?: string;
}) {
  const active = sort.field === field;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn(align === "right" && "text-right", className)}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          "inline-flex items-center gap-1 font-medium hover:text-foreground",
          align === "right" && "ml-auto",
        )}
      >
        {children}
        {active ? (
          sort.dir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-50" />
        )}
      </button>
    </TableHead>
  );
}

/**
 * The filter box.
 *
 * Says what it searches rather than saying "Search", because a box that does
 * not name its scope gets typed into once with a size or a price and then never
 * used again.
 */
export function TableFilter({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="relative min-w-0 flex-1 sm:max-w-xs">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8"
      />
    </div>
  );
}

export function Pager({
  page,
  pageCount,
  total,
  noun,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  noun: string;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 pt-2">
      <span className="text-xs text-muted-foreground tabular-nums">
        {total.toLocaleString()} {noun}
      </span>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          Page {page + 1} of {pageCount}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

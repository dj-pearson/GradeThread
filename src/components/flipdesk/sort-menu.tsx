import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SortOption, SortOptionId } from "@/pages/flipdesk/inventory-sort";

/**
 * The Inventory sort picker.
 *
 * It lived inside listings.tsx until US-3122, which is why the table was the
 * only Inventory view a seller could reorder: the Grid, Kanban and Prep views
 * had no menu at all, and their order was whatever their query happened to ask
 * for. All four use this now, over the same `?sort=` param, so a sort survives
 * a view switch the way the search box and the filter already did.
 *
 * `headerActive` is the table's case alone — a clicked column header overrides
 * the menu, and showing a menu value then would name an order the page is not
 * in. The other views have no headers to click and leave it false.
 */
export function SortMenu({
  options,
  value,
  headerActive = false,
  onChange,
  className,
  label = "Sort by",
}: {
  options: SortOption[];
  value: SortOptionId;
  headerActive?: boolean;
  onChange: (id: string) => void;
  className?: string;
  label?: string;
}) {
  return (
    <Select value={headerActive ? "" : value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue placeholder="Sorted by column" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

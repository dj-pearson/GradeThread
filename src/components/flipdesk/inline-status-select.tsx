import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { ITEM_STATUSES, ITEM_STATUS_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { ItemStatus } from "@/types/database";

type Props = {
  value: ItemStatus;
  onChange: (next: ItemStatus) => void;
  pending?: boolean;
  className?: string;
};

// Inline status control for the listings table. Renders the status as the same
// compact pill <StatusBadge> uses, but opens a dropdown so a reseller can
// advance/change item_status straight from a row — no detail modal. `pending`
// adds an amber ring while an optimistic write is in flight (mirrors InlineCell).
export function InlineStatusSelect({
  value,
  onChange,
  pending = false,
  className,
}: Props) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ItemStatus)}>
      <SelectTrigger
        aria-label="Change status"
        className={cn(
          "h-auto w-fit gap-1 rounded-full border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-2 focus-visible:ring-brand-navy",
          pending && "ring-1 ring-amber-400/60",
          className,
        )}
      >
        <StatusBadge status={value} className="text-[10px]" />
      </SelectTrigger>
      <SelectContent>
        {ITEM_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {ITEM_STATUS_LABELS[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

import { StatusBadge } from "@/components/ui/status-badge";
import { ITEM_STATUSES, ITEM_STATUS_LABELS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { ItemStatus } from "@/types/database";

type Props = {
  value: ItemStatus;
  onChange: (next: ItemStatus) => void;
  /**
   * Which row this control belongs to — see itemRowLabel(). REQUIRED: one
   * "Change status" per row is a name; two hundred of them is a maze, and the
   * compiler is the only thing that makes a new call site supply this.
   */
  rowLabel: string;
  pending?: boolean;
  className?: string;
};

// Inline status control for the listings table. A transparent NATIVE <select>
// is overlaid on the compact <StatusBadge> so a reseller can change item_status
// straight from a row — no detail modal.
//
// Native, NOT a Radix Select popover, on purpose: a portal-based dropdown was
// unreliable inside the virtualized, click-to-open table rows — clicking the
// pill "did nothing" (the popover never opened). A native <select> always opens
// on click, regardless of virtualization / row-level onClick handlers.
// `pending` adds an amber ring while an optimistic write is in flight.
export function InlineStatusSelect({
  value,
  onChange,
  rowLabel,
  pending = false,
  className,
}: Props) {
  return (
    <span
      className={cn(
        "relative inline-flex items-center rounded-full focus-within:ring-2 focus-within:ring-brand-navy",
        pending && "ring-1 ring-amber-400/60",
        className,
      )}
    >
      <StatusBadge status={value} className="text-[10px]" />
      {/* The native <select> is layered over the badge (inset-0), so every click
          in this cell lands on it — and its own stopPropagation keeps the row's
          navigate-on-click from swallowing the interaction. */}
      <select
        // No "currently …" here, unlike InlineCell: a native <select> announces
        // its selected option as part of its VALUE, so spelling the status into
        // the name would have it read twice.
        aria-label={`Status of ${rowLabel}`}
        value={value}
        onChange={(e) => onChange(e.target.value as ItemStatus)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {ITEM_STATUSES.map((s) => (
          <option key={s} value={s}>
            {ITEM_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
    </span>
  );
}

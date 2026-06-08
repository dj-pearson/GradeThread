import { cn } from "@/lib/utils";
import {
  ITEM_STATUS_LABELS,
  ITEM_STATUS_TONE,
  STATUS_TONE_CLASSES,
} from "@/lib/constants";
import type { ItemStatus } from "@/types/database";

// One consistent pill for an inventory item's status. Reads the centralized
// label + tone maps in constants.ts so the same status renders identically in
// the inventory table, the listings table, mobile cards, etc. — no more
// per-page color schemes.
export function StatusBadge({
  status,
  className,
}: {
  status: ItemStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        STATUS_TONE_CLASSES[ITEM_STATUS_TONE[status]],
        className,
      )}
    >
      {ITEM_STATUS_LABELS[status]}
    </span>
  );
}

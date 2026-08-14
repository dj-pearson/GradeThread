import { Link } from "react-router";
import { ExternalLink, ImageOff } from "lucide-react";
import type { CaseItem } from "@/hooks/use-case-items";

// US-2521: the garment a return or cancellation is about. Both rows carry
// buttons that move money, and both used to identify the case by an id alone —
// so deciding one meant opening eBay in another tab to find out what it was.

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function CaseItemSummary({
  item,
  caseUrl,
  caseLabel,
}: {
  /** Null when nothing local matched the order or item id. */
  item: CaseItem | null | undefined;
  /** The eBay case or order page. */
  caseUrl: string;
  caseLabel: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
        {item?.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageOff className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0">
        {item ? (
          <Link
            to={`/dashboard/flipdesk/items/${item.inventoryItemId}`}
            className="block truncate font-medium hover:underline"
          >
            {item.title || "Untitled item"}
          </Link>
        ) : (
          // Say which it is. A missing match is usually a sale that predates the
          // connection, not a missing garment, and guessing a title would be
          // worse than saying nothing.
          <span className="block truncate font-medium text-muted-foreground">
            No matching item in your inventory
          </span>
        )}
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {item?.salePrice != null && <span>Sold for {usd.format(item.salePrice)}</span>}
          <a
            href={caseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline"
          >
            {caseLabel}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

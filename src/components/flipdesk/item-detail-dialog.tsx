import { useNavigate } from "react-router-dom";
import { ExternalLink, X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ItemCanvas } from "@/components/flipdesk/item-canvas";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import type { ItemFullRow } from "@/types/database";

// Quick-look wrapper around <ItemCanvas /> used from the items list and the
// pipeline kanban. The same canvas also renders standalone at
// /dashboard/flipdesk/items/:id — use the "Open as page" link for a
// deep-linkable URL.
type Props = {
  item: ItemFullRow | null;
  onClose: () => void;
};

export function ItemDetailDialog({ item, onClose }: Props) {
  const navigate = useNavigate();

  return (
    <Sheet open={item != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        {item && (
          <>
            {/* Sticky header */}
            <SheetHeader className="shrink-0 border-b px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-base">
                    {item.item_title || "Untitled item"}
                  </SheetTitle>
                  <SheetDescription className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                    <span>SKU {item.item_number ?? "(none)"}</span>
                    <span className="text-muted-foreground/40">·</span>
                    <span>
                      Status{" "}
                      <span className="font-medium">
                        {ITEM_STATUS_LABELS[item.status]}
                      </span>
                    </span>
                  </SheetDescription>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onClose();
                      navigate(`/dashboard/flipdesk/items/${item.id}`);
                    }}
                    className="h-8 px-2 text-xs"
                  >
                    <ExternalLink className="mr-1 h-3.5 w-3.5" />
                    Full page
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={onClose}
                  >
                    <X className="h-4 w-4" />
                    <span className="sr-only">Close</span>
                  </Button>
                </div>
              </div>
            </SheetHeader>

            {/* Scrollable canvas */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <ItemCanvas
                item={item}
                onAfterSave={onClose}
                onCancel={onClose}
                showHeader={false}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

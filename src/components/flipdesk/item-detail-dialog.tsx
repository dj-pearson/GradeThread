import { useNavigate } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  if (!item) return null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] w-[calc(100vw-2rem)] max-w-5xl overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">
                {item.item_title || "Untitled item"}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span>SKU {item.item_number ?? "(none)"}</span>
                <span className="text-muted-foreground/60">·</span>
                <span>
                  Status{" "}
                  <span className="font-medium">
                    {ITEM_STATUS_LABELS[item.status]}
                  </span>
                </span>
              </DialogDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onClose();
                navigate(`/dashboard/flipdesk/items/${item.id}`);
              }}
              className="flex-shrink-0"
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open as page
            </Button>
          </div>
        </DialogHeader>
        <div className="min-w-0">
          <ItemCanvas
            item={item}
            onAfterSave={onClose}
            onCancel={onClose}
            showHeader={false}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

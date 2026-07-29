import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FlipdeskComposerPage } from "@/pages/flipdesk/composer";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import type { ItemFullRow } from "@/types/database";

// Quick-look wrapper around the item editor, used from the items list and the
// pipeline kanban. The same editor renders standalone at
// /dashboard/flipdesk/items/:id — use the "Full page" link for a deep-linkable
// URL (and more room; this editor is a two-column layout at desktop widths).
type Props = {
  item: ItemFullRow | null;
  onClose: () => void;
};

export function ItemDetailDialog({ item, onClose }: Props) {
  const navigate = useNavigate();
  // US-2256: the composer's own guard is React Router's blocker, which only sees
  // ROUTE changes. Dismissing this sheet — the X, the overlay, Escape — is not a
  // navigation, so the sheet has to run the same confirm itself or thirteen cards
  // of edits vanish on a stray click outside it.
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState<null | "close" | "fullPage">(
    null,
  );

  function leave(intent: "close" | "fullPage") {
    if (dirty) {
      setConfirming(intent);
      return;
    }
    commit(intent);
  }

  function commit(intent: "close" | "fullPage") {
    const id = item?.id;
    setConfirming(null);
    setDirty(false);
    onClose();
    if (intent === "fullPage" && id) {
      navigate(`/dashboard/flipdesk/items/${id}`);
    }
  }

  return (
    <>
      <Sheet
        open={item != null}
        onOpenChange={(o) => {
          if (!o) leave("close");
        }}
      >
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
                      {dirty && (
                        <>
                          <span className="text-muted-foreground/40">·</span>
                          <span className="font-medium text-amber-600 dark:text-amber-400">
                            Unsaved changes
                          </span>
                        </>
                      )}
                    </SheetDescription>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => leave("fullPage")}
                      className="h-8 px-2 text-xs"
                    >
                      <ExternalLink className="mr-1 h-3.5 w-3.5" />
                      Full page
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => leave("close")}
                    >
                      <X className="h-4 w-4" />
                      <span className="sr-only">Close</span>
                    </Button>
                  </div>
                </div>
              </SheetHeader>

              {/* Scrollable editor — the same one the full page renders, so a
                  quick-look never shows a different (smaller) set of fields than
                  the page does. */}
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <FlipdeskComposerPage
                  itemId={item.id}
                  showHeader={false}
                  onDirtyChange={setDirty}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={confirming != null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              You have changes to this listing that haven&apos;t been saved. If
              you close now they&apos;ll be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirming(null)}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirming && commit(confirming)}
            >
              Leave and discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

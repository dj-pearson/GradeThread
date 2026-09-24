// AL-05: "p" used to publish the selection straight to eBay. It now opens this
// confirm first: how many drafts, how many the pre-flight will likely refuse,
// and what they are worth. Enter confirms (the action is focused on open) and
// Esc cancels.
import { useRef } from "react";
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

export interface DraftsPublishConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  /** Selected drafts that are flagged, unpriced, uncategorized or scheduled. */
  blocked: number;
  totalValue: number;
  hiddenBySearch: number;
  onConfirm: () => void;
}

const money = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD" });

export function DraftsPublishConfirm({
  open,
  onOpenChange,
  count,
  blocked,
  totalValue,
  hiddenBySearch,
  onConfirm,
}: DraftsPublishConfirmProps) {
  const actionRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          actionRef.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            Publish {count} draft{count === 1 ? "" : "s"} to eBay?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Listed value {money(totalValue)}.
            {blocked > 0 &&
              ` ${blocked} of them ${blocked === 1 ? "is" : "are"} flagged, unpriced, missing a category or scheduled, so eBay checks will likely stop ${blocked === 1 ? "it" : "them"}.`}
            {hiddenBySearch > 0 &&
              ` ${hiddenBySearch} more selected draft${hiddenBySearch === 1 ? " is" : "s are"} hidden by your search and won't be sent.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction ref={actionRef} onClick={onConfirm}>
            Publish {count}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
